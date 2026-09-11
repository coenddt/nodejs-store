'use strict';

/**
 * CRUD — 薄 Host 适配层
 *
 * 全部纯逻辑（GQL 解析、权限、命令规划、结果后处理）都在 Rust core；
 * 本模块只做 Host 三件事：
 *   1. 命令执行（唯一 IO 边界：把 core 产出的 Command JSON 映射到原生驱动调用）
 *   2. 占位符替换（{{phase1.ids}} / {{step.<N>._id}} 依赖真实执行结果）
 *   3. 原生回调（asyncFn 计算列两段式：prepareQuery 取 fnRefs → Host await → stripQuery）
 *
 * 不确定性输入由本层供给：now（时钟）、newIds（随机 ID，core 按需消费）。
 */

const { PermissionError, getContext } = require('./permission');
const { core: _core, get: _getSchema, getAsyncFn } = require('./schema');

const _PHASE1_IDS = /^\{\{phase1\.ids\}\}$/;
const _STEP_PH = /^\{\{step\.(\d+)\._id\}\}$/;

/** core 权限类错误消息 → PermissionError（消息与 core 常量保持一致） */
const _PERMISSION_MSGS = new Set(['无访问权限', '无写入权限', '无删除权限', '无批量写入权限']);

let _db = null;

function setDb(db) {
  _db = db;
}

function _getDb() {
  if (_db === null) throw new Error('MongoStore 未初始化，请先调用 init(db)');
  return _db;
}

/** 绑定层调用包装：权限类错误映射为 PermissionError */
function _call(fn) {
  try {
    return fn();
  } catch (e) {
    if (_PERMISSION_MSGS.has(e && e.message)) throw new PermissionError(e.message);
    throw e;
  }
}

function _ctx() {
  return getContext() ?? null;
}

// ─── ID 供给（Host 随机源） ──────────────────────────────────

const _ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 按 schema.idPrefix 生成唯一 ID（时间戳36进制 + 随机4位） */
function _generateId(schema) {
  const ts = Date.now().toString(36).toUpperCase();
  let rnd = '';
  for (let i = 0; i < 4; i++) {
    rnd += _ID_CHARS[Math.floor(Math.random() * _ID_CHARS.length)];
  }
  return schema.idPrefix + ts + rnd.toUpperCase();
}

/** 对齐 core `is_truthy`（字符串仅判空，不 trim） */
function _truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

/**
 * 预生成 mutation 的 ID 池：按数据树逐节点判断是否需要新 _id
 * （与 core `needs_new_id` 一致：无有效 _id 且 schema 配了 idPrefix），
 * 保证游标消费顺序与节点顺序对齐（父子 schema 前缀不同也能取对 ID）。
 */
function _newIdPool(schemaName, data) {
  const pool = [];
  const walk = (name, node) => {
    const s = _getSchema(name);
    if (!_truthy(node?._id) && s.idPrefix) {
      pool.push(_generateId(s));
    }
    for (const [key, val] of Object.entries(node || {})) {
      const rel = s.relations[key];
      if (!rel || val === null || val === undefined) continue;
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child !== null && child !== undefined) walk(rel.model, child);
        }
      } else {
        walk(rel.model, val);
      }
    }
  };
  walk(schemaName, data);
  return pool;
}

// ─── 命令执行（唯一 IO 边界） ────────────────────────────────

/** Command JSON → 原生驱动调用 */
async function _exec(cmd) {
  const coll = _getDb().collection(cmd.collection);
  switch (cmd.kind) {
    case 'find': {
      const opts = cmd.projection ? { projection: cmd.projection } : undefined;
      return coll.find(cmd.filter, opts).toArray();
    }
    case 'aggregate':
      return coll.aggregate(cmd.pipeline).toArray();
    case 'countDocuments':
      return coll.countDocuments(cmd.filter);
    case 'findOne': {
      const opts = cmd.projection ? { projection: cmd.projection } : undefined;
      return coll.findOne(cmd.filter, opts);
    }
    case 'insertOne':
      await coll.insertOne(cmd.doc);
      return cmd.doc;
    case 'insertMany':
      await coll.insertMany(cmd.docs);
      return { insertedCount: cmd.docs.length };
    case 'findOneAndUpdate':
      return coll.findOneAndUpdate(cmd.filter, cmd.update, cmd.options);
    case 'updateMany':
      return coll.updateMany(cmd.filter, cmd.update);
    case 'deleteMany':
      return coll.deleteMany(cmd.filter);
    default:
      throw new Error(`未支持的命令: ${cmd.kind}`);
  }
}

