'use strict';

/**
 * 数据源路由（多后端）
 *
 * core 产出的 Command 携带 `source` / `database` / `schema` / `collection` 定位四元组
 * （见 rust-store/core 的 Command 契约），Host 只按 `source` 选连接、
 * 按 `database`（PG 另加 `schema`）定位连接内的库/schema：
 *   - Mongo 源：直接交原生驱动（`db.collection(...)`）
 *   - SQL 源（mysql / postgres / sqlite）：先经 core `dialectTranslate` 翻译为
 *     SQL 语句序列，再交该连接的 `exec` 执行器
 *
 * Mongo 连接支持两种形态（绝不猜，按命令的 database 严格校验）：
 *   - db 实例：命令 `database` 必须为 null（db 实例无法跨库，非 null 显式报错）
 *   - MongoClient：命令 `database` 必须非 null（db 名）→ `client.db(db).collection(...)`
 *
 * 数据源名缺省为 `default`；`init` 传入单个 Mongo db 实例时自动归一为
 * `{ default: db }`，保证既有单库调用零变更。
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { getCore, get: _getSchema } = require('./schema');
const { emit: _emitFeedback } = require('./feedback');
const executors = require('./executors');

const DEFAULT_SOURCE = 'default';

/** 本地磁盘数据源类型标记（连接描述符与事务视图均携带该 `kind`） */
const LOCAL_KIND = 'local';

let _connections = Object.create(null);

/** 事务作用域的连接覆盖：source → 事务描述符（见 runInTransaction） */
const _txStore = new AsyncLocalStorage();

/** 当前会话：优先于 _txStore（会话内部自持事务连接） */
const _sessionStore = new AsyncLocalStorage();

/** 写命令 kind（与 crud 侧 Command.kind 一致） */
const WRITE_KINDS = new Set([
  'insertOne',
  'insertMany',
  'updateMany',
  'findOneAndUpdate',
  'deleteMany',
]);

/** SQL 后端 kind 白名单（Mongo 驱动实例 / Mongo 事务视图一律非 SQL） */
const SQL_KINDS = new Set(['mysql', 'postgres', 'sqlite']);

/** Mongo 事务能力缓存：client -> true/false（探测失败不写缓存，下次重探） */
const _mongoTxCap = new WeakMap();

/** 命令是否为写命令（跨源写 fail-closed 判定用） */
function isWriteCommand(cmd) {
  return !!cmd && WRITE_KINDS.has(cmd.kind);
}

/** 会话内写入了多个数据源：跨源写无法原子（fail-closed，绝不静默提交半截） */
class NonAtomicWriteError extends Error {
  constructor(sources) {
    const list = Array.from(sources).sort();
    super(
      `会话内写入了多个数据源（${list.join(', ')}）：跨源写无法原子（Phase 1 未提供分布式事务）；请拆分为多个会话，或改用单一数据源`,
    );
    this.name = 'NonAtomicWriteError';
    this.sources = list;
  }
}

/** 当前生效会话（无则 null） */
function currentSession() {
  return _sessionStore.getStore() || null;
}

/**
 * SQL 下推遇到无法安全翻译的组合（core 标记 unsupported）
 *
 * 显式报错而非静默执行「缺少该段」的 SQL（会返回错误结果）；
 * 自动反馈：触发原因见 message，修复指引见 feedback()。
 */
class PushdownUnsupportedError extends Error {
  constructor(source, kind, codes, warnings) {
    super(`SQL 下推不支持（${kind}）: ${codes.join(', ')}；${warnings.join(' / ')}`);
    this.name = 'PushdownUnsupportedError';
    this.source = source;
    this.kind = kind;
    this.codes = codes;
    this.warnings = warnings;
  }

  /** 转统一反馈事件（与 feedback.emit 的事件形状一致） */
  feedback() {
    return {
      type: 'sql_pushdown_unsupported',
      code: 'pushdownUnsupported',
      layer: 'dialect',
      message: this.message,
      hint: '改写查询避开该组合，或改用 Mongo 源执行该段取数',
      source: this.source,
      kind: this.kind,
    };
  }
}

