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

/** 递归改写 filter：`field: null`（标量等值）→ `field: {$eq: null, $exists: true}`。 */
function _explicitNull(v) {
  if (Array.isArray(v)) return v.map(_explicitNull);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('$') && (val !== null && typeof val === 'object')) {
        out[k] = _explicitNull(val);
      } else if (k.startsWith('$')) {
        out[k] = val;
      } else if (val !== null && typeof val === 'object') {
        out[k] = _explicitNull(val);
      } else if (val === null) {
        out[k] = { $eq: null, $exists: true };
      } else {
        out[k] = val;
      }
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

/** Command JSON → MongoDB 原生驱动调用（session 非空时全部操作携带该 session） */
async function execMongo(db, cmd, session) {
  const coll = db.collection(cmd.collection);
  switch (cmd.kind) {
    case 'find': {
      _normFilter(cmd);
      const opts = _opts(session, cmd.projection ? { projection: cmd.projection } : undefined);
      return coll.find(cmd.filter, opts).toArray();
    }
    case 'aggregate':
      // cmd.options 为原生聚合透传项（executeNative 注入；GQL 路径无此键，零回归）
      _normPipeline(cmd);
      return coll.aggregate(cmd.pipeline, _opts(session, cmd.options)).toArray();
    case 'countDocuments':
      _normFilter(cmd);
      return coll.countDocuments(cmd.filter, _opts(session));
    case 'findOne': {
      _normFilter(cmd);
      const opts = _opts(session, cmd.projection ? { projection: cmd.projection } : undefined);
      return coll.findOne(cmd.filter, opts);
    }
    case 'insertOne': {
      const doc = cmd.doc || {};
      // 阶段2（no-error-masking）：Mongo 无自增语义 —— `_id` 缺失的文档只可能来自
      // 声明 strategy=autoincrement 的 schema（常规 schema 该形态已被 core 拦截）。
      // 禁止 ObjectId 静默顶替自增契约，显式报错。
      if (!doc._id) {
        throw new Error(
          'AUTOINCREMENT_NOT_SUPPORTED: schema 声明了 strategy="autoincrement"，'
          + 'MongoDB 后端无自增语义（禁 ObjectId 顶替）；请使用 SQL 数据源');
      }
      await coll.insertOne(doc, _opts(session));
      return doc;
    }
    case 'insertMany':
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
    case 'findOneAndUpdate':
      _normFilter(cmd);
      return coll.findOneAndUpdate(cmd.filter, cmd.update, _opts(session, cmd.options));
    case 'updateMany':
      _normFilter(cmd);
      return coll.updateMany(cmd.filter, cmd.update, _opts(session));
    case 'deleteMany':
      _normFilter(cmd);
      return coll.deleteMany(cmd.filter, _opts(session));
    default:
      throw new Error(`未支持的命令: ${cmd.kind}`);
  }
}

module.exports = { execMongo, openTransaction };
