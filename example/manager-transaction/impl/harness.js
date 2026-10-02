'use strict';

/**
 * manager-transaction 场景 harness —— 真实库逐后端执行 T1/T2/T3 组用例。
 *
 * 复刻 course-platform/impl/harness.js（同构简化：无 probes、无 fn/asyncFn 计算列），
 * 差异点：① 新增「裸 raw 步骤」`{"op":"raw","fn":...}`（调 impl/checks.js 的同名协程，
 * 自身执行操作与断言）；② 用例支持 `backends` 子集限定（T2-01 仅 SQL 三后端 / T2-02 仅 Mongo）。
 *
 * 设计约束不变：
 *   - Registry 进程级单例、同名 schema 重复注册为「更新语义」→ 单进程内串行跑 4 后端；
 *   - MongoDB 为语义基准(oracle)，SQL 后端对拍；不可达 → available=false + skipReason，绝不静默；
 *   - 本脚本只出证据，不修实现。
 */

const fs = require('node:fs');
const path = require('node:path');

const { init, store, permission, feedback, schema: sc, executors, workflow, ddl } = require('../../../src');
const { CHECKS } = require('./checks');

const ROOT = path.resolve(__dirname, '..');

/** 场景后端清单（MongoDB 为语义基准，必须最先跑以产出 oracle） */
const BACKENDS = ['mongodb', 'postgres', 'mysql', 'sqlite'];

/** 主场景表 + autoincrement 探针表（均含归档表） */
const MAIN_TABLES = [
  'users', 'products', 'inventories', 'orders', 'order_items', 'auto_orders',
];
const ARCHIVE_TABLES = MAIN_TABLES.map((t) => `${t}_deleted`);

// 独立库 mongo_store_e2e_mgrtx：与 course-platform harness（mongo_store_e2e）隔离——
// node --test 并发跑多文件时两 harness 各自 reset/seed，同库即互踩（E11000 dup key）。
// 库名与 py 版对照关系见各 harness 头注释；可用环境变量整串覆盖
const MYSQL_URI =
  process.env.MYSQL_URI
  || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e_mgrtx?charset=utf8mb4';
const PG_URI = process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e_mgrtx';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e_mgrtx';

// ──────────────────────────────────────────────────────────── 装载 ──

function loadCases() {
  const dir = path.join(ROOT, 'cases');
  const cases = [];
  for (const f of fs.readdirSync(dir).sort()) {
    cases.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return cases;
}

function loadSeed() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'seed.json'), 'utf8'));
}

function loadSchemas() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'schema.json'), 'utf8'));
}

/** DDL 文本 → 语句数组（剥整行 `--` 注释后按 `;` 切分） */
function loadDdl(kind) {
  const text = fs.readFileSync(path.join(ROOT, 'ddl', `${kind}.sql`), 'utf8');
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 内建 schema（__workflowRun）建表语句——与业务表同一 DDL 生成器产出，零特判。
 *
 * 前置 DROP IF EXISTS：e2e 库随业务表一起可重入重建（生产启用工作流时由
 * ddl.generate(backend, ['__workflowRun']) 一次性建表，见 README「事务边界」）。
 */
function builtinDdl(kind) {
  const stmts = String(ddl.generate(kind, ['__workflowRun']))
    .split('\n\n')
    .filter((x) => x.trim());
  const table = kind === 'mysql' ? '`__workflowRun`' : '"__workflowRun"';
  return [`DROP TABLE IF EXISTS ${table}`].concat(stmts);
}

function registerAll() {
  for (const defn of loadSchemas()) sc.register(defn);
}

// ──────────────────────────────────────────────────────────── 后端 ──

async function setupBackend(kind) {
  if (kind === 'sqlite') {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (const stmt of [...loadDdl('sqlite'), ...builtinDdl('sqlite')]) db.exec(stmt);
    return { driver: db, conn: executors.createConnection('sqlite', db) };
  }
  if (kind === 'mysql') {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool(MYSQL_URI);
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      await pool.end().catch(() => {});
      return { error: `MySQL 不可达（${MYSQL_URI}）: ${e.message}` };
    }
    for (const stmt of [...loadDdl('mysql'), ...builtinDdl('mysql')]) await pool.query(stmt);
    return { driver: pool, conn: executors.createConnection('mysql', pool) };
  }
  if (kind === 'postgres') {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: PG_URI, connectionTimeoutMillis: 3000 });
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      await pool.end().catch(() => {});
      return { error: `PostgreSQL 不可达（${PG_URI}）: ${e.message}` };
    }
    for (const stmt of [...loadDdl('postgres'), ...builtinDdl('postgres')]) await pool.query(stmt);
    return { driver: pool, conn: executors.createConnection('postgres', pool) };
  }
  if (kind === 'mongodb') {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
    } catch (e) {
      await client.close().catch(() => {});
      return { error: `MongoDB 不可达（${MONGO_URI}）: ${e.message}` };
    }
    const db = client.db();
    return { driver: db, conn: db, client };
  }
  throw new Error(`未知后端 ${kind}`);
}