/** Mongo 形态判别：db 实例（collection 为函数）或 MongoClient（db 为函数且无 collection） */
function _isMongoHandle(x) {
  return (
    !!x &&
    (typeof x.collection === 'function' ||
      (typeof x.db === 'function' && typeof x.collection !== 'function'))
  );
}

/** 归一化连接映射：单个 Mongo db 实例 / MongoClient / 裸 local 描述符 → `{ default: 连接 }` */
function _normalize(connections) {
  if (_isMongoHandle(connections) || isLocalConnection(connections)) {
    return { [DEFAULT_SOURCE]: connections };
  }
  return connections || {};
}

/** 设置数据源连接映射（Mongo 传 db 实例或 MongoClient；SQL 传 `{ kind, exec }` 描述符） */
function setConnections(connections) {
  _connections = Object.assign(Object.create(null), _normalize(connections));
}

/** 取指定数据源连接（未配置即报错） */
function getConnection(source) {
  const conn = _connections[source];
  if (conn === undefined) {
    throw new Error(
      `数据源未配置: ${source}（请检查 init(connections) 与 schema 的 datasource 绑定）`,
    );
  }
  return conn;
}

/** 指定数据源是否已在当前连接映射中配置（辅助动作「软跳过」判定用，如 init 建索引） */
function hasConnection(source) {
  return _connections[source] !== undefined;
}

/** 连接是否为 SQL 执行器描述符（`kind ∈ SQL_KINDS` 且 `exec` 为函数；Mongo 一律非 SQL） */
function isSqlConnection(connection) {
  return (
    !!connection &&
    SQL_KINDS.has(connection.kind) &&
    typeof connection.exec === 'function'
  );
}

/** 数据源名是否绑定 SQL 源 */
function isSql(source) {
  return isSqlConnection(getConnection(source));
}

/** 本地磁盘数据源判别：`kind === 'local'`（描述符与事务视图都携带 `handle`） */
function isLocalConnection(connection) {
  return !!connection && connection.kind === LOCAL_KIND;
}

/**
 * 当前生效连接：事务作用域内返回覆盖描述符，否则返回全局映射的连接
 * （`exec.js#_execOn` 经此取连接，使事务内所有命令落到专用连接）
 */
function connectionFor(source) {
  const store = _txStore.getStore();
  if (store && store.has(source)) return store.get(source);
  return getConnection(source);
}

/** 会话感知的连接解析：会话内返回事务覆盖，否则返回全局连接
 *
 * `crud.exec._execOn` 与 `executeRaw` 共用此入口，保证会话内命令
 * （含跨多次调用的 CRUD 与原生 SQL）落到同一事务连接。
 */
async function resolveConnection(source, isWrite = false) {
  const session = currentSession();
  if (session !== null) {
    const override = await session.connFor(source, isWrite);
    if (override !== null && override !== undefined) return override;
  }
  return connectionFor(source);
}

/** 在会话上下文内执行 fn（供 store.session 使用） */
function runWithSession(session, fn) {
  return _sessionStore.run(session, fn);
}

/** 嵌套作用域无保存点原语 → 降级并入外层（允许降级，禁止静默） */
function warnSavepointUnavailable(source) {
  _emitFeedback({
    type: 'nested_savepoint_unsupported',
    code: 'nestedSavepointUnsupported',
    layer: 'datasource',
    message: `数据源 ${source} 的事务句柄未提供保存点原语：嵌套作用域并入外层（该层失败将回滚整个外层事务）`,
    hint: '为执行器 openTransaction 句柄补 savepoint / releaseSavepoint / rollbackToSavepoint',
    source,
  });
}

