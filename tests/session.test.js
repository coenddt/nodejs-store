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
  const db = new FakeDb({ sessMongo: [{ _id: 'm1', v: 'x' }] });
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

// ─── #12 非会话多源写：程序化声明 nonAtomic（B1） ────────────

test('#12 非会话多源写：恰声明一次 nonAtomic（B1）', async () => {
  const events = [];
  feedback.setSink((e) => events.push(e));
  let ran = false;

  const out = await runAtomic(new Set(['sess_a', 'sess_b']), async () => {
    ran = true;
    return 'ok';
  });

  assert.equal(out, 'ok');
  assert.equal(ran, true, '多源仍按顺序原样执行（不阻断）');
  const na = events.filter((e) => e.code === 'nonAtomic');
  assert.equal(na.length, 1, '多源写恰声明一次');
  assert.equal(na[0].type, 'non_atomic_write');
  assert.equal(na[0].layer, 'crud');
  assert.deepEqual(na[0].sources, ['sess_a', 'sess_b']);
});

// ─── #13 非会话单源写：包事务且不声明 nonAtomic（零回归） ─────

test('#13 非会话单源写：包事务且不声明 nonAtomic', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  datasource.setConnections({ sess_a: descriptor });
  const events = [];
  feedback.setSink((e) => events.push(e));

  const out = await runAtomic(new Set(['sess_a']), async () => 42);

  assert.equal(out, 42);
  assert.equal(state.opened, 1);
  assert.equal(state.committed, 1);
  assert.deepEqual(events.filter((e) => e.code === 'nonAtomic'), []);
});

// ─── #14 同源嵌套 transaction：内层失败只回滚内层、外层提交 ───

test('#14 同源嵌套 transaction：内层失败回滚到保存点、外层提交', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  datasource.setConnections({ sess_a: descriptor });

  await store.transaction('sess_a', async () => {
    await assert.rejects(
      () => store.transaction('sess_a', async () => { throw new Error('inner-boom'); }),
      /inner-boom/,
    );
  });

  assert.equal(state.opened, 1, '嵌套同源事务只开一次事务');
  assert.deepEqual(state.savepoints.map(([, n]) => n), ['sp_1']);
  assert.deepEqual(state.rolled_to_sps.map(([, n]) => n), ['sp_1']);
  assert.deepEqual(state.released_sps.map(([, n]) => n), ['sp_1']);
  assert.equal(state.committed, 1);
  assert.equal(state.rolled_back, 0, '外层捕获后仍整体提交');
});

// ─── #15 同源嵌套 transaction：内层成功只 RELEASE ────────────

test('#15 同源嵌套 transaction：内层成功只 RELEASE 保存点', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  datasource.setConnections({ sess_a: descriptor });

  const out = await store.transaction(
    'sess_a', () => store.transaction('sess_a', async () => 'inner-ok'));

  assert.equal(out, 'inner-ok');
  assert.equal(state.opened, 1);
  assert.deepEqual(state.savepoints.map(([, n]) => n), ['sp_1']);
  assert.deepEqual(state.rolled_to_sps, []);
  assert.deepEqual(state.released_sps.map(([, n]) => n), ['sp_1']);
  assert.equal(state.committed, 1);
  assert.equal(state.rolled_back, 0);
});

// ─── #16 句柄无保存点原语：降级并入外层 + 同源只告警一次 ─────

test('#16 句柄无保存点原语：降级并入外层，同一源只告警一次', async () => {
  const { descriptor, state } = makeFakeSqlExecutor('sqlite', false);
  datasource.setConnections({ sess_a: descriptor });
  const events = [];
  feedback.setSink((e) => events.push(e));
  const ran = [];

  await store.transaction('sess_a', async () => {
    for (let i = 0; i < 2; i += 1) {
      try {
        await store.transaction('sess_a', async () => {
          ran.push('inner');
          throw new Error('inner-boom');
        });
      } catch (_) {
        ran.push('caught');
      }
    }
  });

  assert.deepEqual(ran, ['inner', 'caught', 'inner', 'caught'], '降级：异常上抛由外层自行处理');
  assert.equal(state.opened, 1);
  assert.deepEqual(state.savepoints, []);
  assert.deepEqual(state.released_sps, []);
  const warned = events.filter((e) => e.code === 'nestedSavepointUnsupported');
  assert.equal(warned.length, 1, '同一源（同一外层作用域）只告警一次');
  assert.equal(warned[0].type, 'nested_savepoint_unsupported');
  assert.equal(warned[0].source, 'sess_a');
});

