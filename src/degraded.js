'use strict';

/**
 * 请求级降级容器：按请求记录降级事件，供 `x-store-degraded` 注记与 `degradedStatus()` 读取。
 *
 * 与 cache.js 的本质区别：缓存状态是进程级 provider，降级状态是**按请求**事实，
 * 必须隔离并发请求（禁止全局单例，否则 A 请求的降级会污染 B 请求的响应头）。
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { emit } = require('./feedback');

const _als = new AsyncLocalStorage();

function _statusOf(bucket) {
  if (!bucket || !bucket.events.length) return { degraded: false, events: [] };
  return { degraded: true, events: bucket.events.slice() };
}

/** 在当前请求容器内执行 fn，返回 `{ result, status }`（status 在容器退出前快照） */
async function withRequest(fn) {
  const bucket = { events: [] };
  const result = await _als.run(bucket, fn);
  return { result, status: _statusOf(bucket) };
}

/** 记录一条降级事件：入容器（若有）+ 走统一反馈通道（恒发，允许拦截、禁止静默） */
function record(event) {
  const evt = { ...(event || {}) };
  const bucket = _als.getStore();
  if (bucket) bucket.events.push(evt);
  emit(evt);
}

/** 消费 core 产出的 `plan.degraded`（缺省类型由调用方指定，保持既有文案不变） */
function emitPlan(plan, fallbackType) {
  for (const d of (plan && plan.degraded) || []) {
    record({ ...(d || {}), type: (d && d.type) || fallbackType });
  }
}

/** 当前请求的降级状态（无容器 → 未降级；非 HTTP 调用安全） */
function status() {
  return _statusOf(_als.getStore());
}

/** 产生一条 `vector_degraded` 事件（固定 code / layer，禁调用方改写） */
function vectorDegraded(detail) {
  record({
    type: 'vector_degraded',
    code: 'vectorDegraded',
    layer: 'host',
    backend: detail.backend,
    field: detail.field,
    metric: detail.metric,
    message: detail.message,
    hint: detail.hint,
  });
}

module.exports = { withRequest, record, emitPlan, status, vectorDegraded };
