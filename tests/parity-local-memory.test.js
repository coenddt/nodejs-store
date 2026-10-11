'use strict';

/**
 * 双链路对拍（A2）—— 同一批文档经 local 与 memory 两载体真实 CRUD 读回逐文档一致
 *
 * 约定（对齐执行文档 §5 步骤 6）：
 *   - 只走**真实 CRUD**（`init` + `store.insert` / `store.query`），**不得**直连 store/handle
 *     绕过 core 求值；
 *   - local 与 memory 用**同一份 schema、同一批文档**，各自写入后读回，逐文档 `deepEqual`；
 *   - memory 写后读回另有断言（A2 后半句）。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/parity-local-memory.test.js`
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect: connectLocal } = require('../src/local');
const { connect: connectMemory } = require('../src/memory');
const { readSnapshot } = require('../src/local/store');
const datasource = require('../src/datasource');
const { init, store, schema: _sc } = require('../src');

const _dirs = [];

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nodejs-store-plm-${tag}-`));
  _dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// 同一批文档（显式 _id、无时钟、含 null 字段）：local 与 memory 逐文档对拍
const DOCS = [
  { _id: 'pm_1', name: 'Ada', age: 36, tag: 'a' },
  { _id: 'pm_2', name: 'Bob', age: 20, tag: 'b' },
  { _id: 'pm_3', name: null, age: 45, tag: null },
];

const GQL = 'PmUser($sort:@s0){ _id name age tag }';
const PARAMS = { s0: { _id: 1 } };

test('parity/local-memory: 同一批文档两载体读回逐文档一致（A2）', async () => {
  _sc.register({
    name: 'PmUser', collection: 'pm_users', idPrefix: 'pm_', timestamps: false,
    fields: { name: { type: 'string' }, age: { type: 'int' }, tag: { type: 'string' } },
    relations: {},
  });

  const dir = tmpDir('parity');
  const memStore = new Map();

  let localRows;
  try {
    // ── local 载体：真实 CRUD 写入 + 读回 ──
    await init(connectLocal({ dir }));
    for (const d of DOCS) await store.insert('PmUser', d);
    localRows = await store.query(GQL, PARAMS);
    // 落盘确为物理名分区（证明写入走 local 载体、非内存缓存）
    assert.equal(readSnapshot(dir).pmUsers.length, DOCS.length);
  } finally {
    datasource.setConnections({});
  }

  let memoryRows;
  try {
    // ── memory 载体：注入独立 Map 隔离进程内默认分区，同批写入 + 读回 ──
    await init(connectMemory({ store: memStore }));
    for (const d of DOCS) await store.insert('PmUser', d);
    memoryRows = await store.query(GQL, PARAMS);
    // memory 写后可读回（A2 后半句）
    assert.equal(memoryRows.length, DOCS.length, 'memory 写后应可读回');
    // 进程内容器确有对应分区（证明写入落到 memory 载体）
    assert.equal(memStore.get('pmUsers').length, DOCS.length);
  } finally {
    datasource.setConnections({});
  }

  // ── 双链路对拍：逐文档 deepEqual ──
  assert.equal(memoryRows.length, localRows.length, '两载体读回行数应一致');
  for (let i = 0; i < localRows.length; i += 1) {
    assert.deepEqual(memoryRows[i], localRows[i], `第 ${i} 篇文档两载体读回应一致`);
  }
  assert.deepEqual(memoryRows, localRows);
});
