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
  return {
    kind: 'postgres',
    async exec(plan) {
      let docs = null;
      let rows = null;
      let affectedRows = 0;
      for (const stmt of plan.stmts) {
        const res = await driver.query(stmt.text, stmt.params || []);
        rows = res.rows || [];
        affectedRows = Number(res.rowCount || 0);
        if (stmt.rowShape) docs = _core.restoreRows(stmt.rowShape, rows);
      }
      return { docs, rows, affectedRows };
    },
  };
}

module.exports = { create };