async function reset(kind, driver) {
  const tables = [...ARCHIVE_TABLES, ...MAIN_TABLES];
  if (kind === 'mongodb') {
    for (const t of tables) await driver.collection(t).deleteMany({});
    return;
  }
  if (kind === 'mysql' || kind === 'postgres') {
    for (const t of tables) await driver.query(`DELETE FROM ${t}`);
    return;
  }
  driver.exec(tables.map((t) => `DELETE FROM ${t};`).join('\n'));
}

/** ctx 三态：null/undefined → 无上下文；{internal:true} → 内部上下文；其余原样设置 */
async function withCtx(ctx, fn) {
  if (ctx && typeof ctx === 'object' && ctx.internal) return store.runAsInternal(fn);
  permission.setContext(ctx === null || ctx === undefined ? undefined : ctx);
  return fn();
}

/** seed：走 store.insert 真实写路径（owner/_id 生成全部真实） */
async function seed() {
  for (const batch of loadSeed()) {
    await withCtx(batch.ctx, async () => {
      for (const row of batch.rows) await store.insert(batch.schema, row);
    });
  }
}

async function teardown(kind, driver, client) {
  try {
    if (kind === 'mongodb') await (client ? client.close() : Promise.resolve());
    else if (kind === 'sqlite') driver.close();
    else await driver.end();
  } catch (e) {
    /* 收尾失败不掩盖测试结论 */
  }
}

// ──────────────────────────────────────────────────────────── 归一 ──

function deepSortValue(v) {
  if (Array.isArray(v)) {
    const out = v.map(deepSortValue);
    if (out.length && out.every((x) => x && typeof x === 'object' && !Array.isArray(x) && '_id' in x)) {
      out.sort((a, b) => compareValues(a._id, b._id));
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepSortValue(v[k]);
    return o;
  }
  return v;
}

function stableKey(v) {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v);
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareRow(a, b, sortBy) {
  for (const k of sortBy) {
    let va = a;
    let vb = b;
    for (const seg of k.split('.')) {
      va = va && typeof va === 'object' ? va[seg] : undefined;
      vb = vb && typeof vb === 'object' ? vb[seg] : undefined;
    }
    const c = compareValues(va, vb);
    if (c !== 0) return c;
  }
  return 0;
}

function normRows(rows, normalize) {
  const ignore = (normalize && normalize.ignore) || [];
  let out = (rows || []).map((r) => {
    const o = {};
    for (const k of Object.keys(r)) if (!ignore.includes(k)) o[k] = r[k];
    return deepSortValue(o);
  });
  const sortBy = normalize && normalize.sortBy;
  if (sortBy && sortBy.length) out.sort((a, b) => compareRow(a, b, sortBy));
  else out.sort((a, b) => compareValues(stableKey(a), stableKey(b)));
  return out;
}

function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  }
  if (
    a && b && typeof a === 'object' && typeof b === 'object'
    && !Array.isArray(a) && !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
  }
  return false;
}

