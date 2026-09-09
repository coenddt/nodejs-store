'use strict';

/**
 * MongoStore — 轻量 MongoDB 数据层（Node.js 版）
 *
 * 核心理念:
 *   1. 纯 JSON schema 定义，零代码
 *   2. 读取时自动补默认值 + 执行计算列
 *   3. GQL 树形查询 → 一次 $lookup 聚合
 *   4. 写入只存用户数据，不补默认值
 *
 * 用法:
 *   const { MongoClient } = require('mongodb');
 *   const { init, store } = require('mongo-store-js');
 *
 *   const client = new MongoClient(uri);
 *   await client.connect();
 *   await init(client.db('mydb'));
 *   const items = await store.query('Model($condition:@c0) { field1, field2 }', { c0: {} });
 */

const computes = require('./computes');
const crud = require('./crud');
const permission = require('./permission');
const pipeline = require('./pipeline');
const schema = require('./schema');

/** 对指定 schema 执行 MongoDB 原生聚合查询 */
async function aggregate(schemaName, pl) {
  return crud.aggregate(schemaName, pl);
}

class Store {
  // ── Schema 管理 ──
  register(defn) {
    return schema.register(defn);
  }

  get(name) {
    return schema.get(name);
  }

  has(name) {
    return schema.has(name);
  }

  list() {
    return schema.list();
  }

  // ── CRUD ──
  async query(gql, params) {
    return crud.query(gql, params);
  }

  async queryOne(gql, params) {
    return crud.queryOne(gql, params);
  }

  async queryWithCount(gql, params) {
    return crud.queryWithCount(gql, params);
  }

  async insert(schemaName, data) {
    return crud.insert(schemaName, data);
  }

  async insertMany(schemaName, docs) {
    return crud.insertMany(schemaName, docs);
  }

  async update(schemaName, condition, data, options) {
    return crud.update(schemaName, condition, data, options);
  }

  async updateMany(schemaName, condition, data) {
    return crud.updateMany(schemaName, condition, data);
  }

  async remove(schemaName, condition) {
    return crud.remove(schemaName, condition);
  }

  async exists(schemaName, condition) {
    return crud.exists(schemaName, condition);
  }

  async count(schemaName, filter) {
    return crud.count(schemaName, filter);
  }

  // ── Mutation / Upsert ──
  async mutation(schemaName, data) {
    return crud.mutation(schemaName, data);
  }

  async upsert(schemaName, condition, data, options) {
    return crud.upsert(schemaName, condition, data, options);
  }

  // ── 原生聚合 ──
  async aggregate(schemaName, pl) {
    return crud.aggregate(schemaName, pl);
  }

  // ── 底层工具（调试/高级用法） ──
  parseGQL(gql) {
    return pipeline.parseGql(gql);
  }

  buildPipeline(ast, params) {
    return pipeline.buildPipeline(ast, params);
  }

  // ── 权限控制（AsyncLocalStorage 上下文） ──
  setContext(ctx) {
    return permission.setContext(ctx);
  }

  getContext() {
    return permission.getContext();
  }

  scopedRoles(roles, fn) {
    return permission.scopedRoles(roles, fn);
  }

  async runAsInternal(fn) {
    return permission.runAsInternal(fn);
  }
}

/** 自定义权限错误（实例可被 store.PermissionError 捕获） */
Store.prototype.PermissionError = permission.PermissionError;

const store = new Store();

/** 索引名对齐 MongoDB 自动命名（k1_v1_k2_v2），用于幂等创建 */
async function _createIndexesIfNeeded(db) {
  const names = schema.list();
  for (const name of names) {
    const s = schema.get(name);
    const coll = db.collection(s.collection);

    let existingIndexes;
    try {
      existingIndexes = await coll.listIndexes().toArray();
    } catch (e) {
      existingIndexes = [];
    }

    for (const idx of s.indexes || []) {
      try {
        const keys = idx.keys;
        if (!keys) continue;

        // 合并 inline 选项（unique/sparse/expireAfterSeconds 等）与显式 options
        const explicitOptions = idx.options || {};
        const finalOptions = {};
        for (const [k, v] of Object.entries(idx)) {
          if (k !== 'keys' && k !== 'options') finalOptions[k] = v;
        }
        Object.assign(finalOptions, explicitOptions);

        // 检查是否已有同 key 模式的索引（忽略选项差异）
        const nameFromKeys = Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_');
        if (existingIndexes.some((ei) => ei.name === nameFromKeys)) continue;

        await coll.createIndex(Object.entries(keys), finalOptions);
      } catch (e) {
        console.error(`[MongoStore] 创建索引失败 ${s.collection}: ${e && e.message ? e.message : e}`);
      }
    }
  }
}

/** 初始化 store — 传入 MongoDB Node 驱动的 db 实例 */
async function init(db) {
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError('init(db) 需要 MongoDB Node 驱动的 db 实例');
  }
  crud.setDb(db);

  // 自动创建索引 — 幂等安全
  await _createIndexesIfNeeded(db);

  return store;
}

module.exports = {
  init,
  store,
  Store,
  aggregate,
  PermissionError: permission.PermissionError,
  schema,
  permission,
  pipeline,
  computes,
  crud,
};
