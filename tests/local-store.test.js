'use strict';

/**
 * 本地磁盘数据源（local）Host 单测
 *
 * 分步累积：本文件随执行文档 `02-node宿主local连接与文件落盘` 的步骤 2/3/4/8 逐步补齐。
 * 运行：`$env:LOCAL_CORE='1'; node --test tests/local-store.test.js`（或 `npm test`）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSnapshot, writeCollections, withDirLock } = require('../src/local/store');
const { createDb } = require('../src/local/handle');
const { connect, LOCAL_KIND } = require('../src/local');
const datasource = require('../src/datasource');
const feedback = require('../src/feedback');
const { init, store, schema: _sc } = require('../src');

const _dirs = [];

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nodejs-store-local-${tag}-`));
  _dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 步骤 2：文件 IO ─────────────────────────────────────────

test('local/store: 目录不存在 → 空快照', () => {
  const dir = path.join(tmpDir('missing'), 'not-created');
  assert.deepEqual(readSnapshot(dir), {});
});

test('local/store: 写→读往返（文档数组，可读 JSON）', () => {
  const dir = tmpDir('roundtrip');
  const docs = [{ _id: 'u1', name: 'Ada' }, { _id: 'u2', name: 'Bob' }];
  writeCollections(dir, ['users'], { users: docs });

  assert.deepEqual(readSnapshot(dir), { users: docs });
  // 落盘文件确为可读 JSON 数组
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  assert.deepEqual(onDisk, docs);
});

test('local/store: 只回写 changed 中的集合', () => {
  const dir = tmpDir('partial');
  writeCollections(dir, ['a', 'b'], { a: [{ _id: 1 }], b: [{ _id: 2 }] });
  writeCollections(dir, ['a'], { a: [{ _id: 1 }, { _id: 3 }], b: [{ _id: 999 }] });

  const snap = readSnapshot(dir);
  assert.deepEqual(snap.a, [{ _id: 1 }, { _id: 3 }]);
  assert.deepEqual(snap.b, [{ _id: 2 }], '未在 changed 中的集合不应被回写');
});

test('local/store: 非数组集合文件 → 抛错（禁静默当空）', () => {
  const dir = tmpDir('nonarray');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ _id: 'u1' }));
  assert.throws(() => readSnapshot(dir), /必须是文档数组/);
});

test('local/store: 非法 JSON 集合文件 → 抛错', () => {
  const dir = tmpDir('badjson');
  fs.writeFileSync(path.join(dir, 'users.json'), '{ not json');
  assert.throws(() => readSnapshot(dir), /非法 JSON/);
});

test('local/store: withDirLock 串行化并发写，互不覆盖', async () => {
  const dir = tmpDir('lock');
  const snap = { users: [], posts: [] };
  const write = (name) => withDirLock(dir, () => {
    snap[name] = [...snap[name], { _id: `${name}-1` }];
    writeCollections(dir, [name], snap);
  });

  await Promise.all([write('users'), write('posts'), write('users')]);

  const onDisk = readSnapshot(dir);
  assert.equal(onDisk.users.length, 2, 'users 两次写应累加（串行、无丢失）');
  assert.equal(onDisk.posts.length, 1);
});

// ─── 步骤 3：Mongo 兼容手柄 ─────────────────────────────────

/** 内存 io（驱动 handle，不经 store/落盘） */
function memIo(initial = {}) {
  const box = { snap: initial };
  return {
    box,
    io: {
      load: () => box.snap,
      save: (_changed, collections) => { box.snap = collections; },
    },
  };
}