/** 错误路径保存点回滚 / 释放失败：发反馈，绝不掩盖原始错误 */
function warnSavepointFailed(source, name, exc) {
  _emitFeedback({
    type: 'savepoint_failed',
    code: 'savepointFailed',
    layer: 'datasource',
    message: `保存点回滚/释放失败（${name}，数据源 ${source}）：${exc}`,
    hint: '检查该数据源连接与事务状态；该嵌套作用域可能未能独立回滚',
    source,
    savepoint: name,
  });
}

/** 回滚到保存点并释放；任一失败发 savepoint_failed（不掩盖原始错误） */
async function rollbackSavepoint(tx, source, name) {
  const errors = [];
  for (const op of ['rollbackToSavepoint', 'releaseSavepoint']) {
    try {
      await tx[op](name);
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length > 0) warnSavepointFailed(source, name, errors[0]);
}

/**
 * 同源嵌套事务作用域：在已持有的事务连接上开保存点
 *   - 外层句柄无 savepoint 原语 → 降级并入外层（同一外层作用域只告警一次）；
 *   - 成功 RELEASE；失败 ROLLBACK TO + RELEASE 后原样上抛（外层可继续）。
 */
async function nestedSavepointScope(source, outer, fn) {
  const tx = outer.tx;
  if (!tx || typeof tx.savepoint !== 'function') {
    if (!outer.spWarned) {
      outer.spWarned = true;
      warnSavepointUnavailable(source);
    }
    return fn();
  }
  const depth = (outer.spDepth || 0) + 1;
  outer.spDepth = depth;
  const name = `sp_${depth}`;
  await tx.savepoint(name); // 创建失败直接上抛（保存点不存在，无需回滚）
  let out;
  try {
    out = await fn();
  } catch (e) {
    await rollbackSavepoint(tx, source, name);
    throw e;
  } finally {
    outer.spDepth = depth - 1;
  }
  await tx.releaseSavepoint(name);
  return out;
}

/**
 * 事务作用域：在单个源上以「同连接 + 同事务」执行 fn 内的全部命令
 *
 *   - 会话内调用：并入会话（事务边界由会话统一管理），不另开事务；
 *   - SQL 源且执行器实现 withTransaction：包事务；同源嵌套开 SAVEPOINT sp_<n>；
 *   - SQL 源且执行器**未**实现 withTransaction：按原样执行并发 `transaction_not_atomic`
 *     （降级不静默，与 `store.session` 的 `session_not_atomic` 对称）；
 *   - Mongo 源：探测可事务（replica set / sharded）→ 包 session 事务；standalone / unknown
 *     → 发 `mongo_transaction_unsupported` 并按原样执行（绝不静默假装已事务化）；
 *   - Mongo 无保存点原语：同源嵌套走既有 `nested_savepoint_unsupported` 降级声明；
 *   - 事务体抛错统一 rollback 后原样上抛。
 */
async function runInTransaction(source, fn) {
  const session = currentSession();
  if (session !== null) {
    // 会话内：事务边界由会话统一管理；本层作为嵌套作用域开保存点（失败只回滚本层）
    return session.nestedScope(fn);
  }
  const conn = getConnection(source);
  const parent = _txStore.getStore() || new Map();

  if (isLocalConnection(conn)) {
    // ── 本地磁盘分支（事务作用域）──
    if (typeof conn.withTransaction !== 'function') {
      // 降级不静默：显式声明本事务作用域未生效
      warnTransactionNotAtomic(source, conn.kind);
      return fn();
    }
    if (parent.has(source)) {
      // 同源嵌套：local 快照无保存点原语 → 走降级声明（nestedSavepointScope 内判定）
      return nestedSavepointScope(source, parent.get(source), fn);
    }
    const tx = await conn.openTransaction();
    const view = { kind: LOCAL_KIND, conn, session: tx.session, tx, handle: tx.handle };
    const store = new Map(parent);
    store.set(source, view);
    return _txStore.run(store, async () => {
      try {
        const out = await fn();
        await tx.commit();
        return out;
      } catch (e) {
        await tx.rollback();
        throw e;
      } finally {
        await tx.release();
      }
    });
  }

  if (isSqlConnection(conn)) {
    // ── SQL 分支（事务作用域）──
    if (typeof conn.withTransaction !== 'function') {
      // 降级不静默：与 store.session 的 session_not_atomic 对称，显式声明本事务作用域未生效
      warnTransactionNotAtomic(source, conn.kind);
      return fn();
    }
    if (parent.has(source)) {
      // 同源嵌套事务：在已持有的事务连接上开保存点（内层失败只回滚本层，外层可继续）
      return nestedSavepointScope(source, parent.get(source), fn);
    }
    const txDescriptor = { kind: conn.kind, exec: null, tx: null };
    const store = new Map(parent);
    store.set(source, txDescriptor);
    return _txStore.run(store, () =>
      conn.withTransaction(async (execOnTx, tx) => {
        txDescriptor.exec = execOnTx;
        txDescriptor.tx = tx;
        return fn();
      }),
    );
  }

  // ── Mongo 分支 ──
  if (parent.has(source)) {
    // 同源嵌套：Mongo 无保存点 → 复用降级声明（内层失败将回滚整个外层事务）
    return nestedSavepointScope(source, parent.get(source), fn);
  }
  const cap = await mongoTransactable(conn);
  if (cap !== true) {
    warnMongoUnsupported(source, cap === false ? 'standalone' : 'unknown');
    return fn();
  }
  const tx = await executors.mongo.openTransaction(conn);
  const view = { kind: 'mongo', conn, session: tx.session, tx };
  const store = new Map(parent);
  store.set(source, view);
  return _txStore.run(store, async () => {
    try {
      const out = await fn();
      await tx.commit();
      return out;
    } catch (e) {
      await tx.rollback();
      throw e;
    } finally {
      await tx.release();
    }
  });
}

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
  } catch (_) {
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

/** SQL 执行器未实现 withTransaction → 事务作用域按原样执行（允许降级，禁止静默）
 *
 * 与 `session_not_atomic`（会话路径）对称：同一类降级在两条入口（`store.transaction`
 * 与 `store.session`）都必须显式声明，不留静默口子。
 */
function warnTransactionNotAtomic(source, kind) {
  _emitFeedback({
    type: 'transaction_not_atomic',
    code: 'transactionNotAtomic',
    layer: 'datasource',
    message: `数据源 ${source}(${kind}) 未实现 withTransaction：事务作用域内命令按原样执行（非原子）`,
    hint: '为该执行器实现 withTransaction，或将写命令收敛到已支持事务的数据源',
    source,
    kind,
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

/**
 * SQL 路径：translate（core 纯逻辑）→ exec（连接执行器）→ 结果塑形
 *
 * 执行器只做「绑定参数 + 执行 + restoreRows」，返回中立包络；此处依 command.kind
 * 塑形为 Mongo 驱动等价返回值（见 `./executors/index.js#shapeResult`），
 * 使上层（crud/*）对 Mongo / SQL 两条路径无感。
 */
async function execSql(source, connection, cmd) {
  const plan = getCore().dialectTranslate(connection.kind, cmd);
  // Host 兜底：core 标记了无法安全下推的组合（如 $lookup 子 $limit 每父 top-N）时，
  // 绝不执行「缺少该段」的 SQL（会静默返回错误结果），改为显式报错，由调用方降级重查。
  // 先于执行器检查 —— 命令本身不可安全下推时，报下推不支持而非「执行器未接入」
  // （对齐 py_store/datasource.py#exec_sql 的检查次序）。
  if (Array.isArray(plan.unsupported) && plan.unsupported.length > 0) {
    const err = new PushdownUnsupportedError(
      source,
      connection.kind,
      plan.unsupported.map((u) => (u && u.code) || String(u)),
      (plan.warnings || []).map((w) => String(w)),
    );
    // 自动反馈：拦截即告警（无 sink 时打 stderr），禁止静默失守
    _emitFeedback(err.feedback());
    throw err;
  }
  if (typeof connection.exec !== 'function') {
    throw new Error(
      `SQL 数据源 ${source}(${connection.kind}) 的执行器未接入（见执行文档 Phase 4）`,
    );
  }
  const out = await connection.exec(plan);
  return executors.shapeResult(cmd, out);
}

/** 原生 SQL 入口的显式错误（非 SQL 源 / 执行器未接入） */
class RawSqlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RawSqlError';
  }
}

/**
 * 在指定 SQL 源上执行原生 SQL（Host 层逃生口，编译由 core 的 rawStmtCompile 完成）
 *
 * 两档参数风格（core 编译器按 params 类型自动分档）：
 *   - 位置档：params 为数组（或 null）→ SQL 原样透传，占位符为各后端原生风格
 *     （mysql/sqlite 用 `?`，postgres 用 `$1..$n`）；
 *   - 命名档：params 为对象 → SQL 文本中的 `:name` 编译为方言占位符（同名复用、
 *     跳过 `::` cast / 引号 / 注释边界；缺名 / 多余名显式报错）。
 *
 *   - 事务 / 会话作用域内经 `resolveConnection` 落到事务专用连接 → 支持 SELECT ... FOR UPDATE；
 *   - `isWrite` 缺省时由 SQL 首词推断（SELECT/WITH/EXPLAIN/SHOW/PRAGMA/TABLE 视为读，
 *     其余按写——默认写是安全方向）；显式传入则覆盖推断；
 *   - 仅支持 SQL 源；Mongo 源显式报错（绝不静默）；
 *   - 返回 `{ rows, affectedRows }`。
 *   对齐 py_store/datasource.py#execute_raw。
 */
async function executeRaw(source, sql, params = null, isWrite = null) {
  if (params != null && !Array.isArray(params) && typeof params !== 'object') {
    throw new RawSqlError(`原生 SQL params 仅支持数组（位置档）或对象（命名档），收到 ${typeof params}`);
  }
  const conn0 = connectionFor(source);
  if (!conn0 || !SQL_KINDS.has(conn0.kind)) {
    throw new RawSqlError(
      `数据源 ${source} 不是 SQL 源（原生 SQL 入口仅支持 mysql/postgres/sqlite）`,
    );
  }
  let compiled;
  try {
    compiled = getCore().rawStmtCompile(conn0.kind, sql, params ?? null, isWrite ?? null);
  } catch (e) {
    throw new RawSqlError((e && e.message) || String(e));
  }
  const conn = await resolveConnection(source, compiled.isWrite);
  if (!conn || typeof conn.exec !== 'function') {
    throw new RawSqlError(`SQL 数据源 ${source}(${conn && conn.kind}) 的执行器未接入`);
  }
  const stmt = { text: compiled.sql, params: compiled.params, isWrite: compiled.isWrite };
  const out = await conn.exec({ stmts: [stmt] });
  return { rows: out.rows ?? null, affectedRows: Number(out.affectedRows || 0) };
}

/** 原生 Mongo 命令入口的显式错误（非 Mongo 源 / 非 Mongo 形态） */
class NativeCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NativeCommandError';
  }
}

