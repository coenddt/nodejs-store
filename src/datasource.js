'use strict';

/**
 * 数据源路由（多后端）
 *
 * core 产出的 Command 携带 `source` / `namespace` / `collection` 三元组
 * （见 rust-store/core 的 Command 契约），Host 只按 `source` 选连接、
 * 按 `namespace` 定位连接内的库/schema：
 *   - Mongo 源：直接交原生驱动（`db.collection(...)`）
 *   - SQL 源（mysql / postgres / sqlite）：先经 core `dialectTranslate` 翻译为
 *     SQL 语句序列，再交该连接的 `exec` 执行器
 *
 * Mongo 连接支持两种形态（绝不猜，按命令的 namespace 严格校验）：
 *   - db 实例：命令 `namespace` 必须为 null（db 实例无法跨库，非 null 显式报错）
 *   - MongoClient：命令 `namespace` 必须非 null（db 名）→ `client.db(ns).collection(...)`
 *
 * 数据源名缺省为 `default`；`init` 传入单个 Mongo db 实例时自动归一为
 * `{ default: db }`，保证既有单库调用零变更。
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { core: _core, get: _getSchema } = require('./schema');
const { emit: _emitFeedback } = require('./feedback');
const executors = require('./executors');

const DEFAULT_SOURCE = 'default';

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

/** 归一化连接映射：单个 Mongo db 实例 / MongoClient → `{ default: 连接 }` */
function _normalize(connections) {
  if (_isMongoHandle(connections)) {
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

/** 连接是否为 SQL 执行器描述符（`{ kind, exec }`；Mongo 为驱动实例） */
function isSqlConnection(connection) {
  return (
    !!connection &&
    typeof connection.kind === 'string' &&
    typeof connection.exec === 'function'
  );
}

/** 数据源名是否绑定 SQL 源 */
function isSql(source) {
  return isSqlConnection(getConnection(source));
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
 * 事务作用域：在单个 SQL 源上以「同连接 + 同事务」执行 fn 内的全部命令
 *
 *   - fn 内经 `_exec` 路由到该 source 的命令全部落到事务连接（commit/rollback 一体）；
 *   - Mongo 源 / 执行器未实现 withTransaction / 多源混合时按原样执行
 *     （跨源无法原子 —— 信任边界见 README「事务边界」），绝不静默假装已事务化；
 *   - 同源嵌套：在已持有的事务连接上开保存点 SAVEPOINT sp_<n>（内层失败 ROLLBACK TO 本层，
 *     外层可继续）；句柄无保存点原语则降级并入外层发 nested_savepoint_unsupported；
 *   - 事务体抛错统一 rollback 后原样上抛。
 */
async function runInTransaction(source, fn) {
  const session = currentSession();
  if (session !== null) {
    // 会话内：事务边界由会话统一管理；本层作为嵌套作用域开保存点（失败只回滚本层）
    return session.nestedScope(fn);
  }
  const conn = getConnection(source);
  if (!isSqlConnection(conn) || typeof conn.withTransaction !== 'function') {
    return fn();
  }
  const parent = _txStore.getStore();
  const store = new Map(parent || []);
  if (store.has(source)) {
    // 同源嵌套事务：在已持有的事务连接上开保存点（内层失败只回滚本层，外层可继续）
    return nestedSavepointScope(source, store.get(source), fn);
  }
  const txDescriptor = { kind: conn.kind, exec: null, tx: null };
  store.set(source, txDescriptor);
  return _txStore.run(store, () =>
    conn.withTransaction(async (execOnTx, tx) => {
      txDescriptor.exec = execOnTx;
      txDescriptor.tx = tx;
      return fn();
    }),
  );
}

/**
 * Mongo 源：按命令的 `namespace` 解析目标 db（两种形态，绝不猜）
 *
 *   - db 实例（`db.collection` 为函数）：namespace 必须为 null，非 null 显式报错；
 *   - MongoClient（`db` 为函数且无 `collection`）：namespace 必须非 null，
 *     返回 `client.db(namespace)`；
 *   - 非 Mongo（SQL 描述符）返回 null，由调用方走 SQL 路径。
 */
function mongoDb(connection, source, namespace) {
  if (typeof connection.collection === 'function') {
    if (namespace) {
      throw new Error(
        `数据源 ${source} 是 Mongo db 实例，命令携带了 namespace="${namespace}"（db 实例不支持跨库；跨库请改传 MongoClient 并用 schema.namespace 声明库名）`,
      );
    }
    return connection;
  }
  if (typeof connection.db === 'function') {
    if (!namespace) {
      throw new Error(
        `数据源 ${source} 是 MongoClient，命令缺少 namespace（ MongoClient 形态必须在 schema 声明 namespace 即 db 名）`,
      );
    }
    return connection.db(namespace);
  }
  return null;
}

/** schema 声明的数据源名（缺省 `default`） */
function sourceOfSchema(name) {
  return _getSchema(name).datasource || DEFAULT_SOURCE;
}

/** 某 schema 所属数据源的连接（供 Host 侧直连场景） */
function connectionOfSchema(name) {
  return getConnection(sourceOfSchema(name));
}

/** 某 schema 的 Mongo db 句柄（按镜像的 datasource + namespace 解析；SQL 源返回 null） */
function dbOfSchema(name) {
  const s = _getSchema(name);
  const source = s.datasource || DEFAULT_SOURCE;
  return mongoDb(getConnection(source), source, s.namespace || null);
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
  const plan = _core.dialectTranslate(connection.kind, cmd);
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
 * 在指定 SQL 源上执行原生 SQL（Host 层逃生口，绕开 core 的 dialectTranslate）
 *
 *   - 事务 / 会话作用域内经 `resolveConnection` 落到事务专用连接 → 支持 SELECT ... FOR UPDATE；
 *   - 占位符沿用各后端原生风格（mysql/sqlite 用 `?`，postgres 用 `$1..$n`）；
 *   - 仅支持 SQL 源；Mongo 源显式报错（绝不静默）；
 *   - `isWrite=false` 视为读（取行）；`true` 视为写（取影响行数）；
 *   - 返回 `{ rows, affectedRows }`。
 *   对齐 py_store/datasource.py#execute_raw。
 */
async function executeRaw(source, sql, params = [], isWrite = false) {
  const conn = await resolveConnection(source, isWrite);
  if (!conn || typeof conn.kind !== 'string') {
    throw new RawSqlError(
      `数据源 ${source} 不是 SQL 源（原生 SQL 入口仅支持 mysql/postgres/sqlite）`,
    );
  }
  if (typeof conn.exec !== 'function') {
    throw new RawSqlError(`SQL 数据源 ${source}(${conn.kind}) 的执行器未接入`);
  }
  const stmt = { text: sql, params: Array.from(params || []), isWrite: Boolean(isWrite) };
  const out = await conn.exec({ stmts: [stmt] });
  return { rows: out.rows ?? null, affectedRows: Number(out.affectedRows || 0) };
}

/**
 * 显式会话（工作单元）
 *
 *   - 惰性开事务：命令真正落到某 SQL 源时才 checkout 并 BEGIN（空会话不占连接）；
 *   - Mongo 源 / 缺 openTransaction 的执行器 → 直通 + 告警一次（绝不静默）；
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
    this._views = new Map();     // source -> { kind, exec, tx } | null（null = 直通）
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

  /** 解析并缓存该源的事务视图；返回 { kind, exec, tx } 或 null（直通） */
  async _openView(source) {
    const override = _txStore.getStore();
    if (override && override.has(source) && override.get(source).exec) {
      // 外层事务（runInTransaction / 外层会话）已绑定该源 → 复用，不新开事务、不告警
      return override.get(source);
    }
    const connection = getConnection(source);
    if (isSqlConnection(connection) && typeof connection.openTransaction === 'function') {
      const tx = await connection.openTransaction();
      this._txs.set(source, tx);
      this._opened.push(source);
      return { kind: connection.kind, exec: tx.exec, tx };
    }
    if (isSqlConnection(connection)) this._warnNotAtomic(source, connection.kind);
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
  setConnections,
  getConnection,
  hasConnection,
  isSqlConnection,
  isSql,
  connectionFor,
  resolveConnection,
  runInTransaction,
  nestedSavepointScope,
  warnSavepointUnavailable,
  warnSavepointFailed,
  mongoDb,
  sourceOfSchema,
  connectionOfSchema,
  dbOfSchema,
  route,
  execSql,
  executeRaw,
  isWriteCommand,
  currentSession,
  runWithSession,
  Session,
  NonAtomicWriteError,
  PushdownUnsupportedError,
  RawSqlError,
};
