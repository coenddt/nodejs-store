'use strict';

/**
 * Mongo 执行器（驱动：mongodb 原生）
 *
 * 只做「Command JSON → 原生驱动调用」（铁律 1/3）：全部纯逻辑（GQL 解析、权限、
 * 命令规划、结果后处理）都在 Rust core。对齐 ``py-store/src/py_store/executors/mongo.py``。
 *
 * 唯一原生边界改写：`_explicitNull` —— 把「字段 = null」的**等值条件**编译为
 * 「字段存在且为 null」（`{$eq: null, $exists: true}`）。理由：Mongo 原生把 `{f: null}`
 * 同时命中「值为 null」与「字段缺失」两类文档，而本 store 的三态契约（F-07/H-09）
 * 要求 `null` 只命中显式 null、`$exists:false` 才命中缺失 —— 这与 SQL 侧
 * `col IS NULL`（显式 null）语义对齐。运算对象（`$ne:null`/`$exists`/`$gt`…）不改写。
 *
 * Mongo session 事务：本模块只提供原语 `openTransaction`（`startSession` +
 * `startTransaction`）与 `execMongo(..., session)` 透传；事务的编排（提交/回滚/
 * 降级声明）由 datasource 层负责。Mongo **无** `SAVEPOINT` 原语，故不提供保存点系列。
 */

/** 单键改写规则：运算符对象与普通对象递归；普通键显式 null → 等值三态改写；其余原样 */
function _explicitVal(val, isOp) {
  if (val === null && !isOp) return { $eq: null, $exists: true };
  if (val !== null && typeof val === 'object') return _explicitNull(val);
  return val;
}

/** 递归改写 filter：`field: null`（标量等值）→ `field: {$eq: null, $exists: true}`。 */
function _explicitNull(v) {
  if (Array.isArray(v)) return v.map(_explicitNull);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = _explicitVal(val, k.startsWith('$'));
    }
    return out;
  }
  return v;
}

function _normFilter(cmd) {
  if (cmd.filter && typeof cmd.filter === 'object' && !Array.isArray(cmd.filter)) {
    cmd.filter = _explicitNull(cmd.filter);
  }
}

function _normPipeline(cmd) {
  if (!Array.isArray(cmd.pipeline)) return;
  for (const stage of cmd.pipeline) {
    if (stage && typeof stage === 'object' && stage.$match && typeof stage.$match === 'object') {
      stage.$match = _explicitNull(stage.$match);
    }
  }
}

/** Mongo 连接的 client：db 实例取 .client；MongoClient 返回自身 */
function _clientOf(connection) {
  if (connection && typeof connection.db === 'function' && typeof connection.collection !== 'function') {
    return connection; // MongoClient
  }
  return (connection && connection.client) || null; // Db.client
}

/** 合并 session 到 options（session 为空时返回原 options 语义，零回归） */
function _opts(session, base) {
  const o = base ? { ...base } : {};
  if (session) o.session = session;
  return o;
}

/**
 * Mongo 事务句柄：startSession + startTransaction
 *   - commit/rollback 幂等；release 结束 session；
 *   - 无保存点原语（Mongo 不支持 SAVEPOINT），嵌套由 datasource 层降级声明。
 */
async function openTransaction(connection) {
  const client = _clientOf(connection);
  const session = client.startSession();
  session.startTransaction();
  let closed = false;
  return {
    session,
    async commit() {
      if (closed) return;
      closed = true;
      await session.commitTransaction();
    },
    async rollback() {
      if (closed) return;
      closed = true;
      await session.abortTransaction();
    },
    async release() {
      await session.endSession();
    },
  };
}

/** find/findOne 共用的 projection opts */
function _projOpts(session, cmd) {
  return _opts(session, cmd.projection ? { projection: cmd.projection } : undefined);
}

/** insertOne（阶段2，no-error-masking）：Mongo 无自增语义 —— `_id` 缺失的文档只可能来自
 * 声明 strategy=autoincrement 的 schema（常规 schema 该形态已被 core 拦截）。
 * 禁止 ObjectId 静默顶替自增契约，显式报错。 */
