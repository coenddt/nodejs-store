'use strict';

/**
 * 06 步骤 5：向量检索 conformance（C1~C11）+ 回填（A10）
 *
 * 后端覆盖：`memory` / `local` / `sqlite` 必跑；`postgres` / `mysql` / `mongodb`
 * 沿用 `real-backends-e2e.test.js:9` 的「实例不可达即 skip」约定。
 *
 * 用例集以执行文档 06 §4.5 的 JSON 为唯一权威（`VECTOR-CONFORMANCE` 标记夹取，
 * 与 py-store/tests/test_vector_conformance.py 由 `scripts/parity-vector.js` 对拍）。
 *
 * 运行：node scripts/test.js（scripts/test.js 置 LOCAL_CORE=1 + 相邻 rust-store 调试产物）
 *
 * D4-4 零语义拆分：用例集 JSON、CASE 索引、断言助手与 defineSuite 下沉
 * ../test-support/vector-conformance-support.js；真实三库（mongodb / mysql / postgres）
 * 迁 vector-conformance-real-backends.test.js；用例名与断言逐字未改。
 */

const { after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ddl = require('../src/ddl');
const { connect: connectLocal } = require('../src/local');
const { connect: connectMemory } = require('../src/memory');
const { executors } = require('../src');
const { defineSuite, registerSchemaName } = require('../test-support/vector-conformance-support');

const _dirs = [];

// ─── memory（必跑） ───────────────────────────────────────────
const MEM_STORE = new Map();
defineSuite('memory', async () => ({ vc_memory: connectMemory({ store: MEM_STORE }) }));

// ─── local（必跑；独立临时目录） ──────────────────────────────
defineSuite(
  'local',
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodejs-store-vc-local-'));
    _dirs.push(dir);
    return { vc_local: connectLocal({ dir }) };
  },
);

// ─── sqlite（必跑；内存库） ──────────────────────────────────
let _sqliteDb = null;
defineSuite(
  'sqlite',
  async () => {
    _sqliteDb = new Database(':memory:');
    _sqliteDb.exec(ddl.generate('sqlite', [registerSchemaName('sqlite'), 'VectorConformanceDeleted']));
    return { vc_sqlite: executors.createConnection('sqlite', _sqliteDb) };
  },
  async () => {
    if (_sqliteDb) _sqliteDb.close();
    _sqliteDb = null;
  },
);

after(() => {
  for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
});