const isSqlBackend = (kind) => kind !== 'mongodb';

// ──────────────────────────────────────────────────────────── 断言 ──

function _codes(events) {
  return (events || []).map((e) => e && e.code);
}

async function runStep(h, step) {
  const before = h.eventsAll.length;
  const op = step.op;
  let error = null;
  let result = null;
  try {
    if (op === 'query') result = await h.store.query(step.gql, step.params ?? null);
    else if (op === 'query_one') result = await h.store.queryOne(step.gql, step.params ?? null);
    else if (op === 'query_with_count') result = await h.store.queryWithCount(step.gql, step.params ?? null);
    else if (op === 'count') result = await h.store.count(step.schema, step.filter ?? null);
    else if (op === 'exists') result = await h.store.exists(step.schema, step.condition);
    else if (op === 'insert') result = await h.store.insert(step.schema, step.data);
    else if (op === 'insert_many') result = await h.store.insertMany(step.schema, step.rows);
    else if (op === 'update') result = await h.store.update(step.schema, step.condition, step.data);
    else if (op === 'update_many') result = await h.store.updateMany(step.schema, step.condition, step.data);
    else if (op === 'remove') result = await h.store.remove(step.schema, step.condition);
    else if (op === 'upsert') result = await h.store.upsert(step.schema, step.condition, step.data);
    else if (op === 'mutation') result = await h.store.mutation(step.schema, step.data);
    else if (op === 'set_flag') result = _setFlag(step.name, step.value);
    else if (op === 'set_ctx') result = (permission.setContext(step.ctx ?? null), null);
    else if (op === 'register_workflow') result = workflow.register(step.defn);
    else if (op === 'run_workflow') {
      result = await store.runWorkflow(step.name, step.input ?? null,
        { dryRun: Boolean(step.dryRun) });
    } else throw new Error(`未知 op: ${op}`);
  } catch (e) {
    error = e; // 统一捕获作为「显式报错」证据
  }
  const events = h.eventsAll.slice(before);
  return { result, error, events };
}

function _setFlag(name, value) {
  if (name === 'require_context') return store.setRequireContext(value);
  throw new Error(`未知开关 ${name}`);
}

function _matchError(err, expect) {
  const code = expect.code;
  const permErr = err instanceof store.PermissionError;
  if (code) {
    if (code === 'ERR_PERMISSION' && permErr) return true;
    if (permErr && expect.status) return err.status === expect.status;
    return String(err.message || err).includes(code);
  }
  return true;
}

