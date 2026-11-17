'use strict';

/**
 * schema 策略开关（D4-4 零语义拆分自 schema.js）
 *
 * 承载上下文强制 / 角色豁免 / 拒写 / 未配置姿态 / 定义层门禁 / 查询档位六类
 * 开关的 Host 侧委托入口。判决唯一在 core，本模块只做转发（逐个一行，
 * 与拆分前逐字同语义）。
 */

const { getCore } = require('./core-view');

/**
 * 开关「上下文强制」（默认关闭 = fail-open，与 JS 原版语义一致）。
 *
 * 开启后：所有 plan 入口遇 ctx 缺失抛 `ERR_NO_CONTEXT` 错误（fail-secure）；
 * 内部调用（索引创建、归档回填、后台任务等）须显式传 `{ internal: true }` 上下文。
 */
function setRequireContext(needCtx = true) {
  getCore().setRequireContext(Boolean(needCtx));
}

/** 豁免角色清单（命中者在一切判决环节直接放行）。默认空——无豁免（清单化语义） */
function setExemptRoles(roles) {
  getCore().setExemptRoles(roles);
}

/** 拒写角色清单（命中者一切写路径拒绝，读不受影响）。默认空——无拒写 */
function setDenyWriteRoles(roles) {
  getCore().setDenyWriteRoles(roles);
}

/** schema 白名单缺失/为空时的默认姿态：'open'（默认，放行）| 'closed'（全拒） */
function setUnconfiguredPolicy(policy) {
  getCore().setUnconfiguredPolicy(policy);
}

/**
 * 定义层门禁策略：`closed=true` 时仅 internal 或 `roles` 白名单可注册/覆盖。
 * 判决唯一在 core；默认 Open（`register` 无 ctx 亦放行，保既有兼容）。
 */
function setMetaPolicy(closed, roles) {
  getCore().setMetaPolicy(Boolean(closed), roles);
}

/** 「上下文强制」开关当前值（对齐 py_store.schema.require_context） */
function requireContext() {
  return getCore().requireContext();
}

/**
 * 设置查询档位：`'standard'`（默认，功能最大化 + 跨 DB 对齐）/
 * `'text2query'`（功能收缩 + 硬限制）
 *
 * 判决唯一在 core；未知档位由 core 抛错（禁静默回落到默认档）。
 */
function setProfile(profile) {
  getCore().setProfile(profile);
}

/** 当前档位字符串（`'standard'` / `'text2query'`；对齐 py_store.schema.get_profile） */
function getProfile() {
  return getCore().profile();
}

module.exports = {
  setRequireContext,
  requireContext,
  setExemptRoles,
  setDenyWriteRoles,
  setUnconfiguredPolicy,
  setMetaPolicy,
  setProfile,
  getProfile,
};
