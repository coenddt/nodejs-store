'use strict';

/**
 * Mongo 物理名翻译与结果回映射（设计 §6 / 03 执行文档 §4.5）
 *
 * 唯一翻译算法在 Rust core::naming（经 core-node 透出）；本模块**只消费**，禁止自研：
 *   - 正向 `_toMongo(cmd)`：逻辑命令 → 物理命令（collection / 键 / 字段引用 → camelCase）
 *   - 反向 `_toLogical(result, cmd)`：驱动返回文档 → 逻辑文档（按逐 schema 逆表）
 *
 * 三条不变量（I1–I3）：
 *   - 契约保留键（键名本身，如 localField/foreignField/as/let）不翻译；
 *   - `$` 前缀操作符、`_id` 保留物理主键、`__`/`^__` 内部合成名不翻译；
 *   - 关系名不翻译（`$lookup.as` 保持逻辑关系名），其**值**为数据字段名时翻译。
 *
 * 回映射**不可**由 camelCase 反推（物理形式不可逆），必须以命令 collection 定位 schema，
 * 用 `naming` 对每个逻辑键算出物理键构成 `physical → logical` 逆表；关系子文档按关系目标
 * schema 的逆表递归。
 */

const { translateName } = require('./core');
const schemaMod = require('./schema');

const MONGO = 'mongodb';

/** 保留物理名（I3）：`_id`、`__`/`^__` 前缀内部合成名不翻译 */
function isReserved(name) {
  return typeof name === 'string'
    && (name === '_id' || name.startsWith('__') || name.startsWith('^__'));
}

/** 逻辑名 → Mongo 物理名（camelCase）；保留名原样（单点：core::naming.translateName） */
function physical(logical) {
  if (typeof logical !== 'string' || logical === '') return logical;
  return isReserved(logical) ? logical : translateName(logical, MONGO);
}

// ─── 正向：逻辑命令 → 物理命令 ───────────────────────────────

/** 键名 / 点号路径翻译（关系名与内部别名不翻译；段级处理） */
function trKey(key, rels) {
  if (typeof key !== 'string' || key === '') return key;
  if (key.startsWith('$')) return key;                      // `$` 前缀操作符
  if (isReserved(key)) return key;                          // `_id` / `__` 内部名
  if (key.includes('.')) {
    return key.split('.').map((seg) => trSeg(seg, rels)).join('.');
  }
  return rels.has(key) ? key : physical(key);               // 关系名不翻译
}

function trSeg(seg, rels) {
  if (isReserved(seg)) return seg;
  return rels.has(seg) ? seg : physical(seg);
}

/** `$fieldRef` 字符串值翻译（`$$var` 系统变量保留） */
function trRef(value, rels) {
  if (typeof value !== 'string' || !value.startsWith('$') || value.startsWith('$$')) {
    return value;
  }
  return '$' + trKey(value.slice(1), rels);
}

/**
 * 深度键翻译。
 * `transformRefs=true` 时同时翻译 `$fieldRef` 字符串值（pipeline / `$expr` 语境）；
 * 普通文档（filter/doc/projection）保持值原样，避免误译字面量。
 */
function walk(node, rels, transformRefs) {
  if (Array.isArray(node)) return node.map((n) => walk(n, rels, transformRefs));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$literal') { out[k] = v; continue; }              // 字面量不改
      if (k === '$expr') { out[k] = walk(v, rels, true); continue; } // 表达式内字段引用须译
      if (k === '$lookup' && v && typeof v === 'object') {
        out[k] = trLookup(v, rels);
        continue;
      }
      out[trKey(k, rels)] = walk(v, rels, transformRefs);
    }
    return out;
  }
  return transformRefs ? trRef(node, rels) : node;
}

