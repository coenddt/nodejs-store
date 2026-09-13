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

const { core } = require('./schema');

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
  return core.canRead(_model(schema), ctx ?? null);
}

function canWriteSchema(schema, ctx) {
  return core.canWrite(_model(schema), ctx ?? null);
}

function shouldInjectOwnerCondition(schema, ctx) {
  return core.shouldInjectOwner(_model(schema), ctx ?? null);
}

function mergeOwnerCondition(schema, ctx, condition) {
  const out = core.mergeOwnerCondition(_model(schema), ctx ?? null, condition ?? null);
  // core 在「不注入」时返回 null（无法区分原条件为 null）→ 原样返回入参条件
  return out === null || out === undefined ? condition : out;
}

function getReadableFields(schema, ctx) {
  return core.readableFields(_model(schema), ctx ?? null);
}

function getReadableRelations(schema, ctx) {
  return core.readableRelations(_model(schema), ctx ?? null);
}

function getWritableFields(schema, ctx) {
  return core.writableFields(_model(schema), ctx ?? null);
}

function filterWritableData(schema, ctx, data) {
  return core.filterWritableData(_model(schema), ctx ?? null, data);
}

// ─── 自定义错误 ──────────────────────────────────────────────

class PermissionError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'PermissionError';
    this.status = status;
  }
}

module.exports = {
  setContext,
  getContext,
  scopedRoles,
  runAsInternal,
  canReadSchema,
  canWriteSchema,
  shouldInjectOwnerCondition,
  mergeOwnerCondition,
  getReadableFields,
  getReadableRelations,
  getWritableFields,
  filterWritableData,
  PermissionError,
};