async function assertStep(h, step, oracleRows) {
  const expect = step.expect || {};
  if (!expect.kind) return { ok: true, note: 'no assertion' };
  const kind = expect.kind;
  const isSql = isSqlBackend(h.backend);
  const policy = step.sqlPolicy || h.casePolicy || 'parity';
  const err = h.error;
  const events = h.events;

  if (kind === 'error') {
    if (err === null || err === undefined) return { ok: false, note: '期望抛错但未抛错' };
    return { ok: _matchError(err, expect), note: `实际错误: ${err.message || err}` };
  }
  if (kind === 'feedback') {
    const codes = _codes(events);
    return { ok: codes.includes(expect.code), note: `事件 codes: ${JSON.stringify(codes)}` };
  }
  if (kind === 'unsupported') {
    if (!isSql) return { ok: true, note: 'mongo 基准支持' };
    const codes = _codes(events).filter(Boolean);
    if ((err !== null && err !== undefined) || codes.length) {
      return { ok: true, note: `显式(err=${err ? err.name : null}, events=${JSON.stringify(codes)})` };
    }
    return { ok: false, note: '不可翻译却静默返回了结果（既无错误也无告警）' };
  }

  if (kind === 'run') {
    // run 文档断言：runWorkflow 统一契约不抛错；error 键显式存在时严格相等
    // （含 null——no-error-masking §二：成功态 error 必须为 null 的正向断言）
    if (err !== null && err !== undefined) {
      return { ok: false, note: `run_workflow 不应抛错（统一契约），实际: ${err.message || err}` };
    }
    const r = h.result || {};
    if (r.status !== expect.status) {
      return { ok: false, note: `status=${r.status} 期望 ${expect.status}（error=${JSON.stringify(r.error)}）` };
    }
    if ('error' in expect && r.error !== expect.error) {
      return { ok: false, note: `error=${JSON.stringify(r.error)} 期望 ${JSON.stringify(expect.error)}` };
    }
    if ('stepIndex' in expect && r.stepIndex !== expect.stepIndex) {
      return { ok: false, note: `stepIndex=${r.stepIndex} 期望 ${expect.stepIndex}` };
    }
    const states = (r.steps || []).map((st) => st.state);
    if ('stepStates' in expect && JSON.stringify(states) !== JSON.stringify(expect.stepStates)) {
      return { ok: false, note: `stepStates=${JSON.stringify(states)} 期望 ${JSON.stringify(expect.stepStates)}` };
    }
    return { ok: true, note: `run=${r.status} states=${JSON.stringify(states)}` };
  }

  if (err !== null && err !== undefined) {
    if (isSql && policy === 'explicit-or-parity') {
      return { ok: true, note: `SQL 显式报错（${err.name}）可接受` };
    }
    return { ok: false, note: `执行报错: ${err.message || err}` };
  }

  if (kind === 'raw') {
    const fn = CHECKS[expect.fn];
    if (!fn) return { ok: false, note: `未知 raw 断言 ${expect.fn}` };
    return fn(h, expect);
  }
  if (kind === 'count') {
    return { ok: h.result === expect.value, note: `count=${h.result} 期望 ${expect.value}` };
  }
  if (kind === 'exists') {
    return { ok: Boolean(h.result) === Boolean(expect.value), note: `exists=${h.result}` };
  }
  if (kind === 'inserted') {
    let ok = Boolean(h.result) && String(h.result._id || '').startsWith(expect.idPrefix);
    if (expect.hasTimestamps) {
      ok = ok && typeof h.result.createdAt === 'number' && h.result.createdAt > 0;
    }
    return { ok, note: `insert 结果: ${JSON.stringify(h.result)}` };
  }
  if (kind === 'updated') {
    const val = (h.result || {}).modifiedCount;
    const exp = expect.modifiedCount;
    return { ok: exp === undefined || exp === null ? true : val === exp, note: `modifiedCount=${val}` };
  }
  if (kind === 'removed') {
    const r = h.result || {};
    return {
      ok: r.deletedCount === expect.deletedCount && r.archivedCount === expect.archivedCount,
      note: `remove 结果: ${JSON.stringify(r)}`,
    };
  }

  if (kind === 'rows') {
    let expected = expect.rows;
    if (expected === undefined || expected === null) {
      expected = oracleRows;
      if ((expected === undefined || expected === null) && isSql) {
        return { ok: false, note: '缺少期望行集且无 mongo oracle' };
      }
    }
    if ((expected === undefined || expected === null) && !isSql) {
      return { ok: true, note: 'mongo 基准（无显式期望，仅作 oracle）' };
    }
    const act = normRows(h.result, expect.normalize);
    const exp = normRows(expected, expect.normalize);
    if (deepEq(act, exp)) return { ok: true, note: `${act.length} 行` };
    return {
      ok: false,
      note: `行集不一致\n  实际: ${JSON.stringify(act)}\n  期望: ${JSON.stringify(exp)}`,
    };
  }

  return { ok: false, note: `未知断言 kind=${kind}` };
}

// ──────────────────────────────────────────────────────────── 执行 ──

const _eventsAll = [];

