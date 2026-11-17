'use strict';

/**
 * `Store` 方法组：权限上下文 + RBAC 动态策略 + 角色清单与未配置姿态 + 统一安全模式
 * （D4-4 零语义拆分自 index.js）。
 *
 * 全部为薄转发（判决唯一在 core / secure 模块，本层仅透传）。继承自 ./api-ops：
 * 方法组沿原型链组装为 `Store` 的基类链，供 TS checkJs 解析签名。
 */

const permission = require('../permission');
const schema = require('../schema');
const secure = require('../secure');
const OpsApi = require('./api-ops');

class AccessApi extends OpsApi {
  // ── 权限控制（AsyncLocalStorage 上下文） ──
  setContext(ctx) {
    return permission.setContext(ctx);
  }

  getContext() {
    return permission.getContext();
  }

  scopedRoles(roles, fn) {
    return permission.scopedRoles(roles, fn);
  }

  async runAsInternal(fn) {
    return permission.runAsInternal(fn);
  }

  // ── RBAC 动态策略（判决唯一在 core；本层仅透传配置与查询面） ──
  setRbac(policy) {
    return permission.setRbac(policy);
  }

  rbacEnabled() {
    return permission.rbacEnabled();
  }

  rbacCan(model, action, ctx) {
    return permission.rbacCan(model, action, ctx);
  }

  rbacReadableFields(model, ctx) {
    return permission.rbacReadableFields(model, ctx);
  }

  rbacWritableFields(model, ctx) {
    return permission.rbacWritableFields(model, ctx);
  }

  rbacRowCondition(model, action, ctx) {
    return permission.rbacRowCondition(model, action, ctx);
  }

  // ── 角色清单与未配置姿态（清单化语义，判决唯一在 core；本层仅透传配置） ──
  setExemptRoles(roles) {
    return permission.setExemptRoles(roles);
  }

  setDenyWriteRoles(roles) {
    return permission.setDenyWriteRoles(roles);
  }

  setUnconfiguredPolicy(policy) {
    return permission.setUnconfiguredPolicy(policy);
  }

  /** 定义层门禁策略（判决唯一在 core）：closed 时仅 internal/白名单可注册或覆盖 */
  setMetaPolicy(closed, roles) {
    return schema.setMetaPolicy(closed, roles);
  }

  // ── 统一安全模式（fail-secure 一键入口；见 ./secure） ──
  /**
   * 一键进入 fail-secure：同时翻转「上下文强制 + 未配白名单全拒 + 定义注册门禁」
   * 三个独立开关。`opts.adminRoles` 为允许改定义的角色（默认仅 internal）。
   * 返回 `{ secure: true }`。
   */
  secureMode(opts) {
    return secure.secureMode(opts);
  }

  /** 当前是否经统一入口处于安全模式 */
  isSecure() {
    return secure.isSecure();
  }

  /** 退出安全模式、恢复默认 fail-open（仅供本地脚本/测试） */
  relaxMode() {
    return secure.relaxMode();
  }
}

module.exports = AccessApi;
