'use strict';

/**
 * 工作流注册表（进程内 Map；D4-4 零语义拆分自 workflow.js）。
 *
 * `_workflows` 必须是**唯一实例**：执行器直读它（`run` 按 name 取 defn）、测试与 parity 锚
 * 直接对它做 delete/has。故本模块持有它并由门面原样导出（同一引用，不复制）。
 *
 * 注册语义：注册即静态校验（validateDefn → validatePlanable），白名单外显式 Err；
 * 同名同形重复注册幂等通过（场景 harness 每后端复跑同一批用例须可重入），同名异形禁止覆盖。
 */

const { getCore } = require('../schema');
const { getContext } = require('../permission');
const { WorkflowError } = require('./errors');
const { _evaluate } = require('./permission-eval');
const { validateDefn } = require('./validate');
const { validatePlanable } = require('./planable');

// ─── 注册表 ──────────────────────────────────────────────────

const _workflows = new Map();

/** 注册工作流定义（注册即静态校验，白名单外显式 Err；name 全局唯一）。
 *
 * `ctx`：可选定义层门禁上下文（`{internal: true}` / `{roles: [...]}`）。判决唯一在 core
 * （`getCore().canRegister`，与 schema.register 同一 MetaPolicy）；默认 Open → 全放行。
 * Closed 且 ctx 不过 → 抛 `ERR_PERMISSION:`（定义不写入）。
 *
 * 同名同形重复注册幂等通过（对齐 core schema.register 的复跑语义——场景 harness
 * 每后端复跑同一批用例时必须可重入）；同名异形显式 Err（禁止静默覆盖已注册定义）。
 */
function register(defn, ctx) {
  // 定义层门禁：判决先于静态校验（拒绝即返回，零副作用；与 schema.register_with_ctx 同序）
  if (!getCore().canRegister(ctx ?? null)) {
    const name = defn && defn.name ? defn.name : '';
    throw new WorkflowError(`ERR_PERMISSION: 无权注册或覆盖工作流定义 ${name}`);
  }
  const errors = validateDefn(defn);
  if (errors.length) throw new WorkflowError(`WORKFLOW_UNSUPPORTED: ${errors.join('；')}`);
  // B1：注册期「只校验不绑参」可规划性（结构 + 参数键完整）；独立于纯函数 validateDefn
  const planErrors = validatePlanable(defn);
  if (planErrors.length) {
    throw new WorkflowError(`WORKFLOW_UNSUPPORTED: ${planErrors.join('；')}`);
  }
  const name = defn.name;
  if (_workflows.has(name)) {
    if (_workflows.get(name) === defn) return defn;
    throw new WorkflowError(
      `WORKFLOW_UNSUPPORTED: Workflow 已注册且定义不同，禁止覆盖: ${name}`);
  }
  _workflows.set(name, defn);
  return defn;
}

/** 按名取 defn（read 白名单过滤；denyRead 显式拒绝优先；不可见与不存在同形——防枚举） */
function get(name, ctx = undefined) {
  const d = _workflows.get(name);
  if (!d) throw new Error(`Workflow 未注册: ${name}`);
  const c = ctx === undefined ? getContext() ?? null : ctx;
  if (d.denyRead === true || !_evaluate(d.read ?? null, c)) throw new Error(`Workflow 未注册: ${name}`);
  return d;
}

/** 全部可见工作流名（read 白名单过滤） */
function list(ctx = undefined) {
  const c = ctx === undefined ? getContext() ?? null : ctx;
  return [..._workflows.values()]
    .filter((d) => d.denyRead !== true && _evaluate(d.read ?? null, c))
    .map((d) => d.name);
}

module.exports = { _workflows, register, get, list };