async function _insertOneDoc(coll, cmd, session) {
  const doc = cmd.doc || {};
  if (!doc._id) {
    throw new Error(
      'AUTOINCREMENT_NOT_SUPPORTED: schema 声明了 strategy="autoincrement"，'
      + 'MongoDB 后端无自增语义（禁 ObjectId 顶替）；请使用 SQL 数据源');
  }
  await coll.insertOne(doc, _opts(session));
  return doc;
}

/** insertMany：upsertById（归档幂等）逐条覆盖；否则整批插入（_id 缺失显式报错） */
async function _insertManyDocs(coll, cmd, session) {
  if (cmd.upsertById) {
    // 归档幂等（core planArchiveDocs）：按 _id 逐条覆盖 —— 「归档成功但删除失败」
    // 的重试不再因 _id 冲突整批失败。SQL 侧由 dialect 的 ON CONFLICT/REPLACE 承接。
    for (const doc of cmd.docs) {
      await coll.replaceOne({ _id: doc._id }, doc, _opts(session, { upsert: true }));
    }
    return { insertedCount: cmd.docs.length };
  }
  if (cmd.docs.some((d) => !(d && d._id))) {
    throw new Error(
      'AUTOINCREMENT_NOT_SUPPORTED: schema 声明了 strategy="autoincrement"，'
      + 'MongoDB 后端无自增语义（禁 ObjectId 顶替）；请使用 SQL 数据源');
  }
  await coll.insertMany(cmd.docs, _opts(session));
  return { insertedCount: cmd.docs.length };
}

/** 并发原语（C1）仅 SQL 三后端有方言路径：Mongo 无行锁语义等价物，
 * 禁止静默走通用路径或伪装成功 —— 显式报错并指引改用 SQL 源。 */
function _claimUnsupported(cmd) {
  const { PushdownUnsupportedError } = require('../errors'); // D4-1 解环：错误类下沉，mongo 不再回指 datasource
  throw new PushdownUnsupportedError(
    cmd.source || '', cmd.kind, ['concurrencyPrimitivesSqlOnly'],
    ['claim/compareAndSet 仅 SQL 源支持（MongoDB 无行锁等价物）；请使用 SQL 源']);
}

// kind → 执行器（Object.create(null) 防原型键误命中；claim/compareAndSet 共用拒绝路径）
const _HANDLERS = Object.assign(Object.create(null), {
  find: (coll, cmd, session) => {
    _normFilter(cmd);
    return coll.find(cmd.filter, _projOpts(session, cmd)).toArray();
  },
  aggregate: (coll, cmd, session) => {
    // cmd.options 为原生聚合透传项（executeNative 注入；GQL 路径无此键，零回归）
    _normPipeline(cmd);
    return coll.aggregate(cmd.pipeline, _opts(session, cmd.options)).toArray();
  },
  countDocuments: (coll, cmd, session) => {
    _normFilter(cmd);
    return coll.countDocuments(cmd.filter, _opts(session));
  },
  findOne: (coll, cmd, session) => {
    _normFilter(cmd);
    return coll.findOne(cmd.filter, _projOpts(session, cmd));
  },
  insertOne: (coll, cmd, session) => _insertOneDoc(coll, cmd, session),
  insertMany: (coll, cmd, session) => _insertManyDocs(coll, cmd, session),
  findOneAndUpdate: (coll, cmd, session) => {
    _normFilter(cmd);
    return coll.findOneAndUpdate(cmd.filter, cmd.update, _opts(session, cmd.options));
  },
  updateMany: (coll, cmd, session) => {
    _normFilter(cmd);
    return coll.updateMany(cmd.filter, cmd.update, _opts(session));
  },
  deleteMany: (coll, cmd, session) => {
    _normFilter(cmd);
    return coll.deleteMany(cmd.filter, _opts(session));
  },
  claim: (coll, cmd) => _claimUnsupported(cmd),
  compareAndSet: (coll, cmd) => _claimUnsupported(cmd),
});

/** Command JSON → MongoDB 原生驱动调用（session 非空时全部操作携带该 session） */
async function execMongo(db, cmd, session) {
  const coll = db.collection(cmd.collection);
  const handler = _HANDLERS[cmd.kind];
  if (!handler) throw new Error(`未支持的命令: ${cmd.kind}`);
  return handler(coll, cmd, session);
}

module.exports = { execMongo, openTransaction };
