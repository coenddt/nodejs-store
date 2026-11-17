'use strict';

/**
 * run 生命周期：权限裁决 → running 落库 → 步骤循环 → 终态收尾（D4-4 零语义拆分自
 * workflow.js）。
 *
 * run 记录时序（§2 生命线）：先落 running（独立提交，进程崩溃可见）→ 步骤事务 →
 * 收尾 update 终态（事务外独立提交——业务回滚不影响失败 run 可查，铁律 B）。
 * 审计通道身份与触发者权限解耦：模块内部写入走干净 internal 上下文（见 _runInternal）。
 */

const crud = require('../crud');
const { getContext, _als } = require('../permission');
const { requireContext: _requireContext } = require('../schema');
const { _BUILTIN_NAME, ensureBuiltin } = require('./builtin');
const { _StepFailure } = require('./errors');
const { _evaluate, _runWhitelist } = require('./permission-eval');
const { _executeAll } = require('./steps');
const { _workflows } = require('./registry');

/**
 * 干净 internal 上下文（{internal: true}，丢弃触发者 roles）
 *
 * 不用 permission.runAsInternal：它保留原 roles，而 core 对 guest **硬拒写**先于
 * internal 放行（permission.rs::can_write_schema）——guest 触发的 rejected 落库会
 * 被自己的 guest 角色挡住。审计通道的身份必须与触发者权限解耦。
 */
async function _runInternal(fn) {
  return _als.run({ internal: true }, fn);
}

/** run 记录写入（internal 上下文——__workflowRun write 显式空名单仅放行 internal/admin） */
async function _persistWrite(doc) {
  return _runInternal(() => crud.mutation(_BUILTIN_NAME, doc));
}

/** run 记录收尾更新（事务外独立提交：业务事务回滚不影响失败 run 可查——铁律 B） */
async function _persistUpdate(rid, patch) {
  return _runInternal(() => crud.update(_BUILTIN_NAME, { _id: rid }, patch));
}

/** 内存 run 文档补落库元数据（_id / createdAt / updatedAt） */
function _withMeta(runDoc, saved) {
  return {
    ...runDoc,
    _id: saved ? saved._id ?? null : null,
    createdAt: saved ? saved.createdAt ?? null : null,
    updatedAt: saved ? saved.updatedAt ?? null : null,
  };
}

/** 权限判定（§0.6）：fail-secure 优先于 dry-run——null = 放行，否则为 rejected 文案 */
function _rejectReason(d, ctx) {
  if (_requireContext() && ctx == null) {
    return 'ERR_NO_CONTEXT: 上下文强制开启，无 ctx 拒跑（fail-secure 优先于 dry-run）';
  }
  if (!_evaluate(_runWhitelist(d), ctx)) {
    return `run 白名单拦截: 触发者角色不在 run 白名单内（${JSON.stringify(_runWhitelist(d) || [])}）`;
  }
  return null;
}

/** run 记录落库 running 并取 rid（先于步骤：中断可观测） */
async function _startRunning(runDoc) {
  const saved = await _persistWrite(runDoc);
  return { saved, rid: saved ? saved._id ?? null : null };
}

/** 步骤循环 + 终态归集：_StepFailure → failed/dryFailed 留痕；编程错误照常抛 */
async function _runAndSettle(d, st, ctx, now, dry) {
  let status = dry ? 'drySucceeded' : 'succeeded';
  let error = null;
  let stepIndex = null;
  try {
    await _executeAll(d, st, ctx, now);
  } catch (e) {
    if (!(e instanceof _StepFailure)) throw e;
    status = dry ? 'dryFailed' : 'failed';
    error = String(e.message);
    stepIndex = e.index;
  }
  return { status, error, stepIndex };
}

/** run 入参形态校验（编程错误照常抛 TypeError，不入 run 终态） */
function _checkRunInput(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError(`run(name, input) 的 input 须为 dict，收到 ${typeof input}`);
  }
}

/**
 * 触发工作流 → 完整 run 文档（§3）
 *
 * 统一契约：执行期一切业务失败（步骤 Err / fail 步骤 / 权限拒绝）都表达为 run 终态
 * （failed / rejected）+ error 字段返回，不抛异常；编程错误（未注册 / input 非法 /
 * defn 校验失败）照常抛错。dry-run 下 query 真实执行（只读安全），mutation/fail 记
 * wouldRun。跨步骤原子性：单源 run 整体原子（N1 实测可行——外层 runAtomic 包住整个
 * 步骤循环，内层 mutation 嵌套并入）；多源 / 预扫失败按顺序执行并发反馈事件（禁静默）。
 * run 记录时序（§2 生命线）：先落 running（独立提交，进程崩溃可见）→ 步骤事务 →
 * 收尾 update 终态（事务外独立提交——业务回滚不影响失败 run 可查，铁律 B）。
 */
async function run(name, input = null, { dryRun = false, routeOverride = null } = {}) {
  ensureBuiltin();
  const d = _workflows.get(name);
  if (!d) throw new Error(`Workflow 未注册: ${name}`);
  _checkRunInput(input);
  const inp = { ...(input || {}) };
  const ctx = getContext() ?? null;
  const now = Date.now();
  const dry = Boolean(dryRun);

  const runDoc = {
    workflow: name, status: 'running', input: inp, steps: [],
    error: null, stepIndex: null, dryRun: dry, now,
  };

  // 1. 权限（§0.6）：fail-secure 优先于 dry-run（N3 实测裁决）——require_context 开启
  //    且无 ctx → rejected 拒跑；run 白名单外 → rejected（落库可审计，一次落终态）
  const rejected = _rejectReason(d, ctx);
  if (rejected !== null) {
    runDoc.status = 'rejected';
    runDoc.error = rejected;
    const saved = await _persistWrite(runDoc);
    return _withMeta(runDoc, saved);
  }

  // 2. 状态落库 running（先于步骤：中断可观测）
  const { saved, rid } = await _startRunning(runDoc);

  // 3/4. 步骤循环（单源时整体原子；失败 _StepFailure 冒泡出事务 → 整体回滚）
  //      + 终态归集，收尾 update 事务外独立提交
  const st = {
    inputMap: inp, ctxMap: Object.create(null), trace: runDoc.steps,
    dry, routeOverride,
  };
  const { status, error, stepIndex } = await _runAndSettle(d, st, ctx, now, dry);
  runDoc.status = status;
  runDoc.error = error;
  runDoc.stepIndex = stepIndex;
  await _persistUpdate(rid, { status, steps: st.trace, error, stepIndex });
  return _withMeta(runDoc, saved);
}

module.exports = {
  _runInternal,
  _persistWrite,
  _persistUpdate,
  _withMeta,
  _rejectReason,
  _startRunning,
  _runAndSettle,
  _checkRunInput,
  run,
};
