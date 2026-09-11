'use strict';

/**
 * Host 同构契约测试（JS 侧）
 *
 * 依据执行文档 6.3：定义一份 Host 契约表，JS 与 Python 各实现同名语义方法，
 * 以**共享 fixture**（`rust-store/fixtures/host/*.json`）分别喂两侧 Host，
 * 断言两侧产出的结果深比较相等。
 *
 *   1. placeholders.json    → `crud.resolvePlaceholders`
 *   2. truthy.json          → `crud._truthy`
 *   3. id_pool.json         → `crud._newIdPool`
 *   4. callback_bridge.json → `schema.register` 回调桥（fn 走 core / asyncFn 留 Host）
 *
 * Python 侧对拍：`py-store/tests/test_host_contract.py`。
 * 运行：npm --prefix nodejs-store test（或 LOCAL_CORE=1 node --test tests/host-contract.test.js）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolvePlaceholders, _truthy, _newIdPool } = require('../src/crud');
const { register } = require('../src/schema');
const { setContext } = require('../src/permission');

const HOST_FIXTURES = path.join(__dirname, '..', '..', 'rust-store', 'fixtures', 'host');
const load = (name) => JSON.parse(fs.readFileSync(path.join(HOST_FIXTURES, name), 'utf8'));

// ─── 1. 占位符替换 ──────────────────────────────────────────

test('host contract: resolvePlaceholders', () => {
  const fx = load('placeholders.json');
  for (const c of fx.cases) {
    const got = resolvePlaceholders(c.command, {
      ids: c.ids !== undefined ? c.ids : null,
      steps: c.steps !== undefined ? c.steps : [],
    });
    assert.deepEqual(got, c.expected, `占位符用例不一致: ${c.name}`);
  }
});

// ─── 2. is_truthy 语义 ──────────────────────────────────────

test('host contract: _truthy', () => {
  const fx = load('truthy.json');
  for (const c of fx.cases) {
    assert.equal(_truthy(c.value), c.expected, `truthy 用例不一致: ${c.name}`);
  }
});

// ─── 3. mutation ID 池遍历 ──────────────────────────────────

test('host contract: _newIdPool', () => {
  const fx = load('id_pool.json');
  for (const s of fx.schemas) register(s);

  for (const c of fx.cases) {
    const pool = _newIdPool(c.model, c.data);
    assert.equal(pool.length, c.expectCount, `ID 池长度不一致: ${c.name}`);
    c.expectPrefixes.forEach((prefix, i) => {
      assert.ok(
        pool[i].startsWith(prefix),
        `ID 池第 ${i} 项前缀不符: ${c.name}（期望 ${prefix}，实际 ${pool[i]}）`,
      );
    });
  }
});

// ─── 4. 回调桥（fn + asyncFn） ──────────────────────────────

/** fixture 声明的桩语义：`hc_sum_ab = sum(a, b)` / `hc_tag_skus = join(items[].sku, '|')` */
const _STUBS = {
  hc_sum_ab: (doc) => (doc.a || 0) + (doc.b || 0),
  hc_tag_skus: (items) => {
    for (const it of items) it.skuTag = (it.items || []).map((s) => s.sku).join('|');
  },
};

class _MemCursor {
  constructor(docs) {
    this.docs = docs;
  }

  async toArray() {
    return [...this.docs];
  }
}

class _MemColl {
  constructor(docs) {
    this.docs = docs !== undefined ? docs : [];
  }

  find() {
    return new _MemCursor(this.docs);
  }

  aggregate() {
    return new _MemCursor(this.docs);
  }

  async findOne() {
    return this.docs.length ? { ...this.docs[0] } : null;
  }
}

class _FakeDb {
  constructor(docs) {
    this._docs = docs;
    this._colls = {};
  }

  collection(name) {
    if (!this._colls[name]) this._colls[name] = new _MemColl(name === 'hc_posts' ? this._docs : []);
    return this._colls[name];
  }
}

test('host contract: callback bridge (fn + asyncFn)', async () => {
  const fx = load('callback_bridge.json');

  // 把 fixture 的声明式 computes 替换为真实桩函数后注册
  for (const s of fx.schemas) {
    const defn = JSON.parse(JSON.stringify(s));
    for (const [key, comp] of Object.entries(defn.computes || {})) {
      const ref = comp.fnRef || key;
      if (comp.fn) comp.fn = _STUBS[ref];
      if (comp.asyncFn) comp.asyncFn = _STUBS[ref];
    }
    register(defn);
  }

  const { query, setConnections } = require('../src/crud');
  const c = fx.cases[0];
  setContext(undefined);
  setConnections(new _FakeDb(c.docs));

  const out = await query(c.gql);
  assert.deepEqual(out, c.expected, `回调桥结果不一致: ${c.name}`);
});
