'use strict';

/**
 * 步骤执行与断言（D4-4 零语义拆分自 harness-lib.js）。
 *
 * `runStep` 按 op 分派到 store 门面（两场景并集，统一把异常捕获为「显式报错」证据）；
 * `assertStep` 按 expect.kind 分流到 error/feedback/unsupported/run/结果类断言。
 * 与后端无关、无文件 IO——仅依赖 store/permission/workflow 门面与 oracle 归一函数。
 * 语义说明见 harness-lib.js 模块头「零语义说明」段（op 并集与断言分支逐行核对结论不变）。
 */

const { store, permission, workflow } = require('../../src');
const { normRows, deepEq, isSqlBackend } = require('./harness-oracle');

function _codes(events) {
  return (events || []).map((e) => e && e.code);
}

// op → 执行器 `(h, step)` → 结果（两场景 op 分派并集）。await 统一包裹，
// 同步分支（set_ctx / register_workflow / set_flag）结果原样返回，语义不变。
const _STEP_OPS = Object.assign(Object.create(null), {
  query: (h, step) => h.store.query(step.gql, step.params ?? null),
  query_one: (h, step) => h.store.queryOne(step.gql, step.params ?? null),
  query_with_count: (h, step) => h.store.queryWithCount(step.gql, step.params ?? null),
  query_federated: (h, step) => h.store.queryFederated(step.gql, step.params ?? null),
  count: (h, step) => h.store.count(step.schema, step.filter ?? null),
  exists: (h, step) => h.store.exists(step.schema, step.condition),
  insert: (h, step) => h.store.insert(step.schema, step.data),
  insert_many: (h, step) => h.store.insertMany(step.schema, step.rows),
  update: (h, step) => h.store.update(step.schema, step.condition, step.data),
  update_many: (h, step) => h.store.updateMany(step.schema, step.condition, step.data),
  remove: (h, step) => h.store.remove(step.schema, step.condition),
  upsert: (h, step) => h.store.upsert(step.schema, step.condition, step.data),
  mutation: (h, step) => h.store.mutation(step.schema, step.data),
  set_ctx: (h, step) => (permission.setContext(step.ctx ?? null), null),
  register_workflow: (h, step) => workflow.register(step.defn),
  run_workflow: (h, step) => store.runWorkflow(step.name, step.input ?? null,
    { dryRun: Boolean(step.dryRun) }),
  set_flag: (h, step) => _setFlag(step.name, step.value),
});

/** 执行单个 op（两场景 op 分派并集），返回 `{ result, error, events }` */
async function runStep(h, step) {
  const before = h.eventsAll.length;
  let error = null;
  let result = null;
  try {
    const dispatch = _STEP_OPS[step.op];
    if (!dispatch) throw new Error(`未知 op: ${step.op}`);
    result = await dispatch(h, step);
  } catch (e) {
    error = e; // 统一捕获作为「显式报错」证据
  }
  const events = h.eventsAll.slice(before);
  return { result, error, events };
}

function _setFlag(name, value) {
  if (name === 'require_context') return store.setRequireContext(value);
  throw new Error(`未知开关 ${name}`);
}

function _matchError(err, expect) {
  const code = expect.code;
  const permErr = err instanceof store.PermissionError;
  if (code) {
    if (code === 'ERR_PERMISSION' && permErr) return true;
    if (permErr && expect.status) return err.status === expect.status;
    return String(err.message || err).includes(code);
  }
  return true;
}

/** error 断言：须抛错且命中 expect.code / PermissionError 状态 */
function _assertError(err, expect) {
  if (err === null || err === undefined) return { ok: false, note: '期望抛错但未抛错' };
  return { ok: _matchError(err, expect), note: `实际错误: ${err.message || err}` };
}

/** feedback 断言：事件 codes 含 expect.code */
function _assertFeedback(events, expect) {
  const codes = _codes(events);
  return { ok: codes.includes(expect.code), note: `事件 codes: ${JSON.stringify(codes)}` };
}

/** unsupported 断言（仅 SQL 侧）：不可翻译须显式（err 或事件告警），禁静默返回结果 */
function _assertUnsupported(isSql, err, events) {
  if (!isSql) return { ok: true, note: 'mongo 基准支持' };
  const codes = _codes(events).filter(Boolean);
  if ((err !== null && err !== undefined) || codes.length) {
    return { ok: true, note: `显式(err=${err ? err.name : null}, events=${JSON.stringify(codes)})` };
  }
  return { ok: false, note: '不可翻译却静默返回了结果（既无错误也无告警）' };
}

/** run 期望键逐项对比（error → stepIndex → stepStates，短路顺序与原版一致）：差异返回 note，全过返回 null */
function _runFieldDiff(r, expect) {
  if ('error' in expect && r.error !== expect.error) {
    return `error=${JSON.stringify(r.error)} 期望 ${JSON.stringify(expect.error)}`;
  }
  if ('stepIndex' in expect && r.stepIndex !== expect.stepIndex) {
    return `stepIndex=${r.stepIndex} 期望 ${expect.stepIndex}`;
  }
  const states = (r.steps || []).map((st) => st.state);
  if ('stepStates' in expect && JSON.stringify(states) !== JSON.stringify(expect.stepStates)) {
    return `stepStates=${JSON.stringify(states)} 期望 ${JSON.stringify(expect.stepStates)}`;
  }
  return null;
}

