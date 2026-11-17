'use strict';

/**
 * 占位符替换与 atomic_commands 执行（D4-4 零语义拆分自 crud/exec.js）
 *
 * 承载：`{{phase1.ids}}` / `{{step.<N>._id}}` 与 `___claimed_ids___` 两套替换入口，
 * 以及 claim / compareAndSet 的执行管道（同连接同事务内顺序执行）。
 */

const datasource = require('../datasource');
const { _exec } = require('./exec-io');

const _PHASE1_IDS = /^\{\{phase1\.ids\}\}$/;
const _STEP_PH = /^\{\{step\.(\d+)\._id\}\}$/;

/** 深度替换命令中的占位符（命中 resolver 返回非字符串时替换） */
function _substitute(value, resolver) {
  if (typeof value === 'string') return resolver(value);
  if (Array.isArray(value)) return value.map((v) => _substitute(v, resolver));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _substitute(v, resolver);
    return out;
  }
  return value;
}

/**
 * Host 契约：把命令中的占位符替换为执行结果
 *
 *   - `{{phase1.ids}}`     → 两阶段查询第一步取回的 id 数组（整值替换）
 *   - `{{step.<N>._id}}`   → mutation 第 N 步执行结果的 _id
 *
 * 未命中的占位符原样保留（便于定位 core 与 Host 的契约漂移）。
 * Python 侧 `py_store.crud.exec.resolve_placeholders` 为同语义实现，
 * 两侧共测 `rust-store/fixtures/host/placeholders.json`。
 */
function resolvePlaceholders(command, { ids = null, steps = [] } = {}) {
  return _substitute(command, (s) => {
    if (_PHASE1_IDS.test(s)) return ids ?? s;
    const m = s.match(_STEP_PH);
    if (m) {
      const idx = Number(m[1]);
      if (idx < steps.length) return steps[idx];
    }
    return s;
  });
}

const _CLAIMED_IDS = '___claimed_ids___';
const _MODE_ATOMIC = 'atomic_commands';

/**
 * atomic_commands 专用占位符替换：`___claimed_ids___` → 领取到的 _id 数组
 *
 * 与 `{{phase1.ids}}` 分开实现（two_phase 与 claim 各用各的替换入口），契约同源：
 * 整值替换（字符串整体匹配才替换）；未命中原样保留——token 残留会让 SQL 因非法
 * 语法显式报错（no-error-masking：禁静默当作空集执行）。
 */
function _fillClaimed(command, ids) {
  return _substitute(command, (s) => (s === _CLAIMED_IDS ? ids : s));
}

/** 从 claim 命令的执行包络提取领取到的 _id 列表
 *
 * 三后端 rows 形状统一含 `_id`：MySQL/PG 为 stmt1 `SELECT _id` 的行；SQLite 为
 * `UPDATE … RETURNING` 的完整行。行缺 `_id` 视为契约漂移——跳过而非静默顶替
 * （禁伪造领取结果）。
 */
function _claimedIdsOf(env) {
  const rows = (env && typeof env === 'object' ? env.rows : null) || [];
  return rows
    .filter((r) => r && typeof r === 'object' && '_id' in r)
    .map((r) => r._id);
}

/**
 * atomic_commands mode 执行器（claim / compareAndSet 的执行管道）
 *
 *   - mode 校验：仅接受 `atomic_commands`，其余显式报错（禁静默走通用路径——
 *     该 mode 的语义是「全部命令同连接同事务内顺序执行」，走通用路径会丢失原子性）；
 *   - 事务包裹：`datasource.runInTransaction`（claim 的 SELECT FOR UPDATE SKIP
 *     LOCKED 与标记 UPDATE 必须同一作用域）；
 *   - 占位符回填：前条 claim 包络的 _id 列表（`___claimed_ids___` 整值替换）→
 *     末条取行命令；零领取（rows 空）直接返回空、不执行后续命令；
 *   - 方言已随领取语句取回完整还原行（如 SQLite 的 `UPDATE … RETURNING`）→
 *     直接作为领取结果，不再执行取行命令；
 *   - compareAndSet 为单命令 plan：直接执行并返回包络（matched 从包络读，
 *     见 crud/claim.js）。对齐 py_store `crud/exec.py#run_atomic_commands`。
 */
async function runAtomicCommands(source, plan) {
  const mode = (plan || {}).mode;
  if (mode !== _MODE_ATOMIC) {
    throw new Error(
      `runAtomicCommands 仅接受 mode='${_MODE_ATOMIC}'，实际 ${JSON.stringify(mode)}`
      + '（禁静默走通用路径：atomic_commands 的同事务语义不可降级）');
  }
  const commands = plan.commands || [];
  if (commands.length === 0) {
    throw new Error('atomic_commands plan 缺少 commands（禁静默空执行）');
  }

  async function _do() {
    const env = await _exec(commands[0]);
    if (commands.length === 1) return env;
    const docs = env && typeof env === 'object' ? env.docs : null;
    if (docs !== null && docs !== undefined) return docs;
    const ids = _claimedIdsOf(env);
    if (ids.length === 0) return [];
    return _exec(_fillClaimed(commands[1], ids));
  }

  return datasource.runInTransaction(source, _do);
}

module.exports = {
  _substitute,
  resolvePlaceholders,
  _fillClaimed,
  _claimedIdsOf,
  runAtomicCommands,
};
