'use strict';

/**
 * Mutation / Upsert / 原生聚合 —— 规划步骤序列 → 依序执行 + 父子 _id 占位符回填
 */

const { core: _core, get: _getSchema } = require('../schema');
const datasource = require('../datasource');
const { emit: _emitFeedback } = require('../feedback');
const { _call, _ctx, _exec, _nowFor, resolvePlaceholders } = require('./exec');
const { _generateId, _newIdPool } = require('./id');

/** mutation 单条：规划步骤序列 → 依序执行 + 父子 _id 占位符回填 */
async function _mutationOne(schemaName, data, now, routeOverride = null) {
  const plan = _call(() =>
    _core.planMutation(schemaName, data, now, _newIdPool(schemaName, data), _ctx(),
      routeOverride));

  // §11.4 静默点收口：规划期降级（如关系不可读被跳过）走统一反馈通道，禁止静默失守
  for (const d of plan.degraded || []) {
    _emitFeedback({ ...(d || {}), type: 'mutation_degraded' });
  }

  const runSteps = async () => {
    const resolved = [];
    let rootResult = null;
    for (const [i, step] of plan.steps.entries()) {
      const cmd = resolvePlaceholders(step.command, { steps: resolved });
      const result = await _exec(cmd);
      resolved.push(result ? (result._id ?? null) : null);
      if (i === 0) rootResult = result; // 首步即根写入
    }

    return rootResult ? _call(() => _core.applyWriteDefaults(schemaName, rootResult)) : null;
  };

  // 单一 SQL 源 → 步骤序列整体事务化（同连接同事务，任一步失败整体回滚）；
  // Mongo 源 / 跨源步骤按原样顺序执行（非原子边界见 README「事务边界」）
  const sources = [...new Set(plan.steps.map((s) => s.command.source || datasource.DEFAULT_SOURCE))];
  if (sources.length === 1 && datasource.isSql(sources[0])) {
    return datasource.runInTransaction(sources[0], runSteps);
  }
  return runSteps();
}

/**
 * mutation — 智能持久化
 *
 * 自动判断 upsert/insert，支持父子文档关联填充。
 * `routeOverride` 可选：`{ source?, namespace? }` 多租户路由。
 */
async function mutation(schemaName, data, routeOverride = null) {
  const isArray = Array.isArray(data);
  const items = isArray ? data : [data];

  if (!items.length) return isArray ? [] : null;

  // §11.3 确定性输入：一次 mutation 调用共用一个 now
  // （数组内多条 + 父子步骤 + 默认值 / 计算列全部同值）
  const now = _nowFor(schemaName);

  const results = [];
  for (const item of items) {
    results.push(await _mutationOne(schemaName, item, now, routeOverride));
  }

  return isArray ? results : results[0];
}

/**
 * upsert — 显式条件 upsert
 *
 * 与 mutation 不同，upsert 需要调用方显式提供 match 条件，不处理父子关系。
 */
async function upsert(schemaName, condition, data, options = null, routeOverride = null) {
  const s = _getSchema(schemaName);
  const plan = _call(() => _core.planUpsert(
    schemaName, condition ?? null, data ?? null, options ?? null, _nowFor(schemaName),
    s.idPrefix ? _generateId(s) : '', _ctx(), routeOverride,
  ));
  const result = await _exec(plan.command);
  return result ? _call(() => _core.applyWriteDefaults(schemaName, result)) : null;
}

module.exports = { mutation, upsert };
