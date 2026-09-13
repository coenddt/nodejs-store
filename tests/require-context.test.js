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
  await assert.rejects(() => store.query('RcPost{ title }'), /ERR_NO_CONTEXT/);
  await assert.rejects(() => store.insert('RcPost', { title: 'x' }), /ERR_NO_CONTEXT/);
  await assert.rejects(() => store.update('RcPost', {}, { title: 'y' }), /ERR_NO_CONTEXT/);
  await assert.rejects(() => store.remove('RcPost', {}), /ERR_NO_CONTEXT/);
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
