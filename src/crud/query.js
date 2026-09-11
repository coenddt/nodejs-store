'use strict';

/**
 * 读路径 —— find 快路径 / 两阶段（取 ID → 关联 → 还原排序）/ 标准聚合 + asyncFn 尾处理
 * / 跨库联邦（逐源执行 → 内存 hash join）
 */

const { core: _core, getAsyncFn } = require('../schema');
const { _call, _ctx, _exec, _execOn, resolvePlaceholders } = require('./exec');

/** 执行读命令序列：find 快路径 / 两阶段（取 ID → 关联 → 还原排序）/ 标准聚合 */
async function _runQueryPlan(plan) {
  if (plan.mode === 'two_phase') {
    const idDocs = await _exec(plan.commands[0]);
    const ids = idDocs.map((d) => d._id);
    if (!ids.length) return [];
    const cmd2 = resolvePlaceholders(plan.commands[1], { ids });
    const items = await _exec(cmd2);
    return _core.restoreSortOrder(items, ids, plan.sort ?? null).items;
  }
  return _exec(plan.commands[0]);
}

/** 读路径尾处理两段式：core 后处理 → Host 执行 asyncFn → core 剥离注入依赖 */
async function _finalize(plan, items) {
  if (!plan.postprocess) return items;
  const prepared = _core.prepareQuery(plan.postprocess, items, _ctx());
  for (const ref of prepared.fnRefs) {
    const fn = getAsyncFn(ref);
    if (!fn) throw new Error(`asyncFn 计算列 ${ref} 未注册实现`);
    await fn(prepared.items, _ctx());
  }
  return _core.stripQuery(plan.postprocess, prepared.items).items;
}

/**
 * GQL 查询（返回数组）
 *
 * 支持的 params 键（通过 GQL 的 @key 引用）:
 *   $condition / $sort / $skip / $limit / $pipeline
 * 使用 $pipeline 时，框架不追加 compute 层、不补默认值、不裁剪，完全由用户控制。
 */
async function query(gql, params = null) {
  const plan = _call(() => _core.planQuery(gql, params ?? {}, _ctx()));
  return _finalize(plan, await _runQueryPlan(plan));
}

/** GQL 查询（返回单条） */
async function queryOne(gql, params = null) {
  const items = await query(gql, params);
  return items.length ? items[0] : null;
}

/**
 * 执行单个联邦取数单元（按 `sources[].source` 精确路由；two_phase 走两阶段）
 *
 * 与单库 `_runQueryPlan` 同形：只差路由键（单元自带 source，不按 collection 反查）。
 */
async function _runFederatedUnit(unit) {
  const commands = unit.commands || [];
  if (unit.mode === 'two_phase') {
    const idDocs = await _execOn(unit.source, commands[0]);
    const ids = idDocs.map((d) => d._id);
    if (!ids.length) return [];
    const cmd2 = resolvePlaceholders(commands[1], { ids });
    const items = await _execOn(unit.source, cmd2);
    return _core.restoreSortOrder(items, ids, unit.sort ?? null).items;
  }
  return _execOn(unit.source, commands[0]);
}

/**
 * 跨库联邦查询（返回嵌套文档数组）
 *
 * Host 四步：core `planFederated` 拆源 → 逐源执行 → core `mergeFederated`
 * 内存 hash join → 统一后处理（`_finalize`，与单库同一路径）。
 *
 * `postprocess` 取自根单元快照（含全部关系），因此结果形状与单库 `query` 完全一致。
 * 每源取数上限 `MAX_FEDERATION_ROWS` 由 core 强制（超限即报错，拒绝静默全表拉取）；
 * 无法下推的分页/排序进 `plan.degraded` 并告警，不阻断查询。
 */
async function queryFederated(gql, params = null) {
  const plan = _call(() => _core.planFederated(gql, params ?? {}, _ctx()));

  for (const d of plan.degraded || []) {
    console.warn(`[federation] 降级 ${(d && d.code) || ''}: ${(d && d.message) || ''}`);
  }

  const results = [];
  for (const unit of plan.sources || []) {
    results.push(await _runFederatedUnit(unit));
  }

  const merged = _call(() => _core.mergeFederated(plan, results));
  return _finalize(plan, merged);
}

/**
 * GQL 查询（返回 items + total + 分页元数据）
 *
 * 支持两种分页参数方式：
 *   1. page/pageSize（推荐）— 自动计算 skip/limit，page 默认 0，pageSize 默认 50
 *   2. 传统 $skip/$limit — 从 GQL 参数推导 page/pageSize
 * pageSize 上限 5000，防止拖库。
 */
async function queryWithCount(gql, params = null) {
  const plan = _call(() => _core.planQueryWithCount(gql, params ?? {}, _ctx(), null));
  const items = await _finalize(plan, await _runQueryPlan(plan));
  const total = await _exec(plan.countCommand);
  return {
    items,
    total,
    hasMore: (plan.page + 1) * plan.pageSize < total,
    page: plan.page,
    pageSize: plan.pageSize,
  };
}

module.exports = { query, queryOne, queryWithCount, queryFederated };
