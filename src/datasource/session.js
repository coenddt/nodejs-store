'use strict';

/**
 * 显式会话（工作单元）（D4-4 零语义拆分自 datasource.js）
 *
 * 承载：`Session` 类（惰性开事务、跨源写 fail-closed、嵌套保存点作用域、
 * 会话 API 委托）与提交失败时回滚其余事务的收尾逻辑。
 */

const { emit: _emitFeedback } = require('../feedback-core');
const { NonAtomicWriteError } = require('../errors');
const executors = require('../executors');
const { _txStore, _crud } = require('./state');
const { getConnection, isSqlConnection, isEmbeddedConnection } = require('./conn');
const { mongoTransactable, warnMongoUnsupported } = require('./mongo');
const { warnSavepointUnavailable, warnSavepointFailed } = require('./tx');
const { executeRaw } = require('./raw');

/** 提交失败：回滚其余全部已开事务（其余的失败同样收集进 errors，不掩盖首个提交错误） */
async function _rollbackOthers(txs, opened, source, errors) {
  for (const other of opened) {
    if (other === source) continue;
    try {
      await txs.get(other).rollback();
    } catch (exc2) {
      errors.push([other, exc2]);
    }
  }
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
          await _rollbackOthers(this._txs, this._opened, source, errors);
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

  /** 开事务并登记到会话（_openView 三载体共用；commit/rollback 由 commitAll/rollbackAll 统一收口） */
  async _openRegisteredTx(source, open) {
    const tx = await open();
    this._txs.set(source, tx);
    this._opened.push(source);
    return tx;
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
        const tx = await this._openRegisteredTx(source, () => connection.openTransaction());
        return { kind: connection.kind, exec: tx.exec, tx };
      }
      this._warnNotAtomic(source, connection.kind);
      return null;
    }
    // 嵌入式载体（local / memory）：快照隔离开事务；无原语 → 声明未原子并直通
    if (isEmbeddedConnection(connection)) {
      if (typeof connection.openTransaction === 'function') {
        const tx = await this._openRegisteredTx(source, () => connection.openTransaction());
        return {
          kind: connection.kind, conn: connection, session: tx.session, tx, handle: tx.handle,
        };
      }
      this._warnNotAtomic(source, connection.kind);
      return null; // 直通：_execOn 收到原始描述符（同样带 handle）
    }
    // Mongo 源（裸驱动实例）
    const cap = await mongoTransactable(connection);
    if (cap === true) {
      const tx = await this._openRegisteredTx(
        source, () => executors.mongo.openTransaction(connection),
      );
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

  // ---------- 会话 API（与 Store 同名同形，委托 crud；经注入表取用，不回指 crud） ----------
  async query(...a) { return _crud().query(...a); }
  async queryOne(...a) { return _crud().queryOne(...a); }
  async queryWithCount(...a) { return _crud().queryWithCount(...a); }
  async insert(...a) { return _crud().insert(...a); }
  async insertMany(...a) { return _crud().insertMany(...a); }
  async update(...a) { return _crud().update(...a); }
  async updateMany(...a) { return _crud().updateMany(...a); }
  async upsert(...a) { return _crud().upsert(...a); }
  async remove(...a) { return _crud().remove(...a); }
  async exists(...a) { return _crud().exists(...a); }
  async count(...a) { return _crud().count(...a); }
  async mutation(...a) { return _crud().mutation(...a); }
  async executeRaw(...a) { return executeRaw(...a); }
}

module.exports = { Session, _rollbackOthers };
