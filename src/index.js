'use strict';

/**
 * nodejs-store — 轻量多后端数据层（Node.js 版，Rust 单核心架构；支持 MongoDB / MySQL / SQLite / PostgreSQL）
 *
 * 核心理念:
 *   1. 纯 JSON schema 定义，零代码
 *   2. Rust core 统一实现 GQL 解析 / 权限 / 计算列 / 命令规划（core-node 绑定）
 *   3. src/*.js 为薄 Host 适配层：驱动 IO + 回调 + 占位符替换
 *   4. Python 侧（core-py）复用同一 Rust core，双端语义天然一致
 *
 * Rust core 与 Node/Python 绑定位于独立仓库 rust-store，本仓库通过其绑定产物引用。
 *
 * 用法:
 *   const { MongoClient } = require('mongodb');
 *   const { init, store } = require('nodejs-store');
 *
 *   const client = new MongoClient(uri);
 *   await client.connect();
 *   await init(client.db('mydb'));
 *   const items = await store.query('Model($condition:@c0) { field1, field2 }', { c0: {} });
 */

const crud = require('./crud');
const datasource = require('./datasource');
const executors = require('./executors');
const introspect = require('./introspect');
const permission = require('./permission');
const schema = require('./schema');
const { syncSchema } = require('./sync');

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

  /** 跨库联邦查询（一条 GQL 跨多数据源：各源取数 → 内存 join → 统一后处理） */
  async queryFederated(gql, params) {
    return crud.queryFederated(gql, params);
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

  // ── 结构同步（SQL 数据源：introspect → schemaFromRows → mergeSchema → register） ──
  async syncSchema(opts) {
    return syncSchema(opts);
  }

  // ── 底层工具（调试/高级用法） ──
  /** 解析 GQL 并构建 pipeline，返回 `{tokens, ast, pipeline, projection}` */
  buildPipeline(gql, params) {
    return schema.core.buildPipeline(gql, params ?? {}, permission.getContext() ?? null);
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

/**
 * 索引名对齐 MongoDB 自动命名（k1_v1_k2_v2），用于幂等创建。
 *
 * 按 source 分派：Mongo 源执行 `_createIndexesIfNeeded`；SQL 后端**不建索引**
 * （`schema.indexes` 仅作元数据，见执行文档 Phase 3 动作 5）。
 */
async function _createIndexesIfNeeded() {
  const names = schema.list();
  for (const name of names) {
    const s = schema.get(name);
    const db = datasource.connectionOfSchema(name);
    if (typeof db.collection !== 'function') continue; // SQL 后端不建索引

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

/**
 * 初始化 store — 传入数据源连接映射
 *
 *   - 多源：`init({ default: db, mysql_a: { kind: 'mysql', exec }, ... })`
 *   - 单源简写：`init(db)`（Mongo db 实例，自动归一为 `{ default: db }`）
 *
 * 连接按 schema 的 `datasource` 绑定路由；缺省绑定回落 `default`。
 */
async function init(connections) {
  if (!connections || typeof connections !== 'object') {
    throw new TypeError('init(connections) 需要数据源连接映射（或单个 MongoDB db 实例）');
  }
  datasource.setConnections(connections);

  // 自动创建索引（仅 Mongo 源）— 幂等安全
  await _createIndexesIfNeeded();

  return store;
}

module.exports = {
  init,
  store,
  Store,
  aggregate: crud.aggregate,
  PermissionError: permission.PermissionError,
  datasource,
  schema,
  permission,
  crud,
  executors,
  introspect,
  syncSchema,
};
