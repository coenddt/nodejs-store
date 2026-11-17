/**
 * nodejs-store 类型声明（手写，与 src/index.js 的 module.exports 一一对应）。
 *
 * 设计口径：
 * - 公开门面（Store / init / store / createApp / 错误类）给出真实签名，供 IDE 与
 *   `tsc --checkJs` 消费方获得提示；
 * - 参数与返回值按运行时实际契约声明为 `any` / `Record<string, any>` 的地方，
 *   是因为这些位置在 JS 实现里本就是动态结构（GQL 参数、schema 定义、后端驱动对象），
 *   强类型化会与实现反向漂移，故不虚构成具体形状；
 * - 子模块（datasource / local / ddl / ...）按其运行时导出的命名空间给出索引签名。
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 结构化错误基类：带机器可读 `code` 与可选 HTTP `status` */
export class StoreError extends Error {
  code?: string
  status?: number
  detail?: any
  resourceId?: string
  constructor(message?: string, opts?: Record<string, any>)
}

export class PermissionError extends StoreError {}
export class NoContextError extends StoreError {}
export class ProfileViolation extends StoreError {}
export class PushdownUnsupportedError extends StoreError {}
export class RawSqlError extends StoreError {}
export class NativeCommandError extends StoreError {}
export class NonAtomicWriteError extends StoreError {}
export class WorkflowError extends StoreError {}
export class MetaDefError extends StoreError {}
export class MigrationUnsupported extends StoreError {}
export class AskExhausted extends StoreError {}

/** 一个请求 / 一个安全域的事务会话（`store.session(fn)` 内构造） */
export class Session {
  userId?: string
  roles?: string[]
  [key: string]: any
  constructor(opts?: Record<string, any>)
}

/** 数据引擎门面：schema 管理 + CRUD + 工作流 + 元数据控制面 */
export class Store {
  constructor(opts?: Record<string, any>)

  // ── Schema ──
  register(defn: Record<string, any>, ctx?: any): any
  registerBatch(items: Array<Record<string, any>>, ctx?: any): any
  unregister(name: string): any
  get(name: string): any
  has(name: string): boolean
  list(): string[]
  setFn(fnRef: string, impl: Function): void
  assertFnsCovered(defns: any): void
  setTriggerFn(fnRef: string, impl: Function): void
  assertTriggerFnsCovered(defns: any): void
  loadDefs(opts?: Record<string, any>): Promise<any[]>

  // ── CRUD ──
  query(gql: string, params?: any, routeOverride?: any): Promise<any>
  queryOne(gql: string, params?: any, routeOverride?: any): Promise<any>
  queryWithCount(gql: string, params?: any, routeOverride?: any): Promise<any>
  queryFederated(gql: string, params?: any): Promise<any>
  insert(schemaName: string, data: any, routeOverride?: any): Promise<any>
  insertMany(schemaName: string, docs: any[], routeOverride?: any): Promise<any>
  update(schemaName: string, condition: any, data: any, options?: any, routeOverride?: any): Promise<any>
  applyWriteComputes(schemaName: string, doc: any): any
  updateMany(schemaName: string, condition: any, data: any, routeOverride?: any): Promise<any>
  remove(schemaName: string, condition: any, routeOverride?: any, options?: any): Promise<any>
  exists(schemaName: string, condition: any, routeOverride?: any): Promise<boolean>
  count(schemaName: string, filter?: any, routeOverride?: any): Promise<number>
  mutation(schemaName: string, data: any, routeOverride?: any): Promise<any>
  upsert(schemaName: string, condition: any, data: any, options?: any, routeOverride?: any): Promise<any>
  claim(schemaName: string, filter: any, update: any, opts?: any): Promise<any>
  compareAndSet(schemaName: string, filter: any, update: any, opts?: any): Promise<any>
  renewLease(schemaName: string, filter: any, leaseFields: any, opts?: any): Promise<any>
  syncSchema(opts?: any): Promise<any>
  transaction(source: string, fn: Function): Promise<any>
  session(fn: Function): Promise<any>
  executeRaw(source: string, sql: string, params?: any[] | null, isWrite?: boolean | null): Promise<any>
  executeNative(source: string, collection: string, pipeline?: any[], options?: any): Promise<any>
  aggregate(schemaName: string, pipeline?: any[], options?: any): Promise<any>
  generateDdl(backend: string, names?: string[]): any

