'use strict';

/**
 * Mongo session 事务用例（执行总纲 A1–A8）
 *
 * 零外部服务路径：假 Mongo client/db（记录 session 与事务调用）；
 * 真实路径：本机单节点副本集 rs0（独立库 mongo_store_e2e_tx）验证事务真提交 / 真回滚；
 * 非 rs 环境（CI standalone）自动 skip。
 *
 * 运行：node scripts/test.js（置 LOCAL_CORE=1 使用仓库内 Rust 核心）
 * 对齐 py-store/tests/test_mongo_session.py
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { store, feedback, datasource, schema: _sc } = require('../src');
const naming = require('../src/naming');
const { runAtomic } = require('../src/crud/exec');
const mongo = require('../src/executors/mongo');

// ─── 假 Mongo 驱动（能力 + session 记录） ─────────────────────

function makeRecColl(rec, name) {
  const opt = (opts) => (opts || {}).session || null;
  return {
    find(f, opts) { rec.ops.push([name, 'find', opt(opts)]); return { toArray: async () => [] }; },
    aggregate(p, opts) { rec.ops.push([name, 'aggregate', opt(opts)]); return { toArray: async () => [] }; },
    async countDocuments(f, opts) { rec.ops.push([name, 'countDocuments', opt(opts)]); return 0; },
    async findOne(f, opts) { rec.ops.push([name, 'findOne', opt(opts)]); return null; },
    async insertOne(doc, opts) { rec.ops.push([name, 'insertOne', opt(opts)]); return doc; },
    async insertMany(docs, opts) { rec.ops.push([name, 'insertMany', opt(opts)]); return { insertedCount: docs.length }; },
    async replaceOne(f, doc, opts) { rec.ops.push([name, 'replaceOne', opt(opts)]); return { modifiedCount: 1 }; },
    async findOneAndUpdate(f, u, opts) { rec.ops.push([name, 'findOneAndUpdate', opt(opts)]); return null; },
    async updateMany(f, u, opts) { rec.ops.push([name, 'updateMany', opt(opts)]); return { modifiedCount: 1 }; },
    async deleteMany(f, opts) { rec.ops.push([name, 'deleteMany', opt(opts)]); return { deletedCount: 1 }; },
  };
}

function makeDb(hello) {
  const rec = { ops: [], tx: [], sessions: [], hello: 0 };
  const client = {
    // node 原生驱动：startSession / startTransaction 为同步，commit/abort/endSession 为 async
    startSession() {
      const s = {
        startTransaction() { rec.tx.push('start'); },
        async commitTransaction() { rec.tx.push('commit'); },
        async abortTransaction() { rec.tx.push('abort'); },
        async endSession() { rec.tx.push('end'); },
      };
      rec.sessions.push(s);
      return s;
    },
    db() {
      return {
        async command() {
          rec.hello += 1;
          if (hello instanceof Error) throw hello;
          return hello;
        },
      };
    },
    _counter: () => rec.hello,
  };
  const db = {
    client,
    collection(name) { return makeRecColl(rec, name); },
  };
  return { db, rec, client };
}

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
});

function registerMongo(name, source, collection) {
  _sc.register({
    name, collection: collection || name.toLowerCase(), timestamps: false, idPrefix: 'MX',
    fields: { v: { type: 'string' } }, relations: {}, datasource: source,
  });
}

// ─── #A1 能力探测四态 ────────────────────────────────────────

test('#A1 能力探测四态：replica set / sharded / standalone / 探测失败', async () => {
  const { db: repl } = makeDb({ setName: 'rs0' });
  const { db: shard } = makeDb({ msg: 'isdbgrid' });
  const { db: alone } = makeDb({ ok: 1 });
  const { db: err } = makeDb(new Error('boom'));
  assert.equal(await datasource.mongoTransactable(repl), true);
  assert.equal(await datasource.mongoTransactable(shard), true);
  assert.equal(await datasource.mongoTransactable(alone), false);
  assert.equal(await datasource.mongoTransactable(err), null);
});

// ─── #A2 探测按 client 缓存；失败不缓存 ──────────────────────

test('#A2 探测按 client 缓存；失败不缓存（重探）', async () => {
  const { db, rec } = makeDb({ setName: 'rs0' });
  await datasource.mongoTransactable(db);
  await datasource.mongoTransactable(db);
  assert.equal(rec.hello, 1, '同一 client 只探测一次');

  const { db: bad, rec: badRec } = makeDb(new Error('x'));
  assert.equal(await datasource.mongoTransactable(bad), null);
  assert.equal(await datasource.mongoTransactable(bad), null);
  assert.equal(badRec.hello, 2, '探测失败不写缓存（重探）');
});

// ─── #A6 事务原语：start/commit/abort/end，幂等，无保存点 ────

test('#A6 事务原语：commit 幂等且无保存点原语', async () => {
  const { db, rec } = makeDb({ setName: 'rs0' });
  const tx = await mongo.openTransaction(db);
  assert.equal(tx.savepoint, undefined);
  assert.equal(tx.releaseSavepoint, undefined);
  await tx.commit();
  await tx.commit();          // 幂等
  await tx.release();
  assert.deepEqual(rec.tx, ['start', 'commit', 'end']);
  assert.ok(tx.session, '句柄携带 session');
});

// ─── #A5 execMongo 全 9 kind 透传 session ───────────────────

test('#A5 execMongo 全 9 kind 均透传 session', async () => {
  const { db, rec } = makeDb({ setName: 'rs0' });
  const sentinel = { id: 'sentinel' };
  const cmds = [
    { collection: 'c', kind: 'find', filter: {} },
    { collection: 'c', kind: 'aggregate', pipeline: [] },
    { collection: 'c', kind: 'countDocuments', filter: {} },
    { collection: 'c', kind: 'findOne', filter: {} },
    { collection: 'c', kind: 'insertOne', doc: { _id: '1' } },
    { collection: 'c', kind: 'insertMany', docs: [{ _id: '1' }] },
    { collection: 'c', kind: 'insertMany', docs: [{ _id: '1' }], upsertById: true },
    { collection: 'c', kind: 'findOneAndUpdate', filter: {}, update: {} },
    { collection: 'c', kind: 'updateMany', filter: {}, update: {} },
    { collection: 'c', kind: 'deleteMany', filter: {} },
  ];
  for (const cmd of cmds) await mongo.execMongo(db, { ...cmd }, sentinel);
  assert.ok(rec.ops.length >= cmds.length, '应有操作记录');
  assert.ok(rec.ops.every((op) => op[2] === sentinel), '每个操作都携带 session');
});

test('#A5b 无 session 时不注入 session（零回归）', async () => {
  const { db, rec } = makeDb({ setName: 'rs0' });
  await mongo.execMongo(db, { collection: 'c', kind: 'insertOne', doc: { _id: '1' } });
  assert.equal(rec.ops[0][2], null, '无 session 时不传');
});

// ─── #A3 standalone：会话内声明降级、命令仍执行 ──────────────

test('#A3 standalone：会话内声明降级且命令按原样执行', async () => {
  const { db, rec } = makeDb({ ok: 1 });
  registerMongo('MxAloneNode', 'mx_alone_n');
  datasource.setConnections({ mx_alone_n: db });
  const events = [];
  feedback.setSink((e) => events.push(e));

  await store.session(async (s) => {
    await s.insert('MxAloneNode', { v: '1' });
    await s.insert('MxAloneNode', { v: '2' });
  });

  const warned = events.filter((e) => e.code === 'mongoTransactionUnsupported');
  assert.equal(warned.length, 1, '同一源只声明一次');
  assert.equal(warned[0].deployment, 'standalone');
  assert.equal(events.filter((e) => e.type === 'session_not_atomic').length, 0);
  assert.deepEqual(rec.sessions, [], 'standalone 不开 session');
  assert.deepEqual(rec.ops.map((op) => op[1]), ['insertOne', 'insertOne'], '命令按原样执行');
});

// ─── #A4 unknown：声明 deployment=unknown ───────────────────

test('#A4 探测失败：声明 deployment=unknown', async () => {
  const { db } = makeDb(new Error('probe-fail'));
  registerMongo('MxUnknownNode', 'mx_unknown_n');
  datasource.setConnections({ mx_unknown_n: db });
  const events = [];
  feedback.setSink((e) => events.push(e));

  await store.session(async (s) => {
    await s.insert('MxUnknownNode', { v: '1' });
  });

  const warned = events.filter((e) => e.code === 'mongoTransactionUnsupported');
  assert.equal(warned.length, 1);
  assert.equal(warned[0].deployment, 'unknown');
});

// ─── #A7 单 Mongo 源 runAtomic 包事务（可事务桩） ───────────

test('#A7 runAtomic：单 Mongo 源包事务并提交', async () => {
  const { db, rec } = makeDb({ setName: 'rs0' });
  registerMongo('MxTxNode', 'mx_tx_n');
  datasource.setConnections({ mx_tx_n: db });

  const out = await runAtomic(new Set(['mx_tx_n']), async () => {
    await store.insert('MxTxNode', { v: '1' });
    return 'ok';
  });

  assert.equal(out, 'ok');
  assert.deepEqual(rec.tx, ['start', 'commit', 'end']);
  assert.notEqual(rec.ops[0][2], null, '写入携带 session');
});

test('#A7b runAtomic：Mongo 事务体失败 → abort', async () => {
  const { db, rec } = makeDb({ setName: 'rs0' });
  registerMongo('MxTxFailNode', 'mx_tx_fail_n');
  datasource.setConnections({ mx_tx_fail_n: db });

  await assert.rejects(
    () => runAtomic(new Set(['mx_tx_fail_n']), async () => {
      await store.insert('MxTxFailNode', { v: '1' });
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(rec.tx, ['start', 'abort', 'end']);
});

// ─── #A8 嵌套 Mongo 走保存点降级 ────────────────────────────

test('#A8 嵌套 Mongo：走既有保存点降级声明（不发「不支持」）', async () => {
  const { db, rec } = makeDb({ setName: 'rs0' });
  registerMongo('MxNestNode', 'mx_nest_n');
  datasource.setConnections({ mx_nest_n: db });
  const events = [];
  feedback.setSink((e) => events.push(e));

  await store.session(async (s) => {
    await s.insert('MxNestNode', { v: '1' });
    await store.session(async (inner) => {
      await inner.insert('MxNestNode', { v: '2' });
    });
  });

  assert.ok(events.some((e) => e.code === 'nestedSavepointUnsupported'),
    'Mongo 无保存点 → 既有降级声明');
  assert.equal(events.filter((e) => e.code === 'mongoTransactionUnsupported').length, 0,
    '可事务的 Mongo 不应发「不支持」声明');
  assert.equal(rec.tx.filter((t) => t === 'start').length, 1, '嵌套会话共用外层事务');
});

// ─── #A10 真实本机 rs0：事务真提交 / 真回滚 ─────────────────

const MONGO_TX_URI = process.env.MONGO_URI_TX || 'mongodb://127.0.0.1:27017/mongo_store_e2e_tx';

/** 连本机 Mongo；不可达或非副本集（如 CI standalone）→ skip；返回 { client, db } 或 null */
async function realRsDbOrSkip(t) {
  let MongoClient;
  try { ({ MongoClient } = require('mongodb')); } catch (_) { t.skip('缺 mongodb 驱动'); return null; }
  const client = new MongoClient(MONGO_TX_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName) {
      await client.close();
      t.skip('本机 Mongo 非副本集（如 CI standalone）→ 跳过');
      return null;
    }
  } catch (_) {
    await client.close();
    t.skip('本机 MongoDB 不可达');
    return null;
  }
  return { client, db: client.db('mongo_store_e2e_tx') };
}

