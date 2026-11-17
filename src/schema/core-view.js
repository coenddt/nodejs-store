'use strict';

/**
 * core 门面视图（D4-4 零语义拆分自 schema.js）
 *
 * 承载 Rust core 注册表单例与「base / 作用域视图」两个取值入口。
 * 独立成叶子模块：schema.js 与其子模块（mirror / policy）都依赖本模块，
 * 而本模块不依赖它们，加载图为 DAG。
 */

const native = require('../core');
const scope = require('../scope');

/** Rust core 注册表（全项目共享单例） */
const core = new native.Registry();

/**
 * 取当前生效的 core 门面（R2 双端宿主作用域）：作用域内回退到该作用域的派生视图，否则 base。
 *
 *   - 未进入作用域（无 `withScope`）→ 恒等 base `core`（零行为变化，fail-open 姿态不变）；
 *   - 进入作用域 → 返回 `scope.currentView()`（派生 Registry，策略覆盖只作用于本作用域）；
 *   - 视图为只读：写类调用（register/setXxx）由 core 守卫抛 `ERR_POLICY_VIEW_READONLY:`。
 *
 * 禁模块级/跨 await 缓存返回值（03 §7）：每个调用点现场取。
 */
function getCore() {
  return scope.currentView() ?? core;
}

/**
 * 取 base core 门面（恒 base，无视作用域）：协议皮派生视图的唯一合法起点
 * （R2-04 §4.1 `store.baseView()`；皮侧禁自持 `new Registry()`——§7）。
 * 与 `getCore()` 的区别：getCore 作用域内返回派生视图，getBase 恒返回 base。
 */
function getBase() {
  return core;
}

module.exports = { core, getCore, getBase };