  // ── 元数据控制面 ──
  persistDef(defn: any, opts?: any): Promise<any>
  listDefs(opts?: any): Promise<any>
  restoreDefs(opts?: any): Promise<any>
  rollbackTo(opts?: any): Promise<any>
  migrate(opts?: any): Promise<any>
  persistWorkflowDef(defn: any, opts?: any): Promise<any>
  listWorkflowDefs(opts?: any): Promise<any>
  loadWorkflowDefs(opts?: any): Promise<any>
  rollbackWorkflowTo(opts?: any): Promise<any>

  // ── 内建 / 反馈 / 缓存 ──
  ensureBuiltins(): any
  enableFeedbackTable(): any
  setFeedbackMeta(meta: any): any
  flushFeedback(): Promise<any>
  setCacheStatus(fn: Function): any
  cacheStatus(ctx?: any): any

  // ── 能力探测 / 向量 / 工作流 ──
  capabilities(opts?: any): Promise<any>
  degradedStatus(): any
  withDegradedScope(fn: Function): any
  ensureVectorIndexes(opts?: any): Promise<any>
  reindexVectors(schemaName: string, opts?: any): Promise<any>
  registerVectorReindex(cfg: any): any
  registerWorkflow(defn: any, ctx?: any): any
  workflows(ctx?: any): any
  getWorkflow(name: string, ctx?: any): any
  runWorkflow(name: string, input?: any, opts?: any): Promise<any>
  buildPipeline(gql: string, params?: any): any
  baseView(): any

  // ── 上下文 / 画像 / AI 问数 ──
  setRequireContext(needCtx?: boolean): any
  requireContext(): boolean
  setProfile(profile: any): any
  getProfile(): any
  text2query(fn: Function): Promise<any>
  ask(question: string, opts?: any): Promise<any>
  describeForAi(ctx?: any): Promise<any>
}

/** 初始化全局 store（可传 store.config.json 路径或配置对象） */
export function init(opts?: any): Store
/** 全局 store 单例（`src/index.js:676` 的 `new Store()`；init 后重新装配同一实例） */
export const store: Store
/** 由配置装配宿主应用（bootstrap：schema 装载 + 协议皮） */
export function createApp(opts?: any): Promise<any>
export function setFn(fnRef: string, impl: Function): void
export function assertFnsCovered(defns: any): void
export function setTriggerFn(fnRef: string, impl: Function): void
export function assertTriggerFnsCovered(defns: any): void
/** text-to-query 两阶段规划（自然语言 → GQL → 执行计划） */
export function text2query(fn: Function): Promise<any>

// ── 执行作用域 ──
export function withScope(view: any, fn: Function): any
export function currentScope(): any
export function currentView(): any

// ── 子模块（运行时为 CommonJS 命名空间对象）──
export const datasource: Record<string, any>
export const local: Record<string, any>
export const ddl: Record<string, any>
export const load: Record<string, any>
export const schema: Record<string, any>
export const secure: Record<string, any>
export const permission: Record<string, any>
export const crud: Record<string, any>
export const resource: Record<string, any>
export const executors: Record<string, any>
export const feedback: Record<string, any>
export const cache: Record<string, any>
export const introspect: Record<string, any>
export const syncSchema: any
export const workflow: Record<string, any>
export const metadef: Record<string, any>
export const migrate: any
export const ask: any
export const describeForAi: any
export const AskResult: any
export const llm: Record<string, any>
