'use strict';

/**
 * 三级白名单判定 + py 类型名对齐（D4-4 零语义拆分自 workflow.js）。
 *
 * 判决口径与 core permission.rs::evaluate 同构（doc=Missing 语义），本层只承接宿主侧
 * 的 run/get/list 三处调用。`_pyTypeName` 供占位符求值与 when 比较的错误文案复用
 * （与 py `type(v).__name__` 逐字 parity）。
 */

// ─── 权限：三级白名单判定（§0.6；core permission.rs::evaluate 同构，doc=Missing 语义） ──

/** 类型名对齐 py type(v).__name__（错误文案 parity：NoneType/int/float/str/bool/list/dict） */
function _pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'dict';
  return typeof v;
}

/**
 * 角色白名单评估（与 core permission.rs::evaluate 同构；新建 run 无属主文档 → creator 按 Missing 通过）。
 *
 * - ctx 缺失 / internal：直通放行（与 core 一致，先于名单判定）；
 * - 未配置（null/undefined）：缺省姿态 Open → 放行（core 默认 UnconfiguredPolicy::Open）；
 * - 显式空名单（[]）：按「未配置」处理 → 放行（旧语义；注册期已告警
 *   workflowWhitelistEmptyAsUnconfigured），避免旧定义升级即 403；
 * - 显式拒绝唯一入口是 denyRead（core 新增开关，口径以其为准）；
 * - 无内置角色硬编码：admin/super_admin 必须写进名单才放行（core 已清单化）。
 */
function _evaluate(roleList, ctx) {
  if (ctx == null) return true;
  if (ctx.internal) return true;
  if (roleList === null || roleList === undefined) return true;
  if (roleList.length === 0) return true;
  const roles = ctx.roles || [];
  const effective = roles.length ? roles : [ctx.role];
  return effective.some((r) => roleList.includes(r)) || roleList.includes('creator');
}

/**
 * run 白名单：显式声明优先，否则回退 write（§0.6 旧语义：空名单按未配置处理）
 */
function _runWhitelist(defn) {
  const run = defn.run;
  // JS 空数组是 truthy，必须显式按长度判断「未配置」
  if (run != null && (!Array.isArray(run) || run.length > 0)) return run;
  const write = defn.write;
  return write === undefined ? null : write;
}

module.exports = { _pyTypeName, _evaluate, _runWhitelist };