test('#A10 真实本机 rs0：会话事务提交后全部可见', async (t) => {
  const r = await realRsDbOrSkip(t);
  if (!r) return;
  const { client, db } = r;
  const coll = naming.physical('mx_real_n');
  await db.collection(coll).drop().catch(() => {});
  registerMongo('MxRealNode', 'mx_real_n', 'mx_real_n');
  datasource.setConnections({ mx_real_n: db });
  try {
    await store.session(async (s) => {
      await s.insert('MxRealNode', { v: 'a' });
      await s.insert('MxRealNode', { v: 'b' });
    });
    assert.equal(await db.collection(coll).countDocuments({}), 2);
  } finally {
    await db.collection(coll).drop().catch(() => {});
    await client.close();
  }
});

test('#A10b 真实本机 rs0：会话异常 → abort，全部不可见', async (t) => {
  const r = await realRsDbOrSkip(t);
  if (!r) return;
  const { client, db } = r;
  const coll = naming.physical('mx_real_nb');
  await db.collection(coll).drop().catch(() => {});
  registerMongo('MxRealNodeB', 'mx_real_n', 'mx_real_nb');
  datasource.setConnections({ mx_real_n: db });
  try {
    await assert.rejects(
      () => store.session(async (s) => {
        await s.insert('MxRealNodeB', { v: 'a' });
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await db.collection(coll).countDocuments({}), 0);
  } finally {
    await db.collection(coll).drop().catch(() => {});
    await client.close();
  }
});