/**
 * 在指定 Mongo 源上执行原生聚合管道（Host 层逃生口，对标 SQL 侧 executeRaw）
 *
 *   - 复用 GQL 路径唯一的 Mongo IO 边界（executors/mongo.js#execMongo 的 aggregate
 *     分支），options 为驱动原生透传项（allowDiskUse/batchSize/hint/maxTimeMS…，
 *     宿主不做白名单）；
 *   - 事务 / 会话作用域内自动透传 session（session 由事务强制接管，
 *     options.session 不可覆盖）；统一按读路径解析（isWrite=false），
 *     $merge/$out 写管道请自行开事务；
 *   - 仅支持 Mongo 源：SQL 源显式报错并指引 executeRaw（绝不静默）；
 *     MongoClient 形态须经 schema 声明 database（mongoDb 既有校验，缺名即报错）；
 *   - 返回 `{ rows }`。
 *   对齐 py_store/datasource.py#execute_native。
 */
async function executeNative(source, collection, pipeline = [], options = null) {
  const conn = await resolveConnection(source, false);
  if (isSqlConnection(conn)) {
    throw new NativeCommandError(
      `数据源 ${source} 是 SQL 源（原生 Mongo 命令入口仅支持 mongo；SQL 源请用 executeRaw）`,
    );
  }
  const isTxView = !!conn && conn.kind === 'mongo';
  const isLocal = isLocalConnection(conn);
  const db = isLocal ? conn.handle : mongoDb(isTxView ? conn.conn : conn, source, null);
  if (!db) {
    throw new NativeCommandError(
      `数据源 ${source} 不是 Mongo 源（原生 Mongo 命令入口仅支持 mongo）`,
    );
  }
  const cmd = {
    kind: 'aggregate',
    collection,
    pipeline: Array.from(pipeline || []),
    options: { ...(options || {}) },
  };
  // 属性路径调用（monkeypatch 可拦截）；session 由事务强制注入（_opts 内覆盖用户值）
  const rows = await executors.mongo.execMongo(db, cmd, isTxView ? conn.session : null);
  return { rows };
}

