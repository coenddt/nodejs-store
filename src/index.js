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
const feedback = require('./feedback');
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
  /**
   * GQL 查询。`routeOverride`（可选）：`{ source?, namespace? }` 多租户路由，
   * 覆盖命令定位（权限/计算列仍按结构 schema 判定）。下同。
   * 注意：`routeOverride` 为**受信服务端参数**，禁止透传用户输入（否则可被用于跨源路由，CWE-639）。
   */
  async query(gql, params, routeOverride) {
    return crud.query(gql, params, routeOverride);
  }

  async queryOne(gql, params, routeOverride) {
    return crud.queryOne(gql, params, routeOverride);
  }

  async queryWithCount(gql, params, routeOverride) {
    return crud.queryWithCount(gql, params, routeOverride);
  }

  /** 跨库联邦查询（一条 GQL 跨多数据源：各源取数 → 内存 join → 统一后处理） */
  async queryFederated(gql, params) {
    return crud.queryFederated(gql, params);
  }

  async insert(schemaName, data, routeOverride) {
    return crud.insert(schemaName, data, routeOverride);
  }

  async insertMany(schemaName, docs, routeOverride) {
    return crud.insertMany(schemaName, docs, routeOverride);
  }

  async update(schemaName, condition, data, options, routeOverride) {
    return crud.update(schemaName, condition, data, options, routeOverride);
  }

  async updateMany(schemaName, condition, data, routeOverride) {
    return crud.updateMany(schemaName, condition, data, routeOverride);
  }

  async remove(schemaName, condition, routeOverride) {
    return crud.remove(schemaName, condition, routeOverride);
  }

  async exists(schemaName, condition, routeOverride) {
    return crud.exists(schemaName, condition, routeOverride);
  }

  async count(schemaName, filter, routeOverride) {
    return crud.count(schemaName, filter, routeOverride);
  }

  // ── Mutation / Upsert ──
  async mutation(schemaName, data, routeOverride) {
    return crud.mutation(schemaName, data, routeOverride);
  }

  async upsert(schemaName, condition, data, options, routeOverride) {
    return crud.upsert(schemaName, condition, data, options, routeOverride);
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

  // ── 宿主接入守卫（Registry 级，对齐 py-store c44001e） ──
  /**
   * 开关「上下文强制」（默认关闭 = fail-open）。开启后：所有查询/写入在 ctx 缺失时
   * 抛 `ERR_NO_CONTEXT`（fail-secure）；内部调用须显式传 `{ internal: true }` 上下文。
   */
  setRequireContext(needCtx = true) {
    return schema.setRequireContext(needCtx);
  }

  /** 「上下文强制」开关当前值（对齐 py-store store.require_context） */
  requireContext() {
    return schema.requireContext();
  }

  /** 设置数据源连接映射（多后端路由；对齐 py-store store.set_connections） */
  setConnections(connections) {
    return datasource.setConnections(connections);
  }

  /** 注册反馈事件回调（兜底/降级/拦截的统一出口）；传 null 恢复默认 stderr */
  setFeedbackSink(fn) {
    return feedback.setSink(fn);
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
    // 索引创建是初始化的辅助动作（非命令路由）：schema 绑定的 source 暂未在
    // 当前连接映射中时软跳过，不阻塞 init；其余配置错误（namespace 形态不匹配等）
    // 按 fail-fast 由 dbOfSchema 上抛，不静默吞掉
    if (!datasource.hasConnection(datasource.sourceOfSchema(name))) continue;
    const db = datasource.dbOfSchema(name); // Mongo 按 (datasource, namespace) 解析；SQL 源返回 null
    if (!db) continue; // SQL 后端不建索引

    const coll = db.collection(s.collection);

    let existingIndexes;
    try {
      existingIndexes = await coll.listIndexes().toArray();
    } catch (e) {
      // 只吞服务器错误（集合尚未存在 → NamespaceNotFound 属 MongoServerError）；
      // 连接/程序错误按 fail-fast 上抛，不再静默吞掉（对齐 py 侧 PyMongoError 收窄）
      if (e && e.name === 'MongoServerError') existingIndexes = [];
      else throw e;
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
        // 索引创建失败不阻塞 init（辅助动作），但必须走统一反馈通道：
        // 无 sink 时由 feedback 默认落 stderr（不双份打印），宿主可 setFeedbackSink 接管
        feedback.emit({
          type: 'index_create_failed',
          code: 'indexCreateFailed',
          layer: 'host',
          message: `创建索引失败 ${s.collection}: ${e && e.message ? e.message : e}`,
          hint: '检查该集合的索引定义与连接权限；索引缺失不影响读写，相关查询将退化为全表扫描',
        });
      }
    }
  }
}

/**
 * 初始化 store — 传入数据源连接映射
 *
 *   - 多源：`init({ default: db, mongo_b: client, pg_a: { kind: 'postgres', exec }, ... })`
 *   - 单源简写：`init(db)` / `init(client)`（Mongo db 实例或 MongoClient，自动归一为
 *     `{ default: 连接 }`）
 *
 * 连接按命令的 `source` 路由、`namespace` 定位库（schema 声明）；缺省绑定回落 `default`。
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
  PermissionError: permission.PermissionError,
  PushdownUnsupportedError: datasource.PushdownUnsupportedError,
  datasource,
  schema,
  permission,
  crud,
  executors,
  feedback,
  introspect,
  syncSchema,
};
