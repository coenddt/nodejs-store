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

async function freshStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE r2_null (
      _id TEXT PRIMARY KEY, title TEXT, nick TEXT, __present TEXT
    );
    CREATE TABLE r2_null_deleted (
      _id TEXT PRIMARY KEY, title TEXT, nick TEXT, deleted_at INTEGER, __present TEXT
    );
  `);
  db.prepare('INSERT INTO r2_null (_id, title, nick, __present) VALUES (?, ?, ?, ?)')
    .run('rn1', 't0', null, ',_id,title,nick,');
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

test('exists 走带 ctx 的读权限出口', { skip: '等待 core 导出 planExistsWithCtx（第二轮跨方向项 P1）' }, async () => {
  await freshStore();
  permission.setContext({ userId: 'u1', roles: [] });
  const visible = await store.exists('R2Null', { _id: 'rn1' });
  permission.setContext(undefined);
  assert.equal(visible, false, 'read:[] 下存在性探测应不可见');
});
