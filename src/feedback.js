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

/** 注册反馈事件回调 `fn(event)`；传 null/非函数恢复默认 stderr 行为 */
function setSink(fn) {
  _sink = typeof fn === 'function' ? fn : null;
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

module.exports = { setSink, emit };
