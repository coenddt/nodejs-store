'use strict';

/**
 * 04 · 缓存角色：注记为真（A8/A9）
 *
 * A8：无 provider 恒 BYPASS；注入 provider 后 `HIT` 仅在本次**选中**链路 `role==='cache'`
 *     时出现（有 cache 链路但未选中 ⇒ `MISS`；无 cache 链路/未记录 ⇒ `BYPASS`）；
 *     异常/非法值 ⇒ `BYPASS` + feedback 留痕。
 * A9：载体不可用（Redis 连接/命令失败）⇒ 显式 `Err`（`RedisIoError`），禁静默当空快照。
 *
 * 既有 `tests/cache.test.js` 是注记位语义的回归基线，本文件不触碰它。
 * 运行：$env:LOCAL_CORE='1'; node --test tests/cache-link.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../src/cache');
const feedback = require('../src/feedback');
const { schema: _sc } = require('../src');
const { createLinkCacheProvider } = require('../src/cache/provider');
const { runWithSelection, currentSelection } = require('../src/cache/context');
const { createRedisIo, RedisIoError } = require('../src/cache/redis-io');

/** 收集期间 emit 的事件（用后恢复原 sink，并复位 provider 防跨用例污染） */
function collect(body) {
  const prev = feedback.getSink();
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    body();
  } finally {
    feedback.setSink(prev);
    cache.setCacheStatus(null);
  }
  return events;
}

const L_CACHE_FIRST = {
  User: [
    { source: 'cache_src', database: 'db', schema: null, role: 'cache', priority: 0 },
    { source: 'main_src', database: 'db', schema: null, role: 'primary', priority: 1 },
  ],
};
const L_CACHE_SECOND = {
  User: [
    { source: 'main_src', database: 'db', schema: null, role: 'primary', priority: 0 },
    { source: 'cache_src', database: 'db', schema: null, role: 'cache', priority: 1 },
  ],
};
const L_NO_CACHE = {
  User: [{ source: 'main_src', database: 'db', schema: null, role: 'primary', priority: 0 }],
};

test('A8①：无 provider → 恒 BYPASS（注记必须为真）', () => {
  cache.setCacheStatus(null);
  assert.equal(cache.cacheStatus({}), 'BYPASS');
});

test('A8②：声明 cache 链路且本次选中 → HIT', () => {
  cache.setCacheStatus(createLinkCacheProvider());
  assert.equal(runWithSelection(L_CACHE_FIRST, () => cache.cacheStatus({})), 'HIT');
  cache.setCacheStatus(null);
});

test('A8③：有 cache 链路但本次未选中 → MISS', () => {
  cache.setCacheStatus(createLinkCacheProvider());
  assert.equal(runWithSelection(L_CACHE_SECOND, () => cache.cacheStatus({})), 'MISS');
  cache.setCacheStatus(null);
});

test('A8③b：无 cache 链路 / 未记录 → BYPASS（绝不猜）', () => {
  cache.setCacheStatus(createLinkCacheProvider());
  assert.equal(runWithSelection(L_NO_CACHE, () => cache.cacheStatus({})), 'BYPASS');
  assert.equal(currentSelection(), null, '作用域外应为 null');
  assert.equal(cache.cacheStatus({}), 'BYPASS', '未记录选中信息 ⇒ BYPASS');
  cache.setCacheStatus(null);
});

test('A8④：provider 抛错 / 返回非法值 → BYPASS 且 feedback 留痕', () => {
  const failed = collect(() => {
    cache.setCacheStatus(() => { throw new Error('boom'); });
    assert.equal(cache.cacheStatus({}), 'BYPASS');
  });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].code, 'cacheStatusFailed');
  assert.equal(failed[0].layer, 'host');

  const invalid = collect(() => {
    cache.setCacheStatus(() => 'NOPE');
    assert.equal(cache.cacheStatus({}), 'BYPASS');
  });
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].code, 'cacheStatusInvalid');
});

test('A8 端到端：真实 plan.links（primary 优先）⇒ MISS（注记与选中一致）', () => {
  _sc.register({
    name: 'ClUser', collection: 'cl_users', idPrefix: 'clu_', timestamps: false,
    datasource: 'cl_main', fields: { name: { type: 'string' } }, relations: {},
  });
  const core = _sc.getCore();
  const ds = { sources: { cl_cache: 'mongodb', cl_main: 'mongodb' } };
  const gql = 'ClUser{name}';

  // core 语义：links 恒以 `role=primary`（rank 最优）为首，即本次选中主链路。
  // 故真实计划的注记应为 MISS（未命中缓存），绝非 HIT —— 这正是「注记为真」。
  core.applyLinkDecls({
    sources: {
      cl_cache: { kind: 'mongodb', databases: ['cldb'] },
      cl_main: { kind: 'mongodb', databases: ['cldb'] },
    },
    defs: ['schema'],
    links: {
      ClUser: [
        { source: 'cl_main', role: 'primary', priority: 0, database: 'cldb' },
        { source: 'cl_cache', role: 'cache', priority: 5, database: 'cldb' },
      ],
    },
  });
  const plan = core.planFederated(gql, {}, undefined, ds);
  assert.ok(plan.links && plan.links.ClUser, 'plan 应含 ClUser 链路');
  assert.equal(plan.links.ClUser[0].role, 'primary', 'primary（rank 最优）为选中首项');
  assert.ok(plan.links.ClUser.some((l) => l.role === 'cache'), '仍含 cache 候选（未选中）');

  cache.setCacheStatus(createLinkCacheProvider());
  assert.equal(runWithSelection(plan.links, () => cache.cacheStatus({})), 'MISS');
  // 对照：若本次选中 cache（cache 为首项，如 P2 主链路不可达被跳过）⇒ HIT（见 A8②）
  const cacheFirst = { ClUser: [{ source: 'cl_cache', role: 'cache', priority: 0, database: 'cldb' }] };
  assert.equal(runWithSelection(cacheFirst, () => cache.cacheStatus({})), 'HIT');

  cache.setCacheStatus(null);
});

test('A9：载体不可用（Redis 命令失败）⇒ 显式 Err，禁静默当空快照', async () => {
  const io = createRedisIo({
    client: {
      scan() { throw new Error('conn refused'); },
      get() { return null; },
      set() {},
    },
  });
  await assert.rejects(
    () => io.load('db'),
    (e) => {
      assert.ok(e instanceof RedisIoError, '应为 RedisIoError');
      assert.equal(e.op, 'scan');
      return true;
    },
  );

  const io2 = createRedisIo({
    client: {
      scan() { return []; },
      get() { throw new Error('read timeout'); },
      set() {},
    },
  });
  // scan 返回空 ⇒ load 正常返回空快照；此处改为验证 get 失败路径
  const io3 = createRedisIo({
    client: {
      scan() { return ['store/db/orders']; },
      get() { throw new Error('read timeout'); },
      set() {},
    },
  });
  await assert.rejects(() => io3.load('db'), (e) => {
    assert.ok(e instanceof RedisIoError);
    assert.equal(e.op, 'get');
    return true;
  });

  // 连接正常（scan 空）⇒ 空快照（非静默掩盖：无键即空，可区分）
  assert.deepEqual(await io2.load('db'), {});
});
