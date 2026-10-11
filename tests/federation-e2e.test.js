'use strict';

/**
 * Phase 5 · A5/A6：跨库联邦查询端到端
 *
 * A5：一条 GQL 跨源取数（根 `mongodb_e2e` → 子 `mysql_e2e`）出嵌套结果；
 * A6：跨库计算列（依赖子源关系字段）在同一 GQL 内生效。
 *
 * 需本机 127.0.0.1 已启动 MySQL(3306) / MongoDB(27017)，
 * 库 `mongo_store_e2e_fed`，账号 `e2e/e2e123`（可用 MYSQL_URI / MONGO_URI 覆盖）；
 * 任一不可达则整体 skip，不影响其余回归。
 *
 * 数据隔离（ISTQB Independent/Repeatable）：本文件使用**独立库** `mongo_store_e2e_fed`
 * （MySQL database 与 Mongo db 同名），`before` 中的 DROP/CREATE 仅作用于本库，
 * 与 `real-backends-e2e.test.js`（`mongo_store_e2e_real`）互不干扰，
 * 全量套件并发/重复运行不再互相清空对方 fixture。
 *
 * 全程只走 store 统一入口：`store.queryFederated` → core `planFederated` 拆源
 * → 逐源执行（Mongo 原生 / SQL translate→exec）→ core `mergeFederated` 内存 join
 * → 统一后处理（asyncFn 计算列）。
 *
 * 运行：node scripts/test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');

const { init, store, executors, permission, schema: _sc } = require('../src');
const naming = require('../src/naming');

// 独立库名（可整串用 MYSQL_URI / MONGO_URI 环境变量覆盖，便于 CI 复用外部实例）
const MYSQL_URI =
  process.env.MYSQL_URI
  || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e_fed?charset=utf8mb4';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e_fed';

const MYSQL_DDL = [
  'DROP TABLE IF EXISTS fed_orders_deleted',
  'DROP TABLE IF EXISTS fed_orders',
  `CREATE TABLE fed_orders (
     _id VARCHAR(64) NOT NULL,
     user_id VARCHAR(64),
     code VARCHAR(255),
     amount DOUBLE,
     __present VARCHAR(255),
     PRIMARY KEY (_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const state = { mongoReady: false, mysqlReady: false, reason: '数据库不可达' };

async function setupMongo() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch (e) {
    state.reason = `MongoDB 不可达（${MONGO_URI}）: ${e.message}`;
    await client.close().catch(() => {});
    return null;
  }
  const db = client.db();
  await db.collection(naming.physical('fed_users')).deleteMany({});
  state.mongoClient = client;
  state.mongoReady = true;
  return db;
}

async function setupMysql() {
  const pool = mysql.createPool(MYSQL_URI);
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    state.reason = `MySQL 不可达（${MYSQL_URI}）: ${e.message}`;
    await pool.end().catch(() => {});
    return null;
  }
  for (const stmt of MYSQL_DDL) await pool.query(stmt);
  state.mysqlPool = pool;
  state.mysqlReady = true;
  return executors.createConnection('mysql', pool);
}

/** A6：跨库计算列（依赖子源关系字段 `orders{code}`）——由 Host 在 merge 后执行 */
function orderCodes(items) {
  for (const it of items) {
    it.orderCodes = (it.orders || []).map((o) => o.code).join(',');
  }
}

before(async () => {
  permission.setContext(undefined);
  const db = await setupMongo();
  const mysqlConn = await setupMysql();
  if (!state.mongoReady || !state.mysqlReady) return;

  _sc.register({
    name: 'FedUser',
    collection: 'fed_users',
    idPrefix: 'u_',
    datasource: 'mongo_e2e',
    timestamps: false,
    fields: { name: { type: 'string' } },
    relations: {
      orders: { model: 'FedOrder', type: 'many', localField: '_id', foreignField: 'userId' },
    },
    computes: {
      orderCodes: {
        type: 'string',
        asyncFn: orderCodes,
        fnRef: 'fed_order_codes',
        depends: ['orders{code}'],
      },
    },
  });
  _sc.register({
    name: 'FedOrder',
    collection: 'fed_orders',
    idPrefix: 'o_',
    datasource: 'mysql_e2e',
    timestamps: false,
    fields: {
      userId: { type: 'string' },
      code: { type: 'string' },
      amount: { type: 'number' },
    },
    relations: {},
  });

  await init({ mongo_e2e: db, mysql_e2e: mysqlConn });
});

after(async () => {
  if (state.mysqlPool) await state.mysqlPool.end().catch(() => {});
  if (state.mongoClient) await state.mongoClient.close().catch(() => {});
});

