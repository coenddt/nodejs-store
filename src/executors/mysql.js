'use strict';

/**
 * MySQL 执行器（驱动：mysql2/promise）
 *
 * 只做「绑定参数 + 执行 + 回喂」（铁律 1/8）：SQL 全部由 core `dialectTranslate`
 * 产出（占位符为 `?`），本模块不拼任何 SQL。MySQL 无 `RETURNING`，写后回读由 core
 * 产出「UPDATE/INSERT + SELECT」两条语句，本模块按序执行并取回读结果即可。
 * 返回中立包络 `{ docs, rows, affectedRows }`，由 `./index.js` 依 command.kind 塑形。
 */

const { core: _core } = require('../schema');

/** mysql2 返回 RowDataPacket 实例，转普通对象后再交 core（绑定层只认纯 JSON） */
function _plain(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = row[k];
  return out;
}

/** 创建执行器描述符（可直接作为 `init(connections)` 的一个 SQL 数据源连接） */
function create(driver, _options = {}) {
  if (!driver || typeof driver.execute !== 'function') {
    throw new TypeError('mysql 执行器需要 mysql2/promise 的连接或连接池');
  }

  /** 在指定连接上依序执行 plan.stmts（多语句 plan 由 withTransaction 包事务） */
  async function runStmts(conn, plan) {
    let docs = null;
    let rows = null;
    let affectedRows = 0;
    for (const stmt of plan.stmts) {
      const [raw] = await conn.execute(stmt.text, stmt.params || []);
      if (Array.isArray(raw)) {
        rows = raw.map(_plain);
        if (stmt.rowShape) docs = _core.restoreRows(stmt.rowShape, rows);
      } else {
        affectedRows = Number(raw.affectedRows || 0);
      }
    }
    return { docs, rows, affectedRows };
  }

  return {
    kind: 'mysql',
    exec: (plan) => runStmts(driver, plan),
    /**
     * 事务执行：body(executeOnTx) 的所有 plan 落在同一连接同一事务内，
     * 成功 commit / 失败 rollback。池自动取专用连接（结束归还）。
     */
    async withTransaction(body) {
      const conn =
        typeof driver.getConnection === 'function' ? await driver.getConnection() : driver;
      try {
        await conn.beginTransaction();
        const out = await body((plan) => runStmts(conn, plan));
        await conn.commit();
        return out;
      } catch (e) {
        try {
          await conn.rollback();
        } catch (_) {
          /* rollback 失败不掩盖原始错误 */
        }
        throw e;
      } finally {
        if (conn !== driver && typeof conn.release === 'function') conn.release();
      }
    },
  };
}

module.exports = { create };
