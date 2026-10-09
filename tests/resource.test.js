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
    async queryOne(gql, params) { return rows.find((r) => r._schema === 'Resource' && r._id === params.c0._id) || null; },
    async remove(schema, cond) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i]._schema === schema && (cond.resourceId ? rows[i].resourceId === cond.resourceId : rows[i]._id === cond._id)) rows.splice(i, 1); return { deletedCount: 1 }; },
  };
}

/** 通用 fake store：按物理字段名匹配（供字段映射用例） */
function genericStore() {
  const rows = [];
  const match = (r, cond) => Object.entries(cond).every(([k, v]) => r[k] === v);
  return {
    _rows: rows,
    async exists(schema, cond) { return rows.some((r) => r._schema === schema && match(r, cond)); },
    async insert(schema, data) { rows.push({ _schema: schema, ...data }); return data; },
    async insertMany(schema, docs) { docs.forEach((d) => rows.push({ _schema: schema, ...d })); return docs; },
    async query(gql, params) { const s = gql.split('(')[0].trim(); return rows.filter((r) => r._schema === s && match(r, params.c0)); },
    async queryOne(gql, params) { const s = gql.split('(')[0].trim(); return rows.find((r) => r._schema === s && match(r, params.c0)) || null; },
    async remove(schema, cond) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i]._schema === schema && match(rows[i], cond)) rows.splice(i, 1); return { deletedCount: 1 }; },
  };
}

function memProvider(kind, writes) {
  return { create: () => ({
    kind,
    async put(k, b) { writes.set(k, Buffer.from(b)); },
    async get(k) { if (!writes.has(k)) throw new Error('miss'); return writes.get(k); },
    async remove(k) { writes.delete(k); },
    async exists(k) { return writes.has(k); },
  }) };
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

test('字段映射：自定义物理字段名全链路（put/open/remove/binding/跳过列）', async () => {
  const store = genericStore();
  const writes = new Map();
  resource.registerProvider('memmap', memProvider('memmap', writes));
  resource.configure({
    store,
    schema: { resource: 'Asset', location: 'AssetLoc', binding: 'AssetBind' },
    fields: {
      resource: { sha1: 'contentHash', fileName: 'name', mime: 'contentType', size: null, kind: null },
      location: { resourceId: 'assetId', backend: 'store', key: 'objectKey', status: null, priority: null },
      binding: { resourceId: 'assetId', businessTable: 'entity', businessId: 'entityId', userId: null },
    },
    providers: [{ kind: 'memmap' }],
  });

  const out = await resource.put({
    bytes: Buffer.from('data'), fileName: 'n.bin', mime: 'application/x-bin', kind: 'img',
    bind: { businessTable: 'T', businessId: 7, userId: 9 },
  });

  const res = store._rows.find((r) => r._schema === 'Asset');
  assert.deepStrictEqual(res, {
    _schema: 'Asset', _id: out.resourceId, contentHash: out.sha1, name: 'n.bin', contentType: 'application/x-bin',
  });
  const loc = store._rows.find((r) => r._schema === 'AssetLoc');
  assert.strictEqual(loc.assetId, out.resourceId);
  assert.strictEqual(loc.store, 'memmap');
  assert.ok(loc.objectKey.includes(out.sha1));
  assert.ok(!('status' in loc) && !('priority' in loc));         // 跳过列不落库
  const bind = store._rows.find((r) => r._schema === 'AssetBind');
  assert.deepStrictEqual(bind, { _schema: 'AssetBind', assetId: out.resourceId, entity: 'T', entityId: '7' });
  assert.ok(!('userId' in bind));                                 // 可选角色 null → 跳过

  const got = await resource.open(out.resourceId);
  assert.strictEqual(got.bytes.toString(), 'data');
  assert.strictEqual(got.fileName, 'n.bin');
  assert.strictEqual(got.mime, 'application/x-bin');
  assert.strictEqual(got.backend, 'memmap');
  assert.strictEqual(got.key, loc.objectKey);

  await resource.remove(out.resourceId);
  assert.strictEqual(store._rows.filter((r) => r._schema === 'Asset' || r._schema === 'AssetLoc').length, 0);
  assert.strictEqual(writes.size, 0);
});

test('字段映射：必填/未知 → configure 抛错且零写库', () => {
  const store = genericStore();
  const base = { store, providers: [{ kind: 'memmap' }] };
  assert.throws(() => resource.configure({ ...base, fields: { resource: { sha1: null } } }), /sha1/);
  assert.throws(() => resource.configure({ ...base, fields: { location: { backend: '' } } }), /backend/);
  assert.throws(() => resource.configure({ ...base, fields: { binding: { businessId: 1 } } }), /businessId/);
  assert.throws(() => resource.configure({ ...base, fields: { bogus: {} } }), /未知表/);
  assert.throws(() => resource.configure({ ...base, fields: { resource: { bogus: 'x' } } }), /未知角色/);
  assert.strictEqual(store._rows.length, 0);
});

test('字段映射：meta 缺失 → 仍出字节 + resource_meta_missing 反馈', async () => {
  const store = genericStore();
  const writes = new Map();
  store.queryOne = async () => null;                              // 模拟 Resource 行缺失
  const feedback = require('../src/feedback');
  const events = [];
  const prev = feedback.getSink();
  feedback.setSink((e) => events.push(e));
  try {
    resource.registerProvider('memmiss2', memProvider('memmiss2', writes));
    resource.configure({ store, providers: [{ kind: 'memmiss2' }] });
    const out = await resource.put({ bytes: Buffer.from('z'), fileName: 'z.bin', mime: 'text/plain' });
    const got = await resource.open(out.resourceId);
    assert.strictEqual(got.bytes.toString(), 'z');
    assert.strictEqual(got.fileName, null);                       // meta 缺失 → null（调用方兜底）
    assert.strictEqual(got.mime, null);
    assert.ok(events.some((e) => e.code === 'resourceMetaMissing'));
  } finally {
    feedback.setSink(prev);
  }
});
