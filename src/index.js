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

const ask = require('./ask');
const crud = require('./crud');
const datasource = require('./datasource');
const { Session, NonAtomicWriteError } = require('./datasource');
const ddl = require('./ddl');
const executors = require('./executors');
const feedback = require('./feedback');
const introspect = require('./introspect');
const llm = require('./llm');
const metadef = require('./metadef');
const permission = require('./permission');
const { text2query } = require('./profile');
const schema = require('./schema');
const { syncSchema } = require('./sync');
const workflow = require('./workflow');

class Store {
  // ── Schema 管理 ──
  /** 注册 schema（可选 `ctx` 过定义层门禁，见 setMetaPolicy；默认 Open） */
  register(defn, ctx) {
    return schema.register(defn, ctx);
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

  // ── 事务 + 原生 SQL（复用 datasource.runInTransaction；见 README「事务边界」）──
  /**
   * 事务作用域：单 SQL 源「同连接 + 同事务」执行 fn（复用 runInTransaction）
   *
   * fn 内 executeRaw / CRUD 均落到该源的事务连接（commit/rollback 一体）；
   * Mongo 源或执行器未实现 withTransaction 时按原样执行（跨源无法原子），
   * 绝不静默假装已事务化。单源场景 source 传 'default'。
   *
   * 同源嵌套 transaction 会开保存点（内层失败只回滚本层）；句柄无保存点原语时
   * 降级并入外层并发 nested_savepoint_unsupported。
   */
  async transaction(source, fn) {
    return datasource.runInTransaction(source, fn);
  }

  /**
   * 会话（工作单元）：回调式，退出统一提交 / 异常统一回滚
   *
   * 用法:
   *   await store.session(async (s) => {
   *     await s.insert('Order', { ... });
   *     await s.update('Account', cond, { ... });
   *   });
   *
   * 约束：同一会话内写命令只允许落在**单一数据源**；跨源写退出时抛
   * NonAtomicWriteError（先全部回滚，绝不提交半截）。
   *
   * 嵌套：内层会话作为嵌套作用域在已有事务上开保存点，内层失败只回滚本层
   * （生命周期仍交外层）。
   */
  async session(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('store.session(fn) 需要回调函数：await store.session(async (s) => { ... })');
    }
    const s = new Session();
    const parent = datasource.currentSession();
    if (parent !== null) {
      // 嵌套：生命周期交外层；本层作为嵌套作用域（保存点隔离，失败只回滚本层）
      s.bindOuter(parent);
      const scope = parent.pushScope();
      try {
        const out = await fn(s);
        await parent.popScope(scope, false);
        return out;
      } catch (err) {
        await parent.popScope(scope, true);
        throw err;
      }
    }
    return datasource.runWithSession(s, async () => {
      try {
        const out = await fn(s);
        await s.exit(null);
        return out;
      } catch (err) {
        await s.exit(err);
        throw err;
      }
    });
  }

  /**
   * 在指定 SQL 源执行原生 SQL（事务内可用；编译由 core rawStmtCompile 完成）
   *
   * 两档参数风格：位置档（params 为数组/null）→ SQL 原样透传，占位符为各后端
   * 原生风格（mysql/sqlite 用 `?`，postgres 用 `$1..$n`）；命名档（params 为对象）
   * → SQL 文本中的 `:name` 编译为方言占位符（同名复用、跳过 `::` cast / 引号 /
   * 注释边界；缺名 / 多余名显式报错）。isWrite 缺省时按 SQL 首词推断（读白名单外
   * 一律按写——安全方向）。仅支持 SQL 源（Mongo 源抛 RawSqlError）。
   * 对齐 py-store store.execute_raw。
   */
  async executeRaw(source, sql, params = null, isWrite = null) {
    return datasource.executeRaw(source, sql, params, isWrite);
  }