/**
 * 显式会话（工作单元）
 *
 *   - 惰性开事务：命令真正落到某 SQL 源时才 checkout 并 BEGIN（空会话不占连接）；
 *   - Mongo 源按探测结果事务化；不可事务（standalone/unknown）→ 直通 +
 *     `mongo_transaction_unsupported` 声明（绝不静默）；
 *   - 跨源写 fail-closed：≥2 个源发生写命令 → 退出时全部 rollback 并抛
 *     NonAtomicWriteError；
 *   - 嵌套会话 / 会话内 transaction：作为嵌套作用域在已有事务上开保存点
 *     （内层失败只回滚本层；名字形如 sp_<n>）。
 *
 * 会话上下文由 `store.session` 用 `_sessionStore.run(session, fn)` 整体包裹
 * （见 index.js#session）；`Session` 自身不设置上下文，`bindOuter` 只记录父子关系。
 */
class Session {
  constructor() {
    this._views = new Map();     // source -> { kind, exec, tx } | Mongo 视图 | null（null = 直通）
    this._txs = new Map();       // source -> 显式事务句柄
    this._opened = [];           // 开启顺序
    this._wrote = new Set();     // 发生过写命令的 source
    this._warned = new Set();
    this._outer = null;
    this._spWarned = new Set();  // 无保存点原语的告警去重
    this._scopes = [];           // 嵌套作用域栈（仅最外层会话持有）
    this._spSeq = 0;             // 保存点命名序号（sp_<n>）
  }