async function runBackend(kind, oracle) {
  _eventsAll.length = 0;
  feedback.setSink((e) => _eventsAll.push(e));

  const h = {
    backend: kind,
    driver: null, // setup 后填充（阶段4 T4 迁移用例执行 DDL 用）
    store,
    eventsAll: _eventsAll,
    result: null,
    error: null,
    events: [],
    casePolicy: null,
  };

  const setup = await setupBackend(kind);
  if (setup.error) {
    return { backend: kind, available: false, skipReason: setup.error, results: [], oracle: null };
  }
  const { driver, conn, client } = setup;
  h.driver = driver;

  registerAll();
  if (kind !== 'mongodb') {
    // 阶段3 建→读闭环：手工 DDL 建表后，执行引擎 ddl.generate 产的 CREATE INDEX
    // （unique 索引物理生效 → T3-02 重复键显式报错）
    const { ddl: ddlMod } = require('../../../src');
    const idxStmts = ddlMod
      .generate(kind)
      .split('\n\n')
      .map((x) => x.trim())
      .filter((x) => /^CREATE (UNIQUE )?INDEX/i.test(x));
    for (const st of idxStmts) {
      if (kind === 'sqlite') driver.exec(st);
      else await driver.query(st);
    }
  }
  if (kind === 'mongodb') {
    // init 的 Mongo unique 索引构建对已有重复数据会失败（E11000 仅告警）→
    // 先清空集合再 init，保证索引在空集合上构建成功
    await reset(kind, driver);
  }
  await init({ default: conn });

  const cases = loadCases();
  const caseOracle = oracle || {};
  const results = [];
  const collectedOracle = {};

  try {
    for (const c of cases) {
      if (c.backends && !c.backends.includes(kind)) continue; // backends 子集限定
      if ((c.reset || 'seed') === 'seed') {
        await reset(kind, driver);
        await seed();
      }
      const savedRequire = store.requireContext();
      const savedProfile = sc.getProfile();
      sc.setProfile(c.profile || 'standard');
      h.casePolicy = c.sqlPolicy || null;
      const stepsOut = [];
      const caseOracleSteps = [];
      try {
        await withCtx(c.ctx, async () => {
          for (let si = 0; si < c.steps.length; si += 1) {
            const step = c.steps[si];
            let ok;
            let note;
            if (step.op === 'raw') {
              // 裸 raw 步骤：调 checks 同名协程（自身执行操作与断言，复用 h.result）
              h.events = [];
              const fn = CHECKS[step.fn];
              if (!fn) {
                ok = false;
                note = `未知裸 raw 步骤 ${step.fn}`;
              } else {
                ({ ok, note } = await fn(h, step));
              }
              caseOracleSteps.push(null);
            } else {
              const { result, error, events } = await runStep(h, step);
              h.result = result;
              h.error = error;
              h.events = events;
              let oracleRows = null;
              if (kind === 'mongodb') {
                if ((step.expect || {}).kind === 'rows') {
                  oracleRows = normRows(h.result, (step.expect || {}).normalize);
                  caseOracleSteps.push(oracleRows);
                } else {
                  caseOracleSteps.push(null);
                }
              } else if (caseOracle && Array.isArray(caseOracle[c.id]) && si < caseOracle[c.id].length) {
                oracleRows = caseOracle[c.id][si];
              }
              ({ ok, note } = await assertStep(h, step, oracleRows));
            }
            stepsOut.push({
              idx: si,
              ok,
              note,
              op: step.op,
              expectKind: (step.expect || {}).kind,
            });
          }
        });
      } finally {
        store.setRequireContext(savedRequire);
        sc.setProfile(savedProfile);
      }
      results.push({
        id: c.id,
        title: c.title || '',
        group: c.group,
        backend: kind,
        status: stepsOut.every((s) => s.ok) ? 'pass' : 'fail',
        steps: stepsOut,
      });
      if (kind === 'mongodb') collectedOracle[c.id] = caseOracleSteps;
    }
  } finally {
    await teardown(kind, driver, client);
  }

  return {
    backend: kind,
    available: true,
    skipReason: null,
    results,
    oracle: kind === 'mongodb' ? collectedOracle : null,
  };
}

module.exports = {
  BACKENDS,
  MYSQL_URI,
  PG_URI,
  MONGO_URI,
  loadCases,
  runBackend,
};
