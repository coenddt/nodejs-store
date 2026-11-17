'use strict';

/**
 * 步骤执行器：源预扫 / 跨源告警 / 单步骤执行 / when 分流 / 线性循环（D4-4 零语义拆分自
 * workflow.js）。
 *
 * 执行态打包为单对象 st `{inputMap, ctxMap, trace, dry, routeOverride}`（原六参收敛）。
 * 迹与 defn.steps 一一对应（skipped/wouldRun/ran/failed 均留痕，绝不静默跳过）；
 * 失败抛 `_StepFailure`（带步骤下标）交由 runner 收尾。
 */

const crud = require('../crud');
const { emit: _emitFeedback } = require('../feedback-core');
const { getCore } = require('../schema');
const { _call, sourcesOf: _sourcesOf, runAtomic } = require('../crud/exec');
const { _newIdPool } = require('../crud/id');
const { _StepFailure } = require('./errors');
const { _evalWhen } = require('./when');
const { _resolveTree, _resolveStr } = require('./placeholder');

// ─── 执行器（线性步骤循环 + fail-fast；§2 生命线） ─────────────

/**
 * 预扫全部 mutation 步骤的数据源集合（run 级原子包络依据；plan 是纯函数不执行）。
 * 返回 null = 预扫失败 → 降级裸跑（单步骤内原子，emit 反馈事件，禁静默）。
 * 占位符原样参与规划（plan 只看结构键，不校验占位符字符串值——实测）。
 */
function _prescanSources(defn, routeOverride, now, ctx) {
  const sources = new Set();
  for (const step of defn.steps) {
    if (step.op !== 'mutation') continue;
    try {
      const pool = _newIdPool(step.model, step.data);
      const plan = _call(() => getCore().planMutation(step.model, step.data, now, pool, ctx, routeOverride));
      for (const s of _sourcesOf(plan)) sources.add(s || 'default');
    } catch (e) {
      // 预扫失败降级裸跑（显式声明，禁静默）
      _emitFeedback({
        type: 'workflow_prescan_failed',
        code: 'workflowPrescanFailed',
        layer: 'workflow',
        message: `run 源预扫失败（步骤 model=${step.model}）：${e && e.message ? e.message : e}；`
          + '本 run 降级裸跑（跨步骤非原子，单步骤内仍原子）',
        hint: '检查该 mutation 步骤的 model/结构是否可规划；预扫仅提取数据源，不影响执行',
      });
      return null;
    }
  }
  return sources;
}

/** 多源 run：无法原子 → 程序化声明（允许顺序执行，禁止静默；对齐 non_atomic_write 语义） */
function _warnNonAtomic(sources) {
  const listed = [...sources].sort();
  _emitFeedback({
    type: 'workflow_non_atomic',
    code: 'workflowNonAtomic',
    layer: 'workflow',
    message: `本 run 的写步骤跨 ${listed.length} 个数据源（${listed.join(', ')}）：`
      + '无法原子，按顺序执行（跨步骤非原子）',
    hint: '把写步骤收敛到单一数据源；跨源强一致首批请拆为宿主代码编排',
    sources: listed,
  });
}

/** 执行单步骤（when 已判定通过）：query / mutation / fail */
async function _execStep(step, inputMap, ctxMap, routeOverride, index) {
  const op = step.op;
  if (op === 'query') {
    const params = _resolveTree(step.params ?? null, inputMap, ctxMap, true);
    const rows = await crud.query(step.gql, params, routeOverride);
    if (rows.length > 1) {
      throw new _StepFailure(
        `query 步骤 "${step.as}" 返回 ${rows.length} 行（期望 ≤1：占位符引用要求唯一结果；`
        + '请收紧条件或加 $limit:1）', index);
    }
    return rows.length ? rows[0] : null;
  }
  if (op === 'mutation') {
    const data = _resolveTree(step.data, inputMap, ctxMap, true);
    if (step.upsert) {
      const match = _resolveTree(step.match, inputMap, ctxMap, true);
      return crud.upsert(step.model, match, data, null, routeOverride);
    }
    return crud.mutation(step.model, data, routeOverride);
  }
  // fail：显式业务断言失败（§4.2）——message 支持内嵌占位符丰富错误文案
  throw new _StepFailure(_resolveStr(step.message, inputMap, ctxMap, true), index);
}

