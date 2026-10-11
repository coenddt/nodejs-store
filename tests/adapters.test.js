'use strict';

/**
 * 第三方接口适配器 E2E —— A7 前半 / A9（对齐执行文档 03 §5 步骤 3、§1 验收）
 *
 *   1. A7 前半：本地 HTTP stub → `pullInto` → 落主链路 → 既有 GQL 查询命中；
 *   2. A9：非 2xx / JSON 解析失败 / `pick` 非数组 ⇒ `HttpAdapterError`（禁静默）；成功 0 条 ⇒ `pulled: 0` 且不写。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/adapters.test.js`
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { connect } = require('../src/memory');
const datasource = require('../src/datasource');
const load = require('../src/load');
const { init, store, schema } = require('../src');
const { createHttpAdapter, pullInto } = require('../src/adapters');

// ─── 本地 HTTP stub（监听 127.0.0.1 随机端口，after() 关闭） ───────────

let server = null;
let baseUrl = '';
const hits = { pull: 0, boom: 0, notjson: 0, scalar: 0, empty: 0 };

function handler(req, res) {
  const json = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url === '/pull') {
    hits.pull += 1;
    json([{ name: 'Ada' }, { name: 'Bob' }]);
  } else if (req.url === '/boom') {
    hits.boom += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  } else if (req.url === '/notjson') {
    hits.notjson += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('<html>not json</html>');
  } else if (req.url === '/scalar') {
    hits.scalar += 1;
    json({ total: 2 }); // 对象而非数组
  } else if (req.url === '/empty') {
    hits.empty += 1;
    json([]);
  } else {
    res.writeHead(404);
    res.end();
  }
}

before(() => new Promise((resolve) => {
  server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  if (server) server.close(() => resolve());
  else resolve();
}));

// ─── A7 前半：stub → pullInto → 落主链路 → GQL 命中 ────────────────────

test('adapters/A7: stub → pullInto → 落主链路 → 既有 GQL 命中', async () => {
  schema.register({
    name: 'AdpUser', collection: 'adp_users', idPrefix: 'adp_', timestamps: false,
    fields: { name: { type: 'string' } }, relations: {},
  });
  try {
    await init(connect({ store: new Map() }));

    const adapter = createHttpAdapter({ baseUrl: `${baseUrl}/pull` });
    const out = await pullInto({ adapter, schemaName: 'AdpUser', store });

    assert.equal(out.pulled, 2);
    assert.equal(hits.pull, 1, 'stub 应被拉取一次');

    const rows = await store.query('AdpUser{ _id name }');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.name).sort(), ['Ada', 'Bob']);
    assert.equal(await store.count('AdpUser', {}), 2);
  } finally {
    datasource.setConnections({});
  }
});

// ─── A9：失败显式 Err（禁静默） ───────────────────────────────────────

test('adapters/A9: 非 2xx ⇒ HttpAdapterError（携 status/url）', async () => {
  const adapter = createHttpAdapter({ baseUrl: `${baseUrl}/boom` });
  await assert.rejects(() => adapter.fetch(), (e) => {
    assert.equal(e.name, 'HttpAdapterError');
    assert.equal(e.status, 500);
    assert.match(e.url, /\/boom$/);
    return true;
  });
});

test('adapters/A9: 响应体非 JSON ⇒ HttpAdapterError', async () => {
  const adapter = createHttpAdapter({ baseUrl: `${baseUrl}/notjson` });
  await assert.rejects(() => adapter.fetch(), (e) => e.name === 'HttpAdapterError');
});

test('adapters/A9: pick 结果非数组 ⇒ HttpAdapterError', async () => {
  const adapter = createHttpAdapter({ baseUrl: `${baseUrl}/scalar`, pick: (j) => j.total });
  await assert.rejects(() => adapter.fetch(), (e) => e.name === 'HttpAdapterError');
});

// ─── A9：成功 0 条 ⇒ pulled:0 且不写（合法结果，与失败可区分） ──────────

test('adapters/A9: 成功 0 条 ⇒ pulled:0 且不调写路径', async () => {
  const adapter = createHttpAdapter({ baseUrl: `${baseUrl}/empty` });
  let writeCalls = 0;
  const spyStore = { insertMany: async () => { writeCalls += 1; return []; } };

  const out = await pullInto({ adapter, schemaName: 'AdpEmpty', store: spyStore });
  assert.deepEqual(out, { pulled: 0, written: null });
  assert.equal(writeCalls, 0, '0 条不得调用写路径');
});

// ─── A7 后半：sources 出现 kind:"http" ⇒ 显式 Err（零代码改动） ─────────

test('adapters/A7 后半: sources.kind="http" ⇒ 显式 Err（接口不可注册为可查询源）', () => {
  const cfg = { sources: { api: { kind: 'http', databases: ['x'] } }, defs: [] };
  assert.throws(() => load.planLoad(cfg, []), /kind 非法/);
});
