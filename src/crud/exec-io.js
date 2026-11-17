'use strict';

/**
 * 命令执行 IO 边界（D4-4 零语义拆分自 crud/exec.js）
 *
 * 承载：Command JSON → 数据源路由与执行（Mongo 原生驱动 / 嵌入式载体 / SQL
 * translate→exec），含向量查询的应用层精确检索降级。权限/档位映射与多源编排留在
 * ../exec.js。
 */

const datasource = require('../datasource');
const { execMongo } = require('../executors/mongo');
const { _toMongo, _toLogical } = require('../naming');
const vectorScan = require('../vector-scan');
const degraded = require('../degraded');

/**
 * Mongo 原生执行 + 向量降级（03 §4.7）
 *
 * 真实驱动不认 `$vectorSearch`（非 Atlas / 未建向量索引）时，捕获该形态错误后
 * 取候选行 → core `localEval` 精确打分。`$vectorSearch.metric` 是 core 内部元数据键，
 * 只在物理命令副本上剥离（local 求值仍需该键）。
 */
async function _execMongoVector(db, cmd, session) {
  try {
    return _toLogical(
      await execMongo(db, vectorScan.stripVectorMeta(_toMongo(cmd)), session),
      cmd,
    );
  } catch (e) {
    if (!vectorScan.canScan(cmd, 'mongo') || !vectorScan.isUnsupportedStageError(e)) throw e;
    const spec = cmd.pipeline[0].$vectorSearch;
    degraded.vectorDegraded({
      backend: 'mongodb',
      field: spec.path,
      metric: spec.metric,
      message: vectorScan.DEGRADED_MESSAGES.mongodb,
      hint: vectorScan.DEGRADED_HINT,
    });
    return vectorScan.scan(cmd, {
      exec: async (candidate) => _toLogical(
        await execMongo(db, vectorScan.stripVectorMeta(_toMongo(candidate)), session),
        candidate,
      ),
    });
  }
}

/** 在指定数据源上执行命令（Mongo 走原生驱动，SQL 走 translate → exec；
 * 事务 / 会话作用域内经 datasource.resolveConnection 落到事务专用连接） */
async function _execOn(source, cmd) {
  const connection = await datasource.resolveConnection(source, datasource.isWriteCommand(cmd));
  // 嵌入式载体（local / memory）：与 Mongo 同路径（复用 execMongo）
  // 按命令的 database 取该库分区手柄；缺省回落描述符自身 handle（向后兼容）
  if (datasource.isEmbeddedConnection(connection)) {
    const db = typeof connection.handleFor === 'function'
      ? connection.handleFor(cmd.database ?? null)
      : connection.handle;
    // 嵌入式载体（local / memory）无原生近似索引：向量查询恒为应用层精确检索，
    // 须显式声明降级（06 §4.6 C10；native 是静态能力，不因此改变）
    if (vectorScan.canScan(cmd, datasource.kindOf(connection))) {
      const spec = cmd.pipeline[0].$vectorSearch;
      const kind = datasource.kindOf(connection);
      degraded.vectorDegraded({
        backend: kind,
        field: spec.path,
        metric: spec.metric,
        message: vectorScan.DEGRADED_MESSAGES[kind],
        hint: vectorScan.DEGRADED_HINT,
      });
    }
    return _toLogical(await execMongo(db, _toMongo(cmd)), cmd);
  }
  if (connection && connection.kind === 'mongo') {
    // Mongo 事务视图：db 按命令 database 解析，session 透传给驱动
    const db = datasource.mongoDb(connection.conn, source, cmd.database ?? null);
    return _execMongoVector(db, cmd, connection.session);
  }
  const db = datasource.mongoDb(connection, source, cmd.database ?? null);
  if (db) {
    // Mongo 物理名翻译（逻辑 → camelCase）；执行后按 schema 逆表回映射（物理 → 逻辑）
    return _execMongoVector(db, cmd, undefined);
  }
  return datasource.execSql(source, connection, cmd);
}

/** Command JSON → 按命令自带的 `source` 路由（不按 collection 反查） */
async function _exec(cmd) {
  return _execOn(cmd.source || datasource.DEFAULT_SOURCE, cmd);
}

module.exports = { _execMongoVector, _execOn, _exec };
