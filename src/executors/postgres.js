'use strict';

/**
 * PostgreSQL 执行器（驱动：pg）
 *
 * 只做「绑定参数 + 执行 + 回喂」（铁律 1/8）：SQL 全部由 core `dialectTranslate`
 * 产出（占位符为 `$n`，params 顺序一致），本模块不拼任何 SQL。PG 原生支持
 * `RETURNING`，故写后回读为单语句。返回中立包络 `{ docs, rows, affectedRows }`，
 * 由 `./index.js` 依 command.kind 塑形为 Mongo 驱动等价返回值。
 */

const { core: _core } = require('../schema');
const { normalizeRows } = require('./_values');
const txShared = require('./tx'); // D4-2 去重：事务骨架与 mysql/sqlite 共享（./tx）

/** 创建执行器描述符（可直接作为 `init(connections)` 的一个 SQL 数据源连接） */
function create(driver, _options = {}) {
  if (!driver || typeof driver.query !== 'function') {
    throw new TypeError('postgres 执行器需要 pg 的 Pool/Client 实例');
  }

  /** 在指定连接上依序执行 plan.stmts */
  async function runStmts(conn, plan) {
    let docs = null;
    let rows = null;
    let affectedRows = 0;
    for (const stmt of plan.stmts) {
      const res = await conn.query(stmt.text, stmt.params || []);
      rows = normalizeRows(res.rows || [], res.fields, 'postgres');
      affectedRows = Number(res.rowCount || 0);
      if (stmt.rowShape) docs = _core.restoreRows(stmt.rowShape, rows);
    }
    return { docs, rows, affectedRows };
  }

  /**
   * 显式事务句柄：池 checkout 专用 client（失败直接上抛，无静默兜底）
   * + BEGIN + 幂等 commit/rollback；release 归还连接（单连接为 no-op）。
   * 骨架在 ./tx 与 mysql 共享，方言差异仅 BEGIN/COMMIT/ROLLBACK 的驱动调用形态。
   */
  const openTransaction = () =>
    txShared.pooledTransaction({
      driver,
      execOn: runStmts,
      begin: (conn) => conn.query('BEGIN'),
      commit: (conn) => conn.query('COMMIT'),
      rollback: (conn) => conn.query('ROLLBACK'),
    });

  /** 事务执行：基于 openTransaction（无第二套事务路径），任一失败整体回滚；
   *  body(exec, tx) 第二参数为事务句柄（供上层读保存点原语），可选——旧单参写法继续可用 */
  const withTransaction = (body) => txShared.withTransaction(openTransaction, body);

  return {
    kind: 'postgres',
    exec: (plan) => runStmts(driver, plan),
    withTransaction,
    openTransaction,
  };
}

module.exports = { create };
