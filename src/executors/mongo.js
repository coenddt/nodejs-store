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

/** Command JSON → MongoDB 原生驱动调用 */
async function execMongo(db, cmd) {
  const coll = db.collection(cmd.collection);
  switch (cmd.kind) {
    case 'find': {
      _normFilter(cmd);
      const opts = cmd.projection ? { projection: cmd.projection } : undefined;
      return coll.find(cmd.filter, opts).toArray();
    }
    case 'aggregate':
      _normPipeline(cmd);
      return coll.aggregate(cmd.pipeline).toArray();
    case 'countDocuments':
      _normFilter(cmd);
      return coll.countDocuments(cmd.filter);
    case 'findOne': {
      _normFilter(cmd);
      const opts = cmd.projection ? { projection: cmd.projection } : undefined;
      return coll.findOne(cmd.filter, opts);
    }
    case 'insertOne':
      await coll.insertOne(cmd.doc);
      return cmd.doc;
    case 'insertMany':
      if (cmd.upsertById) {
        // 归档幂等（core planArchiveDocs）：按 _id 逐条覆盖 —— 「归档成功但删除失败」
        // 的重试不再因 _id 冲突整批失败。SQL 侧由 dialect 的 ON CONFLICT/REPLACE 承接。
        for (const doc of cmd.docs) {
          await coll.replaceOne({ _id: doc._id }, doc, { upsert: true });
        }
        return { insertedCount: cmd.docs.length };
      }
      await coll.insertMany(cmd.docs);
      return { insertedCount: cmd.docs.length };
    case 'findOneAndUpdate':
      _normFilter(cmd);
      return coll.findOneAndUpdate(cmd.filter, cmd.update, cmd.options);
    case 'updateMany':
      _normFilter(cmd);
      return coll.updateMany(cmd.filter, cmd.update);
    case 'deleteMany':
      _normFilter(cmd);
      return coll.deleteMany(cmd.filter);
    default:
      throw new Error(`未支持的命令: ${cmd.kind}`);
  }
}

module.exports = { execMongo };
