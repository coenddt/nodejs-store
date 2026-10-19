'use strict';

/**
 * 资源凭据命名池（C2/A3）单测：双池共存互不串写 + 旧形状向后兼容 + 互斥/未知池校验
 * （镜像 py-store/tests/test_resource_pools.py；s3 双凭据用 local provider 双根目录离线等价）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function poolCfg(tmp, subs = ['a', 'b']) {
  return { pools: {
    sys: { providers: [{ kind: 'local', options: { baseDir: path.join(tmp, subs[0]) } }] },
    biz: { providers: [{ kind: 'local', options: { baseDir: path.join(tmp, subs[1]) } }] },
  } };
}

test('双池共存：put(pool=...) 各落各的根目录，互不串写', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp_iso_'));
  resource.configure({ store: fakeStore(), ...poolCfg(tmp) });
  assert.deepEqual(resource.poolNames(), ['sys', 'biz']);

  const rSys = await resource.put({ bytes: Buffer.from('sys-doc'), pool: 'sys' });
  const rBiz = await resource.put({ bytes: Buffer.from('biz-doc'), pool: 'biz' });
  const aRoot = path.join(tmp, 'a');
  const bRoot = path.join(tmp, 'b');
  // local provider 文件路径 = baseDir + resourceContentPath(sha1)：只扫目录即可判定串写
  const list = (root) => fs.readdirSync(root, { recursive: true }).join(',');
  assert.ok(list(aRoot).includes(rSys.sha1.slice(0, 2)) && list(aRoot).includes(rSys.sha1));
  assert.ok(!list(aRoot).includes(rBiz.sha1));
  assert.ok(list(bRoot).includes(rBiz.sha1));
  assert.ok(!list(bRoot).includes(rSys.sha1));
  // open 按池读取：sys 池读回 sys 字节；biz 池读该 id → location 行（跨池共享元数据表）
  // 存在但 biz 池无文件 → 降级后 lastErr 原样重抛（ENOENT，禁改语义、禁跨池串读）
  const got = await resource.open(rSys.resourceId, { pool: 'sys' });
  assert.equal(got.bytes.toString(), 'sys-doc');
  await assert.rejects(() => resource.open(rSys.resourceId, { pool: 'biz' }),
    (e) => e.code === 'ENOENT');
  // remove 按池清副本：sys 池清理不影响 biz 池文件
  assert.deepEqual(await resource.remove(rSys.resourceId, { pool: 'sys' }), { removed: ['local'] });
  assert.ok(!list(aRoot).includes(rSys.sha1));
  assert.ok(list(bRoot).includes(rBiz.sha1));
});

test('旧形状完全向后兼容：等价默认池 "default"', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp_leg_'));
  const view = resource.configure({
    store: fakeStore(),
    providers: [{ kind: 'local', options: { baseDir: path.join(tmp, 'only') } }],
  });
  assert.deepEqual(Object.keys(view), ['default']);
  assert.deepEqual(resource.poolNames(), ['default']);
  const out = await resource.put({ bytes: Buffer.from('legacy'), fileName: 'x.txt', mime: 'text/plain' });
  assert.equal(out.locations[0].status, 'ok');
  const opened = await resource.open(out.resourceId);
  assert.equal(opened.bytes.toString(), 'legacy');
  assert.equal(opened.fileName, 'x.txt');
  // pool=null 与不传等价（= "default"）
  const opened2 = await resource.open(out.resourceId, { pool: null });
  assert.equal(opened2.bytes.toString(), 'legacy');
});

test('互斥校验与未知池名：同现抛错、未知池抛错（禁回落默认池）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp_x_'));
  assert.throws(() => resource.configure({
    providers: [{ kind: 'local', options: { baseDir: tmp } }],
    pools: { sys: { providers: [] } },
  }), /互斥/);
  resource.configure({ store: fakeStore(), ...poolCfg(tmp) });
  await assert.rejects(() => resource.put({ bytes: Buffer.from('x'), pool: 'nope' }), /未知资源池/);
  await assert.rejects(() => resource.open('deadbeef', { pool: 'nope' }), /未知资源池/);
  await assert.rejects(() => resource.remove('deadbeef', { pool: 'nope' }), /未知资源池/);
  await assert.rejects(() => resource.url('local://k', { pool: 'nope' }), /未知资源池/);
});

test('createProvider 公开可达：返回形状稳定（kind + 四方法）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp_'));
  const p = resource.createProvider('local', { baseDir: tmp });
  assert.equal(p.kind, 'local');
  for (const m of ['put', 'get', 'remove', 'exists']) assert.equal(typeof p[m], 'function');
  assert.throws(() => resource.createProvider('nope'), /未知资源 provider/);
});
