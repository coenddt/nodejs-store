'use strict';

/**
 * 本地磁盘数据源（local）命令路由端到端单测（D4-4 零语义拆分）。
 *
 * 自 tests/local-store.test.js 原样迁出步骤 6（store 门面端到端）、archive 归档开关、
 * 步骤 7（indexes 告警 + 模块导出）与步骤 8（A1/A3/A5 补齐）；临时目录工厂下沉
 * ../test-support/local-store-support.js；用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  tmpDir, readSnapshot, connect, datasource, feedback, init, store, _sc,
} = require('../test-support/local-store-support');

// ─── 步骤 6：命令路由接线（store 门面端到端） ───────────────

test('local/exec: store 门面端到端（insert/query 关系/count/update/remove 归档）', async () => {
  _sc.register({
    name: 'ElUser', collection: 'el_users', idPrefix: 'eu_', timestamps: false,
    fields: { name: { type: 'string' } }, relations: {},
  });
  _sc.register({
    name: 'ElPost', collection: 'el_posts', idPrefix: 'ep_', timestamps: false,
    fields: { title: { type: 'string' }, authorId: { type: 'string' } },
    relations: {
      author: { model: 'ElUser', type: 'one', localField: 'authorId', foreignField: '_id' },
    },
  });

  const dir = tmpDir('e2e');
  try {
    await init(connect({ dir }));

    const u = await store.insert('ElUser', { name: 'Ada' });
    const p = await store.insert('ElPost', { title: 'P1', authorId: u._id });
    assert.ok(String(u._id).startsWith('eu_'), '应生成 idPrefix 前缀 _id');

    // 落盘为物理名（camelCase）文件、内容为文档数组
    assert.equal(readSnapshot(dir).elUsers.length, 1);
    assert.equal(readSnapshot(dir).elPosts.length, 1);

    // query（含 one 关系 → 对象）
    const rows = await store.query('ElPost{ title author { name } }');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'P1');
    assert.equal(rows[0].author.name, 'Ada');

    // count
    assert.equal(await store.count('ElPost', {}), 1);

    // update（回读被更新文档）
    const out = await store.update('ElPost', { _id: p._id }, { title: 'P2' });
    assert.equal(out.title, 'P2');
    assert.equal(readSnapshot(dir).elPosts[0].title, 'P2');

    // remove → 归档集合 ElPostDeleted 出现（文件 elPostsDeleted.json）
    const r = await store.remove('ElPost', { _id: p._id });
    assert.equal(r.deletedCount, 1);
    assert.equal(r.archivedCount, 1);
    assert.equal(readSnapshot(dir).elPosts.length, 0);
    assert.equal(readSnapshot(dir).elPostsDeleted.length, 1);
  } finally {
    datasource.setConnections({});
  }
});

// ─── 漉金Core接入扩展 02：archive 归档开关（schema 级 / 调用级） ───

test('local/exec: schema archive:false → remove 不归档且不建归档集合', async () => {
  _sc.register({
    name: 'ElKeep', collection: 'el_keeps', idPrefix: 'ek_', timestamps: false,
    archive: false,
    fields: { title: { type: 'string' } }, relations: {},
  });

  const dir = tmpDir('arch-off');
  try {
    await init(connect({ dir }));

    const p = await store.insert('ElKeep', { title: 'K1' });
    const r = await store.remove('ElKeep', { _id: p._id });
    assert.equal(r.deletedCount, 1);
    assert.equal(r.archivedCount, 0);
    assert.equal(readSnapshot(dir).elKeeps.length, 0);
    assert.ok(!('elKeepsDeleted' in readSnapshot(dir)), 'archive:false 不应出现归档集合');
  } finally {
    datasource.setConnections({});
  }
});

test('local/exec: options {archive:false} → 仅本次跳过，后续默认调用照常归档', async () => {
  _sc.register({
    name: 'ElOnce', collection: 'el_onces', idPrefix: 'eo_', timestamps: false,
    fields: { title: { type: 'string' } }, relations: {},
  });

  const dir = tmpDir('arch-opt');
  try {
    await init(connect({ dir }));

    const a = await store.insert('ElOnce', { title: 'A' });
    const b = await store.insert('ElOnce', { title: 'B' });

    // 本次调用级跳过：删除照常、归档集合不出现
    const r1 = await store.remove('ElOnce', { _id: a._id }, null, { archive: false });
    assert.equal(r1.deletedCount, 1);
    assert.equal(r1.archivedCount, 0);
    assert.ok(!('elOncesDeleted' in readSnapshot(dir)), 'options.archive:false 本次不应归档');

    // 后续默认调用照常归档（注册态未被污染 → 「单次」语义）
    const r2 = await store.remove('ElOnce', { _id: b._id });
    assert.equal(r2.deletedCount, 1);
    assert.equal(r2.archivedCount, 1);
    assert.equal(readSnapshot(dir).elOncesDeleted.length, 1);
  } finally {
    datasource.setConnections({});
  }
});

// ─── 步骤 7：索引声明告警 + 模块导出 ───────────────────────

test('local/index.js: 声明 indexes → localIndexesIgnored（禁静默）；模块导出 local', async () => {
  const api = require('../src');
  assert.equal(typeof api.local.connect, 'function', 'index.js 应导出 local 模块');

  _sc.register({
    name: 'ElIdx', collection: 'el_idx', idPrefix: 'ei_', timestamps: false,
    fields: { name: { type: 'string' } }, relations: {},
    indexes: [{ keys: { name: 1 } }],
  });

  const dir = tmpDir('idx');
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    await init(connect({ dir }));
    assert.ok(
      events.some((e) => e.code === 'localIndexesIgnored'),
      'local schema 声明 indexes 应发 localIndexesIgnored',
    );
    // 不建索引、不抛错：集合仍可正常读写
    await store.insert('ElIdx', { name: 'x' });
    assert.equal(readSnapshot(dir).elIdx.length, 1);
  } finally {
    feedback.setSink(null);
    datasource.setConnections({});
  }
});

// ─── 步骤 8：A1/A3/A5 端到端补齐 ───────────────────────────

test('local/A1: one 关系查询返回含 _id/name 的对象', async () => {
  const dir = tmpDir('rel');
  try {
    await init(connect({ dir }));
    const u = await store.insert('ElUser', { name: 'Rel' });
    await store.insert('ElPost', { title: 'T', authorId: u._id });
    const rows = await store.query('ElPost{ author { _id name } }');
    assert.deepEqual(rows[0].author, { _id: u._id, name: 'Rel' });
  } finally {
    datasource.setConnections({});
  }
});

test('local/A3: store.transaction commit 可见 / 异常回滚不可见（无 mongo 告警）', async () => {
  const dir = tmpDir('tx-store');
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    await init(connect({ dir }));
    await store.transaction('default', async () => {
      await store.insert('ElUser', { name: 'TxAda' });
    });
    assert.equal(readSnapshot(dir).elUsers.length, 1, 'commit 后落盘可见');

    await assert.rejects(
      () => store.transaction('default', async () => {
        await store.insert('ElUser', { name: 'TxBob' });
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(readSnapshot(dir).elUsers.length, 1, 'rollback 后不落盘');
  } finally {
    feedback.setSink(null);
    datasource.setConnections({});
  }
  assert.ok(
    !events.some((e) => e.code === 'mongoTransactionUnsupported'),
    'local 源事务不应出现 mongo 事务告警',
  );
});

test('local/A3: store.session 内多条写提交后可见', async () => {
  const dir = tmpDir('session');
  try {
    await init(connect({ dir }));
    await store.session(async (s) => {
      await s.insert('ElUser', { name: 'S1' });
      await s.insert('ElUser', { name: 'S2' });
    });
    assert.equal(readSnapshot(dir).elUsers.length, 2, '会话提交后两条写可见');
  } finally {
    datasource.setConnections({});
  }
});

test('local/A5: 两次 init 幂等（同目录数据保留、不重复）', async () => {
  const dir = tmpDir('init2');
  try {
    await init(connect({ dir }));
    await store.insert('ElUser', { name: 'Keep' });
    const before = readSnapshot(dir).elUsers.length;

    await init(connect({ dir })); // 二次 init：同一目录
    assert.equal(readSnapshot(dir).elUsers.length, before, '二次 init 不应清空/重复');
    assert.equal(await store.count('ElUser', {}), before);
  } finally {
    datasource.setConnections({});
  }
});