  /** 绑定外层会话（嵌套时生命周期交外层）；由 store.session 调用，不设置上下文 */
  bindOuter(parent) {
    this._outer = parent;
    return this;
  }

  /** 退出会话：err 非空 → 全部回滚并原样上抛；否则跨源写判定后统一提交 */
  async exit(err) {
    if (this._outer !== null) return;
    if (err !== null && err !== undefined) {
      await this._finalize(false);
      throw err;
    }
    if (this._wrote.size > 1) {
      await this._finalize(false);
      throw new NonAtomicWriteError(this._wrote);
    }
    await this._finalize(true);
  }

  async _finalize(commit) {
    const errors = [];
    if (commit) {
      for (const source of this._opened) {
        try {
          await this._txs.get(source).commit();
        } catch (exc) {                     // 提交失败：其余全部回滚
          errors.push([source, exc]);
          for (const other of this._opened) {
            if (other === source) continue;
            try {
              await this._txs.get(other).rollback();
            } catch (exc2) {
              errors.push([other, exc2]);
            }
          }
          break;
        }
      }
    } else {
      for (const source of [...this._opened].reverse()) {
        try {
          await this._txs.get(source).rollback();
        } catch (exc) {
          errors.push([source, exc]);
        }
      }
    }
    for (const source of this._opened) {
      try {
        await this._txs.get(source).release();
      } catch (exc) {
        errors.push([source, exc]);
      }
    }
    this._views.clear();
    this._txs.clear();
    this._opened = [];
    for (const [source, exc] of errors) this._warnFinalizeFailure(source, commit, exc);
    if (errors.length > 0) throw errors[0][1];
  }

