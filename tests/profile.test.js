'use strict';

/**
 * 档位（profile）门禁 —— 双门禁分离：standard 放开 / text2query 功能收缩
 *
 * 与 py-store/tests/test_profile.py 一一对应：
 *   1. 档位读写与未知档抛错（禁静默回落默认档）；
 *   2. `text2query(fn)` 上下文：进入设档、退出恢复原档（token-set/reset，嵌套安全）；
 *   3. text2query 档强制 ctx：无 ctx 即 ProfileViolation + emit `profile_blocked`（禁静默）；
 *   4. `_call` 前缀映射：`ERR_TEXT2QUERY:` → ProfileViolation（400）并提取 feature；
 *   5. standard 档 fail-open：无 ctx 照常查询（既有调用方零感知）；
 *   6. `routeOverride` 受信来源 Host 兜底：text2query 档非空即拒 + emit（layer='host'）；
 *      standard 档放行（判决唯一在 core，Host 仅兜底）。
 *
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  init, store, executors, permission, feedback, schema: _sc,
  text2query, ProfileViolation,
} = require('../src');
const { _call } = require('../src/crud');
const { _guardRouteOverride } = require('../src/crud/query');

const SRC = 'pq_src';

function createDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE pq_model (_id TEXT PRIMARY KEY, title TEXT, __present TEXT);');
  return db;
}

_sc.register({
  name: 'PqModel',
  collection: 'pq_model',
  idPrefix: 'pq_',
  timestamps: false,
  fields: { title: { type: 'string' } },
  relations: {},
  datasource: SRC,
});

before(async () => {
  await init({ [SRC]: executors.createConnection('sqlite', createDb()) });
  permission.setContext(undefined);
});

/** 每用例复位（档位为进程级全局，防用例间串扰） */
function _reset() {
  _sc.setProfile('standard');
  permission.setContext(undefined);
  feedback.setSink(null);
}

// ── 1. 档位读写 ───────────────────────────────────────────────

test('profile: 默认档位 = standard，门面读写一致', async () => {
  _reset();
  assert.equal(_sc.getProfile(), 'standard');
  assert.equal(store.getProfile(), 'standard');
});

test('profile: setProfile 读回；未知档抛错且不回落', async () => {
  _reset();
  _sc.setProfile('text2query');
  assert.equal(_sc.getProfile(), 'text2query');
  store.setProfile('standard');
  assert.equal(store.getProfile(), 'standard');
  assert.throws(() => store.setProfile('nope'));
  assert.equal(_sc.getProfile(), 'standard', '未知档必须 Err，不得静默回落');
  _sc.setProfile('text2query');
  assert.throws(() => _sc.setProfile('Standard'), '大小写敏感，非标准值同样 Err');
  assert.equal(_sc.getProfile(), 'text2query');
  _reset();
});

// ── 2. text2query() 上下文 ────────────────────────────────────

test('profile: text2query 上下文进入设档、退出恢复', async () => {
  _reset();
  assert.equal(_sc.getProfile(), 'standard');
  await store.text2query(async () => {
    assert.equal(_sc.getProfile(), 'text2query');
  });
  assert.equal(_sc.getProfile(), 'standard');
});

test('profile: text2query 嵌套各自恢复原档', async () => {
  _reset();
  await store.text2query(async () => {
    assert.equal(_sc.getProfile(), 'text2query');
    await text2query(async () => {
      assert.equal(_sc.getProfile(), 'text2query');
    });
    assert.equal(_sc.getProfile(), 'text2query');
  });
  assert.equal(_sc.getProfile(), 'standard');
});

