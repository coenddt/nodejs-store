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

const mongo = require('./mongo');
const mysql = require('./mysql');
const postgres = require('./postgres');
const sqlite = require('./sqlite');

const _BACKENDS = { mysql, postgres, sqlite };

// 注意：sqlite 执行器基于 better-sqlite3 同步驱动，调用期间会阻塞事件循环
// （设计选择，非缺陷）——高并发主链路请用 mysql/postgres/mongo，或为 SQLite
// 单独起独立进程；详见 ./sqlite.js 模块头「同步阻塞说明」。

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

// openAcquire 已下沉 ./open（D4-1 解环：mysql/postgres 只需这一个纯鸭子类型
// 函数，不再回指本索引）；此处 re-export 保持对外导出面不变。
const { openAcquire } = require('./open');

/** insertOne 塑形：autoincrement 主键回读（详见 crud/exec.js 对应分支） */
function _shapeInsertOne(cmd, out) {
  const doc = cmd.doc;
  // 阶段2：autoincrement 主键 —— doc 无 `_id`（core 不注入）→ 从执行包络回读
  // 自增值（PG/SQLite RETURNING 走 rows；MySQL/SQLite lastInsertRowid 走 insertId）
  if (doc && !doc._id) {
    let rid = null;
    if (out.rows && out.rows[0] && Object.prototype.hasOwnProperty.call(out.rows[0], '_id')) {
      rid = out.rows[0]._id;
    } else if (out.insertId !== null && out.insertId !== undefined) {
      rid = out.insertId;
    }
    if (rid !== null && rid !== undefined) return { ...doc, _id: rid };
  }
  return doc;
}

const _firstDoc = (out) => (out.docs && out.docs[0]) || null;

// kind → 塑形器（Object.create(null) 防原型键误命中；未登记 kind 等价原 default 分支）
// 统一签名 (cmd, out)：读类只用 out；写类（insertOne/insertMany）还要读 cmd（主键回读/计数）
const _SHAPERS = Object.assign(Object.create(null), {
  find: (_cmd, out) => out.docs || [],
  aggregate: (_cmd, out) => out.docs || [],
  findOne: (_cmd, out) => _firstDoc(out),
  findOneAndUpdate: (_cmd, out) => _firstDoc(out),
  countDocuments: (_cmd, out) => _scalar(out.rows),
  insertOne: (cmd, out) => _shapeInsertOne(cmd, out),
  insertMany: (cmd) => ({ insertedCount: (cmd.docs || []).length }),
  updateMany: (_cmd, out) => ({ modifiedCount: out.affectedRows }),
  deleteMany: (_cmd, out) => ({ deletedCount: out.affectedRows }),
});

/** 中立包络 → Mongo 驱动等价返回值 */
function shapeResult(cmd, out) {
  const shape = _SHAPERS[cmd.kind];
  return shape ? shape(cmd, out) : out;
}

module.exports = { createConnection, openAcquire, shapeResult, mongo, mysql, postgres, sqlite };
