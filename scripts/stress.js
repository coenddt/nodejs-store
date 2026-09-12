'use strict';

/**
 * nodejs-store 多 db 联合压力测试 —— 测试 nodejs-store 宿主层产品
 *
 * 四库并载（MongoDB / MySQL / PostgreSQL / SQLite）：
 *   - StressUser(mongo_e2e) --orders--> StressOrder(mysql_e2e)  [联邦跨源]
 *   - StressUser(mongo_e2e) --invoices--> StressInvoice(pg_e2e) [联邦跨源]
 *   - StressLog(default=sqlite) 独立写读
 *
 * 每 worker 每轮 5 个操作（与 py-store/stress/stress.py 完全对称）：
 *   1. queryFederated 跨 3 源联合查询（多 db 联合核心）
 *   2. SQLite 写 insert(StressLog)
 *   3. PostgreSQL 读 count(StressInvoice)
 *   4. MongoDB 读 query(StressUser)
 *   5. MySQL 写 update(StressOrder, $inc)
 *
 * 用法: node scripts/stress.js [--workers N] [--rounds N]
 * 表名后缀固定 'js'，与 py-store('py') / rust-store('rs') 的压测表隔离。
 * 需 LOCAL_CORE=1（core-node 本地产物加载）。
 */

const path = require('path');
const Module = require('module');

// 驱动依赖位于本仓库 node_modules，脚本从 scripts/ 运行时补齐解析路径
const storeNodeModules = path.join(__dirname, '..', 'node_modules');
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + storeNodeModules;
Module._initPaths();

const { MongoClient } = require('mongodb');
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const Database = require('better-sqlite3');

const { init, store, executors, permission, schema: _sc } = require(
  path.join(__dirname, '..', 'src'),
);

// ─── 参数 ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : def;
}
const WORKERS = arg('workers', 8);
const ROUNDS = arg('rounds', 200);
const SUFFIX = 'js'; // 表隔离后缀（本仓库专用）

// 表 / collection / schema 名后缀：多仓库同时压测时隔离数据（避免 DDL 互踩）
const T = (base) => base + SUFFIX;
const S = (base) => base + (SUFFIX ? SUFFIX[0].toUpperCase() + SUFFIX.slice(1) : '');

const MYSQL_URI = process.env.MYSQL_URI || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e?charset=utf8mb4';
const PG_URI = process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e';

const SEED_USERS = 30;
const SEED_PER_USER = 2;

const USER_SCHEMA = S('StressUser');
const FED_GQL =
  `${USER_SCHEMA}($condition:@c0){_id, name, orders{code, amount}, invoices{title, value}}`;
const FED_PARAMS = { c0: {} };

// ─── 统计工具 ───────────────────────────────────────────────
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  return {
    ops: s.length,
    total_ms: Math.round(total),
    p50_ms: percentile(s, 0.5),
    p95_ms: percentile(s, 0.95),
    max_ms: s.length ? s[s.length - 1] : 0,
    avg_ms: s.length ? Math.round((total / s.length) * 100) / 100 : 0,
  };
}