test('profile: text2query 异常抛出仍恢复原档', async () => {
  _reset();
  await assert.rejects(
    () => text2query(async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(_sc.getProfile(), 'standard');
});

// ── 3. text2query 档强制 ctx + 反馈 ───────────────────────────

test('profile: text2query 档无 ctx —— ProfileViolation + emit profile_blocked', async () => {
  _reset();
  const events = [];
  feedback.setSink((e) => events.push(e));
  await assert.rejects(
    () => text2query(() => store.query('PqModel{ title }')),
    (e) => {
      assert.ok(e instanceof ProfileViolation, '应为 ProfileViolation');
      assert.equal(e.status, 400, '档位拒绝 = 调用方合约违反（400），非 403');
      assert.match(e.message, /text2query/);
      return true;
    },
  );
  assert.equal(events.length, 1, '拦截必须产反馈（允许拦截，禁止静默）');
  const ev = events[0];
  assert.equal(ev.type, 'profile_blocked');
  assert.equal(ev.code, 'profileBlocked');
  assert.equal(ev.layer, 'core');
  assert.equal(ev.profile, 'text2query');
  assert.equal(ev.feature, null, '文案无 [..] → feature 显式留白，不伪造');
  assert.ok(ev.message);
  assert.ok(ev.hint);
  assert.equal(_sc.getProfile(), 'standard', '退出上下文后档位恢复');
  _reset();
});

test('profile: text2query 档带用户 ctx 放行', async () => {
  _reset();
  permission.setContext({ userId: 'u1', roles: ['user'] });
  await text2query(() => store.query('PqModel{ title }'));
  _reset();
});

// ── 4. _call 前缀映射（含 feature 提取） ──────────────────────

test('profile: _call 将 ERR_TEXT2QUERY 前缀映射为 ProfileViolation 并提取 feature', async () => {
  _reset();
  const events = [];
  feedback.setSink((e) => events.push(e));
  assert.throws(
    () => _call(() => { throw new Error('ERR_TEXT2QUERY:text2query 档禁用 [$pipeline 直通]（功能收缩）'); }),
    (e) => {
      assert.ok(e instanceof ProfileViolation);
      assert.equal(e.status, 400);
      assert.equal(e.message, 'text2query 档禁用 [$pipeline 直通]（功能收缩）');
      return true;
    },
  );
  assert.equal(events[0].feature, '$pipeline 直通');
  _reset();
});

test('profile: _call 非档位前缀原样上抛（不吞错、不误映射）', async () => {
  _reset();
  assert.throws(() => _call(() => { throw new Error('ERR_NO_CONTEXT'); }), /ERR_NO_CONTEXT/);
});

// ── 5. standard 档零感知（fail-open） ─────────────────────────

test('profile: standard 档无 ctx 照常查询', async () => {
  _reset();
  const items = await store.query('PqModel{ title }');
  assert.ok(Array.isArray(items));
});

// ── 6. routeOverride 受信来源 Host 兜底 ───────────────────────

test('profile: text2query 档传 routeOverride —— Host 兜底拒 + emit', async () => {
  _reset();
  const events = [];
  feedback.setSink((e) => events.push(e));
  await assert.rejects(
    () => text2query(() => store.query('PqModel{ title }', null, { source: SRC })),
    (e) => {
      assert.ok(e instanceof ProfileViolation, '应为 ProfileViolation');
      assert.equal(e.status, 400, '档位拒绝 = 调用方合约违反（400）');
      assert.match(e.message, /route_override/);
      return true;
    },
  );
  assert.equal(events.length, 1, '兜底命中必产反馈（允许拦截，禁止静默）');
  const ev = events[0];
  assert.equal(ev.type, 'profile_blocked');
  assert.equal(ev.code, 'profileBlocked');
  assert.equal(ev.layer, 'host', "layer='host' 表明 core 层未拦住");
  assert.equal(ev.profile, 'text2query');
  assert.equal(ev.feature, 'route_override');
  assert.ok(ev.hint);
  _reset();
});

test('profile: standard 档 routeOverride 受信可用（Host 兜底放行）', async () => {
  _reset();
  const events = [];
  feedback.setSink((e) => events.push(e));
  _guardRouteOverride({ source: SRC });
  _guardRouteOverride(null);
  assert.equal(events.length, 0);
  _reset();
});

test('profile: text2query 档 queryOne / queryWithCount 同样拒 routeOverride', async () => {
  _reset();
  feedback.setSink(() => {});
  await assert.rejects(
    () => text2query(() => store.queryOne('PqModel{ title }', null, { source: SRC })),
    (e) => { assert.ok(e instanceof ProfileViolation); return true; },
  );
  await assert.rejects(
    () => text2query(() => store.queryWithCount('PqModel{ title }', null, { source: SRC })),
    (e) => { assert.ok(e instanceof ProfileViolation); return true; },
  );
  _reset();
});
