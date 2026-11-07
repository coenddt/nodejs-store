'use strict';

/**
 * 宿主安全面回归（第二轮自检：core 报来的三项宿主问题）
 *
 *   P2-a ctx.internal 不得由请求上下文注入（setContext / scopedContext 收口）
 *   P2-b update/upsert/mutation 的 returns 以落库 doc 为基，只叠加计算列
 *        （显式 null 不得被默认值替换，对齐 core DefaultFill::Insert）
 *   P1   exists 走带 ctx 的读权限出口（等待 core planExistsWithCtx，当前 skip）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, permission, schema: _sc } = require('../src');

const SRC = 'sqlite_host_sec';

const POLICY = {
  mode: 'enforce',
  roles: { viewer: {} },
  grants: [
    { role: 'viewer', model: 'R2Allow', actions: ['read'], readFields: ['_id', 'title'] },
  ],
};

_sc.register({
  name: 'R2Null',
  collection: 'r2_null',
  idPrefix: 'rn',
  timestamps: false,
  fields: {
    _id: { type: 'string' },
    title: { type: 'string' },
    nick: { type: 'string', default: 'anon' },
  },
});

// E1 用：read: [] 显式拒绝 / RBAC 无授权 / 有权通过 / 字段白名单
_sc.register({ name: 'R2Deny', collection: 'r2_deny', timestamps: false, read: [],
  fields: { _id: { type: 'string' }, title: { type: 'string' } } });
_sc.register({ name: 'R2Rbac', collection: 'r2_rbac', timestamps: false, read: ['viewer'],
  fields: { _id: { type: 'string' }, title: { type: 'string' } } });
_sc.register({ name: 'R2Allow', collection: 'r2_allow', timestamps: false, read: ['viewer'],
  fields: { _id: { type: 'string' }, title: { type: 'string' }, secret: { type: 'string' } } });

async function freshStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE r2_null (
      _id TEXT PRIMARY KEY, title TEXT, nick TEXT, __present TEXT
    );
    CREATE TABLE r2_null_deleted (
      _id TEXT PRIMARY KEY, title TEXT, nick TEXT, deleted_at INTEGER, __present TEXT
    );
    CREATE TABLE r2_deny (_id TEXT PRIMARY KEY, title TEXT, __present TEXT);
    CREATE TABLE r2_rbac (_id TEXT PRIMARY KEY, title TEXT, __present TEXT);
    CREATE TABLE r2_allow (_id TEXT PRIMARY KEY, title TEXT, secret TEXT, __present TEXT);
  `);
  db.prepare('INSERT INTO r2_null (_id, title, nick, __present) VALUES (?, ?, ?, ?)')
    .run('rn1', 't0', null, ',_id,title,nick,');
  db.prepare('INSERT INTO r2_deny VALUES (?, ?, ?)').run('d1', 't', ',_id,title,');
  db.prepare('INSERT INTO r2_rbac VALUES (?, ?, ?)').run('r1', 't', ',_id,title,');
  db.prepare('INSERT INTO r2_allow VALUES (?, ?, ?, ?)').run('a1', 't', 's', ',_id,title,secret,');
  await init({ default: executors.createConnection('sqlite', db) });
  return db;
}

test('setContext 拒绝用户透传 internal 可信标记', () => {
  assert.throws(
    () => permission.setContext({ userId: 'u1', roles: ['creator'], internal: true }),
    /ctx\.internal 属可信标记/,
  );
});

test('scopedContext 拒绝用户透传 internal 可信标记', () => {
  assert.throws(
    () => permission.scopedContext({ userId: 'u1', internal: true }, () => 1),
    /ctx\.internal 属可信标记/,
  );
});

test('update returns 以落库 doc 为基：显式 null 不被默认值替换', async () => {
  const db = await freshStore();
  const ret = await store.update('R2Null', { _id: 'rn1' }, { title: 't1' });
  assert.equal(ret.title, 't1');
  assert.equal(ret.nick, null, `returns 的 nick 应保持落库值 null，实际 ${JSON.stringify(ret.nick)}`);
  const row = db.prepare('SELECT nick FROM r2_null WHERE _id = ?').get('rn1');
  assert.equal(row.nick, null);
});

test('exists: read:[] 显式拒绝（不返回 false，抛 PermissionError）', async () => {
  await freshStore();
  permission.setContext({ userId: 'u1', roles: ['viewer'] });
  try {
    await assert.rejects(() => store.exists('R2Deny', { _id: 'd1' }),
      (e) => e instanceof store.PermissionError && /无访问权限/.test(e.message));
  } finally { permission.setContext(undefined); }
});

test('exists: RBAC enforce 无该模型授权 → 拒绝', async () => {
  await freshStore();
  store.setRbac(POLICY);
  permission.setContext({ userId: 'u1', roles: ['viewer'] });
  try {
    await assert.rejects(() => store.exists('R2Rbac', { _id: 'r1' }),
      (e) => e instanceof store.PermissionError);
  } finally { permission.setContext(undefined); store.setRbac(null); }
});

test('exists: 有权通过（静态白名单 + RBAC 授权）', async () => {
  await freshStore();
  store.setRbac(POLICY);
  permission.setContext({ userId: 'u1', roles: ['viewer'] });
  try {
    assert.equal(await store.exists('R2Allow', { title: 't' }), true);
  } finally { permission.setContext(undefined); store.setRbac(null); }
});

test('exists: 条件引用字段白名单外字段应拒绝', { skip: 'core plan_exists_with_ctx 仅校验表级 read/RBAC（rust-store/core/src/command/write.rs:186-205），条件字段白名单未校验 —— 跨方向项' }, async () => {
  await freshStore();
  store.setRbac(POLICY);
  permission.setContext({ userId: 'u1', roles: ['viewer'] });
  try {
    await assert.rejects(() => store.exists('R2Allow', { secret: 's' }),
      (e) => e instanceof store.PermissionError);
  } finally { permission.setContext(undefined); store.setRbac(null); }
});
