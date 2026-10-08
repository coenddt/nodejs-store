'use strict';

/**
 * 写路径 —— 单条/批量插入、更新、删除归档、存在性与计数
 */

const { core: _core, get: _getSchema } = require('../schema');
const { _call, _ctx, _exec, _nowFor, runAtomic, sourcesOf, declareTriggerSources } = require('./exec');
const { _generateId } = require('./id');
const { runTriggers } = require('./triggers');

/** creator 写权限探针：先规划，若 needsProbe 则执行探针命令后重入 */
async function _planWithProbe(planFn) {
  let out = planFn(null, null);
  if (out.needsProbe) {
    const probeDoc = await _exec(out.needsProbe);
    out = planFn(probeDoc !== null && probeDoc !== undefined, probeDoc ?? null);
  }
  return out;
}

/** 插入一条（`routeOverride` 可选：`{ source?, database?, schema? }` 多租户路由） */
async function insert(schemaName, data, routeOverride = null) {
  const s = _getSchema(schemaName);
  const now = _nowFor(schemaName);
  const plan = _call(() =>
    _core.planInsert(schemaName, data ?? null, now, s.idPrefix ? _generateId(s) : '', _ctx(),
      routeOverride));

  const finish = (result) => {
    let returns = plan.returns;
    // 阶段2：autoincrement 主键 —— 执行器已回读自增值，returns 补 `_id`
    if (returns && typeof returns === 'object' && !returns._id
        && result && typeof result === 'object' && result._id !== undefined && result._id !== null) {
      returns = { ...returns, _id: result._id };
    }
    return returns;
  };

  // 无触发器：保持原路径（零回归）
  if (!plan.triggers || !plan.triggers.length) {
    return finish(await _exec(plan.command));
  }
  // 有触发器：主写 + 触发链同一原子作用域（单源真事务 / 跨源发 nonAtomic）
  return runAtomic(sourcesOf(plan), async () => {
    const result = await _exec(plan.command);
    await runTriggers(plan.triggers, { root: result, before: null, now, ctx: _ctx(), executed: new Set() });
    return finish(result);
  });
}

/** 批量插入（带权限检查，自动生成 _id 和时间戳；空数组直接返回空） */
async function insertMany(schemaName, docs, routeOverride = null) {
  if (!Array.isArray(docs) || !docs.length) return [];

  const s = _getSchema(schemaName);
  // 阶段2（no-error-masking）：autoincrement 的批量自增值回读不可靠（MySQL 批量
  // insertId 仅首行、且并发插入会留间隙）→ 显式报错，不静默产出错误 _id
  const idFdef = (s.fields || {})._id || {};
  if (idFdef.strategy === 'autoincrement' && docs.some((d) => !(d && d._id))) {
    throw new Error(
      'AUTOINCREMENT_NOT_SUPPORTED: insertMany 不支持 autoincrement schema'
      + '（批量自增值回读不可靠）；请逐条 insert 或显式提供 _id');
  }
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
 *
 * 「权限探针 + 写」整体纳入同一原子作用域（`runAtomic`）：单一 SQL 源时探针与写
 * 同连接同事务，消除二者之间的并发窗口；`now` 只取一次，两次规划共用（调用级确定性）。
 */
async function update(schemaName, condition, data, options = null, routeOverride = null) {
  const now = _nowFor(schemaName);
  const ctx = _ctx();
  const first = _call(() =>
    _core.planUpdate(schemaName, condition ?? null, data ?? null, options ?? null, now, ctx,
      null, null, routeOverride));
  const sources = sourcesOf(first);

  const doRun = async () => {
    let out = first;
    let before = null;
    if (out.needsProbe) {
      before = await _exec(out.needsProbe);            // 探针文档 = before（含 onFields 投影）
      out = _call(() =>
        _core.planUpdate(schemaName, condition ?? null, data ?? null, options ?? null, now, ctx,
          before !== null && before !== undefined, before ?? null, routeOverride));
    }
    // 触发链触及源并入原子性声明（update 的 triggers 二次规划才产出；跨源 → non_atomic_write）
    if (out.triggers && out.triggers.length) declareTriggerSources(sources, out.triggers);
    const result = await _exec(out.command);
    // 主写有命中才触发（0 行命中 = 无 after，无从引用；配触发器的 update 由 core 强制发探针）
    if (out.triggers && out.triggers.length && result) {
      await runTriggers(out.triggers, { root: result, before, now, ctx, executed: new Set() });
    }
    return result ? _call(() => _core.applyWriteDefaults(schemaName, result)) : null;
  };

  return runAtomic(sources, doRun);
}

/** 执行带 `preCommand` 的命令（阶段1：mutation 关系谓词归一）。
 * preCommand（aggregate 取命中 `_id`）先行执行，把 `_id` 列表回填进主命令 filter 的
 * `$in` 占位（core 注入 `"__REL_PRED_IDS__"`）；空集 → `$in: []`（各后端均不命中任何行）。 */
async function execWithPre(command) {
  const pre = command && command.preCommand;
  if (!pre) return _exec(command);
  const preRows = await _exec(pre);
  const ids = (preRows || []).filter((d) => d && '_id' in d).map((d) => d._id);
  return fillPreIds(command, ids);
}

/** 把 preCommand 取得的 `_id` 列表回填进命令 filter 的 `$in` 占位（递归查找后执行）。
 * core 注入的占位可能位于 `$and` 数组内（改写条件已有其他键时），故递归遍历。 */
function fillPreIds(command, ids) {
  const main = { ...command };
  delete main.preCommand;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const it of node) walk(it);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === 'object' && v.$in === '__REL_PRED_IDS__') {
          node[k] = { $in: [...ids] };
        } else {
          walk(v);
        }
      }
    }
  };
  if (main.filter) walk(main.filter);
  return _exec(main);
}

