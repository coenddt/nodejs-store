'use strict';

/**
 * 多数据源定位用例（B 系列，Host 侧）
 *
 * 对应 `multi-datasource-routing-plan.md` §九：
 *   - B1: 两个 Mongo db 实例 source，同名集合 users，各查各库无串源
 *   - B2: 单 MongoClient source，两个 schema 声明不同 namespace（db 名），各查各库
 *   - B3: (source, namespace, collection) 冲突注册 → 抛错（fail fast，非静默串源）
 *   - B4: 同 SQL 连接双 namespace（SQLite attached db 代演 PG schema）各自命中
 *   - B9: 旧用法 init(db) + schema 无 datasource/namespace → source="default"、
 *         namespace=null，行为零变更
 *   - B10: namespace 非空但 source 为 db 实例 / client 缺 namespace → 显式报错
 *   - B11: syncSchema({ namespace }) 回写 def 的 namespace，与手动声明等价
 *
 * B5-B8（联邦下推 / routeOverride）在 core 侧：
 *   `rust-store/core/tests/pushdown_usecases.rs`。
 *
 * 运行：node scripts/test.js（置 LOCAL_CORE=1 使用仓库内 Rust 核心）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, permission, schema: _sc } = require('../src');
const datasource = require('../src/datasource');

// ─── Mongo 桩驱动 ────────────────────────────────────────────

class MemCursor {
  constructor(docs) {
    this.docs = docs;
  }

  async toArray() {
    return [...this.docs];
  }
}

class MemColl {
  constructor(docs) {
    this.docs = docs || [];
  }

  find() {
    return new MemCursor(this.docs);
  }

  aggregate() {
    return new MemCursor(this.docs);
  }

  async findOne() {
    return this.docs.length ? { ...this.docs[0] } : null;
  }

  async countDocuments() {
    return this.docs.length;
  }

  async insertOne(doc) {
    this.docs.push(doc);
  }

  listIndexes() {
    return new MemCursor([]);
  }

  async createIndex() {}
}

/** Mongo db 实形态（collection 为函数）：固定库，无法跨库 */
class FakeDb {
  /** colls: { 集合名: docs[] } */
  constructor(colls) {
    this.colls = colls || {};
    this.accessed = [];
  }

  collection(name) {
    this.accessed.push(name);
    return new MemColl(this.colls[name]);
  }
}

/** MongoClient 形态（db 为函数且无 collection）：按 namespace 动态取库 */
class FakeClient {
  constructor() {
    this.dbs = Object.create(null);
    this.dbNames = [];
  }

  db(name) {
    this.dbNames.push(name);
    if (!this.dbs[name]) this.dbs[name] = new FakeDb({});
    return this.dbs[name];
  }
}

before(() => {
  permission.setContext(undefined);
});

// ─── B1：双 db 实例，同名集合，各查各库 ──────────────────────

test('B1: 两个 Mongo db 实例 source，同名集合 users，各查各库无串源', async () => {
  const dbA = new FakeDb({ users: [{ _id: 'a1', side: 'A' }] });
  const dbB = new FakeDb({ users: [{ _id: 'b1', side: 'B' }] });

  _sc.register({
    name: 'B1UserA',
    collection: 'users',
    timestamps: false,
    fields: { side: { type: 'string' } },
    relations: {},
    datasource: 'mongo_a',
  });
  _sc.register({
    name: 'B1UserB',
    collection: 'users',
    timestamps: false,
    fields: { side: { type: 'string' } },
    relations: {},
    datasource: 'mongo_b',
  });

  await init({ mongo_a: dbA, mongo_b: dbB });

  const gotA = await store.query('B1UserA{_id, side}');
  const gotB = await store.query('B1UserB{_id, side}');

  assert.deepEqual(gotA, [{ _id: 'a1', side: 'A' }], 'A 源应命中 A 库数据');
  assert.deepEqual(gotB, [{ _id: 'b1', side: 'B' }], 'B 源应命中 B 库数据');
});

// ─── B2：单 MongoClient，双 namespace（db 名） ───────────────

