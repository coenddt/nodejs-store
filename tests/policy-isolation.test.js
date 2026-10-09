'use strict';

/**
 * 执行作用域并发隔离用例（R2 03 §5 步骤 4）——node 宿主 A1/A2/A3/A5 + A4 子集
 *
 * 验证「一请求/一安全域一份 `{view, sink, meta, secure}`」在并发下互不串扰：
 *   A1 profile 视图与 sink 事件隔离（await 让出后各归各）；
 *   A2 两视图不同 rbac 判决各自稳定（rbacCan 为 rbac 判决入口；canRead 为静态面，
 *      core 语义不叠加 rbac，两者一并断言）；
 *   A3 作用域内 `secureMode()` 只作用于本作用域（base 与并发其它作用域均不受影响）；
 *   A4 作用域内 `schema.register` 报 `ERR_POLICY_VIEW_READONLY`（前缀原样，不落 base）；
 *   A5 作用域 sink/meta 隔离（含落库 sink 的 tenant/env 取作用域 meta）。
 *
 * 注意：`withScope` 是 async —— 必须 `await`（同步 try/catch 接不住 rejected Promise）。
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  store, schema, permission, feedback, withScope, currentScope, currentView,
} = require('../src');

const PROFILE_STD = 'standard';
const PROFILE_AI = 'text2query';
const CTX_VIEWER = { userId: 'u1', roles: ['viewer'] };
const CTX_OTHER = { userId: 'u2', roles: ['other'] };

// ── 夹具：base 注册（域外一次性；本文件只读不放宽任何 base 策略）──

schema.register({
  name: 'IsoPost',
  collection: 'iso_posts',
  timestamps: false,
  fields: { title: { type: 'string' } },
  relations: {},
});

/** 静态读白名单 schema：用于断言 canRead 静态面不被 rbac 视图扰动 */
schema.register({
  name: 'IsoAudit',
  collection: 'iso_audits',
  timestamps: false,
  read: ['viewer'],
  fields: { title: { type: 'string' } },
  relations: {},
});

/** rbac 策略：viewer 可读 IsoPost */
const RBAC_GRANTED = {
  mode: 'enforce',
  roles: { viewer: {} },
  grants: [{ role: 'viewer', model: 'IsoPost', actions: ['read'] }],
};
/** rbac 策略：无任何授权（enforce 下该角色被拒） */
const RBAC_DENIED = { mode: 'enforce', roles: { viewer: {} }, grants: [] };

/** 从 base 派生策略视图（作用域 store.view 的构造入口） */
function viewOf(overrides) {
  return schema.core.withPolicy(overrides);
}

