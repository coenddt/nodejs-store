'use strict';

/**
 * `Store` 方法组：向量能力 / 索引 / 回填 + 工作流编排 + 底层工具 + 宿主接入守卫 +
 * 查询档位 + AI 问数 + 连接与资源接线（D4-4 零语义拆分自 index.js）。
 *
 * 本组方法为薄转发（含 `ensureVectorIndexes` 的历史类型断言，原样保留）。继承自
 * ./api-tx-defs：方法组沿原型链组装为 `Store` 的基类链，供 TS checkJs 解析签名。
 */

const ask = require('../ask');
const capabilitiesProbe = require('../capabilities');
const degraded = require('../degraded');
const datasource = require('../datasource');
const feedback = require('../feedback');
const permission = require('../permission');
const { text2query } = require('../profile');
const reindex = require('../reindex');
const resource = require('../resource');
const schema = require('../schema');
const vectorIndex = require('../vector-index');
const workflow = require('../workflow');
const TxDefsApi = require('./api-tx-defs');

class OpsApi extends TxDefsApi {
  // ── 向量能力与降级状态（见 capabilities.js / degraded.js）──
  /** 按 source 探测向量能力（异步：PG 需查 pg_extension） */
  async capabilities(opts) {
    return capabilitiesProbe.capabilities(opts);
  }

  /** 当前请求的降级状态（无请求容器 → degraded:false） */
  degradedStatus() {
    return degraded.status();
  }

  /** 请求级降级作用域：返回 `{ result, status }`（协议皮用于 x-store-degraded） */
  withDegradedScope(fn) {
    return degraded.withRequest(fn);
  }

  // ── Atlas 向量索引（启动/运维调用；不参与请求路径）──
  /** 幂等创建 schema 中声明 options.indexName 的 Atlas 向量索引 */
  ensureVectorIndexes(opts) {
    // 底层 vector-index#ensureVectorIndexes 只取 store（第二参历史形态由 JS 忽略）
    return /** @type {any} */ (vectorIndex.ensureVectorIndexes)(this, opts ?? {});
  }

  // ── 向量回填（VR-10；见 reindex.js）──
  /** 向量回填：按 sourceHash 只重算变化项 */
  async reindexVectors(schemaName, opts) {
    return reindex.reindexVectors(this, schemaName, opts);
  }

  /** 注入 trigger 回调 `<Schema>.vectorReindex`，返回 fnRef（须在 assertTriggerFnsCovered 之前调用） */
  registerVectorReindex(cfg) {
    return reindex.registerVectorReindex(cfg);
  }

  // ── 工作流编排（首批：线性 + when 守卫 + fail-fast；见 workflow.js 与设计文档）──
  /** 注册工作流定义（可选 `ctx` 过定义层门禁；默认 Open。白名单外显式 Err 含 WORKFLOW_UNSUPPORTED） */
  registerWorkflow(defn, ctx) {
    return workflow.register(defn, ctx);
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
    return schema.getCore().buildPipeline(gql, params ?? {}, permission.getContext() ?? null);
  }

  /**
   * base Registry 引用（恒 base，无视作用域）：协议皮经宿主门面派生视图的唯一合法起点
   * （`baseView().withPolicy(overrides)` → withScope；皮侧禁自持 `new Registry()`——R2-04 §4.1/§7）
   */
  baseView() {
    return schema.getBase();
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

  /** text2query 便捷上下文（档位随作用域视图隔离，退出即回退 base——R2，03 §3.2） */
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

  /** 注册资源 provider 类型（转发模块级注册表；`mod` 须含 `create(options)`） */
  registerProvider(kind, mod) {
    return resource.registerProvider(kind, mod);
  }

  configureResource(cfg) {
    return resource.configure(cfg);
  }

  async resourcePut(input) {
    return resource.put(input);
  }

  async resourceOpen(id, opts) {
    return resource.open(id, opts);
  }

  async resourceRemove(id) {
    return resource.remove(id);
  }

  async resourceUrl(ref, opts) {
    return resource.url(ref, opts);
  }
}

module.exports = OpsApi;
