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
const { normalizeRows } = require('./_values');
const txShared = require('./tx'); // D4-2 去重：事务骨架与 postgres/sqlite 共享（./tx）

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
    let insertId = null;
    for (const stmt of plan.stmts) {
      const [raw, fields] = await conn.execute(stmt.text, stmt.params || []);
      if (Array.isArray(raw)) {
        rows = normalizeRows(raw.map(_plain), fields, 'mysql');
        if (stmt.rowShape) docs = _core.restoreRows(stmt.rowShape, rows);
      } else {
        affectedRows = Number(raw.affectedRows || 0);
        // 阶段2：autoincrement 主键写后自增值回读（MySQL 无 RETURNING，insertId =
        // 本连接最近一次 INSERT 生成的自增值）
        insertId = Number(raw.insertId);
      }
    }
    return { docs, rows, affectedRows, insertId };
  }

  /**
   * 显式事务句柄：池 checkout 专用连接（失败直接上抛，无静默兜底）
   * + beginTransaction + 幂等 commit/rollback；release 归还连接（单连接为 no-op）。
   * 骨架在 ./tx 与 postgres 共享，方言差异仅 BEGIN/COMMIT/ROLLBACK 的驱动调用形态。
   */
  const openTransaction = () =>
    txShared.pooledTransaction({
      driver,
      execOn: runStmts,
      begin: (conn) => conn.beginTransaction(),
      commit: (conn) => conn.commit(),
      rollback: (conn) => conn.rollback(),
    });

  /** 事务执行：基于 openTransaction（无第二套事务路径），任一失败整体回滚；
   *  body(exec, tx) 第二参数为事务句柄（供上层读保存点原语），可选——旧单参写法继续可用 */
  const withTransaction = (body) => txShared.withTransaction(openTransaction, body);

  return {
    kind: 'mysql',
    exec: (plan) => runStmts(driver, plan),
    withTransaction,
    openTransaction,
  };
}

module.exports = { create };
