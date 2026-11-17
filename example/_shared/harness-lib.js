'use strict';

/**
 * 场景 harness 共享库 —— example 两场景（course-platform / manager-transaction）的
 * 同构骨架下沉（D4-2 去重提取）。
 *
 * 两场景 harness 的执行管线逐字同构：装载（cases/seed/schema/ddl）→ setupBackend 四分支
 * （sqlite 内存 / mysql / postgres / mongodb，不可达返回 {error} 绝不静默）→
 * reset / withCtx / seed / teardown → 归一（deepSortValue / stableKey / compareValues /
 * compareRow / normRows / deepEq）→ runStep（op 分派、统一捕获为「显式报错」证据）→
 * assertStep（error/feedback/unsupported/run/raw→CHECKS/count/exists/inserted/updated/
 * removed/rows+oracle）→ runBackend 主循环（Mongo 先行产 oracle，SQL 后端对拍）。
 *
 * 场景差异全部经 `config` 注入（薄壳只留差异，骨架零复制）：
 *   - root / tables {main, archive} / uris {mysql, pg, mongo}：目录、清库表集、连接串；
 *   - registerAll(helpers)：schema 注册（course 附 applyFns + PROBES + 豁免清单；
 *     mgrtx 仅 schemas）；
 *   - extraDdl(kind)：建表 DDL 追加语句（mgrtx 的内建 `__workflowRun` 表；course 无）；
 *   - postSetup(kind, driver, helpers)：init 前置（mgrtx 的 CREATE INDEX + Mongo 先清空；
 *     course 无）；
 *   - filterCase(c, kind)：用例过滤（mgrtx 的 backends 子集限定；course 无）；
 *   - onRaw(h, step)：裸 raw 步骤处理（mgrtx 调 CHECKS 协程自执行自断言）；
 *     缺省（未提供）走 assertStep 的 raw 断言分支（course：复用上一步 h.result/h.error）；
 *   - stepMeta(step)：stepsOut 追加字段（course 的 oracleOnly 标记）；
 *   - checks：raw 断言协程表（各场景 impl/checks.js 的 CHECKS）。
 *
 * 零语义说明（对拍两份原 harness 逐行核对）：
 *   - runStep 的 op 分派为两场景**并集**（course 独有 query_federated；mgrtx 独有
 *     set_ctx / register_workflow / run_workflow）——已枚举两场景全部用例，各自从不触发
 *     对方的独有 op，故「未知 op」报错边界不变；
 *   - assertStep 含 run 分支（course 用例无 expect.kind='run'，该分支走不到）；
 *   - compareRow 统一为嵌套键版（`k.split('.')` 逐段下钻）——对平键（无点号）与原
 *     course 平键版逐值等价（normRows 输入恒为对象，`a[k]` 与逐段下钻同值）；
 *   - h 统一带 `driver` 字段（course 的 checks 协程只读 backend/error/events/result/store，
 *     不读 driver，新增字段无观察点）；
 *   - `eventsAll` 缓冲按 createHarness **实例**隔离（原版两 harness 为独立模块实例、
 *     各有独立缓冲；共享库若用模块级数组，node --test 并发跑两场景会互串事件）。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  init, store, permission, feedback, schema: sc, executors, workflow,
} = require('../../src');
const naming = require('../../src/naming');

/** 场景后端清单（MongoDB 为语义基准，必须最先跑以产出 oracle） */
const BACKENDS = ['mongodb', 'postgres', 'mysql', 'sqlite'];

// ──────────────────────────────────────────────────────────── 装载 ──

/** 按场景根目录构造四件装载器（cases / seed / schema / ddl，两场景同构） */
function makeLoaders(root) {
  return {
    /** 按文件名排序装载全部用例 */
    loadCases() {
      const dir = path.join(root, 'cases');
      const cases = [];
      for (const f of fs.readdirSync(dir).sort()) {
        cases.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      }
      return cases;
    },
    loadSeed() {
      return JSON.parse(fs.readFileSync(path.join(root, 'seed', 'seed.json'), 'utf8'));
    },
    loadSchemas() {
      return JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8'));
    },
    /** DDL 文本 → 语句数组（剥整行 `--` 注释后按 `;` 切分） */
    loadDdl(kind) {
      const text = fs.readFileSync(path.join(root, 'ddl', `${kind}.sql`), 'utf8');
      return text
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
    },
  };
}

