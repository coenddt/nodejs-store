'use strict';

/**
 * 反馈事件通道 —— 兜底/降级/拦截触发的统一出口
 *
 * D4-1 解环：emit 状态机（sink/meta/pending）已平移至 `./feedback-core`
 * （零依赖模块）；本文件保留需要 metadef 的 `enableFeedbackTable`（建表 +
 * 落库 sink 接线）并 re-export 公共面——对外 API 与行为与提取前完全一致。
 *
 * 事件形状（对齐 rust-store 联邦 degraded 契约）::
 *
 *   {type, code, layer, message, hint, ...}
 *     - type  : 事件类别（federation_degraded / sql_pushdown_unsupported ...）
 *     - code  : 机器可读代码（crossSourceSort / pushdownUnsupported ...）
 *     - layer : 命中的防护层（federation / dialect ...）
 *     - message: 人可读描述
 *     - hint  : 修复指引（供上游排查/加固）
 */

const core = require('./feedback-core');

/**
 * 一键接线：注册内建 `__feedback` 并把 sink 指向落库；返回 disposer（恢复原 sink）。
 *
 * 落库为异步 fire-and-forget；失败走 stderr + 计数，绝不抛回 `emit`（不破坏主链路）。
 * 未调用本函数时 `emit` 保持原 stderr 行为（不改变默认语义）。
 */
function enableFeedbackTable(store) {
  // 延迟 require：metadef 依赖 schema 等重模块，本模块仅在落库接线时需要它

  const metadef = require('./metadef');
  metadef.ensureBuiltins(); // 幂等（含 __feedback）
  const prev = core.getSink();
  core.setSink((event) => {
    // fields 键空间完全开放、无字段名保留字：事件类别直接落库为 `type` 字段
    const ns = core._currentMeta();
    const row = { ...(event || {}), tenant: ns.tenant || '', env: ns.env || '', now: Date.now() };
    // 在途跟踪：panic 前 flush() 可等待；失败仍走 stderr + 计数（不抛回 emit）
    const p = Promise.resolve(metadef._runInternal(() => store.insert('__feedback', row)))
      .catch((e) => {
        core._fail(`__feedback 落库失败: ${e && e.message ? e.message : e}`);
      })
      .finally(() => { core._untrack(p); });
    core._track(p);
  });
  // disposer：先恢复原 sink（后续 emit 不再入本库），再等待在途落库收口
  return async () => {
    core.setSink(prev);
    await core.flush();
  };
}

module.exports = {
  setSink: core.setSink,
  getSink: core.getSink,
  emit: core.emit,
  setMeta: core.setMeta,
  enableFeedbackTable,
  failCount: core.failCount,
  flush: core.flush,
};
