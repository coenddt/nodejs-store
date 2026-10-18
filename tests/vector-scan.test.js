'use strict';

/**
 * exec 03 · 步骤 8：向量检索降级扫描（§4.7）
 *
 * 覆盖：
 *   - SQLite：真实引擎，`$vectorSearch.filter` 预过滤 + TopK + 零向量跳过；
 *   - MySQL：驱动替身，`execSql` 识别向量命令 → 候选只含 `$match` → core 精确打分；
 *   - Mongo：驱动替身，原生 `$vectorSearch` 报 40324 → 降级；`metric` 只在物理命令上剥离。
 *
 * `_score` 的投影保留由 04 步骤 1 负责（本步只验降级链路：过滤、排序、条数、截断保护）。
 * 本机无 MySQL / PostgreSQL 实例，MySQL 用替身验证编排（真实库为「待核实」项）。
 * 运行：node scripts/test.js（需 LOCAL_CORE=1 + 相邻 rust-store 调试产物）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const ddl = require('../src/ddl');
const datasource = require('../src/datasource');
const { _execOn } = require('../src/crud/exec');
const vectorScan = require('../src/vector-scan');
const { init, store, executors, permission, schema } = require('../src');

const DIM = 4;
const Q = [1, 0, 0, 0];

/** 逻辑行（cosine 分数：a=1、b=0.8、c=0、archived=1、zero 跳过） */
const ROWS = [
  { _id: 'vs_a', title: 'Alpha', status: 'published', embedding: [1, 0, 0, 0] },
  { _id: 'vs_b', title: 'Beta', status: 'published', embedding: [0.8, 0.6, 0, 0] },
  { _id: 'vs_c', title: 'Gamma', status: 'published', embedding: [0, 1, 0, 0] },
  { _id: 'vs_d', title: 'Archived', status: 'archived', embedding: [1, 0, 0, 0] },
  { _id: 'vs_e', title: 'Zero', status: 'published', embedding: [0, 0, 0, 0] },
];

function register(name, collection, source) {
  schema.register({
    name,
    collection,
    idPrefix: 'vs_',
    timestamps: false,
    fields: {
      _id: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string' },
      embedding: { type: 'vector', dim: DIM, metric: 'cosine' },
    },
    relations: {},
    datasource: source,
  });
}

/** 手工 aggregate 命令（core 产出的中间形态；limit 3、cosine） */
function vectorCommand(collection, source, extraStages = []) {
  return {
    kind: 'aggregate',
    collection,
    source,
    pipeline: [
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: Q,
          numCandidates: 30,
          limit: 3,
          metric: 'cosine',
          filter: { status: 'published' },
        },
      },
      { $addFields: { _score: { $meta: 'vectorSearchScore' } } },
      ...extraStages,
    ],
  };
}

register('VsSqlDoc', 'vs_sql_docs', 'vs_sql');
register('VsMyDoc', 'vs_my_docs', 'vs_my');
register('VsMongoDoc', 'vs_mongo_docs', 'vs_mongo');

before(() => {
  permission.setContext(undefined);
});

test('vector-scan: SQLite 真实引擎 —— filter 预过滤 + TopK', async () => {
  const db = new Database(':memory:');
  db.exec(ddl.generate('sqlite', ['VsSqlDoc']));
  await init({ vs_sql: executors.createConnection('sqlite', db) });

  for (const row of ROWS) await store.insert('VsSqlDoc', row);

  const rows = await store.query('VsSqlDoc($condition:@c0){_id, title}', {
    c0: { status: 'published', embedding: { $near: { $vector: Q, $limit: 3 } } },
  });

  // 预过滤 archived 被排除；零向量行跳过；TopK=3
  assert.deepEqual(rows.map((r) => r._id), ['vs_a', 'vs_b', 'vs_c']);
});

test('vector-scan: MySQL 替身 —— execSql 只把 $match 交候选，打分交 core', async () => {
  const plans = [];
  const conn = {
    kind: 'mysql',
    exec: async (plan) => {
      plans.push(plan);
      return { docs: ROWS.filter((r) => r.status === 'published') };
    },
  };
  datasource.setConnections({ vs_my: conn });

  const out = await datasource.execSql('vs_my', conn, vectorCommand('vs_my_docs', 'vs_my'));

  assert.equal(plans.length, 1, '降级只应执行一次候选查询');
  // `SqlStmt.to_value()` 的 SQL 文本键为 `text`（`dialect/ir.rs:41-48`）
  const sql = plans[0].stmts.map((s) => s.text).join('\n');
  assert.ok(!/vectorSearch|embedding\s*<=>/i.test(sql), '候选 SQL 不得包含向量阶段');
  assert.match(sql, /status/i);

  assert.deepEqual(out.map((r) => r._id), ['vs_a', 'vs_b', 'vs_c']);

  // 原命令未被降级路径就地改写（metric 仍需供 local 求值）
  const original = vectorCommand('vs_my_docs', 'vs_my');
  assert.equal(original.pipeline[0].$vectorSearch.metric, 'cosine');
});

test('vector-scan: Mongo 替身 —— 原生报 40324 后降级，物理命令剥离 metric', async () => {
  const seen = [];
  const coll = {
    createIndex: async () => 'vector_index',
    aggregate: (pipeline) => ({
      toArray: async () => {
        seen.push(pipeline);
        if (pipeline.some((s) => s && s.$vectorSearch)) {
          const err = new Error("Unrecognized pipeline stage name: '$vectorSearch'");
          err.code = 40324;
          throw err;
        }
        return ROWS.filter((r) => r.status === 'published');
      },
    }),
  };
  const db = { collection: () => coll };
  datasource.setConnections({ vs_mongo: db });

  const out = await _execOn('vs_mongo', vectorCommand('vs_mongo_docs', 'vs_mongo'));

  assert.equal(seen.length, 2, '先原生一次，再降级候选一次');
  assert.ok(seen[0].some((s) => s.$vectorSearch), '首次必须是原生 $vectorSearch');
  assert.equal(seen[0][0].$vectorSearch.metric, undefined, '驱动不得收到内部 metric 键');
  assert.ok(!seen[1].some((s) => s.$vectorSearch), '候选阶段不得含 $vectorSearch');

  assert.deepEqual(out.map((r) => r._id), ['vs_a', 'vs_b', 'vs_c']);
});

test('vector-scan: 候选超限显式 Err（禁止静默截断）', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ _id: `x${i}`, embedding: Q }));
  await assert.rejects(
    () => vectorScan.scan(vectorCommand('vs_sql_docs', 'vs_sql'), {
      exec: async () => rows,
      maxRows: 2,
    }),
    (err) => err.code === 'vectorScanOverflow' && /禁止静默截断/.test(err.message),
  );
});
