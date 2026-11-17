'use strict';

/**
 * 注册期「只校验不绑参」可规划性校验（D4-4 零语义拆分自 workflow.js）。
 *
 * 与 validateDefn（纯函数、只做结构白名单）分职：本模块需要 core 注册表（buildPipeline），
 * 故独立、不入 validateDefn。纯内存、无 IO、无参数值绑定。
 */

const { getCore } = require('../schema');

// ─── 可规划性（结构 + 参数键完整） ─────────────────────────────

/**
 * 注册期「只校验不绑参」可规划性校验 → 错误列表（空 = 通过）。纯内存、无 IO、无参数值绑定。
 *
 * ① 结构性可规划：对每个 query 步骤的 gql，调用 core 规划门面 `getCore().buildPipeline(gql, {}, null)`
 *    （params 传 {} = 不绑参；ctx 传 null = 不引入调用点上下文）。parse / model / 关系 /
 *    `$pipeline` / 递归深度任一不可规划 → core 抛错，此处汇聚成注册期错误。
 * ② 参数键完整：返回体 `ast` 暴露 `params`（槽位→@key，含嵌套关系，见 core `pipeline/ast.rs`）；
 *    gql 引用的每个 `@key` 须在 step.params 顶层存在——缺键在运行期会被静默丢弃（条件失效）。
 *
 * 与 `validateDefn`（纯函数、只做结构白名单）分职：本函数需要 core 注册表，故独立、不入 validateDefn。
 */
/** 对象分支：收集本层 `params` 槽位键（去掉前导 at 符）+ 递归下钻全部值 */
function _collectParamKeysObj(v, out) {
  const p = v.params;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    // core `ast.params` 的值为 `@key` 形态（含前导 @，实测 core parse.rs 保留 ref 原值）；
    // 归一化去掉前导 @，使错误文案为 `@c0` 而非 `@@c0`。
    for (const k of Object.values(p)) {
      if (typeof k === 'string' && k) out.add(k.startsWith('@') ? k.slice(1) : k);
    }
  }
  Object.values(v).forEach((x) => _collectParamKeys(x, out));
}

function _collectParamKeys(v, out = new Set()) {
  if (Array.isArray(v)) {
    v.forEach((x) => _collectParamKeys(x, out));
    return out;
  }
  if (v && typeof v === 'object') _collectParamKeysObj(v, out);
  return out;
}

/** 参数键完备检查：gql 引用的每个 @key 须在 step.params 顶层存在（缺键运行期被静默丢弃） */
function _planableParams(step, where, built, errors) {
  const p = step.params;
  const provided = new Set(
    p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p) : [],
  );
  for (const key of [..._collectParamKeys(built && built.ast)].sort()) {
    if (!provided.has(key)) {
      errors.push(`${where}: gql 引用了未提供的参数 @${key}（params 须提供该键）`);
    }
  }
}

/** 单个 query 步骤：buildPipeline 可规划 + 参数键完备 */
function _planableStep(step, i, errors) {
  if (!step || step.op !== 'query' || typeof step.gql !== 'string') return;
  const where = `steps[${i}]`;
  let built;
  try {
    built = getCore().buildPipeline(step.gql, {}, null);
  } catch (e) {
    errors.push(`${where}: gql 不可规划: ${e && e.message ? e.message : String(e)}`);
    return;
  }
  _planableParams(step, where, built, errors);
}

function validatePlanable(defn) {
  const errors = [];
  const steps = defn && Array.isArray(defn.steps) ? defn.steps : null;
  if (!steps) return errors;
  steps.forEach((step, i) => _planableStep(step, i, errors));
  return errors;
}

module.exports = {
  _collectParamKeysObj,
  _collectParamKeys,
  _planableParams,
  _planableStep,
  validatePlanable,
};
