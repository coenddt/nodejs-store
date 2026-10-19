'use strict';

/**
 * 并发原语执行入口 —— claim / compareAndSet / renewLease（C1）
 *
 * 纯逻辑（命令规划、方言翻译）全在 Rust core（`planClaim` / `planCompareAndSet`，
 * mode=`atomic_commands`）；本模块只做宿主三件事：时钟供给（`now` 入参注入，
 * core 无时钟）、源路由判定、事务执行（`crud.exec.runAtomicCommands`）。
 * 对齐 py_store `crud/claim.py`（功能镜像铁律）。
 *
 * 源路由契约：claim/compareAndSet 仅支持**单一源**（SQL 三后端）——plan 命令序列的
 * 定位四元组提取出多个源时显式报错（跨源无同事务语义，禁静默选首源）；Mongo 源在
 * 执行层被显式拒绝（execMongo 的 concurrencyPrimitivesSqlOnly 分支）。
 *
 * matched 语义（A2 核心，三后端一致）：`compareAndSet.matched` = WHERE 命中行数。
 * PostgreSQL rowCount 与 SQLite `changes()` 天然为命中行数；MySQL 由 core 方言
 * 两步化承接（stmt1 `SELECT _id FOR UPDATE` 取命中行，matched = 行数；不依赖
 * `CLIENT_FOUND_ROWS`——该 flag 是握手期建连选项，宿主执行器拿到的是现成连接，
 * 无法代设），禁把 changed 当 matched 返回。SQL 单条 UPDATE 无独立 modified 计数
 * 来源，`modified` 与 `matched` 同值（命中行即为该语句触及的行；语义声明见
 * README「声明式并发原语」）。
 */

const { PushdownUnsupportedError } = require('../datasource');
const { getCore, get: _getSchema } = require('../schema');
const { _call, _nowFor, _ctx, runAtomicCommands } = require('./exec');

/** 从 atomic_commands plan 的命令序列提取唯一源（多源/缺源显式报错） */
function _singleSource(plan) {
  const sources = new Set(
    (plan.commands || []).map((c) => (c || {}).source || 'default'));
  if (sources.size !== 1) {
    const listed = Array.from(sources).sort().join(', ');
    throw new PushdownUnsupportedError(
      listed, 'claim', ['concurrencyPrimitivesSingleSource'],
      [`claim/compareAndSet 仅支持单一数据源（同事务语义）；实际涉及: ${listed}`]);
  }
  return Array.from(sources)[0];
}

/** 条件领取 N 行并原子置标；返回领到的行（含领取后最新值）
 *
 * MySQL/PG 走 `FOR UPDATE SKIP LOCKED` 两步同事务；SQLite 走单条
 * `UPDATE … RETURNING`（领取与取行一条语句原子完成）；仅 SQL 源（Mongo 显式拒绝）。
 * 时间戳/身份字段由调用方写入 `update`（门面与 core 均无时钟）。
 */
async function claim(schemaName, filter, update, { limit = 1, sort = null, routeOverride = null } = {}) {
  _getSchema(schemaName); // 未注册 schema 先行显式报错（与写路径入口对齐）
  const now = _nowFor(schemaName);
  const plan = _call(() =>
    getCore().planClaim(schemaName, filter ?? {}, update ?? {}, sort, limit, now,
      _ctx(), routeOverride));
  return runAtomicCommands(_singleSource(plan), plan);
}

/** 条件更新并返回 `{ matched, modified }`（matched = WHERE 命中行数，三后端一致）
 *
 * matched 提取统一规则：包络 rows 非空取 `rows.length`（MySQL 两步 CAS 的 stmt1
 * `SELECT _id FOR UPDATE` 行数即命中数），否则取 `affectedRows`（PG rowCount /
 * SQLite `changes()` 天然 = 命中行数）。空 filter 放行（语义 = 匹配全部，
 * 调用方自行承担范围风险——与 updateMany 行为对齐）。
 */
async function compareAndSet(schemaName, filter, update, { routeOverride = null } = {}) {
  _getSchema(schemaName);
  const now = _nowFor(schemaName);
  const plan = _call(() =>
    getCore().planCompareAndSet(schemaName, filter ?? {}, update ?? {}, now,
      _ctx(), routeOverride));
  const env = await runAtomicCommands(_singleSource(plan), plan);
  let matched = 0;
  if (env && typeof env === 'object') {
    matched = Array.isArray(env.rows) && env.rows.length > 0
      ? env.rows.length
      : Number(env.affectedRows || 0);
  }
  return { matched, modified: matched };
}

/** 租约续期：compareAndSet 组合门面（不新开命令 kind，01 已裁决）
 *
 * 归属条件由调用方 `filter` 携带（如 `{ _id: {$in: ids}, claimedBy: workerId }`），
 * 宿主不隐式注入身份字段；续期时间戳由调用方写入 `leaseFields`（如
 * `{ leaseUntil: <ms> }`）——门面与 core 均无时钟。返回值同 compareAndSet。
 */
async function renewLease(schemaName, filter, leaseFields, { routeOverride = null } = {}) {
  return compareAndSet(schemaName, filter, leaseFields, { routeOverride });
}

module.exports = { claim, compareAndSet, renewLease };