  /**
   * 在指定 Mongo 源执行原生聚合管道（事务内可用；对标 SQL 侧 executeRaw）
   *
   * pipeline 为原生聚合管道（数组），options 为驱动原生透传项（allowDiskUse /
   * batchSize / hint / maxTimeMS…，宿主不做白名单）。事务 / 会话作用域内自动透传
   * session（由事务强制接管，options.session 不可覆盖）；统一按读路径解析，
   * $merge / $out 写管道请自行开事务。仅支持 Mongo 源（SQL 源抛 NativeCommandError
   * 并指引 executeRaw）。返回 { rows }。对齐 py-store store.execute_native。
   */
  async executeNative(source, collection, pipeline = [], options = null) {
    return datasource.executeNative(source, collection, pipeline, options);
  }

  /** 从已注册 schema def 生成指定后端 DDL 文本（纯函数，不连库、不回写；铁律 6） */
  generateDdl(backend, names) {
    return ddl.generate(backend, names);
  }

  // ── meta-store 定义控制面（定义持久化与版本化；见 metadef.js）──
  /** 持久化定义（同名同形幂等，异形 version+1；A1/A2） */
  async persistDef(defn, opts) {
    return metadef.persistDef(this, defn, opts);
  }

  /** 列定义行（按 version desc；name 缺省列全部） */
  async listDefs(opts) {
    return metadef.listDefs(this, opts);
  }

  /** 各 name 的最新 active 行 */
  async loadDefs(opts) {
    return metadef.loadDefs(this, opts);
  }

  /** 从持久化定义重建注册表：schema + workflow 两类（网关 reload 重装配前调用） */
  async restoreDefs(opts) {
    const s = await metadef.restoreDefs(this, { ...(opts || {}), kind: 'schema' });
    const w = await metadef.restoreDefs(this, { ...(opts || {}), kind: 'workflow' });
    return { total: s.total + w.total, applied: s.applied + w.applied };
  }

  /** 回滚到历史版本（重新 register 该版本 defn） */
  async rollbackTo(opts) {
    return metadef.rollbackTo(this, opts);
  }

  // ── 定义控制面：workflow 定义（kind=workflow；见 metadef.js）──
  /** 持久化 workflow 定义（同名同形幂等，异形 version+1） */
  async persistWorkflowDef(defn, opts) {
    return metadef.persistDef(this, defn, { ...(opts || {}), kind: 'workflow' });
  }

  /** 列 workflow 定义行（按 version desc；name 缺省列全部） */
  async listWorkflowDefs(opts) {
    return metadef.listDefs(this, { ...(opts || {}), kind: 'workflow' });
  }

  /** 各 name 的最新 active workflow 定义行 */
  async loadWorkflowDefs(opts) {
    return metadef.loadDefs(this, { ...(opts || {}), kind: 'workflow' });
  }

  /** 回滚 workflow 定义到历史版本（追加式） */
  async rollbackWorkflowTo(opts) {
    return metadef.rollbackTo(this, { ...(opts || {}), kind: 'workflow' });
  }

  /** 自举内建定义表 __schemaDef/__workflowDef（幂等） */
  ensureBuiltins() {
    return metadef.ensureBuiltins();
  }

  // ── 反馈事件落库（A6；见 feedback.js）──
  /** 一键接线：注册内建 __feedback 并把 sink 指向落库；返回 disposer（恢复原 sink） */
  enableFeedbackTable() {
    return feedback.enableFeedbackTable(this);
  }

  /** 注入进程级 ns 标签（tenant/env），供落库事件附加（进程级隔离下天然单 ns） */
  setFeedbackMeta(meta) {
    return feedback.setMeta(meta);
  }

  // ── 工作流编排（首批：线性 + when 守卫 + fail-fast；见 workflow.js 与设计文档）──
  /** 注册工作流定义（注册即静态校验，白名单外显式 Err 含 WORKFLOW_UNSUPPORTED） */
  registerWorkflow(defn) {
    return workflow.register(defn);
  }

  /** 全部可见工作流名（read 白名单过滤） */
  workflows(ctx) {
    return workflow.list(ctx);
  }

  /** 按名取工作流定义（read 白名单过滤；不可见与不存在同形——防枚举） */
  getWorkflow(name, ctx) {
    return workflow.get(name, ctx);
  }

