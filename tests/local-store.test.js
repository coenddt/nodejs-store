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