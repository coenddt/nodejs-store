'use strict';

/**
 * 本地磁盘数据源（local）Host 单测
 *
 * 分步累积：本文件随执行文档 `02-node宿主local连接与文件落盘` 的步骤 2/3/4/8 逐步补齐。
 * 运行：`$env:LOCAL_CORE='1'; node --test tests/local-store.test.js`（或 `npm test`）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSnapshot, writeCollections, withDirLock } = require('../src/local/store');

const _dirs = [];

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nodejs-store-local-${tag}-`));
  _dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 步骤 2：文件 IO ─────────────────────────────────────────

test('local/store: 目录不存在 → 空快照', () => {
  const dir = path.join(tmpDir('missing'), 'not-created');
  assert.deepEqual(readSnapshot(dir), {});
});

test('local/store: 写→读往返（文档数组，可读 JSON）', () => {
  const dir = tmpDir('roundtrip');
  const docs = [{ _id: 'u1', name: 'Ada' }, { _id: 'u2', name: 'Bob' }];
  writeCollections(dir, ['users'], { users: docs });

  assert.deepEqual(readSnapshot(dir), { users: docs });
  // 落盘文件确为可读 JSON 数组
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  assert.deepEqual(onDisk, docs);
});

test('local/store: 只回写 changed 中的集合', () => {
  const dir = tmpDir('partial');
  writeCollections(dir, ['a', 'b'], { a: [{ _id: 1 }], b: [{ _id: 2 }] });
  writeCollections(dir, ['a'], { a: [{ _id: 1 }, { _id: 3 }], b: [{ _id: 999 }] });

  const snap = readSnapshot(dir);
  assert.deepEqual(snap.a, [{ _id: 1 }, { _id: 3 }]);
  assert.deepEqual(snap.b, [{ _id: 2 }], '未在 changed 中的集合不应被回写');
});

test('local/store: 非数组集合文件 → 抛错（禁静默当空）', () => {
  const dir = tmpDir('nonarray');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ _id: 'u1' }));
  assert.throws(() => readSnapshot(dir), /必须是文档数组/);
});

test('local/store: 非法 JSON 集合文件 → 抛错', () => {
  const dir = tmpDir('badjson');
  fs.writeFileSync(path.join(dir, 'users.json'), '{ not json');
  assert.throws(() => readSnapshot(dir), /非法 JSON/);
});

test('local/store: withDirLock 串行化并发写，互不覆盖', async () => {
  const dir = tmpDir('lock');
  const snap = { users: [], posts: [] };
  const write = (name) => withDirLock(dir, () => {
    snap[name] = [...snap[name], { _id: `${name}-1` }];
    writeCollections(dir, [name], snap);
  });

  await Promise.all([write('users'), write('posts'), write('users')]);

  const onDisk = readSnapshot(dir);
  assert.equal(onDisk.users.length, 2, 'users 两次写应累加（串行、无丢失）');
  assert.equal(onDisk.posts.length, 1);
});