/** 深度替换命令中的占位符（命中 resolver 返回非字符串时替换） */
function _substitute(value, resolver) {
  if (typeof value === 'string') return resolver(value);
  if (Array.isArray(value)) return value.map((v) => _substitute(v, resolver));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _substitute(v, resolver);
    return out;
  }
  return value;
}

// ─── 读路径 ──────────────────────────────────────────────────

/** 执行读命令序列：find 快路径 / 两阶段（取 ID → 关联 → 还原排序）/ 标准聚合 */
async function _runQueryPlan(plan) {
  if (plan.mode === 'two_phase') {
    const idDocs = await _exec(plan.commands[0]);
    const ids = idDocs.map((d) => d._id);
    if (!ids.length) return [];
    const cmd2 = _substitute(plan.commands[1], (s) => (_PHASE1_IDS.test(s) ? ids : s));
    const items = await _exec(cmd2);
    return _core.restoreSortOrder(items, ids, plan.sort ?? null).items;
  }
  return _exec(plan.commands[0]);
}

/** 读路径尾处理两段式：core 后处理 → Host 执行 asyncFn → core 剥离注入依赖 */
async function _finalize(plan, items) {
  if (!plan.postprocess) return items;
  const prepared = _core.prepareQuery(plan.postprocess, items, _ctx());
  for (const ref of prepared.fnRefs) {
    const fn = getAsyncFn(ref);
    if (!fn) throw new Error(`asyncFn 计算列 ${ref} 未注册实现`);
    await fn(prepared.items, _ctx());
  }
  return _core.stripQuery(plan.postprocess, prepared.items).items;
}

/**
 * GQL 查询（返回数组）
 *
 * 支持的 params 键（通过 GQL 的 @key 引用）:
 *   $condition / $sort / $skip / $limit / $pipeline
 * 使用 $pipeline 时，框架不追加 compute 层、不补默认值、不裁剪，完全由用户控制。
 */
async function query(gql, params = null) {
  const plan = _call(() => _core.planQuery(gql, params ?? {}, _ctx()));
  return _finalize(plan, await _runQueryPlan(plan));
}

/** GQL 查询（返回单条） */
async function queryOne(gql, params = null) {
  const items = await query(gql, params);
  return items.length ? items[0] : null;
}

/**
 * GQL 查询（返回 items + total + 分页元数据）
 *
 * 支持两种分页参数方式：
 *   1. page/pageSize（推荐）— 自动计算 skip/limit，page 默认 0，pageSize 默认 50
 *   2. 传统 $skip/$limit — 从 GQL 参数推导 page/pageSize
 * pageSize 上限 5000，防止拖库。
 */
async function queryWithCount(gql, params = null) {
  const plan = _call(() => _core.planQueryWithCount(gql, params ?? {}, _ctx(), null));
  const items = await _finalize(plan, await _runQueryPlan(plan));
  const total = await _exec(plan.countCommand);
  return {
    items,
    total,
    hasMore: (plan.page + 1) * plan.pageSize < total,
    page: plan.page,
    pageSize: plan.pageSize,
  };
}

// ─── 写路径 ──────────────────────────────────────────────────

/** creator 写权限探针：先规划，若 needsProbe 则执行探针命令后重入 */
async function _planWithProbe(planFn) {
  let out = planFn(null, null);
  if (out.needsProbe) {
    const probeDoc = await _exec(out.needsProbe);
    out = planFn(probeDoc !== null && probeDoc !== undefined, probeDoc ?? null);
  }
  return out;
}

/** 插入一条 */
async function insert(schemaName, data) {
  const s = _getSchema(schemaName);
  const plan = _call(() =>
    _core.planInsert(schemaName, data ?? null, Date.now(), s.idPrefix ? _generateId(s) : '', _ctx()));
  await _exec(plan.command);
  return plan.returns;
}

/** 批量插入（带权限检查，自动生成 _id 和时间戳；空数组直接返回空） */
async function insertMany(schemaName, docs) {
  if (!Array.isArray(docs) || !docs.length) return [];

  const s = _getSchema(schemaName);
  const plan = _call(() => _core.planInsertMany(
    schemaName,
    docs,
    Date.now(),
    // core 按需消费（仅无 _id 的文档取用），多备无害
    docs.map(() => (s.idPrefix ? _generateId(s) : '')),
    _ctx(),
  ));
  if (plan.command) await _exec(plan.command);
  return plan.returns;
}

