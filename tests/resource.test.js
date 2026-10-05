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