/** `$lookup` 阶段：`from`=集合名（译）、`as`=关系名（不译）、`localField`/`foreignField`=关系字段（译） */
function trLookup(obj, rels) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'from') {
      out[k] = typeof v === 'string' ? physical(v) : v;
    } else if (k === 'localField' || k === 'foreignField') {
      out[k] = typeof v === 'string' ? physical(v) : v;
    } else if (k === 'as') {
      out[k] = v;                                     // 关系名不翻译
    } else if (k === 'let') {
      // 变量名（内部别名）不译；其值中的字段引用须译
      const m = {};
      for (const [vk, vv] of Object.entries(v || {})) m[vk] = walk(vv, rels, true);
      out[k] = m;
    } else {
      out[k] = walk(v, rels, true);
    }
  }
  return out;
}

/** 收集关系名：schema 声明的 relations + pipeline 内全部 `$lookup.as` */
function collectRels(info, pipeline) {
  const rels = new Set();
  for (const r of Object.keys((info && info.relations) || {})) rels.add(r);
  collectAs(pipeline, rels);
  return rels;
}

function collectAs(node, rels) {
  if (Array.isArray(node)) {
    for (const n of node) collectAs(n, rels);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$lookup' && v && typeof v === 'object' && typeof v.as === 'string') rels.add(v.as);
    collectAs(v, rels);
  }
}

/**
 * 逻辑命令 → 物理命令。只翻译**数据标识符**：collection、filter/projection/update/doc/docs
 * 的键、pipeline 的键与 `$fieldRef` 值、`$lookup.from`/`localField`/`foreignField` 的值。
 * `database` / `options` 等非数据标识符原样透传。
 */
function _toMongo(cmd) {
  if (!cmd || typeof cmd !== 'object') return cmd;
  const info = infoForCollection(cmd.collection);
  const rels = collectRels(info, cmd.pipeline);
  const out = { ...cmd };
  if (typeof cmd.collection === 'string') out.collection = physical(cmd.collection);
  for (const k of ['filter', 'projection', 'update', 'doc', 'docs']) {
    if (cmd[k] !== undefined && cmd[k] !== null) out[k] = walk(cmd[k], rels, false);
  }
  if (cmd.pipeline !== undefined && cmd.pipeline !== null) {
    out.pipeline = walk(cmd.pipeline, rels, true);
  }
  return out;
}

// ─── 反向：物理文档 → 逻辑文档（逐 schema 逆表） ──────────────

const _invCache = new Map();

/** 逐 schema 逆表：physical → logical（fields ∪ computes ∪ timestamps ∪ `_id`） */
function inverseTable(info) {
  let t = _invCache.get(info.name);
  if (t) return t;
  t = new Map([['_id', '_id'], ['createdAt', 'createdAt'], ['updatedAt', 'updatedAt']]);
  for (const f of Object.keys(info.fields || {})) t.set(physical(f), f);
  for (const c of Object.keys(info.computes || {})) t.set(physical(c), c);
  _invCache.set(info.name, t);
  return t;
}

/** 由镜像按 collection 定位 schema（定义零落点：collection 逻辑名） */
function infoForCollection(collection) {
  if (typeof collection !== 'string') return null;
  for (const name of schemaMod.list()) {
    let s;
    try { s = schemaMod.get(name); } catch { continue; }
    if (s && s.collection === collection) return s;
  }
  return null;
}

function infoForName(name) {
  if (typeof name !== 'string' || name === '') return null;
  try { return schemaMod.get(name); } catch { return null; }
}

/** 递归回映射文档：关系子文档按目标 schema 逆表递归，其余标量保持不变 */
function mapDoc(value, info) {
  if (Array.isArray(value)) return value.map((v) => mapDoc(v, info));
  if (!value || typeof value !== 'object') return value;
  const inv = inverseTable(info);
  const relations = info.relations || {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(relations, k)) {
      const target = infoForName(relations[k] && relations[k].model);
      out[k] = target ? mapDoc(v, target) : v;
    } else if (inv.has(k)) {
      out[inv.get(k)] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 物理结果 → 逻辑结果。按命令 collection 定位 schema；未注册（无法建逆表）时原样返回
 * （绝不臆测 camelCase 反推）。
 */
function _toLogical(result, cmd) {
  const info = infoForCollection(cmd && cmd.collection);
  if (!info) return result;
  return mapDoc(result, info);
}

module.exports = { _toMongo, _toLogical, physical, isReserved };
