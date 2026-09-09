'use strict';

/**
 * 权限引擎 — AsyncLocalStorage 上下文 + 角色评估 + 字段过滤
 *
 * 角色清单（共 9 种）:
 *   super_admin / admin / internal  ← 自动放行，无所不能
 *   seller / user / verified / buyer ← 大部分公共模型默认开放
 *   court ← TBD
 *   guest ← 默认禁止
 *   creator 是伪角色，由 evaluate() 根据 doc.createdBy === ctx.userId 动态判断
 *
 * 权限规则:
 *   - read/write 不配置 → 所有已登录角色默认可读/可写（guest 除外）
 *   - 无上下文时 evaluate() 返回 true（权限检查禁用，向后兼容）
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const _als = new AsyncLocalStorage();

/** doc 缺省哨兵：区分「新插入」与「查询无结果」 */
const _MISSING = Symbol('mongo-store-missing');

/** 设置当前请求的上下文，每次请求开始时调用一次 */
function setContext(ctx) {
  _als.enterWith(ctx);
}

/** 获取当前请求的上下文，无则 undefined */
function getContext() {
  return _als.getStore();
}

// ─── 权限评估核心 ─────────────────────────────────────────────

/**
 * 评估当前用户是否满足指定角色白名单
 *
 * doc 语义（用于 creator 伪角色）:
 *   _MISSING → 新插入（无已有文档，creator 自动通过）
 *   null     → 查询无结果（creator 不通过）
 *   object   → 已有文档
 */
function evaluate(ctx, roleList, doc = _MISSING) {
  // 无角色白名单 = schema/字段无权限配置 → 按角色取默认行为
  if (!roleList || roleList.length === 0) {
    if (ctx == null) return true;
    if (ctx.internal) return true;
    return !(ctx.roles || []).includes('guest');
  }

  if (ctx == null) return true;
  if (ctx.internal) return true;

  // super_admin / admin 自动放行
  const roles = ctx.roles || [];
  if (roles.includes('super_admin') || roles.includes('admin')) return true;

  // ① 角色匹配
  const effectiveRoles = roles.length ? roles : [ctx.role];
  for (const r of roleList) {
    if (effectiveRoles.includes(r)) return true;
  }

  // ② 创作者匹配
  return _matchCreator(ctx, doc, roleList);
}

/** 创作者伪角色匹配（doc 语义见 evaluate 文档） */
function _matchCreator(ctx, doc, roleList) {
  if (!roleList.includes('creator')) return false;
  if (doc === _MISSING) return true;
  return !!(doc && ctx.userId && doc.createdBy === ctx.userId);
}

// ─── Schema 级检查 ────────────────────────────────────────────

function canReadSchema(schema, ctx) {
  return evaluate(ctx, schema.read);
}

/** 游客无论 schema.write 如何配置，均无写入权限 */
function canWriteSchema(schema, ctx) {
  if (ctx && (ctx.roles || []).includes('guest')) return false;
  return evaluate(ctx, schema.write);
}

// ─── 所有者条件注入 ──────────────────────────────────────────

function shouldInjectOwnerCondition(schema, ctx) {
  if (!ctx || !ctx.userId) return false;
  if (ctx.internal) return false;
  const roles = ctx.roles || [];
  if (roles.includes('super_admin') || roles.includes('admin')) return false;
  const effectiveRoles = roles.length ? roles : [ctx.role];
  const read = schema.read;
  if (read) {
    const realRoles = read.filter((r) => r !== 'creator');
    if (realRoles.some((r) => effectiveRoles.includes(r))) return false;
  }
  return !!(read && read.includes('creator'));
}

function mergeOwnerCondition(schema, ctx, condition) {
  if (!shouldInjectOwnerCondition(schema, ctx)) return condition;
  const ownerCondition = { createdBy: ctx.userId };
  if (!condition) return ownerCondition;
  return { $and: [condition, ownerCondition] };
}

// ─── 字段级过滤（读） ─────────────────────────────────────────

function getReadableFields(schema, ctx) {
  if (ctx == null) return null;
  const allowed = new Set();
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.read) {
      if (evaluate(ctx, field.read)) allowed.add(key);
    } else {
      allowed.add(key);
    }
  }
  return allowed;
}

function getReadableComputes(schema, ctx) {
  if (ctx == null) return null;
  const allowed = new Set();
  for (const [key, comp] of Object.entries(schema.computes || {})) {
    if (comp.read) {
      if (evaluate(ctx, comp.read)) allowed.add(key);
    } else {
      allowed.add(key);
    }
  }
  return allowed;
}

function getReadableRelations(schema, ctx) {
  if (ctx == null) return null;
  const allowed = new Set();
  for (const [key, rel] of Object.entries(schema.relations || {})) {
    if (rel.read) {
      if (evaluate(ctx, rel.read)) allowed.add(key);
    } else {
      allowed.add(key);
    }
  }
  return allowed;
}

// ─── 字段级过滤（写） ─────────────────────────────────────────

function getWritableFields(schema, ctx) {
  if (ctx == null) return null;
  const allowed = new Set();
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.write) {
      if (evaluate(ctx, field.write)) allowed.add(key);
    } else if (canWriteSchema(schema, ctx)) {
      allowed.add(key);
    }
  }
  return allowed;
}

/** 过滤写入数据：只保留当前用户可写的字段 */
function filterWritableData(schema, ctx, data) {
  if (ctx == null) return data;
  const writable = getWritableFields(schema, ctx);
  if (writable === null) return data;
  const result = {};
  for (const key of Object.keys(data)) {
    // 支持点号嵌套路径，按 root 字段检查写权限
    const root = key.includes('.') ? key.split('.', 1)[0] : key;
    if (writable.has(root)) result[key] = data[key];
  }
  return result;
}

// ─── 内部上下文执行 ──────────────────────────────────────────

/**
 * 以指定角色进入临时权限上下文（嵌套安全），执行 fn 后自动恢复原上下文。
 *
 * 与 runAsInternal 同构，供 AI 查询执行等显式角色注入场景使用，
 * 取代 setContext + finally setContext(null) 的清空式写法（后者嵌套时会误清外层上下文，
 * 且「无上下文 = 权限全放行」，清空即静默失守方向）。
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

// ─── 自定义错误 ──────────────────────────────────────────────

class PermissionError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'PermissionError';
    this.status = status;
  }
}

module.exports = {
  _MISSING,
  setContext,
  getContext,
  evaluate,
  canReadSchema,
  canWriteSchema,
  shouldInjectOwnerCondition,
  mergeOwnerCondition,
  getReadableFields,
  getReadableComputes,
  getReadableRelations,
  getWritableFields,
  filterWritableData,
  scopedRoles,
  runAsInternal,
  PermissionError,
};
