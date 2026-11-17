'use strict';

/**
 * 同源嵌套事务 / 嵌套会话的保存点边界（D4-4 零语义拆分）。
 *
 * 自 tests/session.test.js 原样迁出 #14/#15/#16（同源嵌套 transaction 与无保存点降级）、
 * #19/#20（嵌套 session 与会话内 transaction 作为嵌套作用域）；用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeFakeSqlExecutor, setupSingleSql, assertSavepointReleased,
  store, permission, feedback, datasource,
} = require('../test-support/session-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
  permission.setContext(undefined);
});

// ─── #14 同源嵌套 transaction：内层失败只回滚内层、外层提交 ───

test('#14 同源嵌套 transaction：内层失败回滚到保存点、外层提交', async () => {
  const { descriptor, state } = makeFakeSqlExecutor();
  datasource.setConnections({ sess_a: descriptor });

  const innerBoom = async () => { throw new Error('inner-boom'); };
  await store.transaction('sess_a', async () => {
    await assert.rejects(
      () => store.transaction('sess_a', innerBoom),
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
      } catch {
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

// ─── #19 嵌套 session：首次写开保存点、退出释放、共用外层事务 ──

test('#19 嵌套 session：首次写开保存点、退出释放、共用外层事务', async () => {
  const { state } = setupSingleSql();

  await store.session(async (outer) => {
    await outer.insert('SessA', { v: '1' });
    await store.session(async (inner) => {
      await inner.insert('SessA', { v: '2' });
    });
  });

  assert.equal(state.opened, 1, '嵌套会话共用外层事务连接');
  assert.deepEqual(state.savepoints.map(([, n]) => n), ['sp_1'], '内层作用域首次写才开保存点');
  assertSavepointReleased(state);
});

// ─── #20 会话内 transaction：作为嵌套作用域（失败只回滚本层） ──

test('#20 会话内 transaction：作为嵌套作用域，失败只回滚本层', async () => {
  const { state } = setupSingleSql();

  const boomAfterInsert = async () => {
    await store.insert('SessA', { v: '2' });
    throw new Error('inner-boom');
  };
  await store.session(async (s) => {
    await s.insert('SessA', { v: '1' });
    await assert.rejects(
      () => store.transaction('sess_a', boomAfterInsert),
      /inner-boom/,
    );
    await s.insert('SessA', { v: '3' });
  });

  assert.equal(state.opened, 1, '会话内 transaction 不另开事务');
  assert.deepEqual(state.savepoints.map(([, n]) => n), ['sp_1']);
  assert.deepEqual(state.rolled_to_sps.map(([, n]) => n), ['sp_1']);
  assertSavepointReleased(state);
});