// ─── 主流程 ─────────────────────────────────────────────────
async function main() {
  permission.setContext(undefined);

  // 1. 连接四库
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  const mongoDb = client.db();
  const mPool = mysql.createPool(MYSQL_URI);
  const pgPool = new Pool({ connectionString: PG_URI });
  const sqliteDb = new Database(':memory:');

  // 2. 建表 / 清数据（幂等）
  await mongoDb.collection(T('stress_users')).deleteMany({});
  await mPool.query(`DROP TABLE IF EXISTS ${T('stress_orders')}`);
  await mPool.query(
    `CREATE TABLE ${T('stress_orders')} (_id VARCHAR(64) NOT NULL, \`userId\` VARCHAR(64), \`code\` VARCHAR(255), \`amount\` DOUBLE, PRIMARY KEY (_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  await pgPool.query(`DROP TABLE IF EXISTS ${T('stress_invoices')}`);
  await pgPool.query(
    `CREATE TABLE ${T('stress_invoices')} (_id TEXT PRIMARY KEY, "userId" TEXT, "title" TEXT, "value" DOUBLE PRECISION)`,
  );
  sqliteDb.exec(`DROP TABLE IF EXISTS ${T('stress_logs')}`);
  sqliteDb.exec(`CREATE TABLE ${T('stress_logs')} (_id TEXT PRIMARY KEY, msg TEXT, level TEXT)`);

  // 3. schema 注册（跨源 relation = 联邦路径）
  _sc.register({
    name: S('StressUser'), collection: T('stress_users'), idPrefix: 'u_', datasource: 'mongo_e2e', timestamps: false,
    fields: { name: { type: 'string' } },
    relations: {
      orders: { model: S('StressOrder'), type: 'many', localField: '_id', foreignField: 'userId' },
      invoices: { model: S('StressInvoice'), type: 'many', localField: '_id', foreignField: 'userId' },
    },
  });
  _sc.register({
    name: S('StressOrder'), collection: T('stress_orders'), idPrefix: 'o_', datasource: 'mysql_e2e', timestamps: false,
    fields: { userId: { type: 'string' }, code: { type: 'string' }, amount: { type: 'number' } }, relations: {},
  });
  _sc.register({
    name: S('StressInvoice'), collection: T('stress_invoices'), idPrefix: 'v_', datasource: 'pg_e2e', timestamps: false,
    fields: { userId: { type: 'string' }, title: { type: 'string' }, value: { type: 'number' } }, relations: {},
  });
  _sc.register({
    name: S('StressLog'), collection: T('stress_logs'), idPrefix: 'l_', datasource: 'default', timestamps: false,
    fields: { msg: { type: 'string' }, level: { type: 'string' } }, relations: {},
  });

  // 4. init 四源
  await init({
    mongo_e2e: mongoDb,
    mysql_e2e: executors.createConnection('mysql', mPool),
    pg_e2e: executors.createConnection('postgres', pgPool),
    default: executors.createConnection('sqlite', sqliteDb),
  });

  // 5. 预热（种子数据）
  const orderIds = [];
  for (let u = 0; u < SEED_USERS; u++) {
    const user = await store.insert(S('StressUser'), { name: `u_${u}` });
    for (let i = 0; i < SEED_PER_USER; i++) {
      const o = await store.insert(S('StressOrder'), { userId: user._id, code: `c_${u}_${i}`, amount: 1 });
      orderIds.push(o._id);
      await store.insert(S('StressInvoice'), { userId: user._id, title: `v_${u}_${i}`, value: u + i });
    }
  }
  console.log(`[prewarm] users=${SEED_USERS} orders=${orderIds.length} invoices=${SEED_USERS * SEED_PER_USER} ready`);

  // 6. 冒烟：跨 3 源联邦一次，验证链路
  const smoke = await store.queryFederated(FED_GQL, FED_PARAMS);
  if (!smoke.length || !smoke[0].orders || !smoke[0].invoices) {
    throw new Error(`联邦冒烟失败: 结果形状异常 ${JSON.stringify(smoke[0] || {}).slice(0, 200)}`);
  }
  console.log(`[smoke] federation ok: ${smoke.length} users, sample orders=${smoke[0].orders.length} invoices=${smoke[0].invoices.length}`);

  // 7. 并发压测
  const allTimes = [];
  const fedTimes = [];
  const errorsByType = {};

  function recordError(op, e) {
    const key = `${op}: ${(e && e.message) || String(e)}`;
    errorsByType[key] = (errorsByType[key] || 0) + 1;
  }

  async function worker(w) {
    for (let r = 0; r < ROUNDS; r++) {
      // op1: 联合查询（跨 Mongo+MySQL+PG）
      let t0 = Date.now();
      try {
        await store.queryFederated(FED_GQL, FED_PARAMS);
        allTimes.push(Date.now() - t0);
        fedTimes.push(Date.now() - t0);
      } catch (e) { recordError('federated', e); }
      // op2: SQLite 写
      t0 = Date.now();
      try { await store.insert(S('StressLog'), { msg: `w${w}_r${r}`, level: 'info' }); allTimes.push(Date.now() - t0); } catch (e) { recordError('sqlite-insert', e); }
      // op3: PG 读
      t0 = Date.now();
      try { await store.count(S('StressInvoice'), {}); allTimes.push(Date.now() - t0); } catch (e) { recordError('pg-count', e); }
      // op4: Mongo 读
      t0 = Date.now();
      try {
        await store.query(`${S('StressUser')}($condition:@c0){_id, name}`, { c0: { name: `u_${(w + r) % SEED_USERS}` } });
        allTimes.push(Date.now() - t0);
      } catch (e) { recordError('mongo-query', e); }
      // op5: MySQL 写
      t0 = Date.now();
      try {
        const id = orderIds[(w * ROUNDS + r) % orderIds.length];
        await store.update(S('StressOrder'), { _id: id }, { $inc: { amount: 1 } });
        allTimes.push(Date.now() - t0);
      } catch (e) { recordError('mysql-update', e); }
    }
  }

  const tStart = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
  const totalMs = Date.now() - tStart;

  // 8. 汇总输出
  const summary = summarize(allTimes);
  const fed = summarize(fedTimes);
  const out = {
    product: 'nodejs-store',
    suffix: SUFFIX,
    workers: WORKERS,
    rounds: ROUNDS,
    ops_per_round: 5,
    total_ops: summary.ops,
    errors: Object.values(errorsByType).reduce((a, b) => a + b, 0),
    errors_by_type: errorsByType,
    total_ms: totalMs,
    qps: Math.round((summary.ops / totalMs) * 1000 * 100) / 100,
    all_ops: summary,
    federation_ops: fed,
  };
  console.log('[RESULT]' + JSON.stringify(out));

  // 清理
  await mPool.end();
  await pgPool.end();
  sqliteDb.close();
  await client.close();
}

main().catch((e) => {
  console.error('[stress nodejs-store] FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