/**
 * when 判定段：不满足 → skipped 留痕并返回 false；判定失败 → failed 留痕并抛
 * _StepFailure（带步骤下标）。满足 → true。
 */
function _stepWhenOk(step, i, st) {
  const when = step.when;
  if (when == null) return true;
  const asName = step.as ?? null;
  let ok;
  try {
    ok = _evalWhen(when, st.inputMap, st.ctxMap);
  } catch (e) {
    if (!(e instanceof _StepFailure)) throw e;
    st.trace.push({ as: asName, op: step.op, state: 'failed', error: String(e.message) });
    e.index = i;
    throw e;
  }
  if (!ok) {
    st.trace.push({ as: asName, op: step.op, state: 'skipped' });
    return false;
  }
  return true;
}

/**
 * 执行段（when 已过、dry 已分流）：解析占位符（步骤内）→ 执行 → 结果按 as 入上下文
 * → 迹追加。失败统一转 _StepFailure 留痕后抛出。
 */
async function _execStepEntry(step, i, st, entry) {
  let result;
  try {
    result = await _execStep(step, st.inputMap, st.ctxMap, st.routeOverride, i);
  } catch (e) {
    if (e instanceof _StepFailure) {
      st.trace.push({ ...entry, state: 'failed', error: String(e.message) });
      if (e.index == null) e.index = i;
      throw e;
    }
    const msg = `步骤 ${i}（${step.op}）执行失败: ${e && e.message ? e.message : e}`;
    st.trace.push({ ...entry, state: 'failed', error: msg });
    throw new _StepFailure(msg, i);
  }
  if (entry.as) st.ctxMap[entry.as] = result;
  entry.result = result;
  st.trace.push(entry);
}

/** 单步骤：when 判定 → dry-run 分流 → 执行留痕（skipped/wouldRun/ran/failed 均留痕） */
async function _runOneStep(step, i, st) {
  const asName = step.as ?? null;
  const op = step.op;
  // a. when 判定 → 不满足记 skipped（显式留痕，绝不静默跳过），后续步骤照常
  if (!_stepWhenOk(step, i, st)) return;
  // b. dry-run：mutation / fail 不执行，记 wouldRun（§0.7）
  if (st.dry && (op === 'mutation' || op === 'fail')) {
    st.trace.push({ as: asName, op, state: 'wouldRun' });
    return;
  }
  // c/d. 解析占位符（步骤内）→ 执行 → 结果按 as 入上下文 → 迹追加
  const entry = { as: asName, op, state: 'ran' };
  await _execStepEntry(step, i, st, entry);
}

/**
 * 线性步骤循环：迹与 defn.steps 一一对应（skipped/wouldRun/ran/failed 均留痕）。
 * 失败抛 _StepFailure（带步骤下标）——外层收尾统一落 failed 终态 + 整体回滚。
 * 执行态打包为单对象 st `{inputMap, ctxMap, trace, dry, routeOverride}`（原六参收敛）。
 */
async function _runSteps(defn, st) {
  for (const [i, step] of defn.steps.entries()) {
    await _runOneStep(step, i, st);
  }
}

/** 步骤循环包络：单源 run 整体原子（runAtomic 包住步骤循环）；多源/预扫失败降级裸跑 */
async function _executeAll(d, st, ctx, now) {
  if (st.dry) {
    await _runSteps(d, st);
    return;
  }
  const sources = _prescanSources(d, st.routeOverride, now, ctx);
  if (sources !== null && sources.size === 1) {
    await runAtomic(sources, () => _runSteps(d, st));
    return;
  }
  if (sources !== null && sources.size > 1) _warnNonAtomic(sources);
  await _runSteps(d, st);
}

module.exports = {
  _prescanSources,
  _warnNonAtomic,
  _execStep,
  _stepWhenOk,
  _execStepEntry,
  _runOneStep,
  _runSteps,
  _executeAll,
};
