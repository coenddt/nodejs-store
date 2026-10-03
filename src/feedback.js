'use strict';

/**
 * 反馈事件通道 —— 兜底/降级/拦截触发的统一出口
 *
 * 事件形状（对齐 rust-store 联邦 degraded 契约）::
 *
 *   {type, code, layer, message, hint, ...}
 *     - type  : 事件类别（federation_degraded / sql_pushdown_unsupported ...）
 *     - code  : 机器可读代码（crossSourceSort / pushdownUnsupported ...）
 *     - layer : 命中的防护层（federation / dialect ...）
 *     - message: 人可读描述
 *     - hint  : 修复指引（供上游排查/加固）
 *
 * 默认无 sink 时打 stderr（向后兼容）；宿主可 `setSink(fn)` 接管，
 * 接入自动反馈闭环（允许被拦截，禁止静默失守）。
 */

let _sink = null;

// 进程级 ns 标签（进程级隔离下天然单 ns；由宿主 setMeta 注入）
let _meta = { tenant: '', env: '' };

// 落库失败累计计数（进程级；>0 表示有事件未入表——可观测，不静默）
let _failCount = 0;

// 在途落库 Promise（进程级；graceful shutdown 前经 flush() 收口，消除 fire-and-forget 丢事件窗口 D8）
const _pending = new Set();

/** 注册反馈事件回调 `fn(event)`；传 null/非函数恢复默认 stderr 行为 */
function setSink(fn) {
  _sink = typeof fn === 'function' ? fn : null;
}

/** 当前 sink（无则 null）——供接管方（如 ask 编排器）保存/恢复现场 */
function getSink() {
  return _sink;
}

/** 注入进程级 ns 标签（tenant/env），供落库 sink 附加到事件 */
function setMeta(meta) {
  _meta = { ..._meta, ...(meta || {}) };
}

/** 落库失败累计计数（进程级；>0 表示有事件未入表——可观测，不静默） */
function failCount() {
  return _failCount;
}

function _fail(msg) {
  _failCount += 1;
  console.error(`[nodejs-store][feedback] ${msg}`);
}

/**
 * 一键接线：注册内建 `__feedback` 并把 sink 指向落库；返回 disposer（恢复原 sink）。
 *
 * 落库为异步 fire-and-forget；失败走 stderr + 计数，绝不抛回 `emit`（不破坏主链路）。
 * 未调用本函数时 `emit` 保持原 stderr 行为（不改变默认语义）。
 */
function enableFeedbackTable(store) {
  // 延迟 require：避免 schema ↔ feedback 的加载期循环
  // eslint-disable-next-line global-require
  const metadef = require('./metadef');
  metadef.ensureBuiltins(); // 幂等（含 __feedback）
  const prev = getSink();
  setSink((event) => {
    const row = { ...(event || {}), tenant: _meta.tenant || '', env: _meta.env || '', now: Date.now() };
    // 在途跟踪：panic 前 flush() 可等待；失败仍走 stderr + 计数（不抛回 emit）
    const p = Promise.resolve(metadef._runInternal(() => store.insert('__feedback', row)))
      .catch((e) => {
        _fail(`__feedback 落库失败: ${e && e.message ? e.message : e}`);
      })
      .finally(() => { _pending.delete(p); });
    _pending.add(p);
  });
  // disposer：先恢复原 sink（后续 emit 不再入本库），再等待在途落库收口
  return async () => {
    setSink(prev);
    await flush();
  };
}

/**
 * 等待全部在途 `__feedback` 落库完成（graceful shutdown 前调用）。
 * 落库失败已由 sink 内 catch 计为 failCount（不抛回），故此处永不 reject。
 */
async function flush() {
  while (_pending.size) {
    await Promise.all([..._pending]);
  }
}

/** 产出一条反馈事件：有 sink 回调之；否则打印 stderr（允许拦截，禁止静默） */
function emit(event) {
  const e = event || {};
  if (_sink) {
    _sink(e);
    return;
  }
  console.error(
    `[nodejs-store][${e.layer || '?'}/${e.code || '?'}] `
    + `${e.message || ''}（hint: ${e.hint || '-'}）`,
  );
}

module.exports = { setSink, getSink, emit, setMeta, enableFeedbackTable, failCount, flush };
