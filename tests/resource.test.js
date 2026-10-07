const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const resource = require('../src/resource');

function fakeStore() {
  const rows = [];
  return {
    _rows: rows,
    async exists(schema, cond) { return rows.some((r) => r._schema === schema && r._id === cond._id); },
    async insert(schema, data) { rows.push({ _schema: schema, ...data }); return data; },
    async insertMany(schema, docs) { docs.forEach((d) => rows.push({ _schema: schema, ...d })); return docs; },
    async query(gql, params) { const id = params.c0.resourceId; return rows.filter((r) => r._schema === 'ResourceLocation' && r.resourceId === id); },
    async remove(schema, cond) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i]._schema === schema && (cond.resourceId ? rows[i].resourceId === cond.resourceId : rows[i]._id === cond._id)) rows.splice(i, 1); return { deletedCount: 1 }; },
  };
}

test('put fan-out + open degrade + url', async () => {
  const store = fakeStore();
  const writes = new Map();
  resource.registerProvider('memory', { create: () => ({
    kind: 'memory',
    async put(k, b) { writes.set(k, Buffer.from(b)); },
    async get(k) { if (!writes.has(k)) throw new Error('miss'); return writes.get(k); },
    async remove(k) { writes.delete(k); },
    async exists(k) { return writes.has(k); },
  })});
  const dir = path.join(os.tmpdir(), `res-${Date.now()}`);
  resource.configure({
    store,
    providers: [{ kind: 'local', options: { baseDir: dir } }, { kind: 'memory' }],
    url: { baseUrl: 'https://cdn', pathTemplate: '/{contentPath}' },
  });

  const out = await resource.put({ bytes: Buffer.from('hello'), fileName: 'a.txt', mime: 'text/plain' });
  assert.strictEqual(out.locations.length, 2);
  assert.match(out.resourceId, /^[0-9a-f]{40}$/);

  // 去掉 local 副本 → open 降级到 memory
  store._rows.filter((r) => r._schema === 'ResourceLocation' && r.backend === 'local').forEach((r) => { r.status = 'failed'; });
  const got = await resource.open(out.resourceId);
  assert.strictEqual(got.backend, 'memory');
  assert.strictEqual(got.bytes.toString(), 'hello');

  // url 纯拼接（外部 URL 直返）
  assert.strictEqual(await resource.url(out.resourceId), `https://cdn/objects/${out.sha1.slice(0,2)}/${out.sha1}`);
  assert.strictEqual(await resource.url('https://x/y.png'), 'https://x/y.png');
});

test('open：零副本行 → 抛 ERR_RESOURCE_NOT_FOUND: 前缀（spec/03 前缀层 → 适配器 404）', async () => {
  const store = fakeStore();
  resource.registerProvider('memmiss', { create: () => ({
    kind: 'memmiss',
    async put() {},
    async get() { throw new Error('miss'); },
    async remove() {},
    async exists() { return false; },
  })});
  resource.configure({ store, providers: [{ kind: 'memmiss' }] });

  const PREFIX = 'ERR_RESOURCE_NOT_FOUND:';
  const id = '0'.repeat(40);
  await assert.rejects(
    () => resource.open(id),
    (err) => {
      assert.ok(err.message.startsWith(PREFIX), `message 应带稳定前缀，实际=${err.message}`);
      assert.strictEqual(err.message.slice(PREFIX.length), `资源不存在或无可读副本: ${id}`);
      assert.strictEqual(err.resourceId, id);
      return true;
    },
  );
});

test('open：有副本行但 provider 读取失败 → 原样重抛、不带前缀（保持 500 语义）', async () => {
  const store = fakeStore();
  const feedback = require('../src/feedback');
  const prev = feedback.getSink();
  feedback.setSink(() => {});
  try {
    resource.registerProvider('iobad', { create: () => ({
      kind: 'iobad',
      async put() {},
      async get() { throw new Error('io down'); },
      async remove() {},
      async exists() { return false; },
    })});
    resource.configure({ store, providers: [{ kind: 'iobad' }] });
    store._rows.push({ _schema: 'ResourceLocation', resourceId: 'a'.repeat(40), backend: 'iobad', key: 'k', status: 'ok', priority: 0 });

    await assert.rejects(
      () => resource.open('a'.repeat(40)),
      (err) => {
        assert.strictEqual(err.message, 'io down');
        assert.ok(!err.message.startsWith('ERR_RESOURCE_NOT_FOUND:'), '不得把 IO 失败伪装成「不存在」');
        return true;
      },
    );
  } finally {
    feedback.setSink(prev);
  }
});

test('A5 首个副本读失败 → 降级到下一副本 + resource_location_degraded 反馈', async () => {
  const store = fakeStore();
  const feedback = require('../src/feedback');
  const events = [];
  const prev = feedback.getSink();
  feedback.setSink((e) => events.push(e));
  try {
    resource.registerProvider('badget', { create: () => ({
      kind: 'badget',
      async put() {},
      async get() { throw new Error('disk boom'); },
      async remove() {},
      async exists() { return false; },
    })});
    resource.registerProvider('memory', { create: () => {
      const w = new Map();
      return {
        kind: 'memory',
        async put(k, b) { w.set(k, Buffer.from(b)); },
        async get(k) { return w.get(k); },
        async remove(k) { w.delete(k); },
        async exists(k) { return w.has(k); },
      };
    }});
    resource.configure({ store, providers: [{ kind: 'badget' }, { kind: 'memory' }], url: {} });

    const out = await resource.put({ bytes: Buffer.from('hello') });
    const got = await resource.open(out.resourceId);
    assert.strictEqual(got.backend, 'memory');
    assert.strictEqual(got.bytes.toString(), 'hello');
    assert.ok(events.some((e) => e.code === 'resourceLocationDegraded'));
  } finally {
    feedback.setSink(prev);
  }
});

test('A6 副本写失败 → status=failed + resource_location_write_failed 反馈；其余副本可用', async () => {
  const store = fakeStore();
  const feedback = require('../src/feedback');
  const events = [];
  const prev = feedback.getSink();
  feedback.setSink((e) => events.push(e));
  try {
    resource.registerProvider('broken', { create: () => ({
      kind: 'broken',
      async put() { throw new Error('boom'); },
      async get() { throw new Error('boom'); },
      async remove() {},
      async exists() { return false; },
    })});
    resource.registerProvider('memory', { create: () => {
      const w = new Map();
      return {
        kind: 'memory',
        async put(k, b) { w.set(k, Buffer.from(b)); },
        async get(k) { return w.get(k); },
        async remove(k) { w.delete(k); },
        async exists(k) { return w.has(k); },
      };
    }});
    resource.configure({ store, providers: [{ kind: 'memory' }, { kind: 'broken' }], url: {} });

    const out = await resource.put({ bytes: Buffer.from('x') });
    assert.strictEqual(out.locations.find((l) => l.backend === 'broken').status, 'failed');
    assert.strictEqual(out.locations.find((l) => l.backend === 'memory').status, 'ok');
    assert.ok(events.some((e) => e.code === 'resourceLocationWriteFailed'));

    const got = await resource.open(out.resourceId);
    assert.strictEqual(got.backend, 'memory');
  } finally {
    feedback.setSink(prev);
  }
});

test('Store 门面转发 registerProvider', () => {
  const { store } = require('../src');
  const providers = require('../src/resource/providers');
  const mod = { create: () => ({ kind: 'stub-x' }) };
  store.registerProvider('stub-x', mod);
  assert.strictEqual(providers._REG.get('stub-x'), mod);
});
