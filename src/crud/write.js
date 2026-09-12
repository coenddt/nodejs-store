'use strict';

/**
 * 写路径 —— 单条/批量插入、更新、删除归档、存在性与计数
 */

const { core: _core, get: _getSchema } = require('../schema');
const datasource = require('../datasource');
const { _call, _ctx, _exec, _nowFor } = require('./exec');
const { _generateId } = require('./id');

/** creator 写权限探针：先规划，若 needsProbe 则执行探针命令后重入 */
async function _planWithProbe(planFn) {
  let out = planFn(null, null);
  if (out.needsProbe) {
    const probeDoc = await _exec(out.needsProbe);
    out = planFn(probeDoc !== null && probeDoc !== undefined, probeDoc ?? null);
  }
  return out;
}

/** 插入一条（`routeOverride` 可选：`{ source?, namespace? }` 多租户路由） */
async function insert(schemaName, data, routeOverride = null) {
  const s = _getSchema(schemaName);
  const plan = _call(() =>
    _core.planInsert(schemaName, data ?? null, _nowFor(schemaName), s.idPrefix ? _generateId(s) : '', _ctx(),
      routeOverride));
  await _exec(plan.command);
  return plan.returns;
}

/** 批量插入（带权限检查，自动生成 _id 和时间戳；空数组直接返回空） */
async function insertMany(schemaName, docs, routeOverride = null) {
  if (!Array.isArray(docs) || !docs.length) return [];

  const s = _getSchema(schemaName);
  const plan = _call(() => _core.planInsertMany(
    schemaName,
    docs,
    _nowFor(schemaName),
    // core 按需消费（仅无 _id 的文档取用），多备无害
    docs.map(() => (s.idPrefix ? _generateId(s) : '')),
    _ctx(),
    routeOverride,
  ));
  if (plan.command) await _exec(plan.command);
  return plan.returns;
}

/**
 * 更新一条（支持原生操作符，不触发默认值）
 *
 * data 的 key 以 '$' 开头 → 原生 MongoDB 操作符（$set/$inc/$unset 等）直接透传。
 * 否则自动包装为 $set 模式。`routeOverride` 可选（多租户路由）。
 */
async function update(schemaName, condition, data, options = null, routeOverride = null) {
  const out = await _planWithProbe((found, doc) => _call(() =>
    _core.planUpdate(schemaName, condition ?? null, data ?? null, options ?? null, _nowFor(schemaName), _ctx(),
      found, doc, routeOverride)));
  const result = await _exec(out.command);
  return result ? _call(() => _core.applyWriteDefaults(schemaName, result)) : null;
}

/** 批量更新（支持原生操作符） */
async function updateMany(schemaName, condition, data, routeOverride = null) {
  const out = _call(() =>
    _core.planUpdateMany(schemaName, condition ?? null, data ?? null, _nowFor(schemaName), _ctx(), routeOverride));
  const result = await _exec(out.command);
  return { modifiedCount: result.modifiedCount };
}

/** 删除 —— 原表数据先归档到对应 `_deleted` 附表（附 deletedAt），再物理删除原表数据。
 * 归档命令带 `upsertById`（幂等），重试不再因 _id 冲突整批失败；单一 SQL 源时
 * 归档+删除整体事务化（Mongo / 跨源按顺序执行，非原子边界见 README「事务边界」） */
async function remove(schemaName, condition, routeOverride = null) {
  const out = await _planWithProbe((found, doc) => _call(() =>
    _core.planRemove(schemaName, condition ?? null, _ctx(), found, doc, routeOverride)));

  const doRemove = async () => {
    let archivedCount = 0;
    if (out.findCommand) {
      const docs = await _exec(out.findCommand);
      if (docs.length) {
        const arch = _call(() => _core.planArchiveDocs(schemaName, docs, _nowFor(schemaName), routeOverride));
        await _exec(arch.command);
        archivedCount = docs.length;
      }
    }

    const result = await _exec(out.deleteCommand);
    return { deletedCount: result.deletedCount, archivedCount };
  };

  const sources = new Set([out.deleteCommand.source || datasource.DEFAULT_SOURCE]);
  if (out.findCommand) sources.add(out.findCommand.source || datasource.DEFAULT_SOURCE);
  const arr = [...sources];
  if (arr.length === 1 && datasource.isSql(arr[0])) {
    return datasource.runInTransaction(arr[0], doRemove);
  }
  return doRemove();
}

/** 判断是否存在 */
async function exists(schemaName, condition, routeOverride = null) {
  const cmd = _call(() => _core.planExists(schemaName, condition ?? null, routeOverride));
  const doc = await _exec(cmd);
  return doc !== null && doc !== undefined;
}

/** 统计符合条件的文档数量 */
async function count(schemaName, filter = null, routeOverride = null) {
  const cmd = _call(() => _core.planCount(schemaName, filter ?? null, routeOverride));
  return _exec(cmd);
}

module.exports = { insert, insertMany, update, updateMany, remove, exists, count };
