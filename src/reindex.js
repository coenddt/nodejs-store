'use strict';

/**
 * 向量回填（VR-10）：按 sourceHash 只重算变化项。
 * 纯宿主编排：query（分页）→ 算摘要 → 比对 → embed → update（向量 + hash 同写）。
 */

const crypto = require('node:crypto');

const schema = require('./schema');
const feedback = require('./feedback');
const triggerExec = require('./crud/triggers');

const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;
const SEP = '\u001e';   // embedding 源文本分隔符（值内出现概率极低，且不影响摘要）

function hashText(sourceFields, doc) {
  const parts = [];
  for (const f of [...sourceFields].sort()) {
    const v = doc[f];
    const s = v === null || v === undefined ? '' : String(v);
    parts.push(`${f}:${Buffer.byteLength(s, 'utf8')}:${s}`);
  }
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

function _meta(schemaName) {
  if (!schema.has(schemaName)) throw new Error(`ERR_REINDEX_SCHEMA:未知 schema ${schemaName}`);
  return schema.get(schemaName);
}

function _opts(m, opts) {
  const o = opts || {};
  const f = m.fields[o.field];
  if (!f || f.type !== 'vector') {
    throw new Error(`ERR_REINDEX_FIELD:${o.field} 不是 ${m.name} 的 vector 字段`);
  }
  const h = m.fields[o.hashField];
  if (!h || h.type !== 'string') {
    throw new Error(`ERR_REINDEX_HASH_FIELD:${o.hashField} 须为 string 字段`);
  }
  if (!Array.isArray(o.sourceFields) || o.sourceFields.length === 0) {
    throw new Error('ERR_REINDEX_SOURCE:sourceFields 须为非空数组');
  }
  for (const s of o.sourceFields) {
    const sf = m.fields[s];
    if (!sf || sf.type !== 'string') {
      throw new Error(`ERR_REINDEX_SOURCE:${s} 须为 string 字段（摘要口径要求，见 §4.1）`);
    }
  }
  if (typeof o.embed !== 'function') {
    throw new Error('ERR_REINDEX_EMBED:embed 须为函数');
  }
  const pageSize = o.pageSize === undefined ? DEFAULT_PAGE : o.pageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE) {
    throw new Error(`ERR_REINDEX_PAGE:pageSize 须为 1..${MAX_PAGE} 的整数`);
  }
  return { ...o, pageSize };
}

function _text(sourceFields, doc) {
  return sourceFields
    .map((f) => {
      const v = doc[f];
      return v === null || v === undefined ? '' : String(v);
    })
    .join(SEP);
}

async function _embedAndWrite(store, m, o, todo, dim) {
  const texts = todo.map((r) => _text(o.sourceFields, r));
  const vecs = await o.embed(texts);
  if (!Array.isArray(vecs) || vecs.length !== texts.length) {
    const got = Array.isArray(vecs) ? vecs.length : '非数组';
    throw new Error(`ERR_REINDEX_EMBED:embed 返回 ${got} 条，期望 ${texts.length} 条`);
  }
  let written = 0;
  for (let i = 0; i < todo.length; i += 1) {
    const v = vecs[i];
    if (!Array.isArray(v) || v.length !== dim) {
      const got = Array.isArray(v) ? v.length : '非数组';
      throw new Error(`ERR_REINDEX_EMBED:第 ${i} 条维度 ${got}，期望 ${dim}`);
    }
    await store.update(m.name, { _id: todo[i]._id }, {
      [o.field]: v,
      [o.hashField]: hashText(o.sourceFields, todo[i]),
    });
    written += 1;
  }
  return written;
}

/** 全量/条件回填。`store` 为宿主门面（Store 实例）。 */
async function reindexVectors(store, schemaName, opts) {
  const started = Date.now();
  const m = _meta(schemaName);
  const o = _opts(m, opts);
  const dim = m.fields[o.field].dim;
  const filter = o.filter || {};
  const proj = ['_id', ...o.sourceFields, o.hashField].join(', ');
  const out = {
    schema: m.name, field: o.field, scanned: 0, embedded: 0,
    skipped: 0, pending: 0, pages: 0,
    dryRun: o.dryRun === true, elapsedMs: 0,
  };

  let anchor = null;
  for (;;) {
    let cond = filter;
    if (anchor !== null) {
      cond = Object.keys(filter).length
        ? { $and: [filter, { _id: { $gt: anchor } }] }
        : { _id: { $gt: anchor } };
    }
    const gql = `${m.name}($condition:@c,$sort:@s,$limit:@l){ ${proj} }`;
    const rows = await store.query(gql, { c: cond, s: { _id: 1 }, l: o.pageSize }, o.routeOverride);
    const page = Array.isArray(rows) ? rows : [];
    out.pages += 1;
    out.scanned += page.length;

    const todo = [];
    for (const r of page) {
      if (o.force !== true && r[o.hashField] === hashText(o.sourceFields, r)) {
        out.skipped += 1;
      } else {
        todo.push(r);
      }
    }
    out.pending += todo.length;

    if (todo.length && out.dryRun !== true) {
      out.embedded += await _embedAndWrite(store, m, o, todo, dim);
      feedback.emit({
        type: 'vector_reindex', code: 'vectorReindex', layer: 'host',
        message: `${m.name}.${o.field} 回填 ${out.embedded}/${out.scanned}（第 ${out.pages} 页）`,
        schema: m.name, field: o.field, page: out.pages,
      });
    }

    if (page.length < o.pageSize) break;
    anchor = page[page.length - 1]._id;
    if (anchor === null || anchor === undefined) {
      throw new Error('ERR_REINDEX_ANCHOR:分页锚点缺失（投影须含 _id）');
    }
  }

  out.elapsedMs = Date.now() - started;
  return out;
}

/** 单条回填（trigger 回调用）；返回 `{ embedded, skipped }`。 */
async function reindexOne(store, schemaName, id, opts) {
  const m = _meta(schemaName);
  const o = _opts(m, opts);
  const dim = m.fields[o.field].dim;
  const proj = ['_id', ...o.sourceFields, o.hashField].join(', ');
  const row = await store.queryOne(
    `${m.name}($condition:@c){ ${proj} }`, { c: { _id: id } }, o.routeOverride);
  if (!row) throw new Error(`ERR_REINDEX_NOT_FOUND:${m.name} 无 _id=${id}`);
  if (o.force !== true && row[o.hashField] === hashText(o.sourceFields, row)) {
    return { embedded: 0, skipped: 1 };
  }
  const n = await _embedAndWrite(store, m, o, [row], dim);
  return { embedded: n, skipped: 0 };
}

/** 注入 trigger 回调 `<Schema>.vectorReindex`；返回 fnRef（供 schema 声明对照）。 */
function registerVectorReindex(cfg) {
  const m = _meta(cfg && cfg.schema);
  const o = _opts(m, cfg);
  const fnRef = `${m.name}.vectorReindex`;
  triggerExec.setTriggerFn(fnRef, async (args, _ctx, host) => {
    const id = args && args._id;
    if (id === null || id === undefined || id === '') {
      throw new Error(`ERR_REINDEX_TRIGGER:${fnRef} 缺少 args._id`);
    }
    return reindexOne(host.store, m.name, id, o);
  });
  return fnRef;
}

module.exports = {
  reindexVectors, reindexOne, registerVectorReindex, hashText,
};