/** n 方栅栏：全部到达后同时放行——保证两个作用域真实重叠（并发交错，而非先后串行） */
function barrier(n) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async function wait() {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

// ── A1：档位视图 + sink 事件隔离 ──────────────────────────────

test('policy-isolation A1: 两并发作用域 profile 视图各归各（await 让出后不串）', async () => {
  const wait = barrier(2);
  const observed = {};

  async function worker(tag, profile) {
    const view = viewOf({ profile });
    const seen = [];
    await withScope({ view }, async () => {
      assert.equal(schema.getCore(), view, `${tag}: 域内 getCore() 应为本作用域视图`);
      seen.push(schema.getCore().profile());
      await wait();                                  // 两作用域在此真实重叠且各自让出
      seen.push(schema.getCore().profile());          // 让出后档位仍各归各
    });
    observed[tag] = seen;
  }

  await Promise.all([worker('a', PROFILE_AI), worker('b', PROFILE_STD)]);
  assert.deepEqual(observed.a, [PROFILE_AI, PROFILE_AI]);
  assert.deepEqual(observed.b, [PROFILE_STD, PROFILE_STD]);

  // 域外回退 base（零默认变更）
  assert.equal(currentScope(), null);
  assert.equal(schema.getCore(), schema.core);
  assert.equal(schema.core.profile(), PROFILE_STD, 'base 档位不得被作用域视图改动');
});

test('policy-isolation A1: 两并发作用域 sink 事件隔离（events 互不含对方事件）', async () => {
  const wait = barrier(2);
  const collected = {};

  async function worker(tag) {
    const events = [];
    await withScope({ view: viewOf({}), sink: (e) => events.push(e) }, async () => {
      feedback.emit({ type: 'isolation', code: `${tag}-1`, layer: 'host' });
      await wait();
      feedback.emit({ type: 'isolation', code: `${tag}-2`, layer: 'host' });
    });
    collected[tag] = events;
  }

  await Promise.all([worker('a'), worker('b')]);
  assert.deepEqual(collected.a.map((e) => e.code), ['a-1', 'a-2']);
  assert.deepEqual(collected.b.map((e) => e.code), ['b-1', 'b-2']);
  assert.ok(!collected.a.some((e) => e.code.startsWith('b-')), 'a 侧不得含 b 的事件');
  assert.ok(!collected.b.some((e) => e.code.startsWith('a-')), 'b 侧不得含 a 的事件');
});

// ── A2：两视图不同 rbac 判决各自稳定 ─────────────────────────

test('policy-isolation A2: 两视图不同 rbac 下判决各自稳定（rbacCan 主判 + canRead 静态面）', async () => {
  const viewGranted = viewOf({ rbac: RBAC_GRANTED });
  const viewDenied = viewOf({ rbac: RBAC_DENIED });
  const wait = barrier(2);
  const seen = {};

  /** 一个快照：[rbacCan(read), canRead(IsoPost 无白名单), canRead(IsoAudit,viewer), canRead(IsoAudit,other)] */
  function snapshot() {
    return [
      store.rbacCan('IsoPost', 'read', CTX_VIEWER),
      permission.canReadSchema('IsoPost', CTX_VIEWER),
      permission.canReadSchema('IsoAudit', CTX_VIEWER),
      permission.canReadSchema('IsoAudit', CTX_OTHER),
    ];
  }

  async function worker(tag, view) {
    const rows = [];
    await withScope({ view }, async () => {
      rows.push(snapshot());
      await wait();
      rows.push(snapshot());                         // 让出后判决不变（视图不可变）
    });
    seen[tag] = rows;
  }

  await Promise.all([worker('granted', viewGranted), worker('denied', viewDenied)]);

  // granted：rbac 授权 → rbacCan true；静态面照旧（无白名单 fail-open、IsoAudit 按角色）
  assert.deepEqual(seen.granted[0], [true, true, true, false]);
  assert.deepEqual(seen.granted[1], [true, true, true, false]);
  // denied：同一 ctx 在该视图被拒；静态面与 granted 视图逐字段一致（互不串扰）
  assert.deepEqual(seen.denied[0], [false, true, true, false]);
  assert.deepEqual(seen.denied[1], [false, true, true, false]);

  // base 仍未注入 rbac → 不介入
  assert.equal(store.rbacEnabled(), false, 'base 不得被视图注入污染');
  assert.equal(store.rbacCan('IsoPost', 'read', CTX_VIEWER), true);
});

test('policy-isolation A2: 视图注入 rbac 不污染 base 与其它视图', async () => {
  const granted = viewOf({ rbac: RBAC_GRANTED });
  const denied = viewOf({ rbac: RBAC_DENIED });
  assert.equal(granted.rbacEnabled(), true);
  assert.equal(denied.rbacEnabled(), true);
  assert.equal(schema.core.rbacEnabled(), false, 'base 视图无 rbac');

  await withScope({ view: granted }, async () => {
    assert.equal(schema.getCore().rbacEnabled(), true);
    assert.equal(store.rbacCan('IsoPost', 'read', CTX_VIEWER), true);
  });
  await withScope({ view: denied }, async () => {
    assert.equal(schema.getCore().rbacEnabled(), true);
    assert.equal(store.rbacCan('IsoPost', 'read', CTX_VIEWER), false);
  });
  assert.equal(schema.core.rbacEnabled(), false, '两个视图退出后 base 仍无 rbac');
  assert.equal(store.rbacCan('IsoPost', 'read', CTX_VIEWER), true);
});

// ── A3：secureMode 并视图只作用本作用域 ──────────────────────

test('policy-isolation A3: 作用域内 secureMode 只作用于本作用域', async () => {
  await withScope({ view: viewOf({}) }, async () => {
    assert.equal(store.isSecure(), false, '进入作用域时本作用域尚未 secure');
    store.secureMode({ adminRoles: ['admin'] });
    assert.equal(store.isSecure(), true, '域内 isSecure 取本作用域标志');
    assert.equal(schema.getCore().requireContext(), true, '三开关已并视图（require_context 已翻）');
    assert.equal(store.getProfile(), PROFILE_STD, '并视图不影响档位');
    await Promise.resolve();                          // 让出后本作用域标志仍在
    assert.equal(store.isSecure(), true);
    assert.equal(schema.getCore().requireContext(), true);
  });

  // base 与其它作用域零污染（base 三开关原样 fail-open）
  assert.equal(store.isSecure(), false, 'base 进程级标志不变');
  assert.equal(schema.core.requireContext(), false, 'base require_context 仍关闭');
  assert.equal(store.requireContext(), false);
});

test('policy-isolation A3: 一处 secureMode 不污染并发另一作用域', async () => {
  const wait = barrier(2);
  const seen = {};

  async function worker(tag, secure) {
    await withScope({ view: viewOf({}) }, async () => {
      if (secure) store.secureMode({ adminRoles: ['admin'] });
      await wait();                                   // 两者重叠：secured 与 plain 同时存活
      seen[tag] = {
        isSecure: store.isSecure(),
        requireContext: schema.getCore().requireContext(),
      };
    });
  }

  await Promise.all([worker('secured', true), worker('plain', false)]);
  assert.deepEqual(seen.secured, { isSecure: true, requireContext: true });
  assert.deepEqual(seen.plain, { isSecure: false, requireContext: false });
  assert.equal(store.isSecure(), false);
  assert.equal(schema.core.requireContext(), false);
});

// ── A4：视图只读守卫 ────────────────────────────────────────

test('policy-isolation A4: 作用域内 register 抛 ERR_POLICY_VIEW_READONLY 且不落 base', async () => {
  await withScope({ view: viewOf({}) }, async () => {
    let err = null;
    try {
      schema.register({
        name: 'IsoNope', collection: 'iso_nope', timestamps: false, fields: {}, relations: {},
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '视图内注册必须抛错（禁静默兜底）');
    assert.ok(
      err.message.startsWith('ERR_POLICY_VIEW_READONLY:'),
      `错误前缀须原样保留：${err.message}`,
    );
  });
  assert.equal(schema.core.has('IsoNope'), false, '被拒定义不得落 base 目录');
  assert.equal(schema.has('IsoNope'), false);
});

// ── A5：sink / meta 隔离 ───────────────────────────────────

test('policy-isolation A5: 两并发作用域 sink/meta 隔离', async () => {
  const wait = barrier(2);
  const seen = {};

  async function worker(tag, tenant, env) {
    const events = [];
    const metas = [];
    await withScope(
      { view: viewOf({}), sink: (e) => events.push(e), meta: { tenant, env } },
      async () => {
        metas.push({ ...currentScope().meta });
        feedback.emit({ type: 'isolation', code: `${tag}-1`, layer: 'host' });
        await wait();
        metas.push({ ...currentScope().meta });        // 让出后 meta 仍各归各
        feedback.emit({ type: 'isolation', code: `${tag}-2`, layer: 'host' });
      },
    );
    seen[tag] = { events: events.map((e) => e.code), metas };
  }

  await Promise.all([worker('a', 't1', 'e1'), worker('b', 't2', 'e2')]);
  assert.deepEqual(seen.a.events, ['a-1', 'a-2']);
  assert.deepEqual(seen.b.events, ['b-1', 'b-2']);
  assert.deepEqual(seen.a.metas, [{ tenant: 't1', env: 'e1' }, { tenant: 't1', env: 'e1' }]);
  assert.deepEqual(seen.b.metas, [{ tenant: 't2', env: 'e2' }, { tenant: 't2', env: 'e2' }]);
  assert.equal(currentScope(), null);
});

test('policy-isolation A5: 落库 sink 的 tenant/env 取作用域 meta（并发各归各）', async () => {
  const rows = [];
  const dispose = feedback.enableFeedbackTable({
    async insert(name, row) { rows.push({ name, row }); return row; },
  });

  try {
    const wait = barrier(2);
    async function worker(tag, tenant, env) {
      await withScope({ view: viewOf({}), meta: { tenant, env } }, async () => {
        feedback.emit({ type: 'isolation', code: `${tag}-1`, layer: 'host' });
        await wait();
        feedback.emit({ type: 'isolation', code: `${tag}-2`, layer: 'host' });
      });
    }
    await Promise.all([worker('a', 't1', 'e1'), worker('b', 't2', 'e2')]);
    await feedback.flush();
  } finally {
    await dispose();                                   // 恢复原 sink + 收口在途落库
  }

  const byCode = new Map(rows.map((r) => [r.row.code, r.row]));
  for (const code of ['a-1', 'a-2', 'b-1', 'b-2']) {
    assert.ok(byCode.has(code), `应落库事件 ${code}（实际 ${[...byCode.keys()].join(',')}）`);
  }
  assert.deepEqual([byCode.get('a-1').tenant, byCode.get('a-1').env], ['t1', 'e1']);
  assert.deepEqual([byCode.get('a-2').tenant, byCode.get('a-2').env], ['t1', 'e1']);
  assert.deepEqual([byCode.get('b-1').tenant, byCode.get('b-1').env], ['t2', 'e2']);
  assert.deepEqual([byCode.get('b-2').tenant, byCode.get('b-2').env], ['t2', 'e2']);
  assert.ok(rows.every((r) => r.name === '__feedback'));
});

test('policy-isolation A5: 作用域 sink 优先于进程级 sink', async () => {
  const procEvents = [];
  const scopedEvents = [];
  feedback.setSink((e) => procEvents.push(e));
  try {
    await withScope({ view: viewOf({}), sink: (e) => scopedEvents.push(e) }, async () => {
      feedback.emit({ type: 'isolation', code: 'scoped', layer: 'host' });
    });
    assert.deepEqual(scopedEvents.map((e) => e.code), ['scoped']);
    assert.equal(procEvents.length, 0, '作用域内不得回落到进程级 sink');

    feedback.emit({ type: 'isolation', code: 'proc', layer: 'host' });
    assert.deepEqual(procEvents.map((e) => e.code), ['proc'], '域外仍走进程级 sink');
  } finally {
    feedback.setSink(null);                            // 恢复默认 stderr，避免污染同进程后续用例
  }
});

// ── 域外零变更（与步骤 2/3 交叉验证）─────────────────────────

test('policy-isolation: 域外零变更（getCore 回退 base，scope/view 为 null）', async () => {
  assert.equal(currentScope(), null);
  assert.equal(currentView(), null);
  assert.equal(schema.getCore(), schema.core);

  const view = viewOf({ profile: PROFILE_AI });
  await withScope({ view }, async () => {
    assert.equal(currentView(), view);
    assert.equal(schema.getCore(), view);
  });

  assert.equal(currentScope(), null);
  assert.equal(currentView(), null);
  assert.equal(schema.getCore(), schema.core);
  assert.equal(schema.core.profile(), PROFILE_STD);
});