/** fn/asyncFn 占位 true → 场景 FNS 表的真函数（agg 计算列原样透传，无 Host 实现） */
function applyFns(defn, fnsTable) {
  for (const [key, val] of Object.entries(defn.computes || {})) {
    if (!val.fn && !val.asyncFn) continue;
    const ref = val.fnRef || key;
    const impl = fnsTable[ref];
    if (!impl) throw new Error(`计算列 ${defn.name}.${key} 缺少 FNS 实现 ${ref}`);
    if (val.fn) val.fn = impl;
    if (val.asyncFn) val.asyncFn = impl;
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

/** 嵌套键版排序比较（`k.split('.')` 逐段下钻；对平键与直接取键等价） */
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

/** 数组分支：长度一致 + 逐位递归 */
function _deepEqArr(a, b) {
  return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
}

/** 普通对象分支：键集严格一致 + 逐键递归 */
function _deepEqObj(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
}

/** 深比较（键集严格一致；数值 0/-0 视为相等，对齐 py 语义） */
function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return _deepEqArr(a, b);
  if (
    a && b && typeof a === 'object' && typeof b === 'object'
    && !Array.isArray(a) && !Array.isArray(b)
  ) {
    return _deepEqObj(a, b);
  }
  return false;
}

const isSqlBackend = (kind) => kind !== 'mongodb';

// ──────────────────────────────────────────────────────────── 断言 ──

function _codes(events) {
  return (events || []).map((e) => e && e.code);
}

// op → 执行器 `(h, step)` → 结果（两场景 op 分派并集）。await 统一包裹，
// 同步分支（set_ctx / register_workflow / set_flag）结果原样返回，语义不变。
const _STEP_OPS = Object.assign(Object.create(null), {
  query: (h, step) => h.store.query(step.gql, step.params ?? null),
  query_one: (h, step) => h.store.queryOne(step.gql, step.params ?? null),
  query_with_count: (h, step) => h.store.queryWithCount(step.gql, step.params ?? null),
  query_federated: (h, step) => h.store.queryFederated(step.gql, step.params ?? null),
  count: (h, step) => h.store.count(step.schema, step.filter ?? null),
  exists: (h, step) => h.store.exists(step.schema, step.condition),
  insert: (h, step) => h.store.insert(step.schema, step.data),
  insert_many: (h, step) => h.store.insertMany(step.schema, step.rows),
  update: (h, step) => h.store.update(step.schema, step.condition, step.data),
  update_many: (h, step) => h.store.updateMany(step.schema, step.condition, step.data),
  remove: (h, step) => h.store.remove(step.schema, step.condition),
  upsert: (h, step) => h.store.upsert(step.schema, step.condition, step.data),
  mutation: (h, step) => h.store.mutation(step.schema, step.data),
  set_ctx: (h, step) => (permission.setContext(step.ctx ?? null), null),
  register_workflow: (h, step) => workflow.register(step.defn),
  run_workflow: (h, step) => store.runWorkflow(step.name, step.input ?? null,
    { dryRun: Boolean(step.dryRun) }),
  set_flag: (h, step) => _setFlag(step.name, step.value),
});

/** 执行单个 op（两场景 op 分派并集），返回 `{ result, error, events }` */
async function runStep(h, step) {
  const before = h.eventsAll.length;
  let error = null;
  let result = null;
  try {
    const dispatch = _STEP_OPS[step.op];
    if (!dispatch) throw new Error(`未知 op: ${step.op}`);
    result = await dispatch(h, step);
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

/** error 断言：须抛错且命中 expect.code / PermissionError 状态 */
function _assertError(err, expect) {
  if (err === null || err === undefined) return { ok: false, note: '期望抛错但未抛错' };
  return { ok: _matchError(err, expect), note: `实际错误: ${err.message || err}` };
}

/** feedback 断言：事件 codes 含 expect.code */
function _assertFeedback(events, expect) {
  const codes = _codes(events);
  return { ok: codes.includes(expect.code), note: `事件 codes: ${JSON.stringify(codes)}` };
}

/** unsupported 断言（仅 SQL 侧）：不可翻译须显式（err 或事件告警），禁静默返回结果 */
function _assertUnsupported(isSql, err, events) {
  if (!isSql) return { ok: true, note: 'mongo 基准支持' };
  const codes = _codes(events).filter(Boolean);
  if ((err !== null && err !== undefined) || codes.length) {
    return { ok: true, note: `显式(err=${err ? err.name : null}, events=${JSON.stringify(codes)})` };
  }
  return { ok: false, note: '不可翻译却静默返回了结果（既无错误也无告警）' };
}

/** run 期望键逐项对比（error → stepIndex → stepStates，短路顺序与原版一致）：差异返回 note，全过返回 null */
function _runFieldDiff(r, expect) {
  if ('error' in expect && r.error !== expect.error) {
    return `error=${JSON.stringify(r.error)} 期望 ${JSON.stringify(expect.error)}`;
  }
  if ('stepIndex' in expect && r.stepIndex !== expect.stepIndex) {
    return `stepIndex=${r.stepIndex} 期望 ${expect.stepIndex}`;
  }
  const states = (r.steps || []).map((st) => st.state);
  if ('stepStates' in expect && JSON.stringify(states) !== JSON.stringify(expect.stepStates)) {
    return `stepStates=${JSON.stringify(states)} 期望 ${JSON.stringify(expect.stepStates)}`;
  }
  return null;
}

/** run 文档断言：runWorkflow 统一契约不抛错；error 键显式存在时严格相等
 * （含 null——no-error-masking §二：成功态 error 必须为 null 的正向断言） */
function _assertRun(h, expect, err) {
  if (err !== null && err !== undefined) {
    return { ok: false, note: `run_workflow 不应抛错（统一契约），实际: ${err.message || err}` };
  }
  const r = h.result || {};
  if (r.status !== expect.status) {
    return { ok: false, note: `status=${r.status} 期望 ${expect.status}（error=${JSON.stringify(r.error)}）` };
  }
  const diff = _runFieldDiff(r, expect);
  if (diff !== null) return { ok: false, note: diff };
  const states = (r.steps || []).map((st) => st.state);
  return { ok: true, note: `run=${r.status} states=${JSON.stringify(states)}` };
}

/** inserted：_id 前缀匹配 + 可选时间戳存在性 */
function _assertInserted(h, expect) {
  let ok = Boolean(h.result) && String(h.result._id || '').startsWith(expect.idPrefix);
  if (expect.hasTimestamps) {
    ok = ok && typeof h.result.createdAt === 'number' && h.result.createdAt > 0;
  }
  return { ok, note: `insert 结果: ${JSON.stringify(h.result)}` };
}

/** 标量结果断言：count / exists / inserted / updated / removed */
function _assertScalar(kind, h, expect) {
  if (kind === 'count') {
    return { ok: h.result === expect.value, note: `count=${h.result} 期望 ${expect.value}` };
  }
  if (kind === 'exists') {
    return { ok: Boolean(h.result) === Boolean(expect.value), note: `exists=${h.result}` };
  }
  if (kind === 'inserted') return _assertInserted(h, expect);
  if (kind === 'updated') {
    const val = (h.result || {}).modifiedCount;
    const exp = expect.modifiedCount;
    return { ok: exp === undefined || exp === null ? true : val === exp, note: `modifiedCount=${val}` };
  }
  const r = h.result || {};
  return {
    ok: r.deletedCount === expect.deletedCount && r.archivedCount === expect.archivedCount,
    note: `remove 结果: ${JSON.stringify(r)}`,
  };
}

/** rows（含分页）：与 expect.rows 或 mongo oracle 比对 */
function _assertRows(h, expect, oracleRows, isSql) {
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

/** 结果类断言（rows/count/exists/inserted/updated/removed/raw）；执行报错前置检查 */
async function _assertResult(kind, h, expect, oracleRows, env) {
  const err = h.error;
  if (err !== null && err !== undefined) {
    if (env.isSql && env.policy === 'explicit-or-parity') {
      return { ok: true, note: `SQL 显式报错（${err.name}）可接受` };
    }
    return { ok: false, note: `执行报错: ${err.message || err}` };
  }
  if (kind === 'raw') {
    const fn = env.checks[expect.fn];
    if (!fn) return { ok: false, note: `未知 raw 断言 ${expect.fn}` };
    return fn(h, expect);
  }
  if (kind === 'rows') return _assertRows(h, expect, oracleRows, env.isSql);
  return _assertScalar(kind, h, expect);
}

/**
 * 断言单步，返回 `{ ok, note }`。`isSql` 由 h.backend 判定；`oracleRows` 来自 mongo 相同步骤；
 * `checks` 为场景 raw 断言协程表（expect.kind='raw' 时按 fn 名取协程）。
 */
async function assertStep(h, step, oracleRows, checks) {
  const expect = step.expect || {};
  if (!expect.kind) return { ok: true, note: 'no assertion' };
  const kind = expect.kind;
  const isSql = isSqlBackend(h.backend);
  const policy = step.sqlPolicy || h.casePolicy || 'parity';
  const err = h.error;
  const events = h.events;

  if (kind === 'error') return _assertError(err, expect);
  if (kind === 'feedback') return _assertFeedback(events, expect);
  if (kind === 'unsupported') return _assertUnsupported(isSql, err, events);
  if (kind === 'run') return _assertRun(h, expect, err);
  // 结果类断言（rows/count/exists/inserted/updated/removed/raw）
  return _assertResult(kind, h, expect, oracleRows, { isSql, policy, checks });
}

// ──────────────────────────────────────────────────────────── 工厂 ──

/**
 * 构造一个场景 harness（装载器 / setup / 归一 / 断言 / runBackend 全套闭包）。
 * @param {object} config 见模块头注释「场景差异全部经 config 注入」
 * @returns {{BACKENDS, MYSQL_URI, PG_URI, MONGO_URI, loadCases, loadSeed, loadSchemas,
 *            loadDdl, applyFns, runBackend}}
 */
function createHarness(config) {
  const loaders = makeLoaders(config.root);
  // 事件缓冲按实例隔离：原版两 harness 为独立模块实例、各有独立缓冲；
  // node --test 并发跑两场景时（feedback.setSink 全局单点）必须互不串扰
  const _eventsAll = [];

  /** 场景 helpers：registerAll / postSetup 等钩子的取数与清库入口（reset 靠函数声明提升直引） */
  const Helpers = {
    ...loaders,
    applyFns,
    sc,
    store,
    reset,
  };

  /** SQL 池探活；不可达 → 关池并返回 `{error}`（绝不静默），可达返回 null */
  async function probePool(pool, label, uri) {
    try {
      await pool.query('SELECT 1');
      return null;
    } catch (e) {
      await pool.end().catch(() => {});
      return { error: `${label} 不可达（${uri}）: ${e.message}` };
    }
  }

  /** sqlite 分支：内存库 + 建表（同步 exec） */
  function _setupSqlite(extra) {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (const stmt of [...loaders.loadDdl('sqlite'), ...extra]) db.exec(stmt);
    return { driver: db, conn: executors.createConnection('sqlite', db) };
  }

  /** mysql / postgres 分支共构：建池 → 探活 → 建表（不可达关池返回 {error}） */
  async function _setupSqlPool(kind, extra) {
    let pool;
    let probe;
    if (kind === 'mysql') {
      const mysql = require('mysql2/promise');
      pool = mysql.createPool(config.uris.mysql);
      probe = await probePool(pool, 'MySQL', config.uris.mysql);
    } else {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: config.uris.pg, connectionTimeoutMillis: 3000 });
      probe = await probePool(pool, 'PostgreSQL', config.uris.pg);
    }
    if (probe) return probe;
    for (const stmt of [...loaders.loadDdl(kind), ...extra]) await pool.query(stmt);
    return { driver: pool, conn: executors.createConnection(kind, pool) };
  }

  /** mongodb 分支：连接 + ping，不可达关连接返回 {error} */
  async function _setupMongo() {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(config.uris.mongo, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
    } catch (e) {
      await client.close().catch(() => {});
      return { error: `MongoDB 不可达（${config.uris.mongo}）: ${e.message}` };
    }
    const db = client.db();
    return { driver: db, conn: db, client };
  }

  /** 连接 + 建表；返回 `{ driver, conn, client?, error? }`；不可达时返回 `{ error: 原因 }` */
  async function setupBackend(kind) {
    // 追加 DDL 仅对 SQL 三分支生效（Mongo 无 DDL——原版 builtinDdl 也只在三分支拼接）
    const extra = kind !== 'mongodb' && config.extraDdl ? config.extraDdl(kind) : [];
    if (kind === 'sqlite') return _setupSqlite(extra);
    if (kind === 'mysql' || kind === 'postgres') return _setupSqlPool(kind, extra);
    if (kind === 'mongodb') return _setupMongo();
    throw new Error(`未知后端 ${kind}`);
  }

  /** 清库：归档表 + 主表（Mongo / SQL 各自路径） */
  async function reset(kind, driver) {
    const tables = [...config.tables.archive, ...config.tables.main];
    if (kind === 'mongodb') {
      // Mongo 落库用物理集合名（core::naming camelCase）：按单点翻译后再清，否则旧物理集合残留
      for (const t of tables) await driver.collection(naming.physical(t)).deleteMany({});
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
    for (const batch of loaders.loadSeed()) {
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
    } catch {
      /* 收尾失败不掩盖测试结论 */
    }
  }

  /** 单步骤执行+断言：raw 走场景协程（缺省复用上一步结果）；其余 runStep→assertStep。
   * `oc`：oracle 采集环境 `{ at(c,si), collected[], kind }`（mongo 侧采集 / SQL 侧回取） */
  async function _execOneStep(h, step, si, c, oc) {
    let ok;
    let note;
    if (step.op === 'raw') {
      h.events = [];
      oc.collected.push(null);
      const handled = config.onRaw ? await config.onRaw(h, step) : undefined;
      if (handled) {
        ({ ok, note } = handled);
      } else {
        // raw 断言复用上一步的 h.result/h.error（自身不发命令、不产事件）；
        // SQL 后端从 mongo oracle 按步骤位取回（mongo 侧 raw 步骤恒为 null）
        ({ ok, note } = await assertStep(h, step, oc.at(c, si), config.checks));
      }
    } else {
      const { result, error, events } = await runStep(h, step);
      h.result = result;
      h.error = error;
      h.events = events;
      let oracleRows = null;
      if (oc.kind === 'mongodb') {
        if ((step.expect || {}).kind === 'rows') {
          oracleRows = normRows(h.result, (step.expect || {}).normalize);
        }
        oc.collected.push(oracleRows);
      } else {
        oracleRows = oc.at(c, si);
      }
      ({ ok, note } = await assertStep(h, step, oracleRows, config.checks));
    }
    return { ok, note };
  }

  /** withCtx 包裹的步骤循环（用例内 ctx 态生效范围）→ stepsOut */
  async function _runCaseSteps(h, c, oc) {
    const stepsOut = [];
    await withCtx(c.ctx, async () => {
      for (let si = 0; si < c.steps.length; si += 1) {
        const step = c.steps[si];
        const { ok, note } = await _execOneStep(h, step, si, c, oc);
        const out = {
          idx: si,
          ok,
          note,
          op: step.op,
          expectKind: (step.expect || {}).kind,
        };
        if (config.stepMeta) Object.assign(out, config.stepMeta(step));
        stepsOut.push(out);
      }
    });
    return stepsOut;
  }

  /** 单用例执行：reset→seed→profile/ctx 态切换（finally 复原）；被过滤返回 null */
  async function _runCase(h, driver, c, oc) {
    if (config.filterCase && !config.filterCase(c, oc.kind)) return null;
    if ((c.reset || 'seed') === 'seed') {
      await reset(oc.kind, driver);
      await seed();
    }
    const savedRequire = store.requireContext();
    // 档位按用例声明切换（缺省 standard），结束复原
    const savedProfile = sc.getProfile();
    sc.setProfile(c.profile || 'standard');
    h.casePolicy = c.sqlPolicy || null;
    const collected = [];
    let stepsOut;
    try {
      stepsOut = await _runCaseSteps(h, c, { ...oc, collected });
    } finally {
      store.setRequireContext(savedRequire);
      sc.setProfile(savedProfile);
    }
    return { stepsOut, caseOracleSteps: collected };
  }

  /**
   * 跑一个后端：`建表 → register → (postSetup) → init → 逐用例（reset→seed→ctx→steps→
   * 断言）→ teardown`。`oracle`：mongo 侧 `runBackend('mongodb').oracle`（SQL 后端对拍用）。
   */
  async function runBackend(kind, oracle) {
    _eventsAll.length = 0;
    feedback.setSink((e) => _eventsAll.push(e));

    const h = {
      backend: kind,
      driver: null, // setup 后填充（迁移类 checks 协程执行 DDL 用）
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

    config.registerAll(Helpers);
    if (config.postSetup) await config.postSetup(kind, driver, Helpers);
    await init({ default: conn });

    const cases = loaders.loadCases();
    const caseOracle = oracle || {};
    /** SQL 后端从 mongo oracle 按步骤位取回（越位/缺失 → null） */
    const oracleAt = (c, si) => (caseOracle && Array.isArray(caseOracle[c.id]) && si < caseOracle[c.id].length
      ? caseOracle[c.id][si] : null);
    const results = [];
    const collectedOracle = {};

    try {
      for (const c of cases) {
        const done = await _runCase(h, driver, c, { at: oracleAt, kind });
        if (!done) continue;
        results.push({
          id: c.id,
          title: c.title || '',
          group: c.group,
          backend: kind,
          status: done.stepsOut.every((s) => s.ok) ? 'pass' : 'fail',
          steps: done.stepsOut,
        });
        if (kind === 'mongodb') collectedOracle[c.id] = done.caseOracleSteps;
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

  return {
    BACKENDS,
    MYSQL_URI: config.uris.mysql,
    PG_URI: config.uris.pg,
    MONGO_URI: config.uris.mongo,
    loadCases: loaders.loadCases,
    loadSeed: loaders.loadSeed,
    loadSchemas: loaders.loadSchemas,
    loadDdl: loaders.loadDdl,
    applyFns,
    runBackend,
  };
}

module.exports = { createHarness };
