'use strict';

/**
 * 非会话原子边界与直通源（D4-4 零语义拆分）。
 *
 * 自 tests/session.test.js 原样迁出 #10（Mongo 源直通）、#12/#13（非会话多源/单源写）；
 * 用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  FakeDb, makeFakeSqlExecutor, runAtomic,
  store, permission, feedback, datasource, schema: _sc,
} = require('../test-support/session-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
  permission.setContext(undefined);
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
