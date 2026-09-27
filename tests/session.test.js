'use strict';

/**
 * Session（工作单元）与原子边界用例（执行文档 05 §4.3，镜像 py §4.2 #1–#10）
 *
 * 逐条覆盖总纲 A1–A9，全部基于**可观测副作用**（openTransaction / commit / rollback /
 * release 调用计数、连接标识、异常类型、反馈事件），不依赖实现细节。
 * 零外部服务：假 SQL 执行器 + 真实 better-sqlite3 文件库。
 *
 * 运行：node scripts/test.js（置 LOCAL_CORE=1 使用仓库内 Rust 核心）
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const { init, store, executors, permission, feedback, datasource, NonAtomicWriteError, schema: _sc } = require('../src');
const { core: _core } = require('../src/schema');

// ─── 假 SQL 执行器工厂（doc 4.1） ─────────────────────────────

function makeFakeSqlExecutor(kind = 'sqlite') {
  const state = {
    opened: 0, committed: 0, rolled_back: 0, released: 0,
    tx_conns: [], exec_conns: [], rows: [],
    fail_on_write: false,
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
    return {
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
  }

  async function withTransaction(body) {
    const tx = await openTransaction();
    try {
      const out = await body(tx.exec);
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

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
  permission.setContext(undefined);
});

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

// ─── #1 成功提交（A8 单一路径 / A1 单源） ────────────────────

test('#1 会话成功提交：opened/committed/released 各 1，rolled_back 0', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });

  await store.session(async (s) => {
    await s.insert('SessA', { v: '1' });
    await s.insert('SessA', { v: '2' });
  });

  assert.equal(state.opened, 1);
  assert.equal(state.committed, 1);
  assert.equal(state.rolled_back, 0);
  assert.equal(state.released, 1);
});

// ─── #2 异常回滚（A2） ───────────────────────────────────────

test('#2 会话体异常：整体回滚并原样上抛（A2）', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });

  await assert.rejects(
    () => store.session(async (s) => {
      await s.insert('SessA', { v: '1' });
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(state.rolled_back, 1);
  assert.equal(state.committed, 0);
  assert.equal(state.released, 1);
});

// ─── #3 惰性开事务：空会话不占连接（A3） ─────────────────────

test('#3 空会话惰性开事务：opened 0（A3）', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });

  await store.session(async () => {});
  assert.equal(state.opened, 0);
});

// ─── #4 跨源写 fail-closed（A1 正向） ────────────────────────

test('#4 跨源写 fail-closed：抛 NonAtomicWriteError 且两源回滚（A1）', async () => {
  const a = makeFakeSqlExecutor();
  const b = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  registerSql('SessB', 'sess_b', 'SB');
  datasource.setConnections({ sess_a: a.descriptor, sess_b: b.descriptor });

  await assert.rejects(
    () => store.session(async (s) => {
      await s.insert('SessA', { v: 'a' });
      await s.insert('SessB', { v: 'b' });
    }),
    (e) => {
      assert.ok(e instanceof NonAtomicWriteError);
      assert.deepEqual(e.sources, ['sess_a', 'sess_b']);
      return true;
    },
  );
  assert.equal(a.state.rolled_back, 1);
  assert.equal(a.state.committed, 0);
  assert.equal(b.state.rolled_back, 1);
  assert.equal(b.state.committed, 0);
});

// ─── #5 跨源读不拦截（A1 反例） ──────────────────────────────

test('#5 跨源读不拦截：A 写 B 读，双源提交（A1 反例）', async () => {
  const a = makeFakeSqlExecutor();
  const b = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  registerSql('SessB', 'sess_b', 'SB');
  datasource.setConnections({ sess_a: a.descriptor, sess_b: b.descriptor });

  await store.session(async (s) => {
    await s.insert('SessA', { v: 'a' });
    await s.count('SessB');
  });

  assert.equal(a.state.committed, 1);
  assert.equal(a.state.rolled_back, 0);
  assert.equal(b.state.committed, 1);
  assert.equal(b.state.rolled_back, 0);
});

// ─── #6 缺 openTransaction 的 SQL 源：降级不静默（A9） ───────

test('#6 缺 openTransaction：session_not_atomic 恰好告警 1 次（A9）', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  delete descriptor.openTransaction; // 降级形态：无显式事务原语
  registerSql('SessC', 'sess_c');
  datasource.setConnections({ sess_c: descriptor });

  const events = [];
  feedback.setSink((e) => events.push(e));

  await store.session(async (s) => {
    await s.executeRaw('sess_c', 'SELECT 1', [], false);
    await s.executeRaw('sess_c', 'SELECT 2', [], false);
  });

  const warned = events.filter((e) => e.type === 'session_not_atomic');
  assert.equal(warned.length, 1, '同一源第二次命令不再告警');
  assert.equal(warned[0].code, 'sessionNotAtomic');
  assert.equal(warned[0].source, 'sess_c');
  assert.equal(state.opened, 0);
});

// ─── #7 executeRaw 落会话连接（A4） ─────────────────────────

test('#7 executeRaw 落在会话事务连接上（A4）', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });

  await store.session(async (s) => {
    await s.executeRaw('sess_a', 'SELECT 1', [], true);
  });

  assert.ok(state.tx_conns.length > 0, '会话须开启事务连接');
  assert.deepEqual(state.exec_conns, state.tx_conns, 'executeRaw 必须落在会话事务连接上');
});

// ─── #8 会话内 store.transaction 并网（A5） ──────────────────

test('#8 会话内 store.transaction 不另开事务（A5）', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });
  const innerRan = [];

  await store.session(async (s) => {
    await s.insert('SessA', { v: '1' });
    await store.transaction('sess_a', async () => {
      innerRan.push('inner');
      await store.insert('SessA', { v: 't' });
    });
  });

  assert.deepEqual(innerRan, ['inner']);
  assert.equal(state.opened, 1, '会话内 transaction 不得另开事务');
});

// ─── #9 update 探针与写同事务（A7） ──────────────────────────

test('#9 update 探针与写同一事务；写失败整体回滚（A7）', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  state.fail_on_write = true;
  registerSql('SessProbe', 'sess_probe', 'SP');
  datasource.setConnections({ sess_probe: descriptor });

  // 借用真实 core 产出规范命令，再以规划桩注入「首次 needsProbe → 重入 command」
  const built = _core.planUpdate(
    'SessProbe', { _id: 'p1' }, { v: 'b' }, null, 0, { internal: true }, null, null, null);
  const writeCmd = built.command;
  const probeCmd = {
    source: writeCmd.source, collection: writeCmd.collection,
    kind: 'findOne', filter: writeCmd.filter,
    projection: { _id: 1, createdBy: 1 },
  };

  const origPlanUpdate = _core.planUpdate;
  let calls = 0;
  _core.planUpdate = () => {
    calls += 1;
    return calls === 1 ? { needsProbe: probeCmd } : { command: writeCmd };
  };
  try {
    await assert.rejects(
      () => store.update('SessProbe', { _id: 'p1' }, { v: 'b' }),
      /模拟写失败/,
    );
  } finally {
    _core.planUpdate = origPlanUpdate;
  }

  assert.equal(state.exec_conns.length, 2, '探针 + 写两次执行');
  assert.equal(state.exec_conns[0], state.exec_conns[1], '探针与写必须同连接');
  assert.equal(state.exec_conns[0], state.tx_conns[0], '必须落在事务连接上');
  assert.equal(state.committed, 0);
  assert.equal(state.rolled_back, 1);
});

// ─── #10 Mongo 源直通（不告警） ──────────────────────────────

test('#10 Mongo 源直通：不告警 session_not_atomic', async () => {
  const db = new FakeDb({ sess_mongo: [{ _id: 'm1', v: 'x' }] });
  _sc.register({
    name: 'SessMongoNode', collection: 'sess_mongo', timestamps: false,
    fields: { v: { type: 'string' } }, relations: {}, datasource: 'sess_mongo',
  });
  datasource.setConnections({ sess_mongo: db });

  const events = [];
  feedback.setSink((e) => events.push(e));

  const got = await store.session(async (s) => s.query('SessMongoNode{_id, v}'));

  assert.deepEqual(got.map((d) => d._id), ['m1']);
  assert.equal(events.filter((e) => e.type === 'session_not_atomic').length, 0,
    'Mongo 源不属「缺原语的 SQL 源」，不得告警');
});

// ─── #11 真实 SQLite：提交可见 / 回滚不可见（A1/A2） ─────────

test('#11 真实 SQLite：提交可见、异常回滚不可见（A1/A2）', async () => {
  const file = path.join(os.tmpdir(), `sess-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  const db2 = new Database(file);
  try {
    db.exec('CREATE TABLE sess_real (_id TEXT PRIMARY KEY, v TEXT, __present TEXT)');
    _sc.register({
      name: 'SessRealNode', collection: 'sess_real', idPrefix: 'SR', timestamps: false,
      fields: { v: { type: 'string' } }, relations: {}, datasource: 'sess_real_n',
    });
    await init({ sess_real_n: executors.createConnection('sqlite', db) });

    await store.session(async (s) => {
      await s.insert('SessRealNode', { v: 'keep' });
    });
    const afterCommit = db2.prepare('SELECT COUNT(*) AS c FROM sess_real').get().c;

    await assert.rejects(
      () => store.session(async (s) => {
        await s.insert('SessRealNode', { v: 'drop' });
        throw new Error('boom');
      }),
      /boom/,
    );
    const afterRollback = db2.prepare('SELECT COUNT(*) AS c FROM sess_real').get().c;

    assert.equal(afterCommit, 1, '会话提交后新连接应可见数据');
    assert.equal(afterRollback, 1, '会话异常回滚后数据不可见');
  } finally {
    db.close();
    db2.close();
    try { fs.unlinkSync(file); } catch (_) { /* 清理失败不掩盖用例结论 */ }
  }
});