test('B2: 单 MongoClient source，两个 schema 不同 namespace，各查各库', async () => {
  const client = new FakeClient();
  client.dbs.tenant_a = new FakeDb({ b2_docs: [{ _id: 't1', tag: 'T-A' }] });
  client.dbs.tenant_b = new FakeDb({ b2_docs: [{ _id: 't2', tag: 'T-B' }] });

  // 同 collection 名，仅靠 namespace 区分（三元组唯一性由 namespace 维度保证）
  _sc.register({
    name: 'B2DocA',
    collection: 'b2_docs',
    timestamps: false,
    fields: { tag: { type: 'string' } },
    relations: {},
    datasource: 'mongo_cluster',
    namespace: 'tenant_a',
  });
  _sc.register({
    name: 'B2DocB',
    collection: 'b2_docs',
    timestamps: false,
    fields: { tag: { type: 'string' } },
    relations: {},
    datasource: 'mongo_cluster',
    namespace: 'tenant_b',
  });

  await init({ mongo_cluster: client });

  const gotA = await store.query('B2DocA{_id, tag}');
  const gotB = await store.query('B2DocB{_id, tag}');

  assert.deepEqual(gotA, [{ _id: 't1', tag: 'T-A' }]);
  assert.deepEqual(gotB, [{ _id: 't2', tag: 'T-B' }]);
  assert.ok(client.dbNames.includes('tenant_a'), '应按 namespace 取 client.db(tenant_a)');
  assert.ok(client.dbNames.includes('tenant_b'), '应按 namespace 取 client.db(tenant_b)');
});

// ─── B3：三元组冲突注册 → 抛错 ───────────────────────────────

test('B3: (source, namespace, collection) 冲突注册应抛错而非静默串源', () => {
  _sc.register({
    name: 'B3First',
    collection: 'b3_same',
    timestamps: false,
    fields: { v: { type: 'string' } },
    relations: {},
    datasource: 'b3_src',
    namespace: 'b3_ns',
  });
  assert.throws(
    () =>
      _sc.register({
        name: 'B3Second',
        collection: 'b3_same',
        timestamps: false,
        fields: { v: { type: 'string' } },
        relations: {},
        datasource: 'b3_src',
        namespace: 'b3_ns',
      }),
    /三元组|已注册|唯一|conflict/i,
  );
});

// ─── B4：同 SQL 连接双 namespace（SQLite attached 代演 PG schema） ──

test('B4: 同连接双 namespace（attached db），各自命中不串表', async () => {
  const db = new Database(':memory:');
  db.exec("ATTACH ':memory:' AS app_a");
  db.exec("ATTACH ':memory:' AS app_b");
  db.exec('CREATE TABLE app_a.b4_rows (_id TEXT PRIMARY KEY, tag TEXT)');
  db.exec('CREATE TABLE app_b.b4_rows (_id TEXT PRIMARY KEY, tag TEXT)');

  _sc.register({
    name: 'B4RowA',
    collection: 'b4_rows',
    idPrefix: 'b4a_',
    timestamps: false,
    fields: { tag: { type: 'string' } },
    relations: {},
    datasource: 'b4_sqlite',
    namespace: 'app_a',
  });
  _sc.register({
    name: 'B4RowB',
    collection: 'b4_rows',
    idPrefix: 'b4b_',
    timestamps: false,
    fields: { tag: { type: 'string' } },
    relations: {},
    datasource: 'b4_sqlite',
    namespace: 'app_b',
  });

  await init({ b4_sqlite: executors.createConnection('sqlite', db) });

  const a = await store.insert('B4RowA', { tag: 'NS-A' });
  const b = await store.insert('B4RowB', { tag: 'NS-B' });

  const gotA = await store.query('B4RowA{_id, tag}');
  const gotB = await store.query('B4RowB{_id, tag}');
  assert.deepEqual(gotA.map((d) => d.tag), ['NS-A']);
  assert.deepEqual(gotB.map((d) => d.tag), ['NS-B']);

  // 物理落库位置核对：namespace 即 attached db
  const rawA = db.prepare('SELECT tag FROM app_a.b4_rows WHERE _id = ?').all(a._id);
  const rawB = db.prepare('SELECT tag FROM app_b.b4_rows WHERE _id = ?').all(b._id);
  assert.equal(rawA.length, 1, 'A 应物理落在 app_a');
  assert.equal(rawB.length, 1, 'B 应物理落在 app_b');
});

// ─── B9：旧用法零变更（default source + null namespace） ─────

