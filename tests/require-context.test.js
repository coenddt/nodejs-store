'use strict';

/**
 * require_context fail-secure 开关（Registry 级，rust-store M-1 闭环）
 *
 * 验证「上下文强制」三种语义：
 *   1. 默认关闭 = fail-open（与 JS 原版 parity：无 ctx 照常查询/写入）；
 *   2. 开启后缺 ctx 抛 `ERR_NO_CONTEXT`（fail-secure，读/写全路径）；
 *   3. 系统上下文（runAsInternal）与用户上下文照常放行；关闭即恢复。
 *
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, permission, schema: _sc } = require('../src');

const SRC = 'rc_src';

function createDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE rc_posts (_id TEXT PRIMARY KEY, title TEXT, __present TEXT);');
  return db;
}

_sc.register({
  name: 'RcPost',
  collection: 'rc_posts',
  idPrefix: 'rp_',
  timestamps: false,
  fields: { title: { type: 'string' } },
  relations: {},
  datasource: SRC,
});

before(async () => {
  await init({ [SRC]: executors.createConnection('sqlite', createDb()) });
  permission.setContext(undefined);
});

test('require_context: 默认关闭 = fail-open（无 ctx 照常查询/写入）', async () => {
  await store.query('RcPost{ title }');
  await store.insert('RcPost', { title: '默认放行' });
});

test('require_context: 开启后缺 ctx 抛 ERR_NO_CONTEXT（读/写全路径）', async () => {
  store.setRequireContext(true);
  await assert.rejects(() => store.query('RcPost{ title }'), permission.NoContextError);
  await assert.rejects(() => store.insert('RcPost', { title: 'x' }), permission.NoContextError);
  await assert.rejects(() => store.update('RcPost', {}, { title: 'y' }), permission.NoContextError);
  await assert.rejects(() => store.remove('RcPost', {}), permission.NoContextError);
});

test('require_context: 系统上下文（runAsInternal）放行', async () => {
  await permission.runAsInternal(async () => store.insert('RcPost', { title: '系统写入' }));
  const items = await permission.runAsInternal(() => store.query('RcPost{ title }'));
  assert.equal(items.length, 2, '默认写入 1 条 + 系统写入 1 条');
  assert.ok(items.some((it) => it.title === '系统写入'));
});

test('require_context: 用户上下文放行', async () => {
  permission.setContext({ userId: 'u1', roles: ['user'] });
  await store.insert('RcPost', { title: '用户写入' });
  const items = await store.query('RcPost{ title }');
  assert.equal(items.length, 3);
});

test('require_context: 关闭后恢复 fail-open', async () => {
  permission.setContext(undefined);
  store.setRequireContext(false);
  await store.query('RcPost{ title }');
});

// ── secureMode 统一安全模式（fail-secure 一键入口；见 src/secure.js） ──

test('secureMode: 一键翻转三个开关，无 ctx 的读写与注册全拒', async () => {
  store.secureMode({ adminRoles: ['admin'] });
  assert.equal(store.isSecure(), true);
  assert.equal(store.requireContext(), true);
  // 开关1 require_context：无 ctx 读写拒绝
  await assert.rejects(() => store.query('RcPost{ title }'), permission.NoContextError);
  await assert.rejects(() => store.insert('RcPost', { title: 'x' }), permission.NoContextError);
  // 开关3 meta closed：无 ctx 注册新定义拒绝
  assert.throws(
    () => _sc.register({ name: 'RcTmp', collection: 'rc_tmp', fields: {}, relations: {}, datasource: SRC }),
    /ERR_PERMISSION/,
  );
});

test('secureMode: 白名单角色可注册，但未配权限白名单的 schema 对任何用户全拒', async () => {
  // 注意：register 的定义门禁只认显式 ctx 参数（不读 ALS），须显式传入
  _sc.register(
    {
      name: 'RcSecret', collection: 'rc_secret', timestamps: false,
      fields: { title: { type: 'string' } }, relations: {}, datasource: SRC,
    },
    { userId: 'admin1', roles: ['admin'] },
  );
  // 查询面身份走 ALS（register 门禁与读写判决的上下文通道不同）
  permission.setContext({ userId: 'admin1', roles: ['admin'] });
  // 开关2 unconfigured=closed：该 schema 未配 read/write 白名单，admin 自己也被拒
  // （判决在 core plan 阶段，先于 SQL 执行，故 rc_secret 物理表缺失不影响断言）。
  // core 抛 ERR_PERMISSION，经 crud/exec._call 归一为 PermissionError（前缀已剥离）。
  await assert.rejects(() => store.query('RcSecret{ title }'), permission.PermissionError);
  await assert.rejects(() => store.insert('RcSecret', { title: 'a' }), permission.PermissionError);
  // 普通用户同样被拒
  permission.setContext({ userId: 'u2', roles: ['user'] });
  await assert.rejects(() => store.query('RcSecret{ title }'), permission.PermissionError);
});

test('secureMode: internal 上下文照常放行（后台任务通道保留）', async () => {
  await permission.runAsInternal(async () => {
    await store.insert('RcPost', { title: '内部写入' });
    const items = await store.query('RcPost{ title }');
    assert.ok(items.some((it) => it.title === '内部写入'));
  });
});

test('secureMode: relaxMode 恢复 fail-open 姿态', async () => {
  store.relaxMode();
  assert.equal(store.isSecure(), false);
  assert.equal(store.requireContext(), false);
  permission.setContext(undefined);
  await store.query('RcPost{ title }');
});
