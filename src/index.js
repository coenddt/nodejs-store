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
 *
 * D4-4 零语义拆分：`Store` 的方法按域下沉 ./index/api-schema-crud（Schema 管理 / CRUD /
 * Mutation / 并发原语）、./index/api-tx-defs（结构同步 / 事务 / 原生执行 / DDL / 定义
 * 控制面 / 反馈 / 缓存）、./index/api-ops（向量 / 工作流 / 底层工具 / 守卫 / 档位 / AI
 * 问数 / 连接与资源）、./index/api-access（权限 / RBAC / 角色清单 / 安全模式）；启动期
 * 索引保障下沉 ./index/mongo-indexes，`aggregate` opt-in 开关下沉 ./index/runtime-state。
 * 本文件保留门面：方法组沿原型链组装为 Store 的基类链（class 继承，TS checkJs 可沿链
 * 解析签名），导出面（键名 / 键序 / 语义）与拆分前逐字一致。
 */

const ask = require('./ask');
const cache = require('./cache');
const crud = require('./crud');
const triggerExec = require('./crud/triggers');
const datasource = require('./datasource');
const { Session, NonAtomicWriteError } = require('./datasource');
const ddl = require('./ddl');
const executors = require('./executors');
const feedback = require('./feedback');
const introspect = require('./introspect');
const llm = require('./llm');
const load = require('./load');
const local = require('./local');
const metadef = require('./metadef');
const migrate = require('./migrate');
const permission = require('./permission');
const { text2query } = require('./profile');
const resource = require('./resource');
const schema = require('./schema');
const scope = require('./scope');
const secure = require('./secure');
const { setFn, assertFnsCovered } = schema;
const { syncSchema } = require('./sync');
const workflow = require('./workflow');
const { createApp } = require('./bootstrap');
// 方法组基类链末端（SchemaCrudApi → TxDefsApi → OpsApi → AccessApi；见 class Store）
const AccessApi = require('./index/api-access');

class Store extends AccessApi {
  // 方法体见 ./index/api-*（D4-4 零语义拆分）：方法组沿原型链组装为
  // SchemaCrudApi → TxDefsApi → OpsApi → AccessApi → Store，避免本文件堆积；
  // 以 class 继承表达（而非动态挂载）以保证 TS checkJs 沿链解析全部方法签名。
}

/** 自定义权限错误（实例可被 store.PermissionError 捕获） */
Store.prototype.PermissionError = permission.PermissionError;
/** 上下文缺失错误（实例可被 store.NoContextError 捕获；fail-secure 下未注入 ctx） */
Store.prototype.NoContextError = permission.NoContextError;
/** 档位拒绝错误（实例可被 store.ProfileViolation 捕获；权限错误另见 PermissionError） */
Store.prototype.ProfileViolation = crud.ProfileViolation;
/** 原生 SQL 入口错误（实例可被 store.RawSqlError 捕获） */
Store.prototype.RawSqlError = datasource.RawSqlError;
/** 原生 Mongo 命令入口错误（实例可被 store.NativeCommandError 捕获） */
Store.prototype.NativeCommandError = datasource.NativeCommandError;
/** AI 问数重试耗尽（实例可被 store.AskExhausted 捕获，携带 .attempts / .events 全轨迹） */
Store.prototype.AskExhausted = ask.AskExhausted;
/** AI 问数成功结果（store.ask 的返回类型） */
Store.prototype.AskResult = ask.AskResult;

const store = new Store();

// 触发链执行器装配：回调经 store.* 写走既有权限/事务路径（避免 crud/* 反向 require 造成循环依赖）
triggerExec.setStore(store);

// ── 启动期索引保障（见 ./index/mongo-indexes）──
const { createIndexesIfNeeded } = require('./index/mongo-indexes');
// ── aggregate opt-in 开关（见 ./index/runtime-state）──
const { setAllowNativeAggregate } = require('./index/runtime-state');

/**
 * 初始化 store — 传入数据源连接映射
 *
 *   - 多源：`init({ default: db, mongo_b: client, pg_a: { kind: 'postgres', exec }, ... })`
 *   - 单源简写：`init(db)` / `init(client)`（Mongo db 实例或 MongoClient，自动归一为
 *     `{ default: 连接 }`）
 *   - 第二参 options：`{ allowNativeAggregate: true }` 开启 `store.aggregate`
 *     schema 名聚合别名（默认关闭，产品边界；未传或传 false 均保持关闭）
 *
 * 连接按命令的 `source` 路由、`database`（PG 另加 `schema`）定位库（schema 声明）；缺省绑定回落 `default`。
 */
async function init(connections, options = null) {
  if (!connections || typeof connections !== 'object') {
    throw new TypeError('init(connections) 需要数据源连接映射（或单个 MongoDB db 实例）');
  }
  setAllowNativeAggregate(options);
  datasource.setConnections(connections);

  // 自动创建索引（仅 Mongo 源）— 幂等安全
  await createIndexesIfNeeded();

  return store;
}

module.exports = {
  init,
  store,
  Store,
  createApp,
  setFn,
  assertFnsCovered,
  setTriggerFn: triggerExec.setTriggerFn,
  assertTriggerFnsCovered: triggerExec.assertTriggerFnsCovered,
  text2query,
  // ── 执行作用域（R2 双端宿主作用域）：一请求/一安全域一份视图，未进入回退 base ──
  withScope: scope.withScope,
  currentScope: scope.currentScope,
  currentView: scope.currentView,
  Session,
  NonAtomicWriteError,
  PermissionError: permission.PermissionError,
  NoContextError: permission.NoContextError,
  ProfileViolation: crud.ProfileViolation,
  PushdownUnsupportedError: datasource.PushdownUnsupportedError,
  RawSqlError: datasource.RawSqlError,
  NativeCommandError: datasource.NativeCommandError,
  datasource,
  local,
  ddl,
  load,
  schema,
  secure,
  permission,
  crud,
  resource,
  executors,
  feedback,
  cache,
  introspect,
  syncSchema,
  workflow,
  WorkflowError: workflow.WorkflowError,
  // ── meta-store 定义控制面（定义持久化与版本化；对齐 py-store metadef）──
  metadef,
  MetaDefError: metadef.MetaDefError,
  migrate: migrate.migrate,
  MigrationUnsupported: migrate.MigrationUnsupported,
  // ── AI 问数（L1）：编排器 + schema 摘要 + LLM 插拔注册表（对齐 py-store ask/llm）──
  ask: ask.ask,
  describeForAi: ask.describeForAi,
  AskResult: ask.AskResult,
  AskExhausted: ask.AskExhausted,
  llm,
};

// D4-1 解环：bootstrap 的 init/store 依赖在此注入（bootstrap 不再回指本模块，
// index→bootstrap 保持单向）；必须置于 module.exports 赋值之后（init/store 已定义）。
require('./bootstrap')._bindDeps({ init, store });
