'use strict';

/**
 * 请求级「选中链路」记录（04 §4.4）—— 只读透传 02 的 `plan.links`，不改 plan 语义。
 *
 * 查询路径拿到 plan 后以 `runWithSelection(plan.links ?? null, () => …)` 包裹执行；
 * 缓存 provider（`provider.js`）经 `currentSelection()` 读取，据此判定本次请求是否
 * 真的由 `role === 'cache'` 链路供数（注记为真的依据）。与 `datasource.js:36`
 * 的 `_txStore` 同法规（AsyncLocalStorage：请求级隔离，免并发串扰）。
 *
 * 未记录（非查询请求 / 02 未启用 / 单库 plan 无 `links`）⇒ `currentSelection()`
 * 返回 `null`，provider 恒 `BYPASS`（安全方向，绝不猜）。
 */

const { AsyncLocalStorage } = require('node:async_hooks');

/** 请求级选中链路：`plan.links` 或 `null` */
const _selectionStore = new AsyncLocalStorage();

/**
 * 在「本次选中链路」作用域内执行 `fn`。
 * @param {object|null} links 02 的 `plan.links`
 *        （`{ "<schema>": [{source, database, schema, role, priority}] }`）；空 ⇒ 记 `null`
 * @param {Function} fn 作用域内执行体（可 async，返回值原样透出）
 * @returns {*} `fn` 的返回值
 */
function runWithSelection(links, fn) {
  return _selectionStore.run(links ?? null, fn);
}

/** 取本次请求的选中链路信息（未记录 ⇒ `null`） */
function currentSelection() {
  return _selectionStore.getStore() ?? null;
}

module.exports = { runWithSelection, currentSelection };