  /**
   * 触发工作流 → 完整 run 文档
   * （终态 failed/rejected 不抛错，以 run.status + error 表达；dryRun 下 mutation/fail 记 wouldRun）
   */
  async runWorkflow(name, input, opts) {
    return workflow.run(name, input ?? null, opts);
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

  // ── 查询档位（判决唯一在 core）：standard 默认放开 / text2query 功能收缩 ──
  /**
   * 设置查询档位：`'standard'`（默认，功能最大化 + 跨 DB 对齐）/
   * `'text2query'`（功能收缩 + 硬限制）。进入档即等效强制 ctx；
   * 未知档由 core 抛错（禁静默回落默认档）。
   */
  setProfile(profile) {
    return schema.setProfile(profile);
  }

  /** 当前查询档位字符串（对齐 py-store store.get_profile） */
  getProfile() {
    return schema.getProfile();
  }

  /** text2query 便捷上下文（进入设档、退出恢复；同 scopedRoles 的 token-set/reset） */
  async text2query(fn) {
    return text2query(fn);
  }

  // ── AI 问数（L1，对齐 py-store store.ask / store.describe_for_ai）──
  /**
   * AI 问数唯一入口（LLM 输出永远当不可信输入；护栏面服务端硬编码，详见 ask.js）
   *
   * @param {string} question 自然语言问题
   * @param {{llm: (string|Function), ctx: object, maxRetries?: number, knowledge?: string}} opts
   * @returns {Promise<ask.AskResult>}
   */
  ask(question, opts) {
    return ask.ask(question, opts);
  }

  /** 输出 LLM 可读的 schema 摘要（权限过滤后的紧凑 JSON 数组；详见 ask.js） */
  describeForAi(ctx = null) {
    return ask.describeForAi(ctx);
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

  // ── RBAC 动态策略（判决唯一在 core；本层仅透传配置与查询面） ──
  setRbac(policy) {
    return permission.setRbac(policy);
  }

  rbacEnabled() {
    return permission.rbacEnabled();
  }

  rbacCan(model, action, ctx) {
    return permission.rbacCan(model, action, ctx);
  }

  rbacReadableFields(model, ctx) {
    return permission.rbacReadableFields(model, ctx);
  }

  rbacWritableFields(model, ctx) {
    return permission.rbacWritableFields(model, ctx);
  }

  rbacRowCondition(model, action, ctx) {
    return permission.rbacRowCondition(model, action, ctx);
  }

  // ── 角色清单与未配置姿态（清单化语义，判决唯一在 core；本层仅透传配置） ──
  setExemptRoles(roles) {
    return permission.setExemptRoles(roles);
  }

  setDenyWriteRoles(roles) {
    return permission.setDenyWriteRoles(roles);
  }

  setUnconfiguredPolicy(policy) {
    return permission.setUnconfiguredPolicy(policy);
  }

  /** 定义层门禁策略（判决唯一在 core）：closed 时仅 internal/白名单可注册或覆盖 */
  setMetaPolicy(closed, roles) {
    return schema.setMetaPolicy(closed, roles);
  }
}

/** 自定义权限错误（实例可被 store.PermissionError 捕获） */
Store.prototype.PermissionError = permission.PermissionError;
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
  text2query,
  Session,
  NonAtomicWriteError,
  PermissionError: permission.PermissionError,
  ProfileViolation: crud.ProfileViolation,
  PushdownUnsupportedError: datasource.PushdownUnsupportedError,
  RawSqlError: datasource.RawSqlError,
  NativeCommandError: datasource.NativeCommandError,
  datasource,
  ddl,
  schema,
  permission,
  crud,
  executors,
  feedback,
  introspect,
  syncSchema,
  workflow,
  WorkflowError: workflow.WorkflowError,
  // ── meta-store 定义控制面（定义持久化与版本化；对齐 py-store metadef）──
  metadef,
  MetaDefError: metadef.MetaDefError,
  // ── AI 问数（L1）：编排器 + schema 摘要 + LLM 插拔注册表（对齐 py-store ask/llm）──
  ask: ask.ask,
  describeForAi: ask.describeForAi,
  AskResult: ask.AskResult,
  AskExhausted: ask.AskExhausted,
  llm,
};