/** run 文档断言：runWorkflow 统一契约不抛错；error 键显式存在时严格相等
 * （含 null——no-error-masking §二：成功态 error 必须为 null 的正向断言） */
function _assertRun(h, expect, err) {
  if (err !== null && err !== undefined) {
    return { ok: false, note: `run_workflow 不应抛错（统一契约），实际: ${err.message || err}` };
  }
  const r = h.result || {};
  if (r.status !== expect.status) {
    return { ok: false, note: `status=${r.status} 期望 ${expect.status}（error=${JSON.stringify(r.error)}）` };
  }
  const diff = _runFieldDiff(r, expect);
  if (diff !== null) return { ok: false, note: diff };
  const states = (r.steps || []).map((st) => st.state);
  return { ok: true, note: `run=${r.status} states=${JSON.stringify(states)}` };
}

/** inserted：_id 前缀匹配 + 可选时间戳存在性 */
function _assertInserted(h, expect) {
  let ok = Boolean(h.result) && String(h.result._id || '').startsWith(expect.idPrefix);
  if (expect.hasTimestamps) {
    ok = ok && typeof h.result.createdAt === 'number' && h.result.createdAt > 0;
  }
  return { ok, note: `insert 结果: ${JSON.stringify(h.result)}` };
}

/** 标量结果断言：count / exists / inserted / updated / removed */
function _assertScalar(kind, h, expect) {
  if (kind === 'count') {
    return { ok: h.result === expect.value, note: `count=${h.result} 期望 ${expect.value}` };
  }
  if (kind === 'exists') {
    return { ok: Boolean(h.result) === Boolean(expect.value), note: `exists=${h.result}` };
  }
  if (kind === 'inserted') return _assertInserted(h, expect);
  if (kind === 'updated') {
    const val = (h.result || {}).modifiedCount;
    const exp = expect.modifiedCount;
    return { ok: exp === undefined || exp === null ? true : val === exp, note: `modifiedCount=${val}` };
  }
  const r = h.result || {};
  return {
    ok: r.deletedCount === expect.deletedCount && r.archivedCount === expect.archivedCount,
    note: `remove 结果: ${JSON.stringify(r)}`,
  };
}

/** rows（含分页）：与 expect.rows 或 mongo oracle 比对 */
function _assertRows(h, expect, oracleRows, isSql) {
  let expected = expect.rows;
  if (expected === undefined || expected === null) {
    expected = oracleRows;
    if ((expected === undefined || expected === null) && isSql) {
      return { ok: false, note: '缺少期望行集且无 mongo oracle' };
    }
  }
  if ((expected === undefined || expected === null) && !isSql) {
    return { ok: true, note: 'mongo 基准（无显式期望，仅作 oracle）' };
  }
  const act = normRows(h.result, expect.normalize);
  const exp = normRows(expected, expect.normalize);
  if (deepEq(act, exp)) return { ok: true, note: `${act.length} 行` };
  return {
    ok: false,
    note: `行集不一致\n  实际: ${JSON.stringify(act)}\n  期望: ${JSON.stringify(exp)}`,
  };
}

/** 结果类断言（rows/count/exists/inserted/updated/removed/raw）；执行报错前置检查 */
async function _assertResult(kind, h, expect, oracleRows, env) {
  const err = h.error;
  if (err !== null && err !== undefined) {
    if (env.isSql && env.policy === 'explicit-or-parity') {
      return { ok: true, note: `SQL 显式报错（${err.name}）可接受` };
    }
    return { ok: false, note: `执行报错: ${err.message || err}` };
  }
  if (kind === 'raw') {
    const fn = env.checks[expect.fn];
    if (!fn) return { ok: false, note: `未知 raw 断言 ${expect.fn}` };
    return fn(h, expect);
  }
  if (kind === 'rows') return _assertRows(h, expect, oracleRows, env.isSql);
  return _assertScalar(kind, h, expect);
}

/**
 * 断言单步，返回 `{ ok, note }`。`isSql` 由 h.backend 判定；`oracleRows` 来自 mongo 相同步骤；
 * `checks` 为场景 raw 断言协程表（expect.kind='raw' 时按 fn 名取协程）。
 */
async function assertStep(h, step, oracleRows, checks) {
  const expect = step.expect || {};
  if (!expect.kind) return { ok: true, note: 'no assertion' };
  const kind = expect.kind;
  const isSql = isSqlBackend(h.backend);
  const policy = step.sqlPolicy || h.casePolicy || 'parity';
  const err = h.error;
  const events = h.events;

  if (kind === 'error') return _assertError(err, expect);
  if (kind === 'feedback') return _assertFeedback(events, expect);
  if (kind === 'unsupported') return _assertUnsupported(isSql, err, events);
  if (kind === 'run') return _assertRun(h, expect, err);
  // 结果类断言（rows/count/exists/inserted/updated/removed/raw）
  return _assertResult(kind, h, expect, oracleRows, { isSql, policy, checks });
}

module.exports = { runStep, assertStep };
