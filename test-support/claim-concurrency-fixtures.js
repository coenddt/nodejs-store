'use strict';

/**
 * claim 并发用例的队列夹具与 worker 侧脚本（D4-4 零语义拆分）。
 *
 * 自 tests/claim-concurrency.test.js 原样下沉：环境常量（SRC_ROOT / STRESS_SECONDS /
 * QUEUE_ROWS）、ClaimJob schema 与建表 DDL、种子与建库入口（seedJobs / openDb /
 * makeFileDb）、子进程内联 worker 脚本 WORKER_SRC、临时文件清理 rmWithRetry；
 * 语句与注释逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

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

/** 建库 + DDL + 预置 pending 行（内存库/文件库两形态共用初始化序列） */
function seedJobs(db, rows) {
  db.exec(DDL);
  const ins = db.prepare(
    'INSERT INTO claim_jobs (_id, status, __present) VALUES (?, ?, ?)');
  for (let i = 0; i < rows; i++) ins.run(`j${String(i).padStart(3, '0')}`, 'pending', 'Y');
}

function openDb(rows) {
  const db = new Database(':memory:');
  seedJobs(db, rows);
  return db;
}

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
  seedJobs(db, rows);
  db.close();
  return dbPath;
}

module.exports = {
  SRC_ROOT, STRESS_SECONDS, QUEUE_ROWS, SCHEMA, WORKER_SRC,
  seedJobs, openDb, makeFileDb, rmWithRetry,
};
