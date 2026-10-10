'use strict';

/**
 * 权限上下文 — AsyncLocalStorage 请求上下文 + 自定义错误
 *
 * 角色评估、字段过滤、所有者条件注入等权限逻辑已全部下沉 Rust core；
 * 本模块只保留 Host 侧职责：
 *   - 请求上下文的隐式传递（core 的 ctx 一律显式入参，由本模块取出后传入）
 *   - PermissionError（core 返回的权限类错误消息由 crud.js 映射为本错误类型）
 */

const { AsyncLocalStorage } = require('node:async_hooks');

// 门面经 `getCore()` 现场取（作用域内作用于派生视图，域外回退 base——03 §4.2）；
// 本模块形参名 `schema` 已被占用（`_model(schema)`），故引入名用 `schemaMod`（对齐 naming.js）
const schemaMod = require('./schema');

const _als = new AsyncLocalStorage();

/** 设置当前请求的上下文，每次请求开始时调用一次 */
function setContext(ctx) {
  _als.enterWith(ctx);
}

/** 获取当前请求的上下文，无则 undefined */
function getContext() {
  return _als.getStore();
}

/**
 * 以指定角色进入临时权限上下文（嵌套安全），执行 fn 后自动恢复原上下文。
 *
 * 供 AI 查询执行等显式角色注入场景使用，取代 setContext + finally setContext(null)
 * 的清空式写法（后者嵌套时会误清外层上下文，且「无上下文 = 权限全放行」，清空即静默失守方向）。
 */
function scopedRoles(roles, fn) {
  const next = { ...(getContext() || {}), roles };
  return _als.run(next, () => fn());
}

/**
 * 以完整上下文 ctx 进入临时权限上下文（嵌套安全），执行 fn 后自动恢复原上下文。
 *
 * 对齐 py_store.permission.scoped_context；与 scopedRoles 同构，区别在于整体替换
 * ctx（保留调用方原上下文于外层），供 AI 问数（ask）等把服务端构造的用户上下文
 * 显式注入执行面的场景——不用「setContext + finally 清空」写法（嵌套时误清外层，
 * 静默失守方向）。
 */
function scopedContext(ctx, fn) {
  return _als.run(ctx ?? null, () => fn());
}

/** 在内部上下文中执行操作（绕过权限检查），结束后自动恢复上下文 */
async function runAsInternal(fn) {
  const prev = getContext();
  const next = { ...(prev || {}), internal: true };
  return _als.run(next, () => fn());
}

// ─── core 权限方法包装（对齐 py_store.permission 的同名薄包装） ──────

/** 接受 schema 对象或 schema 名称 */
function _model(schema) {
  return typeof schema === 'string' ? schema : schema.name;
}

function canReadSchema(schema, ctx) {
  return schemaMod.getCore().canRead(_model(schema), ctx ?? null);
}

function canWriteSchema(schema, ctx) {
  return schemaMod.getCore().canWrite(_model(schema), ctx ?? null);
}

function shouldInjectOwnerCondition(schema, ctx) {
  return schemaMod.getCore().shouldInjectOwner(_model(schema), ctx ?? null);
}

function mergeOwnerCondition(schema, ctx, condition) {
  const out = schemaMod.getCore().mergeOwnerCondition(_model(schema), ctx ?? null, condition ?? null);
  // core 在「不注入」时返回 null（无法区分原条件为 null）→ 原样返回入参条件
  return out === null || out === undefined ? condition : out;
}

function getReadableFields(schema, ctx) {
  return schemaMod.getCore().readableFields(_model(schema), ctx ?? null);
}

function getReadableRelations(schema, ctx) {
  return schemaMod.getCore().readableRelations(_model(schema), ctx ?? null);
}

/** 角色可读计算列集（列级白名单；core 未导出该判决的旧绑定上为 undefined） */
function getReadableComputes(schema, ctx) {
  return schemaMod.getCore().readableComputes(_model(schema), ctx ?? null);
}

function getWritableFields(schema, ctx) {
  return schemaMod.getCore().writableFields(_model(schema), ctx ?? null);
}

function filterWritableData(schema, ctx, data) {
  return schemaMod.getCore().filterWritableData(_model(schema), ctx ?? null, data);
}

// ─── RBAC 动态策略（core 判决；本模块零判决，仅透传，对齐 py_store.permission） ──

/** 注入/清除 RBAC 策略。object = 注入（解析失败 core 抛错）；null = 清除关闭 */
function setRbac(policy) {
  return schemaMod.getCore().setRbac(policy ?? null);
}

/** RBAC 策略是否已注入 */
function rbacEnabled() {
  return schemaMod.getCore().rbacEnabled();
}

/** RBAC 动作判决：action ∈ {read, insert, update, remove}；RBAC 不介入 → true */
function rbacCan(model, action, ctx) {
  return schemaMod.getCore().rbacCan(_model(model), action, ctx ?? null);
}

/** RBAC 叠加后的可读字段集（静态 ∩ readFields）；无 ctx → null 不裁剪 */
function rbacReadableFields(model, ctx) {
  return schemaMod.getCore().rbacReadableFields(_model(model), ctx ?? null);
}

/** RBAC 叠加后的可写字段集（静态 ∩ writeFields）；无 ctx → null 不裁剪 */
function rbacWritableFields(model, ctx) {
  return schemaMod.getCore().rbacWritableFields(_model(model), ctx ?? null);
}

/** RBAC 行级条件（ownerOnly/condition 的 OR 合并体）；action ∈ {read, update, remove} */
function rbacRowCondition(model, action, ctx) {
  return schemaMod.getCore().rbacRowCondition(_model(model), action, ctx ?? null);
}

// ── 角色清单与未配置姿态（清单化语义，判决唯一在 core；本层仅透传） ──

function setExemptRoles(roles) {
  return schemaMod.getCore().setExemptRoles(roles);
}

function setDenyWriteRoles(roles) {
  return schemaMod.getCore().setDenyWriteRoles(roles);
}

function setUnconfiguredPolicy(policy) {
  return schemaMod.getCore().setUnconfiguredPolicy(policy);
}

// ─── 自定义错误 ──────────────────────────────────────────────

class PermissionError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'PermissionError';
    this.status = status;
  }
}

/**
 * 上下文缺失错误（fail-secure：require_context 开启 / secureMode 下未注入 ctx）
 *
 * 与 PermissionError 同属权限上下文类（403）：core 抛 `ERR_NO_CONTEXT:` 稳定前缀
 * （见 core `command/mod.rs`），由 `crud/exec._call` 归一为本类型（前缀已剥离）。
 * `code` 与 core machine code 对齐（`no_context`），供皮按枚举判定（禁按文案匹配）。
 */
class NoContextError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'NoContextError';
    this.code = 'no_context';
    this.status = status;
  }
}

module.exports = {
  setContext,
  _als,
  getContext,
  scopedRoles,
  scopedContext,
  runAsInternal,
  canReadSchema,
  canWriteSchema,
  shouldInjectOwnerCondition,
  mergeOwnerCondition,
  getReadableFields,
  getReadableRelations,
  getReadableComputes,
  getWritableFields,
  filterWritableData,
  setRbac,
  rbacEnabled,
  rbacCan,
  rbacReadableFields,
  rbacWritableFields,
  rbacRowCondition,
  setExemptRoles,
  setDenyWriteRoles,
  setUnconfiguredPolicy,
  PermissionError,
  NoContextError,
};
