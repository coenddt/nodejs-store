'use strict';

/**
 * SQL 执行器注册与结果塑形（Phase 4）
 *
 * 分层（对齐铁律 1/8）：
 *   core `dialectTranslate`（纯逻辑，产 SQL + rowShape）
 *     → 执行器 `{mysql,postgres,sqlite}`（绑定参数 + 执行 + `restoreRows`）
 *     → 本模块把中立包络 `{docs, rows, affectedRows}` 塑形为 **Mongo 驱动等价返回值**
 *
 * 塑形规则与 `crud/exec.js#_execMongo` 逐一对应，保证 Mongo / SQL 两条路径对上层
 * （`crud/query|write|mutation`）透明：上层只看到同一套返回值语义。
 */

const mysql = require('./mysql');
const postgres = require('./postgres');
const sqlite = require('./sqlite');

const _BACKENDS = { mysql, postgres, sqlite };

/** 创建 SQL 数据源连接描述符 `{ kind, exec }`（driver 为对应驱动实例/连接） */
function createConnection(kind, driver, options) {
  const mod = _BACKENDS[kind];
  if (!mod) throw new Error(`未知 SQL 后端: ${kind}（支持 mysql/postgres/sqlite）`);
  return mod.create(driver, options);
}

/** 取行首列标量（COUNT 等聚合列无稳定别名，取首个值；PG 的 bigint 为字符串需数值化） */
function _scalar(rows) {
  const row = rows && rows[0];
  if (!row) return 0;
  const v = Object.values(row)[0];
  return typeof v === 'string' ? Number(v) : v;
}

/** 中立包络 → Mongo 驱动等价返回值 */
function shapeResult(cmd, out) {
  switch (cmd.kind) {
    case 'find':
    case 'aggregate':
      return out.docs || [];
    case 'findOne':
    case 'findOneAndUpdate':
      return (out.docs && out.docs[0]) || null;
    case 'countDocuments':
      return _scalar(out.rows);
    case 'insertOne':
      return cmd.doc;
    case 'insertMany':
      return { insertedCount: (cmd.docs || []).length };
    case 'updateMany':
      return { modifiedCount: out.affectedRows };
    case 'deleteMany':
      return { deletedCount: out.affectedRows };
    default:
      return out;
  }
}

module.exports = { createConnection, shapeResult, mysql, postgres, sqlite };
