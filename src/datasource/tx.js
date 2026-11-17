'use strict';

/**
 * 事务作用域（D4-4 零语义拆分自 datasource.js）
 *
 * 承载：保存点降级告警、同源嵌套保存点作用域、`runInTransaction` 三分支骨架
 * （嵌入式 / SQL / Mongo）与事务视图作用域。会话内调用一律并入会话事务边界。
 */

const { emit: _emitFeedback } = require('../feedback-core');
const executors = require('../executors');
const { _txStore, currentSession } = require('./state');
const {
  getConnection, isEmbeddedConnection, isSqlConnection,
} = require('./conn');
const { mongoTransactable, warnMongoUnsupported } = require('./mongo');

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

/** 未处理哨兵：fn() 可合法返回任意值（含 null/undefined），不能用返回值判「未处理」 */
const UNHANDLED = Symbol('unhandled');

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

/** 事务前置检查（runInTransaction 三分支共享）：无 withTransaction 降级不静默；
 * 同源已持外层事务 → 嵌套保存点作用域；其余返回 UNHANDLED 交调用方继续包事务。 */
function _txPrecheck(source, conn, parent, fn) {
  if (typeof conn.withTransaction !== 'function') {
    // 降级不静默：显式声明本事务作用域未生效（与 store.session 的 session_not_atomic 对称）
    warnTransactionNotAtomic(source, conn.kind);
    return fn();
  }
  if (parent.has(source)) {
    // 同源嵌套事务：在已持有的事务连接上开保存点（内层失败只回滚本层，外层可继续）
    return nestedSavepointScope(source, parent.get(source), fn);
  }
  return UNHANDLED;
}

/** 事务视图作用域：复制父作用域并注入本源视图，fn 的全部命令在新作用域内执行；
 * fn 成功 commit、抛错 rollback（原样上抛）、release 幂等收尾。 */
async function _runTxScope(source, parent, view, fn) {
  const store = new Map(parent);
  store.set(source, view);
  return _txStore.run(store, async () => {
    try {
      const out = await fn();
      await view.tx.commit();
      return out;
    } catch (e) {
      await view.tx.rollback();
      throw e;
    } finally {
      await view.tx.release();
    }
  });
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

  if (isEmbeddedConnection(conn)) {
    // ── 嵌入式载体分支（local / memory；事务作用域）──
    const pre = _txPrecheck(source, conn, parent, fn);
    if (pre !== UNHANDLED) return pre;
    const tx = await conn.openTransaction();
    const view = { kind: conn.kind, conn, session: tx.session, tx, handle: tx.handle };
    return _runTxScope(source, parent, view, fn);
  }

  if (isSqlConnection(conn)) {
    // ── SQL 分支（事务作用域）──
    const pre = _txPrecheck(source, conn, parent, fn);
    if (pre !== UNHANDLED) return pre;
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

  // ── Mongo 分支（无 withTransaction 原语：探测可事务 → session 事务；不用 _txPrecheck）──
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
  return _runTxScope(source, parent, view, fn);
}

module.exports = {
  runInTransaction,
  nestedSavepointScope,
  warnSavepointUnavailable,
  warnSavepointFailed,
  warnTransactionNotAtomic,
};