// ─── #17 真实 SQLite：嵌套 transaction 内层回滚、外层提交 ─────

test('#17 真实 SQLite：嵌套 transaction 内层回滚、外层提交', async () => {
  const file = path.join(os.tmpdir(), `nest-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  const db2 = new Database(file);
  try {
    db.exec('CREATE TABLE nest_t (_id TEXT PRIMARY KEY, v TEXT)');
    datasource.setConnections({ nest_real: executors.createConnection('sqlite', db) });

    const ins = (v) => store.executeRaw(
      'nest_real', 'INSERT INTO nest_t (_id, v) VALUES (?, ?)', [v, v], true);

    await store.transaction('nest_real', async () => {
      await ins('keep');
      await assert.rejects(
        () => store.transaction('nest_real', async () => {
          await ins('drop');
          throw new Error('inner-boom');
        }),
        /inner-boom/,
      );
      await ins('outer');
    });

    const rows = db2.prepare('SELECT _id FROM nest_t ORDER BY _id').all().map((r) => r._id);
    assert.deepEqual(rows, ['keep', 'outer'], '内层写入回滚，外层写入提交');
  } finally {
    db.close();
    db2.close();
    try { fs.unlinkSync(file); } catch (_) { /* 清理失败不掩盖用例结论 */ }
  }
});

// ─── #18 真实 SQLite：嵌套 session 内层回滚、外层提交 ─────────

test('#18 真实 SQLite：嵌套 session 内层回滚、外层提交', async () => {
  const file = path.join(os.tmpdir(), `nest-sess-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  const db2 = new Database(file);
  try {
    db.exec('CREATE TABLE sess_t (_id TEXT PRIMARY KEY, v TEXT)');
    datasource.setConnections({ nest_sess: executors.createConnection('sqlite', db) });

    const ins = (v) => store.executeRaw(
      'nest_sess', 'INSERT INTO sess_t (_id, v) VALUES (?, ?)', [v, v], true);

    await store.session(async () => {
      await ins('keep');
      await assert.rejects(
        () => store.session(async () => {
          await ins('inner');
          throw new Error('inner-boom');
        }),
        /inner-boom/,
      );
      await ins('outer');
    });

    const rows = db2.prepare('SELECT _id FROM sess_t ORDER BY _id').all().map((r) => r._id);
    assert.deepEqual(rows, ['keep', 'outer'], '内层会话写入回滚，外层写入提交');
  } finally {
    db.close();
    db2.close();
    try { fs.unlinkSync(file); } catch (_) { /* 清理失败不掩盖用例结论 */ }
  }
});

// ─── #19 嵌套 session：首次写开保存点、退出释放、共用外层事务 ──

test('#19 嵌套 session：首次写开保存点、退出释放、共用外层事务', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });

  await store.session(async (outer) => {
    await outer.insert('SessA', { v: '1' });
    await store.session(async (inner) => {
      await inner.insert('SessA', { v: '2' });
    });
  });

  assert.equal(state.opened, 1, '嵌套会话共用外层事务连接');
  assert.deepEqual(state.savepoints.map(([, n]) => n), ['sp_1'], '内层作用域首次写才开保存点');
  assert.deepEqual(state.released_sps.map(([, n]) => n), ['sp_1']);
  assert.equal(state.rolled_back, 0);
  assert.equal(state.committed, 1);
});

// ─── #20 会话内 transaction：作为嵌套作用域（失败只回滚本层） ──

test('#20 会话内 transaction：作为嵌套作用域，失败只回滚本层', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  registerSql('SessA', 'sess_a', 'SA');
  datasource.setConnections({ sess_a: descriptor });

  await store.session(async (s) => {
    await s.insert('SessA', { v: '1' });
    await assert.rejects(
      () => store.transaction('sess_a', async () => {
        await store.insert('SessA', { v: '2' });
        throw new Error('inner-boom');
      }),
      /inner-boom/,
    );
    await s.insert('SessA', { v: '3' });
  });

  assert.equal(state.opened, 1, '会话内 transaction 不另开事务');
  assert.deepEqual(state.savepoints.map(([, n]) => n), ['sp_1']);
  assert.deepEqual(state.rolled_to_sps.map(([, n]) => n), ['sp_1']);
  assert.deepEqual(state.released_sps.map(([, n]) => n), ['sp_1']);
  assert.equal(state.rolled_back, 0);
  assert.equal(state.committed, 1);
});
