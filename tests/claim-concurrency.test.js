'use strict';

/**
 * 并发原语测试（C1/A2）：claim 功能用例 + 双进程压测零重复领取 + leader_elector 等价用例
 *
 * 对应执行文档 02 §4.4（镜像 py-store/tests/test_claim_concurrency.py）：
 *   1. SQLite 单进程功能用例：领取数 = limit、置标落库、防重复领取（filter 排除条件）；
 *   2. 双进程压测：2 个独立 node 进程各持独立连接循环 claim 同一 100 行队列——
 *      缺省 60s 短版（CI）；`CLAIM_STRESS_FULL=1` 跑 600s 完整版（A2 定论实验，
 *      与 py 侧 10 分钟定论对应）。判定依据是**各 worker 实际领取到的 _id 列表
 *      无交集**（库内 claimed_by 会被后写覆盖，不能作为重复判定来源）；
 *   3. leader_elector 等价用例：upsert 幂等插入两次仅一行；CAS 抢占 matched=1 /
 *      败者 matched=0；renewLease 归属条件续约。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

const { store, executors } = require('../src');
const { register } = require('../src/schema');
const { setDb } = require('../src/crud');

const SRC_ROOT = path.join(__dirname, '..');
const STRESS_SECONDS = process.env.CLAIM_STRESS_FULL === '1' ? 600 : 60;
const QUEUE_ROWS = 100;

const SCHEMA = {
  name: 'ClaimJob',
  collection: 'claim_jobs',
  timestamps: false,
  fields: {
    status: { type: 'string' },
    claimedBy: { type: 'string' },
    leaseUntil: { type: 'int' },
  },
  relations: {},
};

const DDL = `CREATE TABLE IF NOT EXISTS claim_jobs (
  _id TEXT PRIMARY KEY, status TEXT, claimed_by TEXT, lease_until INT,
  __present TEXT)`;

function openDb(rows) {
  const db = new Database(':memory:');
  db.exec(DDL);
  const ins = db.prepare(
    'INSERT INTO claim_jobs (_id, status, __present) VALUES (?, ?, ?)');
  for (let i = 0; i < rows; i++) ins.run(`j${String(i).padStart(3, '0')}`, 'pending', 'Y');
  return db;
}

// ── 用例 1：单进程功能（领取数 = limit、置标落库、防重复） ──────────────────

test('claim 功能：领取数=limit、置标落库、领完为空', async () => {
  const db = openDb(5);
  register(SCHEMA);
  setDb(executors.createConnection('sqlite', db));
  try {
    const got = await store.claim('ClaimJob', { status: 'pending' },
      { claimedBy: 'w1', status: 'claimed' }, { limit: 3, sort: [['_id', 1]] });
    assert.equal(got.length, 3, `领取数应为 limit=3，实际 ${got.length}`);
    assert.deepEqual(got.map((r) => r._id), ['j000', 'j001', 'j002']);
    // 置标落库（RETURNING 行 = 领取后最新值）
    for (const r of got) {
      assert.equal(r.claimedBy, 'w1');
      assert.equal(r.status, 'claimed');
    }
    // 重复 claim：pending 已排除 → 只剩 2 行可领
    const rest = await store.claim('ClaimJob', { status: 'pending' },
      { claimedBy: 'w2', status: 'claimed' }, { limit: 10 });
    assert.equal(rest.length, 2, rest);
    // 领完后再 claim → 空
    const again = await store.claim('ClaimJob', { status: 'pending' },
      { claimedBy: 'w3', status: 'claimed' }, { limit: 10 });
    assert.deepEqual(again, []);
  } finally {
    db.close();
  }
});

// ── 用例 2：双进程压测（A2 定论实验；短版 60s / 完整 600s） ─────────────────

// worker 内联脚本（spawn node -e）：独立进程独立连接循环 claim，结果写 jsonl
const WORKER_SRC = `
const path = require('node:path');
const fs = require('node:fs');
const Database = require(path.join(process.env.SRC_ROOT, 'node_modules', 'better-sqlite3'));
const { store, executors } = require(path.join(process.env.SRC_ROOT, 'src'));
const { register } = require(path.join(process.env.SRC_ROOT, 'src', 'schema'));
const { setDb } = require(path.join(process.env.SRC_ROOT, 'src', 'crud'));

register({
  name: 'ClaimJob', collection: 'claim_jobs', timestamps: false,
  fields: {
    status: { type: 'string' },
    claimedBy: { type: 'string' },
    leaseUntil: { type: 'int' },
  },
  relations: {},
});
const db = new Database(process.env.DB_PATH, { timeout: 10000 });
setDb(executors.createConnection('sqlite', db));
const stop = Date.now() + Number(process.env.DURATION_S) * 1000;
const out = process.env.OUT_PATH;
(async () => {
  while (Date.now() < stop) {
    let rows = [];
    try {
      rows = await store.claim('ClaimJob', { status: 'pending' },
        { claimedBy: process.env.WORKER_ID, status: 'claimed' }, { limit: 1 });
    } catch (e) {
      // SQLite 写锁忙（另一 worker 正在写）：显式拦截后重试——统计的是「实际
      // 领取列表」，被锁跳过不影响正确性判定
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    for (const r of rows) fs.appendFileSync(out, JSON.stringify({ id: r._id }) + '\\n');
    if (!rows.length) await new Promise((r) => setTimeout(r, 5));
  }
  db.close();
})();
`;

// Windows：进程退出后句柄短暂残留是 OS 延迟释放行为，rm 重试消化；
// fs.rmSync 的 maxRetries 只对 recursive 目录路径生效，单文件手工重试。
// 超限不 fail（断言即结论），但必须告警残留路径——不静默失守。
function rmWithRetry(target, { tries = 10, delayMs = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(target, { force: true, recursive: true });
      return;
    } catch (e) {
      if (i === tries - 1) {
        console.warn(`[cleanup] 临时文件未能删除（句柄仍被占用）: ${target}（${e.code}）`);
      } else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }
  }
}

function makeFileDb(rows) {
  const dbPath = path.join(os.tmpdir(), `claim_stress_${process.pid}_${Date.now()}.db`);
  const db = new Database(dbPath);
  db.exec(DDL);
  const ins = db.prepare(
    'INSERT INTO claim_jobs (_id, status, __present) VALUES (?, ?, ?)');
  for (let i = 0; i < rows; i++) ins.run(`j${String(i).padStart(3, '0')}`, 'pending', 'Y');
  db.close();
  return dbPath;
}

test(`claim 双进程压测：零重复领取（${STRESS_SECONDS}s × 100 行）`, async () => {
  const dbPath = makeFileDb(QUEUE_ROWS);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim_stress_'));
  const outs = [0, 1].map((i) => path.join(outDir, `w${i}.jsonl`));
  const start = Date.now();
  try {
    const workers = [0, 1].map((i) => spawn(
      process.execPath,
      ['-e', WORKER_SRC],
      {
        env: {
          ...process.env,
          SRC_ROOT,
          DB_PATH: dbPath,
          WORKER_ID: `w${i}`,
          DURATION_S: String(STRESS_SECONDS),
          OUT_PATH: outs[i],
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      }));
    const exitCodes = await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
      w.on('exit', (code) => resolve(code));
      w.on('error', reject);
    })));
    for (const [i, code] of exitCodes.entries()) {
      assert.equal(code, 0, `worker w${i} 非零退出 ${code}`);
    }

    const perWorker = outs.map((p) => (fs.existsSync(p)
      ? fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
      : []));
    const allIds = perWorker.flat();
    // 零重复：两 worker 实际领取列表无交集
    const dup = perWorker[0].filter((id) => perWorker[1].includes(id));
    assert.deepEqual(dup, [], `发现重复领取 ${dup.slice(0, 10)}（A2 违约）`);
    // 队列全部领完
    assert.equal(allIds.length, QUEUE_ROWS,
      `应领完全部 ${QUEUE_ROWS} 行，实际 ${allIds.length}（重复 ${allIds.length - new Set(allIds).size}）`);
    // 库内终态：全部 claimed
    const check = new Database(dbPath)
      .prepare("SELECT COUNT(*) AS n FROM claim_jobs WHERE status='claimed'").get();
    assert.equal(check.n, QUEUE_ROWS, `库内 claimed 终态 ${check.n}/${QUEUE_ROWS}`);
    console.log(`\n[压测] ${STRESS_SECONDS}s 双进程 × ${QUEUE_ROWS} 行队列：`
      + `总领取 ${allIds.length}，零重复，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`
      + (STRESS_SECONDS >= 600 ? '（A2 定论：零重复领取）' : '（短版）'));
  } finally {
    rmWithRetry(dbPath);
    rmWithRetry(outDir);
  }
});

// ── 用例 3：leader_elector 等价（upsert 幂等 + CAS 抢占 + 续约） ─────────────

test('leader_elector 等价：upsert 幂等、CAS 抢占、renewLease 归属条件', async () => {
  const db = openDb(0);
  db.exec('ALTER TABLE claim_jobs ADD COLUMN payload TEXT');
  register(SCHEMA);
  setDb(executors.createConnection('sqlite', db));
  try {
    // 幂等插入：upsert 两次仅一行（leader 行固定 _id，按主键 upsert）
    await store.upsert('ClaimJob', { _id: 'leader1' },
      { _id: 'leader1', status: 'leader-hold', claimedBy: 'n1', leaseUntil: 100 });
    await store.upsert('ClaimJob', { _id: 'leader1' },
      { _id: 'leader1', status: 'leader-hold', claimedBy: 'n1', leaseUntil: 100 });
    assert.equal(await store.count('ClaimJob', { status: 'leader-hold' }), 1);

    // CAS 抢占：旧持有者过期 → 竞选者 matched=1
    assert.deepEqual(
      await store.compareAndSet('ClaimJob',
        { _id: 'leader1', status: 'leader-hold', leaseUntil: 100 },
        { claimedBy: 'n2', leaseUntil: 200 }),
      { matched: 1, modified: 1 });
    // 败者（持有者归属条件不满足）matched=0
    assert.deepEqual(
      await store.compareAndSet('ClaimJob',
        { _id: 'leader1', status: 'leader-hold', claimedBy: 'n1' },
        { claimedBy: 'n3' }),
      { matched: 0, modified: 0 });

    // renewLease：归属条件由 filter 携带；持有者续约 matched=1，他人 matched=0
    assert.deepEqual(
      await store.renewLease('ClaimJob', { _id: 'leader1', claimedBy: 'n2' },
        { leaseUntil: 300 }),
      { matched: 1, modified: 1 });
    const bad = await store.renewLease('ClaimJob',
      { _id: 'leader1', claimedBy: 'nX' }, { leaseUntil: 999 });
    assert.equal(bad.matched, 0, bad);
  } finally {
    db.close();
  }
});

// ── Mongo 拒绝：execMongo 对 claim/compareAndSet 显式报错 ───────────────────

test('execMongo 拒绝 claim/compareAndSet（concurrencyPrimitivesSqlOnly）', async () => {
  const { execMongo } = require('../src/executors/mongo');
  const fakeDb = { collection: () => ({}) };
  for (const kind of ['claim', 'compareAndSet']) {
    await assert.rejects(
      () => execMongo(fakeDb, { kind, collection: 'jobs', filter: {}, update: {} }),
      /concurrencyPrimitivesSqlOnly/,
      `execMongo 应拒绝 ${kind}`);
  }
});

// ── A1：MySQL 两步化 claim 的 SQL 文本占位符由 datasource 回填（对齐 py） ──

function twoStepClaimCmd() {
  const { getCore } = require('../src/schema');
  store.register({
    name: 'ClaimOutboxA1', collection: 'claim_outbox_a1', timestamps: false,
    fields: { status: { type: 'string' } },
  });
  const plan = getCore().planClaim(
    'ClaimOutboxA1', { status: 'pending' }, { $set: { status: 'claimed' } },
    [['_id', 1]], 2, 1700000000000, {}, null);
  return plan.commands[0];
}

function fakeMysql() {
  const calls = [];
  return {
    calls,
    conn: {
      kind: 'mysql',
      async exec(p) {
        calls.push(p);
        for (const s of p.stmts || []) {
          if (String(s.text || '').includes('___claimed_ids___')) {
            throw new Error("ER_BAD_FIELD_ERROR: Unknown column '___claimed_ids___' in 'where clause'");
          }
        }
        if (calls.length === 1) {
          return { rows: [{ _id: 'a1' }, { _id: 'a2' }], affectedRows: 0, insertId: null };
        }
        return { rows: [], affectedRows: 2, insertId: null };
      },
    },
  };
}

test('A1：MySQL 两步化 claim 先取 _id 再回填 SQL 文本占位符', async () => {
  const datasource = require('../src/datasource');
  const { calls, conn } = fakeMysql();
  const out = await datasource._execSqlDirect('default', conn, twoStepClaimCmd());
  assert.equal(calls.length, 2, '应执行两次：取 _id + 置标');
  assert.equal(calls[0].stmts.length, 1, '首条只执行取 _id 语句');
  assert.ok(String(calls[1].stmts[0].text).includes("IN ('a1','a2')"), calls[1].stmts[0].text);
  assert.deepEqual(out.rows, [{ _id: 'a1' }, { _id: 'a2' }]);
  assert.equal(out.affectedRows, 2);
});

test('A1：两步化 claim 零领取不执行置标语句', async () => {
  const datasource = require('../src/datasource');
  const calls = [];
  const conn = {
    kind: 'mysql',
    async exec(p) {
      calls.push(p);
      return { rows: [], affectedRows: 0, insertId: null };
    },
  };
  const out = await datasource._execSqlDirect('default', conn, twoStepClaimCmd());
  assert.equal(calls.length, 1);
  assert.deepEqual(out.rows, []);
  assert.equal(out.affectedRows, 0);
});
