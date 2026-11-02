'use strict';

/**
 * accessKeys 声明式行级权限（node 宿主端到端）
 *
 * 与 py 侧 tests/test_access_keys.py 等价（同一 schema 形态、同一断言点）：
 *   1. 非法声明在注册期抛错（判决唯一在 core）；
 *   2. ctx 清单经 Host 透传后，读路径自动注入行条件、写路径自动做子集校验；
 *   3. `ERR_PERMISSION:ACCESS:` 前缀由 Host 映射为 PermissionError（消息剥离前缀）。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/access-keys.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { connect } = require('../src/memory');
const datasource = require('../src/datasource');
const { init, store, permission, schema: _sc } = require('../src');

function registerSchemas() {
  _sc.register({
    name: 'AkItem',
    collection: 'ak_items',
    idPrefix: 'ak_',
    timestamps: false,
    fields: {
      satCode: { type: 'string' },
      title: { type: 'string' },
      tags: { type: 'array' },
      createdBy: { type: 'string' },
    },
    relations: {},
    accessKeys: {
      satCode: { read: 'satsRead', write: 'satsWrite', bypassRoles: ['admin'] },
      tags: { read: 'tagsRead', write: 'tagsWrite' },
    },
  });
  // owner 条件（read=['creator']）+ accessKeys：验证 bypass 只跳过该键，owner 仍生效
  _sc.register({
    name: 'AkOwned',
    collection: 'ak_owned',
    idPrefix: 'ako_',
    timestamps: false,
    read: ['creator'],
    fields: {
      satCode: { type: 'string' },
      title: { type: 'string' },
      createdBy: { type: 'string' },
    },
    relations: {},
    accessKeys: {
      satCode: { read: 'satsRead', write: 'satsWrite', bypassRoles: ['admin'] },
    },
  });
  // 字段白名单（fields.*.write）叠加：不可写字段被过滤，access 校验只看可落库字段
  _sc.register({
    name: 'AkGuarded',
    collection: 'ak_guarded',
    idPrefix: 'akg_',
    timestamps: false,
    fields: {
      satCode: { type: 'string', write: ['viewer'] },
      note: { type: 'string', write: ['nobody'] },
    },
    relations: {},
    accessKeys: {
      satCode: { read: 'satsRead', write: 'satsWrite' },
    },
  });
}

registerSchemas();

async function setup() {
  await init(connect({ database: 'akdb', store: new Map() }));
  // ctx=None 系统写入：预置数据不受 accessKeys 管控
  await store.insert('AkItem', {
    _id: 'ak_r1', satCode: 'GEO', title: 'a', tags: ['x'], createdBy: 'u1',
  });
  await store.insert('AkItem', {
    _id: 'ak_r2', satCode: 'LEO', title: 'b', tags: ['x', 'y'], createdBy: 'u2',
  });
  await store.insert('AkItem', {
    _id: 'ak_r3', satCode: 'MARS', title: 'c', tags: ['y'], createdBy: 'u1',
  });
  await store.insert('AkOwned', {
    _id: 'ako_1', satCode: 'GEO', title: 'o1', createdBy: 'u1',
  });
  await store.insert('AkOwned', {
    _id: 'ako_2', satCode: 'GEO', title: 'o2', createdBy: 'u2',
  });
  await store.insert('AkOwned', {
    _id: 'ako_3', satCode: 'MARS', title: 'o3', createdBy: 'u1',
  });
}

function setCtx({ roles = ['viewer'], userId = 'u1', ...lists } = {}) {
  permission.setContext({ userId, roles, ...lists });
}

function teardown() {
  permission.setContext(undefined);
  datasource.setConnections({});
}

function ids(rows) {
  return rows.map((r) => r._id).sort();
}

function isAccessError(e) {
  return e instanceof store.PermissionError && /ACCESS:/.test(e.message);
}

// ─── 1. 声明校验（注册期 fail-fast） ──────────────────────────

test('accessKeys: 非法声明在注册期抛错', () => {
  assert.throws(
    () => _sc.register({
      name: 'AkBad',
      collection: 'ak_bad',
      timestamps: false,
      fields: { title: { type: 'string' } },
      relations: {},
      accessKeys: { ghost: { read: 'x' } },
    }),
    /accessKeys/,
  );
});

// ─── 2. 读路径：单值成员 + 数组交集（多键 AND） ───────────────

test('accessKeys: 读路径注入成员判定与数组交集', async () => {
  try {
    await setup();
    setCtx({ satsRead: ['GEO', 'LEO'], tagsRead: ['x'] });
    assert.deepEqual(ids(await store.query('AkItem{ _id title }')), ['ak_r1', 'ak_r2']);
  } finally {
    teardown();
  }
});

// ─── 3. ctx 缺键 → fail closed ────────────────────────────────

test('accessKeys: ctx 缺清单键 → PermissionError', async () => {
  try {
    await setup();
    setCtx({ tagsRead: ['x'] }); // 缺 satsRead
    await assert.rejects(() => store.query('AkItem{ _id }'), isAccessError);
  } finally {
    teardown();
  }
});

// ─── 4. 空清单 → 读空结果（与缺键严格区分） ──────────────────

test('accessKeys: 空清单读空结果', async () => {
  try {
    await setup();
    setCtx({ satsRead: [], tagsRead: ['x'] });
    assert.deepEqual(await store.query('AkItem{ _id }'), []);
  } finally {
    teardown();
  }
});

// ─── 5. 写路径：单值越界 / 数组非子集拒绝，子集放行 ──────────

test('accessKeys: 写单值越界拒绝', async () => {
  try {
    await setup();
    setCtx({ satsWrite: ['GEO', 'LEO'], tagsWrite: ['x'] });
    await assert.rejects(
      () => store.insert('AkItem', { satCode: 'MARS', title: 'n', tags: ['x'] }),
      isAccessError,
    );
  } finally {
    teardown();
  }
});

test('accessKeys: 写数组非子集拒绝', async () => {
  try {
    await setup();
    setCtx({ satsWrite: ['GEO', 'LEO'], tagsWrite: ['x'] });
    await assert.rejects(
      () => store.insert('AkItem', { satCode: 'GEO', title: 'n', tags: ['x', 'z'] }),
      isAccessError,
    );
  } finally {
    teardown();
  }
});

test('accessKeys: 写数组子集放行', async () => {
  try {
    await setup();
    setCtx({ satsWrite: ['GEO', 'LEO'], tagsWrite: ['x'] });
    const row = await store.insert('AkItem', { satCode: 'GEO', title: 'n', tags: ['x'] });
    assert.ok(String(row._id).startsWith('ak_'));
  } finally {
    teardown();
  }
});

// ─── 6. bypassRoles 只跳过该键，owner 条件仍生效 ─────────────

test('accessKeys: bypass 角色跳过该键但 owner 仍生效', async () => {
  try {
    await setup();
    setCtx({ roles: ['admin'], userId: 'u1' }); // 未提供 satsRead，但 admin 命中 bypass
    assert.deepEqual(ids(await store.query('AkOwned{ _id title }')), ['ako_1', 'ako_3']);
  } finally {
    teardown();
  }
});

// ─── 7. 字段白名单叠加：不可写字段被过滤、access 校验照常 ────

test('accessKeys: 字段白名单过滤后仍做 access 校验', async () => {
  try {
    await setup();
    setCtx({ satsRead: ['GEO', 'LEO'], satsWrite: ['GEO', 'LEO'] });
    const row = await store.insert('AkGuarded', { satCode: 'GEO', note: 'secret' });
    const stored = await store.query('AkGuarded{ _id satCode note }');
    assert.deepEqual(stored.map((r) => r._id), [row._id]);
    assert.equal('note' in stored[0], false, '不可写字段应被过滤');
    await assert.rejects(
      () => store.insert('AkGuarded', { satCode: 'MARS', note: 'secret' }),
      isAccessError,
    );
  } finally {
    teardown();
  }
});
