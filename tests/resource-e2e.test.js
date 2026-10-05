'use strict';

/**
 * 资源数据驱动 · 真库 e2e（SQLite 内存）
 * 覆盖：注册三 schema → 建表 → 上传 fan-out（local+memory）→ 多副本落库 →
 *       按 id 打开（降级）→ Doc.coverUrl 计算列 → 按 businessId 三级级联删除。
 * 运行：$env:LOCAL_CORE='1'; $env:NODE_ENV='test'; node --test tests/resource-e2e.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { init, store, schema: sc, executors } = require('../src');
const resource = require('../src/resource');
const { cascadeByBusiness } = require('../example/resource-hub/impl/cascade');

const ROOT = path.resolve(__dirname, '..');

function loadDdl() {
  return fs.readFileSync(path.join(ROOT, 'example/resource-hub/ddl/sqlite.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
}

function loadSchemas() {
  const { FNS } = require('../example/resource-hub/impl/fns');
  const arr = JSON.parse(fs.readFileSync(path.join(ROOT, 'example/resource-hub/schema.json'), 'utf8'));
  for (const d of arr) {
    for (const [k, c] of Object.entries(d.computes || {})) {
      if (c.fn || c.asyncFn) {
        const impl = FNS[c.fnRef || k];
        if (!impl) throw new Error(`计算列 ${d.name}.${k} 缺实现`);
        if (c.fn) c.fn = impl; else c.asyncFn = impl;
      }
    }
  }
  return arr;
}

const memoryWrites = new Map();

before(async () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  for (const stmt of loadDdl()) db.exec(stmt);
  for (const defn of loadSchemas()) sc.register(defn);
  await init({ default: executors.createConnection('sqlite', db) });

  resource.registerProvider('memory', { create: () => ({
    kind: 'memory',
    async put(k, b) { memoryWrites.set(k, Buffer.from(b)); },
    async get(k) { if (!memoryWrites.has(k)) throw new Error('miss'); return memoryWrites.get(k); },
    async remove(k) { memoryWrites.delete(k); },
    async exists(k) { return memoryWrites.has(k); },
  })});
  resource.configure({
    providers: [
      { kind: 'local', options: { baseDir: path.join(os.tmpdir(), `res-e2e-${Date.now()}`) } },
      { kind: 'memory' },
    ],
    url: { baseUrl: 'https://cdn.example.com', pathTemplate: '/{contentPath}' },
  });
});

test('上传 → 多副本 → 打开 → 计算列 URL → 级联删除', async () => {
  const bytes = Buffer.from('hello-resource');
  const up = await resource.put({ bytes, fileName: 'a.txt', mime: 'text/plain', kind: 'file',
    bind: { businessTable: 'Doc', businessId: 'd1', userId: 'u1' } });
  assert.match(up.resourceId, /^[0-9a-f]{40}$/);
  assert.equal(up.locations.length, 2);
  assert.ok(up.locations.every((l) => l.status === 'ok'));

  // 多副本落库
  const locs = await store.query(
    'ResourceLocation($condition: @c0) { _id, backend, status }',
    { c0: { resourceId: up.resourceId } },
  );
  assert.equal(locs.length, 2);

  // A9：唯一索引生效 —— 重复插入同 (resourceId, backend) 显式报错
  await assert.rejects(
    () => store.insert('ResourceLocation', {
      resourceId: up.resourceId, backend: 'local', key: 'dup', status: 'ok', priority: 0,
    }),
  );

  // 内容寻址去重：同内容二次上传不新增 Resource 行
  const again = await resource.put({ bytes, fileName: 'copy.txt', mime: 'text/plain' });
  assert.equal(again.resourceId, up.resourceId);

  // 打开（按 provider 配置序，local 优先）
  const got = await resource.open(up.resourceId);
  assert.equal(got.backend, 'local');
  assert.equal(got.bytes.toString(), 'hello-resource');

  // 绑定 + 计算列 URL（业务侧只存 coverId）
  await resource.put({ bytes: Buffer.from('cover-x'), fileName: 'c.png', mime: 'image/png', kind: 'image',
    bind: { businessTable: 'Doc', businessId: 'd1', userId: 'u1' } });

  // A9：ResourceBinding 三元组唯一 —— 重复插入显式报错
  await assert.rejects(
    () => store.insert('ResourceBinding', {
      resourceId: up.resourceId, businessTable: 'Doc', businessId: 'd1', userId: 'u1',
    }),
  );

  await store.insert('Doc', { _id: 'd1', title: 'D', coverId: up.resourceId, createdBy: 'u1' });
  const read = await store.queryOne('Doc($condition: @c0) { _id, title, coverId, coverUrl }', { c0: { _id: 'd1' } });
  assert.equal(read.coverUrl, `https://cdn.example.com/objects/${up.sha1.slice(0, 2)}/${up.sha1}`);

  // 三级级联：绑定 Doc d1 共 2 个资源（up + cover），删 d1 → 两资源均无其他引用 → 彻底删
  const summary = await cascadeByBusiness(store, resource, { businessTable: 'Doc', businessId: 'd1' });
  assert.equal(summary.total, 2);
  assert.equal(summary.removed, 2);
  assert.equal(summary.kept, 0);
  const after = await store.query('Resource($condition: @c0) { _id }', { c0: {} });
  assert.equal(after.length, 0);
});