/** 批量更新（支持原生操作符） */
async function updateMany(schemaName, condition, data, routeOverride = null) {
  const out = _call(() =>
    _core.planUpdateMany(schemaName, condition ?? null, data ?? null, _nowFor(schemaName), _ctx(), routeOverride));
  const result = await execWithPre(out.command);
  return { modifiedCount: result.modifiedCount };
}

/** 删除 —— 原表数据先归档到对应 `_deleted` 附表（附 deletedAt），再物理删除原表数据。
 * 归档命令带 `upsertById`（幂等），重试不再因 _id 冲突整批失败；单一 SQL 源时
 * 归档+删除整体事务化（Mongo / 跨源按顺序执行，非原子边界见 README「事务边界」）。
 * remove 触发链（A5：未声明触发器时无此路径，行为不变）：before = 归档 findCommand
 * 首条（被删文档代表值、全字段）；未删到（docs 空）不触发，与 update 0 行命中语义一致 */
async function remove(schemaName, condition, routeOverride = null) {
  const out = await _planWithProbe((found, doc) => _call(() =>
    _core.planRemove(schemaName, condition ?? null, _ctx(), found, doc, routeOverride)));

  const doRemove = async () => {
    let archivedCount = 0;
    let docs = [];
    // 关系谓词：先执行 deleteCommand.preCommand 取命中 _id（归档 find 与删除共用同一列表）
    const pre = out.deleteCommand && out.deleteCommand.preCommand;
    let ids = null;
    if (pre) {
      const preRows = await _exec(pre);
      ids = (preRows || []).filter((d) => d && '_id' in d).map((d) => d._id);
    }
    if (out.findCommand) {
      docs = await (ids !== null ? fillPreIds(out.findCommand, ids) : _exec(out.findCommand));
      if (docs.length) {
        const arch = _call(() => _core.planArchiveDocs(schemaName, docs, _nowFor(schemaName), routeOverride));
        await _exec(arch.command);
        archivedCount = docs.length;
      }
    }

    const result = await (ids !== null ? fillPreIds(out.deleteCommand, ids) : _exec(out.deleteCommand));
    if (out.triggers && out.triggers.length && docs.length) {
      await runTriggers(out.triggers,
        { root: null, before: docs[0], now: _nowFor(schemaName), ctx: _ctx(), executed: new Set() });
    }
    return { deletedCount: result.deletedCount, archivedCount };
  };

  const sources = sourcesOf(out);
  // 触发链触及源并入原子性声明（跨源 → non_atomic_write）
  if (out.triggers && out.triggers.length) declareTriggerSources(sources, out.triggers);
  return runAtomic(sources, doRemove);
}

/** 判断是否存在 */
async function exists(schemaName, condition, routeOverride = null) {
  const cmd = _call(() => _core.planExists(schemaName, condition ?? null, routeOverride));
  const doc = await _exec(cmd);
  return doc !== null && doc !== undefined;
}

/** 统计符合条件的文档数量 */
async function count(schemaName, filter = null, routeOverride = null) {
  const cmd = _call(() => _core.planCount(schemaName, filter ?? null, _ctx(), routeOverride));
  return _exec(cmd);
}

module.exports = { insert, insertMany, update, updateMany, remove, exists, count };
