'use strict';

/**
 * course-platform 场景 harness —— 真实库逐后端执行 A~J 组矩阵（`harness.py` 的 Node 版）。
 *
 * 设计约束（与 py 版一一对应）：
 *   - Rust core Registry 为进程级单例、同名 schema 重复注册为「更新语义」（放行），
 *     故单进程内可依次跑 4 个后端：每后端 `建表 → register → init({default}) → seed →
 *     逐步执行用例 → 断言 → teardown`（`(source,namespace,collection)` 三元组在四个后端
 *     间完全相同，同名覆盖允许；后端切换靠 `init` 换 `default` 连接）。
 *   - MongoDB 为语义基准(oracle)：先跑 mongodb 产出 oracle（每个 rows 步骤的规范化结果集），
 *     再跑 SQL 后端比对（sqlPolicy=explicit-or-parity 时允许显式 Err，静默不一致判失败）。
 *   - 不可达后端 → available=false + skipReason，绝不静默。
 *   - 本脚本只出证据，不修实现。
 *
 * 用法（由 tests/scenario-course-platform.test.js 调用）：
 *   const h = require('../../example/course-platform/impl/harness');
 *   const mongo = await h.runBackend('mongodb');
 *   const mysql = await h.runBackend('mysql', mongo.oracle);
 */

const fs = require('node:fs');
const path = require('node:path');

const { init, store, permission, feedback, schema: sc, executors } = require('../../../src');
const { FNS } = require('./fns');
const { PROBES } = require('./probes');
const { CHECKS } = require('./checks');

const ROOT = path.resolve(__dirname, '..');

/** 场景后端清单（MongoDB 为语义基准，必须最先跑以产出 oracle） */
const BACKENDS = ['mongodb', 'postgres', 'mysql', 'sqlite'];

/** 主场景 + 探针的 reset 表/集合（探针表无归档 DDL，不参与归档清理） */
const MAIN_TABLES = [
  'users', 'categories', 'courses', 'lessons', 'enrollments',
  'reviews', 'study_notes', 'audit_logs',
  'probe_grades', 'probe_holders', 'probe_memos', 'probe_notes', 'probe_computes',
];
const ARCHIVE_TABLES = [
  'users_deleted', 'categories_deleted', 'courses_deleted', 'lessons_deleted',
  'enrollments_deleted', 'reviews_deleted', 'study_notes_deleted', 'audit_logs_deleted',
];

// 与 py 版同一批库名，保证两宿主可对照；可用环境变量整串覆盖
const MYSQL_URI =
  process.env.MYSQL_URI
  || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e?charset=utf8mb4';
const PG_URI = process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e';

// ──────────────────────────────────────────────────────────── 装载 ──

/** 按文件名排序装载全部用例（A→J） */
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

/** fn/asyncFn 占位 true → `fns.js` 的真函数（agg 计算列原样透传，无 Host 实现） */
function _applyFns(defn) {
  for (const [key, val] of Object.entries(defn.computes || {})) {
    if (!val.fn && !val.asyncFn) continue;
    const ref = val.fnRef || key;
    const impl = FNS[ref];
    if (!impl) throw new Error(`计算列 ${defn.name}.${key} 缺少 FNS 实现 ${ref}`);
    if (val.fn) val.fn = impl;
    if (val.asyncFn) val.asyncFn = impl;
  }
}

/** 注册主场景 schema + 探针 schema（同名重复注册 = 更新语义，可重复调用） */
function registerAll() {
  for (const defn of loadSchemas()) {
    _applyFns(defn);
    sc.register(defn);
  }
  for (const defn of PROBES) {
    _applyFns(defn);
    sc.register(defn);
  }
}

// ──────────────────────────────────────────────────────────── 后端 ──

/**
 * 连接 + 建表；返回 `{ driver, conn, client?, error? }`；
 * 不可达时返回 `{ error: 原因 }`（调用方转 available=false）。
 */
