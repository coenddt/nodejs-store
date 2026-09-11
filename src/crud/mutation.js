'use strict';

/**
 * Mutation / Upsert / 原生聚合 —— 规划步骤序列 → 依序执行 + 父子 _id 占位符回填
 */

const { core: _core, get: _getSchema } = require('../schema');
const { _call, _ctx, _exec, _now, resolvePlaceholders } = require('./exec');
const { _generateId, _newIdPool } = require('./id');

/** mutation 单条：规划步骤序列 → 依序执行 + 父子 _id 占位符回填 */
async function _mutationOne(schemaName, data) {
  const plan = _call(() =>
    _core.planMutation(schemaName, data, _now(), _newIdPool(schemaName, data), _ctx()));

  const resolved = [];
  let rootResult = null;
  for (const [i, step] of plan.steps.entries()) {
    const cmd = resolvePlaceholders(step.command, { steps: resolved });
    const result = await _exec(cmd);
    resolved.push(result ? (result._id ?? null) : null);
    if (i === 0) rootResult = result; // 首步即根写入
  }

  return rootResult ? _call(() => _core.applyWriteDefaults(schemaName, rootResult)) : null;
}

/**
 * mutation — 智能持久化
 *
 * 自动判断 upsert/insert，支持父子文档关联填充。
 */
async function mutation(schemaName, data) {
  const isArray = Array.isArray(data);
  const items = isArray ? data : [data];

  if (!items.length) return isArray ? [] : null;

  const results = [];
  for (const item of items) {
    results.push(await _mutationOne(schemaName, item));
  }

  return isArray ? results : results[0];
}

/**
 * upsert — 显式条件 upsert
 *
 * 与 mutation 不同，upsert 需要调用方显式提供 match 条件，不处理父子关系。
 */
async function upsert(schemaName, condition, data, options = null) {
  const s = _getSchema(schemaName);
  const plan = _call(() => _core.planUpsert(
    schemaName, condition ?? null, data ?? null, options ?? null, _now(),
    s.idPrefix ? _generateId(s) : '', _ctx(),
  ));
  const result = await _exec(plan.command);
  return result ? _call(() => _core.applyWriteDefaults(schemaName, result)) : null;
}

// ─── 原生聚合 ────────────────────────────────────────────────

/** 对指定 schema 执行 MongoDB 原生聚合查询 */
async function aggregate(schemaName, pipeline) {
  const cmd = _call(() => _core.planAggregate(schemaName, pipeline ?? []));
  return _exec(cmd);
}

module.exports = { mutation, upsert, aggregate };