  /** 命令落到该源时解析连接：事务视图 / null（直通，用原始连接）
   *
   * 嵌套作用域内首次**写**某源时，在该事务连接上开保存点（惰性，只读不开）。
   */
  async connFor(source, isWrite = false) {
    if (isWrite) this._wrote.add(source);
    if (!this._views.has(source)) this._views.set(source, await this._openView(source));
    const view = this._views.get(source);
    if (isWrite && this._scopes.length > 0) await this._scopeSavepoints(source, view);
    return view;
  }

  /** 解析并缓存该源的事务视图；返回 { kind, exec, tx } /
   * { kind:'mongo', conn, session, tx } / null（直通） */
  async _openView(source) {
    const override = _txStore.getStore();
    if (override && override.has(source)) {
      const ov = override.get(source);
      if (ov.tx) return ov; // 外层事务已绑定该源 → 复用，不新开事务、不告警
    }
    const connection = getConnection(source);
    if (isSqlConnection(connection)) {
      if (typeof connection.openTransaction === 'function') {
        const tx = await connection.openTransaction();
        this._txs.set(source, tx);
        this._opened.push(source);
        return { kind: connection.kind, exec: tx.exec, tx };
      }
      this._warnNotAtomic(source, connection.kind);
      return null;
    }
    // 本地磁盘源：快照隔离开事务；无原语 → 声明未原子并直通
    if (isLocalConnection(connection)) {
      if (typeof connection.openTransaction === 'function') {
        const tx = await connection.openTransaction();
        this._txs.set(source, tx);
        this._opened.push(source);
        return {
          kind: LOCAL_KIND, conn: connection, session: tx.session, tx, handle: tx.handle,
        };
      }
      this._warnNotAtomic(source, connection.kind);
      return null; // 直通：_execOn 收到原始描述符（同样带 handle）
    }
    // Mongo 源（裸驱动实例）
    const cap = await mongoTransactable(connection);
    if (cap === true) {
      const tx = await executors.mongo.openTransaction(connection);
      this._txs.set(source, tx);
      this._opened.push(source);
      return { kind: 'mongo', conn: connection, session: tx.session, tx };
    }
    this._warnMongo(source, cap);
    return null;
  }

  // ---------- 嵌套作用域（嵌套会话 / 会话内 transaction） ----------

  /** 进入嵌套作用域（内层 session / 会话内 transaction） */
  pushScope() {
    const scope = { savepoints: new Map(), txs: new Map() };
    this._scopes.push(scope);
    return scope;
  }

  /** 退出嵌套作用域：按成败回滚到保存点或释放（失败发反馈，不掩盖原异常） */
  async popScope(scope, rollback) {
    try {
      for (const source of [...scope.savepoints.keys()].reverse()) {
        const name = scope.savepoints.get(source);
        if (name === null) continue;
        const tx = scope.txs.get(source);
        try {
          if (rollback) await tx.rollbackToSavepoint(name);
          await tx.releaseSavepoint(name);
        } catch (e) {
          warnSavepointFailed(source, name, e);
        }
      }
    } finally {
      const i = this._scopes.indexOf(scope);
      if (i >= 0) this._scopes.splice(i, 1);
    }
  }

  /** 会话内以嵌套作用域执行 fn（保存点隔离；失败只回滚本层） */
  async nestedScope(fn) {
    const scope = this.pushScope();
    let out;
    try {
      out = await fn();
    } catch (e) {
      await this.popScope(scope, true);
      throw e;
    }
    await this.popScope(scope, false);
    return out;
  }

