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
      rows = res.rows || [];
      affectedRows = Number(res.rowCount || 0);
      if (stmt.rowShape) docs = _core.restoreRows(stmt.rowShape, rows);
    }
    return { docs, rows, affectedRows };
  }

  return {
    kind: 'postgres',
    exec: (plan) => runStmts(driver, plan),
    /**
     * 事务执行：显式 BEGIN/COMMIT/ROLLBACK 包住 body 的全部 plan。
     * Pool 自动 checkout 专用 client（`release()` 归还）；Client 直连直接用。
     */
    async withTransaction(body) {
      let conn = driver;
      let release = null;
      if (typeof driver.connect === 'function') {
        try {
          const c = await driver.connect();
          // Pool.connect() → 专用 Client（带 release）；Client.connect() → 自身
          if (c && typeof c.query === 'function') {
            conn = c;
            if (c !== driver && typeof c.release === 'function') release = () => c.release();
          }
        } catch (_) {
          /* checkout 失败退回 driver 本体，事务语义由 BEGIN/COMMIT 保证 */
        }
      }
      try {
        await conn.query('BEGIN');
        const out = await body((plan) => runStmts(conn, plan));
        await conn.query('COMMIT');
        return out;
      } catch (e) {
        try {
          await conn.query('ROLLBACK');
        } catch (_) {
          /* rollback 失败不掩盖原始错误 */
        }
        throw e;
      } finally {
        if (release) release();
      }
    },
  };
}

module.exports = { create };