async function setupBackend(kind) {
  if (kind === 'sqlite') {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (const stmt of loadDdl('sqlite')) db.exec(stmt);
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
    for (const stmt of loadDdl('mysql')) await pool.query(stmt);
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
    for (const stmt of loadDdl('postgres')) await pool.query(stmt);
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

/** 清库：归档表 + 主表（Mongo / SQL 各自路径） */
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

/** seed：走 store.insert 真实写路径（owner/时间戳/_id 生成全部真实） */
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

/** 递归把「元素全为含 _id 对象的数组」按 _id 归一，保证关系子数组跨后端可比 */
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

/** 键递归排序的稳定序列化（等价 py `json.dumps(sort_keys=True)`） */
function stableKey(v) {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v);
}

/** 0/-0 视为相等（等价 py 数值比较语义），其余严格 */
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
    const c = compareValues(a[k], b[k]);
    if (c !== 0) return c;
  }
  return 0;
}

/** 行集归一：剔 ignore 键 → 递归 _id 排序 → 按 sortBy（缺省 JSON 序列化）排序 */
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

/** 深比较（键集严格一致；数值 0/-0 视为相等，对齐 py 语义） */
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

/** 执行单个 op，返回 `{ result, error, events }` */
async function runStep(h, step) {
  const before = h.eventsAll.length;
  const op = step.op;
  let error = null;
  let result = null;
  try {
    if (op === 'query') result = await h.store.query(step.gql, step.params ?? null);
    else if (op === 'query_one') result = await h.store.queryOne(step.gql, step.params ?? null);
    else if (op === 'query_with_count') result = await h.store.queryWithCount(step.gql, step.params ?? null);
    else if (op === 'query_federated') result = await h.store.queryFederated(step.gql, step.params ?? null);
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
    else throw new Error(`未知 op: ${op}`);
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

/**
 * 断言单步，返回 `{ ok, note }`。`isSql` 由 h.backend 判定；`oracleRows` 来自 mongo 相同步骤。
 */
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

  // 结果类断言（rows/count/exists/inserted/updated/removed/raw）
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

  // rows（含分页）：与 expect.rows 或 mongo oracle 比对
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

/**
 * 跑一个后端：`建表 → register → init → 逐用例（reset→seed→ctx→steps→断言）→ teardown`。
 * `oracle`：mongo 侧 `runBackend('mongodb').oracle`（SQL 后端对拍用）。
 */
async function runBackend(kind, oracle) {
  _eventsAll.length = 0;
  feedback.setSink((e) => _eventsAll.push(e));

  const h = {
    backend: kind,
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

  registerAll();
  await init({ default: conn });

  const cases = loadCases();
  const caseOracle = oracle || {};
  const results = [];
  const collectedOracle = {};

  try {
    for (const c of cases) {
      if ((c.reset || 'seed') === 'seed') {
        await reset(kind, driver);
        await seed();
      }
      const savedRequire = store.requireContext();
      h.casePolicy = c.sqlPolicy || null;
      const stepsOut = [];
      const caseOracleSteps = [];
      try {
        await withCtx(c.ctx, async () => {
          for (let si = 0; si < c.steps.length; si += 1) {
            const step = c.steps[si];
            if (step.op === 'raw') {
              // raw 断言复用上一步的 h.result/h.error（自身不发命令、不产事件）
              h.events = [];
            } else {
              const { result, error, events } = await runStep(h, step);
              h.result = result;
              h.error = error;
              h.events = events;
            }
            let oracleRows = null;
            if (kind === 'mongodb' && step.op !== 'raw') {
              const kindOf = (step.expect || {}).kind;
              if (kindOf === 'rows') {
                oracleRows = normRows(h.result, (step.expect || {}).normalize);
                caseOracleSteps.push(oracleRows);
              } else {
                caseOracleSteps.push(null);
              }
            } else if (kind === 'mongodb') {
              caseOracleSteps.push(null);
            } else if (caseOracle && Array.isArray(caseOracle[c.id]) && si < caseOracle[c.id].length) {
              oracleRows = caseOracle[c.id][si];
            }
            const { ok, note } = await assertStep(h, step, oracleRows);
            stepsOut.push({
              idx: si,
              ok,
              note,
              op: step.op,
              expectKind: (step.expect || {}).kind,
              oracleOnly: Boolean((step.expect || {}).kind === 'rows'
                && ((step.expect || {}).rows === undefined || (step.expect || {}).rows === null)),
            });
          }
        });
      } finally {
        store.setRequireContext(savedRequire);
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