  /** 嵌套作用域首次写到某源时开保存点（惰性；句柄无原语 → 降级 + 告警一次） */
  async _scopeSavepoints(source, view) {
    const tx = view && view.tx ? view.tx : null;
    for (const scope of this._scopes) {
      if (scope.savepoints.has(source)) continue;
      if (!tx || typeof tx.savepoint !== 'function') {
        this._warnScopeNoSavepoint(source);
        scope.savepoints.set(source, null);
        continue;
      }
      this._spSeq += 1;
      const name = `sp_${this._spSeq}`;
      await tx.savepoint(name); // 创建失败直接上抛（可见错误）
      scope.savepoints.set(source, name);
      scope.txs.set(source, tx);
    }
  }

  _warnScopeNoSavepoint(source) {
    if (this._spWarned.has(source)) return;
    this._spWarned.add(source);
    warnSavepointUnavailable(source);
  }

  // ---------- 告警（自动反馈：允许降级、禁止静默） ----------

  _warnNotAtomic(source, kind) {
    if (this._warned.has(source)) return;
    this._warned.add(source);
    _emitFeedback({
      type: 'session_not_atomic',
      code: 'sessionNotAtomic',
      layer: 'datasource',
      message: `数据源 ${source}(${kind}) 未实现 openTransaction：会话内该源命令按原样执行（非原子）`,
      hint: '为该执行器实现 openTransaction，或将该源的写命令移出会话',
      source,
      kind,
    });
  }

  /** Mongo 部署不支持事务 → 降级声明（同源只声明一次）；cap=false→standalone，null→unknown */
  _warnMongo(source, cap) {
    if (this._warned.has(source)) return;
    this._warned.add(source);
    warnMongoUnsupported(source, cap === false ? 'standalone' : 'unknown');
  }

  _warnFinalizeFailure(source, commit, exc) {
    _emitFeedback({
      type: 'session_finalize_failed',
      code: 'sessionFinalizeFailed',
      layer: 'datasource',
      message: `会话收尾失败（${commit ? 'commit' : 'rollback'}，数据源 ${source}）：${exc}`,
      hint: '检查该数据源连接状态；rollback 失败可能意味着连接已失效',
      source,
    });
  }

  // ---------- 会话 API（与 Store 同名同形，委托 crud） ----------

  async query(...a) {
    const crud = require('./crud');
    return crud.query(...a);
  }

  async queryOne(...a) {
    const crud = require('./crud');
    return crud.queryOne(...a);
  }

  async queryWithCount(...a) {
    const crud = require('./crud');
    return crud.queryWithCount(...a);
  }

  async insert(...a) {
    const crud = require('./crud');
    return crud.insert(...a);
  }

  async insertMany(...a) {
    const crud = require('./crud');
    return crud.insertMany(...a);
  }

  async update(...a) {
    const crud = require('./crud');
    return crud.update(...a);
  }

  async updateMany(...a) {
    const crud = require('./crud');
    return crud.updateMany(...a);
  }

  async upsert(...a) {
    const crud = require('./crud');
    return crud.upsert(...a);
  }

  async remove(...a) {
    const crud = require('./crud');
    return crud.remove(...a);
  }

  async exists(...a) {
    const crud = require('./crud');
    return crud.exists(...a);
  }

  async count(...a) {
    const crud = require('./crud');
    return crud.count(...a);
  }

  async mutation(...a) {
    const crud = require('./crud');
    return crud.mutation(...a);
  }

  async executeRaw(...a) {
    return executeRaw(...a);
  }
}

module.exports = {
  DEFAULT_SOURCE,
  LOCAL_KIND,
  setConnections,
  getConnection,
  hasConnection,
  isSqlConnection,
  isSql,
  isLocalConnection,
  connectionFor,
  resolveConnection,
  runInTransaction,
  nestedSavepointScope,
  warnSavepointUnavailable,
  warnSavepointFailed,
  warnTransactionNotAtomic,
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
  execSql,
  executeRaw,
  executeNative,
  isWriteCommand,
  currentSession,
  runWithSession,
  Session,
  NonAtomicWriteError,
  PushdownUnsupportedError,
  RawSqlError,
  NativeCommandError,
};