/**
 * 更新一条（支持原生操作符，不触发默认值）
 *
 * data 的 key 以 '$' 开头 → 原生 MongoDB 操作符（$set/$inc/$unset 等）直接透传。
 * 否则自动包装为 $set 模式。
 */
async function update(schemaName, condition, data, options = null) {
  const out = await _planWithProbe((found, doc) => _call(() =>
    _core.planUpdate(schemaName, condition ?? null, data ?? null, options ?? null, Date.now(), _ctx(), found, doc)));
  const result = await _exec(out.command);
  return result ? _call(() => _core.applyWriteDefaults(schemaName, result)) : null;
}

/** 批量更新（支持原生操作符） */
async function updateMany(schemaName, condition, data) {
  const out = _call(() =>
    _core.planUpdateMany(schemaName, condition ?? null, data ?? null, Date.now(), _ctx()));
  const result = await _exec(out.command);
  return { modifiedCount: result.modifiedCount };
}

/** 删除 —— 原表数据先归档到对应 `_deleted` 附表（附 deletedAt），再物理删除原表数据 */
async function remove(schemaName, condition) {
  const out = await _planWithProbe((found, doc) => _call(() =>
    _core.planRemove(schemaName, condition ?? null, _ctx(), found, doc)));

  let archivedCount = 0;
  if (out.findCommand) {
    const docs = await _exec(out.findCommand);
    if (docs.length) {
      const arch = _call(() => _core.planArchiveDocs(schemaName, docs, Date.now()));
      await _exec(arch.command);
      archivedCount = docs.length;
    }
  }

  const result = await _exec(out.deleteCommand);
  return { deletedCount: result.deletedCount, archivedCount };
}

/** 判断是否存在 */
async function exists(schemaName, condition) {
  const cmd = _call(() => _core.planExists(schemaName, condition ?? null));
  const doc = await _exec(cmd);
  return doc !== null && doc !== undefined;
}

/** 统计符合条件的文档数量 */
async function count(schemaName, filter = null) {
  const cmd = _call(() => _core.planCount(schemaName, filter ?? null));
  return _exec(cmd);
}

// ─── Mutation / Upsert ──────────────────────────────────────

/** mutation 单条：规划步骤序列 → 依序执行 + 父子 _id 占位符回填 */
async function _mutationOne(schemaName, data) {
  const plan = _call(() =>
    _core.planMutation(schemaName, data, Date.now(), _newIdPool(schemaName, data), _ctx()));

  const resolved = [];
  let rootResult = null;
  for (const [i, step] of plan.steps.entries()) {
    const cmd = _substitute(step.command, (s) => {
      const m = s.match(_STEP_PH);
      if (m && resolved[Number(m[1])] !== undefined) return resolved[Number(m[1])];
      return s;
    });
    const result = await _exec(cmd);
    resolved.push(result ? (result._id ?? null) : null);
    if (i === 0) rootResult = result; // 首步即根写入
  }

  return rootResult ? _call(() => _core.applyWriteDefaults(schemaName, rootResult)) : null;
}

/**
 * mutation — 智能持久化
 *
 * 自动判断 upsert/insert，支持父子文档关联填充。
 */
async function mutation(schemaName, data) {
  const isArray = Array.isArray(data);
  const items = isArray ? data : [data];

  if (!items.length) return isArray ? [] : null;

  const results = [];
  for (const item of items) {
    results.push(await _mutationOne(schemaName, item));
  }

  return isArray ? results : results[0];
}

/**
 * upsert — 显式条件 upsert
 *
 * 与 mutation 不同，upsert 需要调用方显式提供 match 条件，不处理父子关系。
 */
async function upsert(schemaName, condition, data, options = null) {
  const s = _getSchema(schemaName);
  const plan = _call(() => _core.planUpsert(
    schemaName, condition ?? null, data ?? null, options ?? null, Date.now(),
    s.idPrefix ? _generateId(s) : '', _ctx(),
  ));
  const result = await _exec(plan.command);
  return result ? _call(() => _core.applyWriteDefaults(schemaName, result)) : null;
}

// ─── 原生聚合 ────────────────────────────────────────────────

/** 对指定 schema 执行 MongoDB 原生聚合查询 */
async function aggregate(schemaName, pipeline) {
  const cmd = _call(() => _core.planAggregate(schemaName, pipeline ?? []));
  return _exec(cmd);
}

module.exports = {
  setDb,
  _getDb,
  query,
  queryOne,
  queryWithCount,
  insert,
  insertMany,
  update,
  updateMany,
  remove,
  exists,
  count,
  mutation,
  upsert,
  aggregate,
};