test('local/handle: 方法集逐一对应 execMongo（读用游标 / 写 await 落盘）', async () => {
  const { box, io } = memIo({});
  const db = createDb(io);
  const users = db.collection('users');

  // insertOne → result 为写入文档；save 已回写到快照
  const ins = await users.insertOne({ _id: 'u1', name: 'Ada', age: 36 });
  assert.deepEqual(ins, { _id: 'u1', name: 'Ada', age: 36 });
  assert.deepEqual(box.snap.users, [{ _id: 'u1', name: 'Ada', age: 36 }]);

  // insertMany（普通）
  const many = await users.insertMany([{ _id: 'u2', name: 'Bob', age: 20 }]);
  assert.deepEqual(many, { insertedCount: 1 });

  // find → 游标
  const rows = await users.find({ name: 'Ada' }).toArray();
  assert.deepEqual(rows, [{ _id: 'u1', name: 'Ada', age: 36 }]);

  // find + projection
  assert.deepEqual(
    await users.find({}, { projection: { name: 1, _id: 0 } }).toArray(),
    [{ name: 'Ada' }, { name: 'Bob' }],
  );

  // findOne 命中 / 未命中
  assert.equal((await users.findOne({ _id: 'u2' })).name, 'Bob');
  assert.equal(await users.findOne({ _id: 'nope' }), null);

  // countDocuments
  assert.equal(await users.countDocuments({ age: { $gte: 20 } }), 2);

  // execMongo 会把 `field: null` 归一为 `{$eq:null,$exists:true}`（mongo.js §_explicitNull）
  const { io: io2 } = memIo({ docs: [{ _id: 1, x: null }, { _id: 2 }] });
  assert.deepEqual(
    await createDb(io2).collection('docs').find({ x: { $eq: null, $exists: true } }).toArray(),
    [{ _id: 1, x: null }],
  );

  // updateMany / findOneAndUpdate
  assert.deepEqual(await users.updateMany({ name: 'Ada' }, { $set: { seen: true } }), { modifiedCount: 1 });
  assert.deepEqual(await users.findOneAndUpdate({ _id: 'u2' }, { $set: { seen: true } }), { _id: 'u2', name: 'Bob', age: 20, seen: true });

  // aggregate（关系 $lookup）
  const { io: io3 } = memIo({
    probeUsers: [{ _id: 'pu1', name: 'Ada' }],
    probePosts: [{ _id: 'pp1', title: 'P1', userId: 'pu1' }],
  });
  const posts = createDb(io3).collection('probePosts');
  const agg = await posts.aggregate([
    { $match: {} },
    {
      $lookup: {
        as: 'author',
        from: 'probeUsers',
        let: { rel_userId: { $ifNull: ['$userId', null] } },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$rel_userId'] } } },
          { $project: { _id: 1, name: 1 } },
        ],
      },
    },
    { $unwind: { path: '$author', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 1, author: 1, title: 1 } },
  ]).toArray();
  assert.deepEqual(agg, [{ _id: 'pp1', author: { _id: 'pu1', name: 'Ada' }, title: 'P1' }]);

  // deleteMany
  assert.deepEqual(await users.deleteMany({ _id: 'u2' }), { deletedCount: 1 });
  assert.equal(box.snap.users.length, 1);

  // listIndexes（local v1 空）/ createIndex（no-op）
  assert.deepEqual(await users.listIndexes().toArray(), []);
  await users.createIndex({ name: 1 });
});

test('local/handle: 归档 upsertById 路径（replaceOne 逐条 upsert）', async () => {
  const { box, io } = memIo({});
  const deleted = createDb(io).collection('usersDeleted');
  // 对应 execMongo 的 insertMany(upsertById) → 逐条 replaceOne(..., { upsert: true })
  await deleted.replaceOne({ _id: 'u1' }, { _id: 'u1', deletedAt: 100 }, { upsert: true });
  await deleted.replaceOne({ _id: 'u1' }, { _id: 'u1', deletedAt: 200 }, { upsert: true });
  assert.deepEqual(box.snap.usersDeleted, [{ _id: 'u1', deletedAt: 200 }], '按 _id 覆盖，幂等不重复');
  // 非 upsert 调用被拒（只有 upsertById 路径才会走到 replaceOne）
  assert.throws(() => deleted.replaceOne({ _id: 'x' }, { _id: 'x' }), /仅支持 upsert 语义/);
});

// ─── 步骤 4：门面 ───────────────────────────────────────────

