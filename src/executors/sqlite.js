'use strict';

/**
 * SQLite 执行器（驱动：better-sqlite3）
 *
 * 只做「绑定参数 + 执行 + 回喂」（铁律 1/8）：SQL 全部由 core `dialectTranslate`
 * 产出，本模块不拼任何 SQL；带 `rowShape` 的语句结果交 core `restoreRows` 还原为
 * 嵌套文档。返回值是中立包络 `{ docs, rows, affectedRows }`，由 `./index.js`
 * 依 command.kind 塑形为 Mongo 驱动等价返回值。
 *
 * ⚠️ 同步阻塞说明：better-sqlite3 是**同步驱动**，`prepare/all/run` 在 async 契约内
 * 仍会**阻塞事件循环**（本模块保持同步调用是有意为之的设计选择：单连接语义最简、
 * 无跨线程开销）。高并发主链路请改用 MySQL / PostgreSQL / MongoDB 数据源，
 * 或为 SQLite 单独起独立进程隔离阻塞面——本执行器不适合多请求共享的事件循环热路径。
 */

const { core: _core } = require('../schema');

/** better-sqlite3 只接受 number/string/bigint/Buffer/null，布尔需显式转 0/1 */
function _bind(params) {
  return (params || []).map((v) => {
    if (v === true) return 1;
    if (v === false) return 0;
    return v === undefined ? null : v;
  });
}

/** 创建执行器描述符（可直接作为 `init(connections)` 的一个 SQL 数据源连接） */
function create(db, _options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('sqlite 执行器需要 better-sqlite3 Database 实例');
  }

  /** 依序执行 plan.stmts（better-sqlite3 同步单连接；同步调用会阻塞事件循环，见模块头说明） */
  function runStmts(plan) {
    let docs = null;
    let rows = null;
    let affectedRows = 0;
    for (const stmt of plan.stmts) {
      const params = _bind(stmt.params);
      // 带 RETURNING 的写语句同样返回行 → 必须用 all() 取回；其余写语句用 run() 取影响行数
      if (!stmt.isWrite || stmt.rowShape) {
        rows = db.prepare(stmt.text).all(...params);
        if (stmt.rowShape) docs = _core.restoreRows(stmt.rowShape, rows);
      } else {
        affectedRows = Number(db.prepare(stmt.text).run(...params).changes || 0);
      }
    }
    return { docs, rows, affectedRows };
  }

  return {
    kind: 'sqlite',
    exec: runStmts,
    /** 事务执行：显式 BEGIN/COMMIT/ROLLBACK（better-sqlite3 默认 autocommit，显式开事务安全） */
    async withTransaction(body) {
      db.exec('BEGIN');
      try {
        const out = await body(runStmts);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch (_) {
          /* rollback 失败不掩盖原始错误 */
        }
        throw e;
      }
    },
  };
}

module.exports = { create };
