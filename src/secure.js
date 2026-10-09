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
 * 边界：core 是进程级单例，本开关同样是进程级；一进程多租户/多安全域的隔离缺口
 * （R2）不在本轮，安全模式下须一租户一进程。
 */

const schema = require('./schema');
const permission = require('./permission');

let _secure = false;

/**
 * 进入 fail-secure 模式（三个开关同时翻转）。
 * @param {{adminRoles?: string[]}} [opts] adminRoles：允许注册/覆盖定义的角色（配合 meta closed；默认仅 internal）
 * @returns {{secure: true}}
 */
function secureMode(opts = {}) {
  const adminRoles = Array.isArray(opts && opts.adminRoles) ? opts.adminRoles : [];
  schema.setRequireContext(true);
  permission.setUnconfiguredPolicy('closed');
  schema.setMetaPolicy(true, adminRoles);
  _secure = true;
  return { secure: true };
}

/**
 * 是否经统一入口处于安全模式。
 * 注意：本标志只反映 secureMode/relaxMode 的统一动作；单独拨动底层开关不改变本值。
 */
function isSecure() {
  return _secure;
}

/**
 * 退出安全模式，恢复 core 默认的 fail-open 姿态（仅供本地脚本/测试；生产环境禁用）。
 * 不重置各 schema 自身声明的读/写白名单——那是定义的一部分。
 * @returns {{secure: false}}
 */
function relaxMode() {
  schema.setRequireContext(false);
  permission.setUnconfiguredPolicy('open');
  schema.setMetaPolicy(false, []);
  _secure = false;
  return { secure: false };
}

module.exports = { secureMode, isSecure, relaxMode };