test('B9: init(db) + schema 无 datasource/namespace → source=default、namespace=null', async () => {
  const db = new FakeDb({ b9_legacy: [{ _id: 'l1', name: 'legacy' }] });
  _sc.register({
    name: 'B9Legacy',
    collection: 'b9_legacy',
    timestamps: false,
    fields: { name: { type: 'string' } },
    relations: {},
  });

  await init(db); // 单实例旧用法

  const plan = _sc.core.planQuery('B9Legacy{_id, name}', {});
  for (const c of plan.commands) {
    assert.equal(c.source, 'default');
    assert.equal(c.namespace, null);
  }

  const got = await store.query('B9Legacy{_id, name}');
  assert.deepEqual(got, [{ _id: 'l1', name: 'legacy' }]);
});

// ─── B10：Mongo 双形态严格校验（不猜） ───────────────────────

test('B10: namespace 非空但 source 为 db 实例 → 显式报错', () => {
  const fakeDb = new FakeDb({});
  assert.throws(
    () => datasource.mongoDb(fakeDb, 's', 'tenant_x'),
    /namespace.*db 实例|db 实例/i,
  );
});

test('B10: MongoClient 缺 namespace → 显式报错', () => {
  const fakeClient = new FakeClient();
  assert.throws(() => datasource.mongoDb(fakeClient, 's', null), /namespace/i);
});

// ─── B8：routeOverride 同一 schema 落不同租户 namespace ──────

test('B8: routeOverride 多租户路由（insert/query/count 落租户库）', async () => {
  const db = new Database(':memory:');
  db.exec("ATTACH ':memory:' AS tenant_42");
  db.exec('CREATE TABLE b8_rows (_id TEXT PRIMARY KEY, tag TEXT)');
  db.exec('CREATE TABLE tenant_42.b8_rows (_id TEXT PRIMARY KEY, tag TEXT)');

  _sc.register({
    name: 'B8Row',
    collection: 'b8_rows',
    idPrefix: 'b8_',
    timestamps: false,
    fields: { tag: { type: 'string' } },
    relations: {},
    datasource: 'b8_sqlite',
  });

  await init({ b8_sqlite: executors.createConnection('sqlite', db) });

  // 带 override 写入租户库
  const doc = await store.insert('B8Row', { tag: 'T42' }, { namespace: 'tenant_42' });

  // 带 override 读：命中租户库；不带 override 读：默认库为空
  const gotTenant = await store.query('B8Row{_id, tag}', null, { namespace: 'tenant_42' });
  assert.deepEqual(gotTenant.map((d) => d._id), [doc._id]);
  assert.deepEqual(await store.query('B8Row{_id, tag}'), []);
  assert.equal(await store.count('B8Row'), 0);
  assert.equal(await store.count('B8Row', {}, { namespace: 'tenant_42' }), 1);
});

// ─── B11：syncSchema({ namespace }) 回写 def ─────────────────

test('B11: syncSchema({ namespace }) 回写 def 的 namespace，与手动声明等价', async () => {
  const db = new Database(':memory:');
  db.exec("ATTACH ':memory:' AS aux");
  db.exec('CREATE TABLE aux.b11_widgets (_id TEXT PRIMARY KEY, sku TEXT)');

  const defs = await store.syncSchema({
    backend: 'sqlite',
    driver: db,
    introspectOptions: { database: 'aux' },
    datasource: 'b11_sqlite',
    namespace: 'aux',
    registerDefs: false,
  });

  const def = defs.find((d) => d.collection === 'b11_widgets');
  assert.ok(def, '应产出 b11_widgets 定义');
  assert.equal(def.namespace, 'aux', 'namespace 应回写到 def');
  assert.equal(def.datasource, 'b11_sqlite');

  // 注册后路由与手动声明 namespace 的 schema 等价（同一 attached db 可查）
  const manual = _sc.register({
    name: 'B11Manual',
    collection: 'b11_widgets',
    idPrefix: 'b11_',
    timestamps: false,
    fields: { sku: { type: 'string' } },
    relations: {},
    datasource: 'b11_sqlite',
    namespace: 'aux',
  });
  assert.equal(manual.namespace, 'aux');
  // 等价性：syncSchema 产出的 def 与手动声明的定位三元组一致
  assert.deepEqual(
    { source: def.datasource, namespace: def.namespace, collection: def.collection },
    { source: manual.datasource, namespace: manual.namespace, collection: manual.collection },
  );

  await init({ b11_sqlite: executors.createConnection('sqlite', db) });
  const doc = await store.insert('B11Manual', { sku: 'w1' });
  const got = await store.query('B11Manual{_id, sku}');
  assert.equal(got.length, 1);
  assert.equal(got[0]._id, doc._id);
});
