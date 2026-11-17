'use strict';

/**
 * Mongo 源判别、事务能力探测与 schema 路由（D4-4 零语义拆分自 datasource.js）
 *
 * 承载：Mongo db 句柄解析（db 实例 / MongoClient 两形态，绝不猜）、事务能力四态探测
 * （true / false / null，按 client 缓存）、schema → 数据源 → 连接的解析。
 */

const { get: _getSchema } = require('../schema');
const { emit: _emitFeedback } = require('../feedback-core');
const { DEFAULT_SOURCE, _mongoTxCap } = require('./state');
const { getConnection, isSqlConnection } = require('./conn');

/**
 * Mongo 源：按命令的 `database` 解析目标 db（两种形态，绝不猜）
 *
 *   - db 实例（`db.collection` 为函数）：database 必须为 null，非 null 显式报错；
 *   - MongoClient（`db` 为函数且无 `collection`）：database 必须非 null，
 *     返回 `client.db(database)`；
 *   - 非 Mongo（SQL 描述符）返回 null，由调用方走 SQL 路径。
 */
function mongoDb(connection, source, database) {
  if (typeof connection.collection === 'function') {
    if (database) {
      throw new Error(
        `数据源 ${source} 是 Mongo db 实例，命令携带了 database="${database}"（db 实例不支持跨库；跨库请改传 MongoClient 并用 schema.database 声明库名）`,
      );
    }
    return connection;
  }
  if (typeof connection.db === 'function') {
    if (!database) {
      throw new Error(
        `数据源 ${source} 是 MongoClient，命令缺少 database（ MongoClient 形态必须在 schema 声明 database 即 db 名）`,
      );
    }
    return connection.db(database);
  }
  return null;
}

/** MongoClient 形态判别（db 实例有 collection 函数，MongoClient 只有 db） */
function isMongoClientHandle(x) {
  return !!x && typeof x.db === 'function' && typeof x.collection !== 'function';
}

/** Mongo 连接的 client：db 实例取 `.client`；MongoClient 返回自身；其余 null */
function mongoClientOf(connection) {
  if (isMongoClientHandle(connection)) return connection;
  return (connection && connection.client) || null;
}

/**
 * 探测 Mongo 部署是否支持多文档事务（四态，绝不猜；结果按 client 缓存）
 *   - true : 支持（replica set 的 setName，或 sharded 的 msg === 'isdbgrid'）
 *   - false: 不支持（standalone）
 *   - null : 探测失败 / 无法探测（unknown；不写缓存，下次重探）
 * 经 admin 库的 hello 命令探测（只读、幂等、驱动无关）。
 */
async function mongoTransactable(connection) {
  const client = mongoClientOf(connection);
  if (!client) return null;
  if (_mongoTxCap.has(client)) return _mongoTxCap.get(client);
  let hello;
  try {
    hello = await client.db('admin').command({ hello: 1 });
  } catch (e) {
    // 探测失败 → 按语义返回 unknown（不写缓存、下次重探），但显式留痕（禁静默失守）
    _emitFeedback({
      type: 'mongo_transaction_probe_failed',
      code: 'mongoTransactionProbeFailed',
      layer: 'datasource',
      message: `数据源 Mongo 事务能力探测失败（按 unknown 处理，不缓存）：${e && e.message ? e.message : e}`,
      hint: '检查 admin 库 hello 命令可达性（认证/网络）；探测成功前事务判定按 unknown 走',
    });
    return null;
  }
  const cap = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  _mongoTxCap.set(client, cap);
  return cap;
}

/** 数据源名是否绑定 Mongo 源（非 SQL 描述符即 Mongo 驱动实例 / Mongo 事务视图） */
function isMongoSource(source) {
  return !isSqlConnection(getConnection(source));
}

/** Mongo 部署不支持事务 → 降级按原样执行（允许降级，禁止静默）
 *
 * deployment: 'standalone'（探测为不支持）| 'unknown'（探测失败/无法探测）。
 */
function warnMongoUnsupported(source, deployment) {
  _emitFeedback({
    type: 'mongo_transaction_unsupported',
    code: 'mongoTransactionUnsupported',
    layer: 'datasource',
    deployment,
    message: `数据源 ${source} 的 Mongo 部署不支持多文档事务（${deployment}）：本次调用按原样执行（非原子）`,
    hint: '将 MongoDB 部署为 replica set 或 sharded cluster 以启用 session 事务；standalone 无此能力',
    source,
  });
}

/** schema 声明的数据源名（缺省 `default`） */
function sourceOfSchema(name) {
  return _getSchema(name).datasource || DEFAULT_SOURCE;
}

/** 某 schema 所属数据源的连接（供 Host 侧直连场景） */
function connectionOfSchema(name) {
  return getConnection(sourceOfSchema(name));
}

/** 某 schema 的 Mongo db 句柄（按镜像的 datasource + database 解析；SQL 源返回 null） */
function dbOfSchema(name) {
  const s = _getSchema(name);
  const source = s.datasource || DEFAULT_SOURCE;
  return mongoDb(getConnection(source), source, s.database || null);
}

/** Command.source → `{ source, connection }`（三元组中的 source 精确路由） */
function route(cmd) {
  const source = cmd.source || DEFAULT_SOURCE;
  return { source, connection: getConnection(source) };
}

module.exports = {
  mongoDb,
  isMongoClientHandle,
  mongoClientOf,
  mongoTransactable,
  isMongoSource,
  warnMongoUnsupported,
  sourceOfSchema,
  connectionOfSchema,
  dbOfSchema,
  route,
};