test('local/index: connect 产描述符 + 直连读写', async () => {
  const dir = tmpDir('facade');
  writeCollections(dir, ['users'], { users: [{ _id: 'u1', name: 'Ada' }] });

  const conn = connect({ dir });
  assert.equal(conn.kind, LOCAL_KIND);
  assert.equal(conn.kind, 'local');
  assert.equal(conn.dir, path.resolve(dir));
  assert.equal(typeof conn.handle.collection, 'function');
  assert.equal(typeof conn.openTransaction, 'function');
  assert.equal(typeof conn.withTransaction, 'function');

  await conn.handle.collection('users').insertOne({ _id: 'u2', name: 'Bob' });
  assert.equal(readSnapshot(dir).users.length, 2, '直连 ready 后即时落盘');
});

test('local/index: openTransaction 快照隔离（commit 可见 / rollback 丢弃）', async () => {
  const dir = tmpDir('tx');
  writeCollections(dir, ['users'], { users: [{ _id: 'u1' }] });
  const conn = connect({ dir });

  // commit：tx 内写先入内存快照，commit 才落盘
  const tx = await conn.openTransaction();
  await tx.handle.collection('users').insertOne({ _id: 'u2' });
  assert.equal(tx.session.snapshot().users.length, 2, 'tx 内快照含新写');
  assert.equal(readSnapshot(dir).users.length, 1, 'commit 前磁盘不可见（快照隔离）');
  await tx.commit();
  await tx.release();
  assert.equal(readSnapshot(dir).users.length, 2, 'commit 后落盘可见');

  // rollback：丢弃
  const tx2 = await conn.openTransaction();
  await tx2.handle.collection('users').insertOne({ _id: 'u3' });
  await tx2.rollback();
  await tx2.release();
  assert.equal(readSnapshot(dir).users.length, 2, 'rollback 后丢弃');

  // withTransaction 便捷包装
  const out = await conn.withTransaction(async (_s, t) => {
    await t.handle.collection('users').insertOne({ _id: 'u4' });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(readSnapshot(dir).users.length, 3);
});

// ─── 步骤 5：datasource 接线 ────────────────────────────────

test('local/datasource: 裸描述符归一 + 事务作用域（commit 可见 / 无 mongo 告警）', async () => {
  const dir = tmpDir('ds-tx');
  writeCollections(dir, ['users'], { users: [{ _id: 'u1' }] });
  const conn = connect({ dir });
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    assert.equal(datasource.LOCAL_KIND, 'local');
    assert.equal(datasource.isLocalConnection(conn), true);
    datasource.setConnections(conn); // 裸描述符 → { default: conn }
    assert.equal(datasource.getConnection('default'), conn);

    await datasource.runInTransaction('default', async () => {
      const view = datasource.connectionFor('default');
      assert.equal(view.kind, 'local');
      assert.equal(typeof view.handle.collection, 'function', '事务视图须携带 handle');
      await view.handle.collection('users').insertOne({ _id: 'u2' });
      assert.equal(view.session.snapshot().users.length, 2, 'tx 内快照含新写');
      assert.equal(readSnapshot(dir).users.length, 1, 'commit 前磁盘不可见');
    });
    assert.equal(readSnapshot(dir).users.length, 2, 'commit 后落盘可见');
  } finally {
    feedback.setSink(null);
    datasource.setConnections({});
  }
  assert.ok(
    !events.some((e) => e.code === 'mongoTransactionUnsupported'),
    'local 源不得出现 mongo 事务告警',
  );
});

test('local/datasource: 无 withTransaction 原语 → transaction_not_atomic（降级不静默）', async () => {
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    datasource.setConnections({ default: { kind: 'local' } }); // 缺 openTransaction/withTransaction
    const ran = await datasource.runInTransaction('default', async () => 'ok');
    assert.equal(ran, 'ok', '降级后按原样执行');
  } finally {
    feedback.setSink(null);
    datasource.setConnections({});
  }
  assert.ok(
    events.some((e) => e.code === 'transactionNotAtomic'),
    '应声明 transaction_not_atomic',
  );
});

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