'use strict';

/**
 * 内联数组聚合（漉金Core接入扩展 步骤4）—— local 载体端到端
 *
 * 三 computes × 三文档（满 / 空数组 / 缺字段）边界矩阵：
 *   - biddersCount  = $size bidders            → 满=3 / 空=0 / 缺=0
 *   - maxBid        = $max bidders.amount      → 满=300 / 空=null / 缺=null
 *   - bidderCount   = $countDistinct bidders.bidderId（去重剔 null）→ 满=2 / 空=0 / 缺=0
 *
 * 约定（对齐 parity-local-memory 标杆）：只走真实 CRUD（init + store.insert / store.query），
 * 管道求值下沉 rust core（localEval），宿主零改动。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/inline-agg.test.js`
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect: connectLocal } = require('../src/local');
const datasource = require('../src/datasource');
const { init, store, schema: _sc } = require('../src');

const _dirs = [];

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nodejs-store-inline-agg-${tag}-`));
  _dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const DOCS = [
  // 满：3 条记录、最大 300、bidderId 去重（u1 重复）→ 3 / 300 / 2
  { _id: 'ila_1', title: 'a1', bidders: [
    { bidderId: 'u1', amount: 100 },
    { bidderId: 'u2', amount: 300 },
    { bidderId: 'u1', amount: 200 },
  ] },
  // 空数组：长度 0、max 内建 null、去重集空 → 0 / null / 0
  { _id: 'ila_2', title: 'a2', bidders: [] },
  // 缺字段：同空数组语义（$ifNull 兜底为 []）→ 0 / null / 0
  { _id: 'ila_3', title: 'a3' },
];

const GQL = 'IlAuction($sort:@s0){ _id biddersCount maxBid bidderCount }';
const PARAMS = { s0: { _id: 1 } };

test('inline-agg: local 载体三 computes × 满/空/缺 边界矩阵', async () => {
  _sc.register({
    name: 'IlAuction', collection: 'il_auctions', idPrefix: 'ila_', timestamps: false,
    fields: { title: { type: 'string' }, bidders: { type: 'array' } },
    relations: {},
    computes: {
      biddersCount: { type: 'int', depends: ['bidders'], agg: { $size: 'bidders' } },
      maxBid: { type: 'number', depends: ['bidders'], agg: { $max: 'bidders.amount' } },
      bidderCount: { type: 'int', depends: ['bidders'], agg: { $countDistinct: 'bidders.bidderId' } },
    },
  });

  const dir = tmpDir('inline');
  let rows;
  try {
    await init(connectLocal({ dir }));
    for (const d of DOCS) await store.insert('IlAuction', d);
    rows = await store.query(GQL, PARAMS);
  } finally {
    datasource.setConnections({});
  }

  assert.equal(rows.length, DOCS.length, '读回行数应一致');
  assert.deepEqual(rows[0], { _id: 'ila_1', biddersCount: 3, maxBid: 300, bidderCount: 2 });
  assert.deepEqual(rows[1], { _id: 'ila_2', biddersCount: 0, maxBid: null, bidderCount: 0 });
  assert.deepEqual(rows[2], { _id: 'ila_3', biddersCount: 0, maxBid: null, bidderCount: 0 });
});
