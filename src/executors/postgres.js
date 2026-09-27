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
   */
  async function openTransaction() {
    const { openAcquire } = require('./index'); // 延迟导入：避免与 index 的循环依赖
    const { conn, release } = await openAcquire(driver);
    await conn.query('BEGIN');
    let closed = false;
    return {
      exec: (plan) => runStmts(conn, plan),
      async commit() {
        if (closed) return;
        closed = true;
        await conn.query('COMMIT');
      },
      async rollback() {
        if (closed) return;
        closed = true;
        await conn.query('ROLLBACK');
      },
      release,
    };
  }

  /** 事务执行：基于 openTransaction（无第二套事务路径），任一失败整体回滚 */
  async function withTransaction(body) {
    const tx = await openTransaction();
    try {
      const out = await body(tx.exec);
      await tx.commit();
      return out;
    } catch (e) {
      try {
        await tx.rollback();
      } catch (_) {
        /* rollback 失败不掩盖原始错误 */
      }
      throw e;
    } finally {
      await tx.release();
    }
  }

  return {
    kind: 'postgres',
    exec: (plan) => runStmts(driver, plan),
    withTransaction,
    openTransaction,
  };
}

module.exports = { create };
