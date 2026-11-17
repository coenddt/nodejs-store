'use strict';

/**
 * Session / 原子边界用例的共用支撑（D4-4 零语义拆分）。
 *
 * 自 tests/session.test.js 原样下沉：假 SQL 执行器工厂、Mongo 桩驱动、
 * schema 注册与单/双源桩装配、保存点收尾断言。用例文件只保留用例块，
 * 用例名与断言逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const assert = require('node:assert/strict');

const {
  init, store, executors, permission, feedback, datasource, NonAtomicWriteError, schema: _sc,
} = require('../src');
const { core: _core } = require('../src/schema');
const { runAtomic } = require('../src/crud/exec');

// ─── 假 SQL 执行器工厂（doc 4.1） ─────────────────────────────

function makeFakeSqlExecutor(kind = 'sqlite', savepoints = true) {
  const state = {
    opened: 0, committed: 0, rolled_back: 0, released: 0,
    tx_conns: [], exec_conns: [], rows: [],
    fail_on_write: false,
    savepoints: [], released_sps: [], rolled_to_sps: [],
  };
  let n = 0;

  async function runOn(connId, plan) {
    state.exec_conns.push(connId);
    const stmts = (plan && plan.stmts) || [];
    if (state.fail_on_write && stmts.some((s) => s.isWrite)) {
      throw new Error('模拟写失败');
    }
    return { docs: [], rows: [], affectedRows: 1 };
  }

  const baseExec = (plan) => runOn('base', plan);

  async function openTransaction() {
    n += 1;
    state.opened += 1;
    const connId = `conn-${n}`;
    state.tx_conns.push(connId);
    const done = { commit: false, rollback: false, release: false };
    const tx = {
      exec: (plan) => runOn(connId, plan),
      async commit() {
        if (done.commit) return;
        done.commit = true;
        state.committed += 1;
      },
      async rollback() {
        if (done.rollback) return;
        done.rollback = true;
        state.rolled_back += 1;
      },
      async release() {
        if (done.release) return;
        done.release = true;
        state.released += 1;
      },
    };
    if (savepoints) {
      tx.savepoint = async (name) => { state.savepoints.push([connId, name]); };
      tx.releaseSavepoint = async (name) => { state.released_sps.push([connId, name]); };
      tx.rollbackToSavepoint = async (name) => { state.rolled_to_sps.push([connId, name]); };
    }
    return tx;
  }

  async function withTransaction(body) {
    const tx = await openTransaction();
    try {
      const out = await body(tx.exec, tx);
      await tx.commit();
      return out;
    } catch (e) {
      await tx.rollback();
      throw e;
    } finally {
      await tx.release();
    }
  }

  const descriptor = { kind, exec: baseExec, withTransaction, openTransaction };
  return { descriptor, state };
}

// ─── Mongo 桩驱动（#10） ─────────────────────────────────────

class MemCursor {
  constructor(docs) {
    this.docs = docs;
  }

  async toArray() {
    return [...this.docs];
  }
}

class MemColl {
  constructor(docs) {
    this.docs = docs || [];
  }

  find() {
    return new MemCursor(this.docs);
  }

  aggregate() {
    return new MemCursor(this.docs);
  }

  async findOne() {
    return this.docs.length ? { ...this.docs[0] } : null;
  }

  async countDocuments() {
    return this.docs.length;
  }
}

/** Mongo db 实例形态（collection 为函数）：固定库，无法跨库 */
class FakeDb {
  constructor(colls) {
    this.colls = colls || {};
  }

  collection(name) {
    return new MemColl(this.colls[name]);
  }
}

// ─── schema 注册与桩装配（各用例文件的公共夹具） ──────────────

function registerSql(schemaName, source, idPrefix = '') {
  _sc.register({
    name: schemaName,
    collection: schemaName.toLowerCase(),
    idPrefix,
    timestamps: false,
    fields: { v: { type: 'string' } },
    relations: {},
    datasource: source,
  });
}

/** 单源桩三件套：建执行器桩 + 注册 schema + 绑定连接（原 12 处手写逐句等价） */
function setupSingleSql() {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });
  return { descriptor, state };
}

/** 双源桩四件套：A/B 各建桩 + 注册双 schema + 绑定双连接（原 3 处手写逐句等价） */
function setupDualSql() {
  const a = makeFakeSqlExecutor();
  const b = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  registerSql('SessB', 'sess_b', 'SB');
  datasource.setConnections({ sess_a: a.descriptor, sess_b: b.descriptor });
  return { a, b };
}

/** 成功提交收尾断言：保存点已释放、零回滚、事务恰好提交一次（#19/#20 共用） */
function assertSavepointReleased(state) {
  assert.deepEqual(state.released_sps.map(([, n]) => n), ['sp_1']);
  assert.equal(state.rolled_back, 0);
  assert.equal(state.committed, 1);
}

module.exports = {
  makeFakeSqlExecutor,
  FakeDb,
  registerSql,
  setupSingleSql,
  setupDualSql,
  assertSavepointReleased,
  init,
  store,
  executors,
  permission,
  feedback,
  datasource,
  NonAtomicWriteError,
  schema: _sc,
  _core,
  runAtomic,
};