describe('跨库联邦 A5/A6', () => {
  it('单 GQL 跨 Mongo→MySQL：嵌套关联 + 跨库计算列', async (t) => {
    if (!state.mongoReady || !state.mysqlReady) return t.skip(state.reason);

    const u1 = await store.insert('FedUser', { name: 'A' });
    const u2 = await store.insert('FedUser', { name: 'B' });
    await store.insert('FedOrder', { userId: u1._id, code: 'c1', amount: 10 });
    await store.insert('FedOrder', { userId: u1._id, code: 'c2', amount: 20 });
    await store.insert('FedOrder', { userId: u2._id, code: 'c3', amount: 30 });

    const items = await store.queryFederated(
      'FedUser($condition:@c0){name, orders{code, amount}, orderCodes}',
      { c0: {} },
    );

    assert.equal(items.length, 2, '应返回两个用户');
    const a = items.find((d) => d.name === 'A');
    const b = items.find((d) => d.name === 'B');
    assert.ok(a && b, '应包含 A / B 两个用户');

    assert.deepEqual(a.orders.map((o) => o.code).sort(), ['c1', 'c2'], 'A5 跨源关联应挂载子源订单');
    assert.deepEqual(a.orders.map((o) => o.amount).sort((x, y) => x - y), [10, 20]);
    assert.equal(a.orderCodes, 'c1,c2', 'A6 跨库计算列应基于子源关系字段');
    assert.deepEqual(b.orders.map((o) => o.code), ['c3']);
    assert.equal(b.orderCodes, 'c3');
  });

  it('单源（未跨源）联邦查询与单库 query 同形', async (t) => {
    // 与 `before` 同条件：FedUser/FedOrder 的注册依赖两库连接均就绪，
    // 只判 Mongo 会在缺 MySQL 时误把「schema 未注册」当失败（D2：不可用须显式 skip）。
    if (!state.mongoReady || !state.mysqlReady) return t.skip(state.reason);

    const doc = await store.insert('FedUser', { name: 'Solo' });
    const items = await store.queryFederated('FedUser($condition:@c0){_id, name}', { c0: {} });
    const solo = items.find((d) => d.name === 'Solo');
    assert.ok(solo, '单源联邦应走与单库一致的执行路径');
    assert.equal(solo._id, doc._id);
  });
});

/**
 * A4 零回归：未声明 `links` ⇒ `planFederated` 输出除 `v` 外逐字段一致。
 *
 * 自包含（不依赖外部 DB 就绪）：两张跨源 schema 各挂一个 source，
 * 直接把 `dsConfig` 作为 `planFederated` 第 4 参传入 → 纯规划、零 IO。
 * 对照两遍：① 全程不触碰链路声明；② 走宿主装载入口 `applyLinkDecls`
 * 但配置不含 `links`（应 no-op）。两次计划除 `v` 外应逐字段一致。
 */
describe('A4 零回归（plan 快照对拍）', () => {
  it('未声明 links ⇒ planFederated 输出除 v 外逐字段一致', () => {
    _sc.register({
      name: 'A4Order',
      collection: 'a4_orders',
      idPrefix: 'a4o_',
      timestamps: false,
      datasource: 'a4_mongo',
      fields: { userId: { type: 'string' }, code: { type: 'string' } },
      relations: {},
    });
    _sc.register({
      name: 'A4User',
      collection: 'a4_users',
      idPrefix: 'a4u_',
      timestamps: false,
      datasource: 'a4_mysql',
      fields: { name: { type: 'string' } },
      relations: {
        orders: { model: 'A4Order', type: 'many', localField: '_id', foreignField: 'userId' },
      },
    });

    const gql = 'A4User{name, orders{code}}';
    const ds = { sources: { a4_mongo: 'mongodb', a4_mysql: 'mysql' } };
    const core = _sc.getCore();

    // ① 未触碰链路声明
    const base = core.planFederated(gql, {}, undefined, ds);

    // ② 走宿主装载入口，但配置不含 links ⇒ 应为 no-op
    core.applyLinkDecls({
      sources: {
        a4_mongo: { kind: 'mongodb', databases: ['a4db'] },
        a4_mysql: { kind: 'mysql', databases: ['a4db'] },
      },
      defs: ['schema'],
    });
    const after = core.planFederated(gql, {}, undefined, ds);

    assert.equal(after.v, 3, '联邦计划契约升版：v === 3');

    // 除 v 外逐字段一致（A4 零回归红线）
    const stripV = (p) => {
      const o = { ...p };
      delete o.v;
      return o;
    };
    assert.deepEqual(stripV(after), stripV(base), '未声明 links ⇒ planFederated 除 v 外逐字段一致');

    // 未声明 links ⇒ 读链路取注册原序、role/priority 均 null（未重排、未附着）
    assert.ok(after.links, 'plan 应含 v3 的 links 字段');
    for (const name of Object.keys(after.links)) {
      for (const l of after.links[name]) {
        assert.equal(l.role, null, `${name} 未声明 links ⇒ role 应为 null`);
        assert.equal(l.priority, null, `${name} 未声明 links ⇒ priority 应为 null`);
      }
    }
  });
});
