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
      const [raw, fields] = await conn.execute(stmt.text, stmt.params || []);
      if (Array.isArray(raw)) {
        rows = normalizeRows(raw.map(_plain), fields, 'mysql');
        if (stmt.rowShape) docs = _core.restoreRows(stmt.rowShape, rows);
      } else {
        affectedRows = Number(raw.affectedRows || 0);
      }
    }
    return { docs, rows, affectedRows };
  }

  /**
   * 显式事务句柄：池 checkout 专用连接（失败直接上抛，无静默兜底）
   * + beginTransaction + 幂等 commit/rollback；release 归还连接（单连接为 no-op）。
   */
  async function openTransaction() {
    const { openAcquire } = require('./index'); // 延迟导入：避免与 index 的循环依赖
    const { conn, release } = await openAcquire(driver);
    await conn.beginTransaction();
    let closed = false;
    return {
      exec: (plan) => runStmts(conn, plan),
      async savepoint(name) {
        /* 保存点（嵌套事务用）；name 由 Host 生成（sp_<n>），非用户输入。
           MySQL 预备语句协议不支持 SAVEPOINT → 必须走 conn.query */
        await conn.query(`SAVEPOINT ${name}`);
      },
      async releaseSavepoint(name) {
        await conn.query(`RELEASE SAVEPOINT ${name}`);
      },
      async rollbackToSavepoint(name) {
        await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
      },
      async commit() {
        if (closed) return;
        closed = true;
        await conn.commit();
      },
      async rollback() {
        if (closed) return;
        closed = true;
        await conn.rollback();
      },
      release,
    };
  }

  /** 事务执行：基于 openTransaction（无第二套事务路径），任一失败整体回滚；
   *  body(exec, tx) 第二参数为事务句柄（供上层读保存点原语），可选——旧单参写法继续可用 */
  async function withTransaction(body) {
    const tx = await openTransaction();
    try {
      const out = await body(tx.exec, tx);
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
    kind: 'mysql',
    exec: (plan) => runStmts(driver, plan),
    withTransaction,
    openTransaction,
  };
}

module.exports = { create };
