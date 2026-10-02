'use strict';

/**
 * RBAC 宿主包装端到端冒烟（A6-node）：setRbac → 越权 insert → PermissionError → 清除恢复
 *
 * 判决唯一在 core；RBAC 拒绝发生在 plan 阶段（core 产出命令之前），但本测试
 * 用 SQLite 内存库走完整链路（plan + 执行）验证门面透传与策略生命周期。
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, permission, schema: _sc } = require('../src');

const SRC = 'rbac_src';

const POLICY = {
  mode: 'enforce',
  roles: { viewer: {}, editor: {} },
  grants: [
    { role: 'viewer', model: 'Post', actions: ['read'], readFields: ['title'] },
    { role: 'editor', model: 'Post', actions: ['read', 'insert'] },
    { role: 'editor', model: 'Comment', actions: ['read'], ownerOnly: true },
  ],
};
const CTX_VIEWER = { userId: 'u1', roles: ['viewer'] };
const CTX_EDITOR = { userId: 'u2', roles: ['editor'] };

function createDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE rbac_posts (_id TEXT PRIMARY KEY, title TEXT, secret TEXT);');
  return db;
}

_sc.register({
  name: 'Post',
  collection: 'rbac_posts',
  idPrefix: 'rb_',
  timestamps: false,
  fields: { title: { type: 'string' }, secret: { type: 'string' } },
  relations: {},
  datasource: SRC,
});

before(async () => {
  await init({ [SRC]: executors.createConnection('sqlite', createDb()) });
  permission.setContext(undefined);
  store.setRbac(null);
});

test('setRbac 后越权 insert 抛 PermissionError(403)，消息含 RBAC', async () => {
  store.setRbac(POLICY);
  assert.equal(store.rbacEnabled(), true);
  permission.setContext(CTX_VIEWER);
  try {
    await assert.rejects(
      () => store.insert('Post', { title: 'x' }),
      (e) => e instanceof store.PermissionError && e.status === 403 && /RBAC/.test(e.message),
    );
  } finally {
    permission.setContext(undefined);
    store.setRbac(null);
  }
});

test('granted read 放行且字段集取交（readableFields = readFields ∩ 静态）', () => {
  store.setRbac(POLICY);
  try {
    assert.equal(store.rbacCan('Post', 'read', CTX_VIEWER), true);
    assert.equal(store.rbacCan('Post', 'insert', CTX_VIEWER), false);
    assert.deepEqual([...store.rbacReadableFields('Post', CTX_VIEWER)].sort(), ['title']);
    assert.equal(store.rbacCan('Post', 'insert', CTX_EDITOR), true);
  } finally {
    store.setRbac(null);
  }
});

test('清除策略后恢复直通（策略生命周期）', () => {
  store.setRbac(POLICY);
  assert.equal(store.rbacCan('Post', 'insert', CTX_VIEWER), false);
  store.setRbac(null);
  assert.equal(store.rbacEnabled(), false);
  assert.equal(store.rbacCan('Post', 'insert', CTX_VIEWER), true);
});

test('rbacRowCondition 返回 ownerOnly 行条件（reader 本人）', () => {
  store.setRbac({
    mode: 'overlay',
    roles: { reader: {} },
    grants: [{ role: 'reader', model: 'Post', actions: ['read'], ownerOnly: true }],
  });
  try {
    assert.deepEqual(
      store.rbacRowCondition('Post', 'read', { userId: 'u1', roles: ['reader'] }),
      { createdBy: 'u1' },
    );
    // overlay 下无匹配角色 → RBAC 不介入 → 无行级条件
    assert.equal(store.rbacRowCondition('Post', 'read', CTX_VIEWER), null);
  } finally {
    store.setRbac(null);
  }
});
