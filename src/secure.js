'use strict';

/**
 * 统一安全模式（fail-secure 一键入口）
 *
 * 背景：core 的 fail-secure 姿态由三个互相独立的开关拼成——
 *   1. require_context：无 ctx 的读/写一律拒绝（堵「没传上下文 = 系统调用」）；
 *   2. unconfigured policy = closed：schema 未配读/写白名单时默认全拒
 *      （堵「没配权限 = 全开」）；
 *   3. meta policy = closed：注册/覆盖定义须过门禁
 *      （堵运行期未授权改 schema/workflow 定义）。
 * 分开配置极易漏配，任何一个漏配都会留下口子；secureMode 一次翻转三个，消除碎片化。
 *
 * R2（03 §4.3）：作用域内**并视图**——三开关叠加为派生视图并更新本作用域
 * （`scope.view` + `scope.secure`），只作用于该作用域，不影响 base 与其它作用域；
 * 未进入作用域时保持既有 base 路径（三开关原样翻转 + 进程级 `_secure` 标志）。
 * 边界：base 路径的 core 是进程级单例，故进程级标志只反映 base 姿态。
 */

const schema = require('./schema');
const permission = require('./permission');
const { currentScope } = require('./scope');

let _secure = false;

/**
 * 三开关的策略覆盖对象。
 *
 * 键名以 01 号文档 §4.3 `PolicyOverrides` JSON 契约为准（camelCase）：
 * `unconfigured` 是 `roleRules` 的**子键**（非顶层）——写成顶层会被 core
 * 报 `ERR_POLICY_VIEW_READONLY: 未知策略覆盖键`（03 §8.2 的键名核对）。
 */
function _secureOverrides(adminRoles) {
  return {
    requireContext: true,
    roleRules: { unconfigured: 'closed' },
    metaPolicy: { closed: true, roles: adminRoles },
  };
}

/**
 * 进入 fail-secure 模式（三个开关同时翻转）。
 * @param {{adminRoles?: string[]}} [opts] adminRoles：允许注册/覆盖定义的角色（配合 meta closed；默认仅 internal）
 * @returns {{secure: true}}
 */
function secureMode(opts = {}) {
  const adminRoles = Array.isArray(opts && opts.adminRoles) ? opts.adminRoles : [];
  const s = currentScope();
  if (s) {
    // 作用域内：派生叠加视图并更新本作用域（视图只读守卫拦的是注册/清空，非策略叠加）
    s.view = s.view.withPolicy(_secureOverrides(adminRoles));
    s.secure = true;
    return { secure: true };
  }
  schema.getCore().setRequireContext(true);
  permission.setUnconfiguredPolicy('closed');
  schema.getCore().setMetaPolicy(true, adminRoles);
  _secure = true;
  return { secure: true };
}

/**
 * 是否经统一入口处于安全模式。
 * 作用域内取本作用域标志（`true` = 本作用域已并视图）；域外回退进程级 base 标志。
 * 注意：本标志只反映 secureMode/relaxMode 的统一动作；单独拨动底层开关不改变本值。
 */
function isSecure() {
  return currentScope()?.secure ?? _secure;
}

/**
 * 退出安全模式，恢复 core 默认的 fail-open 姿态（仅供本地脚本/测试；生产环境禁用）。
 * 不重置各 schema 自身声明的读/写白名单——那是定义的一部分。
 *
 * 作用域内与 base 路径同构双向：把三开关显式覆盖回 fail-open 默认值（派生新视图，
 * 仅影响本作用域），并撤本作用域标志；域外仍走既有进程级路径。
 * @returns {{secure: false}}
 */
function relaxMode() {
  const s = currentScope();
  if (s) {
    s.view = s.view.withPolicy({
      requireContext: false,
      roleRules: { unconfigured: 'open' },
      metaPolicy: { closed: false, roles: [] },
    });
    s.secure = false;
    return { secure: false };
  }
  schema.getCore().setRequireContext(false);
  permission.setUnconfiguredPolicy('open');
  schema.getCore().setMetaPolicy(false, []);
  _secure = false;
  return { secure: false };
}

module.exports = { secureMode, isSecure, relaxMode };
