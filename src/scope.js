'use strict';
const { AsyncLocalStorage } = require('async_hooks');

const _als = new AsyncLocalStorage();
// store = { view: Registry(派生实例), sink: fn|null, meta: {tenant,env}|null, secure: bool|null }

function currentScope() {
  return _als.getStore() ?? null;          // 未进入作用域 → null（调用方回退 base）
}
function currentView() {
  const s = _als.getStore();
  return s ? s.view : null;
}
async function withScope(store, fn) {
  return _als.run(store, fn);              // ALS 传播含 create_task/to_thread 等价路径（V3 五点已证同语义）
}
module.exports = { withScope, currentScope, currentView };
