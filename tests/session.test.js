'use strict';

/**
 * Session（工作单元）与原子边界用例（执行文档 05 §4.3，镜像 py §4.2 #1–#10）
 *
 * 逐条覆盖总纲 A1–A9，全部基于**可观测副作用**（openTransaction / commit / rollback /
 * release 调用计数、连接标识、异常类型、反馈事件），不依赖实现细节。
 * 零外部服务：假 SQL 执行器 + 真实 better-sqlite3 文件库。
 *
 * 运行：node scripts/test.js（置 LOCAL_CORE=1 使用仓库内 Rust 核心）
 *
 * D4-4 零语义拆分：假执行器 / Mongo 桩 / 桩装配 / 保存点断言下沉
 * ../test-support/session-support.js；#10–#13 迁 session-nonatomic.test.js，
 * #11/#17/#18 迁 session-real.test.js，#14–#16/#19/#20 迁 session-nested.test.js；
 * 用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  setupSingleSql, setupDualSql, makeFakeSqlExecutor, registerSql,
  store, permission, feedback, datasource, NonAtomicWriteError, _core,
} = require('../test-support/session-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
  permission.setContext(undefined);
});

// ─── #1 成功提交（A8 单一路径 / A1 单源） ────────────────────

test('#1 会话成功提交：opened/committed/released 各 1，rolled_back 0', async () => {
  const { state } = setupSingleSql();

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
  const { state } = setupSingleSql();

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
  const { state } = setupSingleSql();

  await store.session(async () => {});
  assert.equal(state.opened, 0);
});

// ─── #4 跨源写 fail-closed（A1 正向） ────────────────────────

test('#4 跨源写 fail-closed：抛 NonAtomicWriteError 且两源回滚（A1）', async () => {
  const { a, b } = setupDualSql();

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
  const { a, b } = setupDualSql();

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
  const { state } = setupSingleSql();

  await store.session(async (s) => {
    await s.executeRaw('sess_a', 'SELECT 1', [], true);
  });

  assert.ok(state.tx_conns.length > 0, '会话须开启事务连接');
  assert.deepEqual(state.exec_conns, state.tx_conns, 'executeRaw 必须落在会话事务连接上');
});

// ─── #8 会话内 store.transaction 并网（A5） ──────────────────

test('#8 会话内 store.transaction 不另开事务（A5）', async () => {
  const { state } = setupSingleSql();
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
