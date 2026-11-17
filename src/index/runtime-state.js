'use strict';

/**
 * index.js 的模块级可变运行时状态（D4-4 零语义拆分）：`aggregate` opt-in 开关。
 *
 * 开关由 `init`（index.js）写入、由 `store.aggregate`（./tx-defs 方法组）读取；
 * 两处分属不同模块后，经本叶子模块的存取函数现场取值 —— 与拆分前「同一模块级
 * `let` 变量被读写」逐字同语义（单例状态、进程内共享）。
 */

// ── aggregate opt-in 开关（默认关闭；init 第二参显式开启，见 store.aggregate）──
let _allowNativeAggregate = false;

/** 设置 `aggregate` 逃生舱开关（init 调用；仅严格 `=== true` 视为开启） */
function setAllowNativeAggregate(options) {
  _allowNativeAggregate = !!(options && options.allowNativeAggregate === true);
}

/** 读取 `aggregate` 逃生舱开关当前值（store.aggregate 调用） */
function allowNativeAggregate() {
  return _allowNativeAggregate;
}

module.exports = { setAllowNativeAggregate, allowNativeAggregate };
