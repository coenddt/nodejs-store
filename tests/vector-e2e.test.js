'use strict';

/**
 * exec 02 · 步骤 10：向量列真实库 e2e（总纲 A3）
 *
 * SQLite 走 better-sqlite3 真实引擎（内存库，无外部服务）：
 *   ddl.generate('sqlite') 建主表 + 归档表 → store.insert 写入 1024 维 → store.query 读回数组。
 * PG / MySQL 本机无实例，只断言 DDL 列类型（A2）；真实库读写为「待核实」项。
 *
 * 运行：node scripts/test.js（需 LOCAL_CORE=1 + 相邻 rust-store 调试产物）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const ddl = require('../src/ddl');
const { init, store, executors, permission, schema } = require('../src');

const SRC = 'sqlite_vec_e2e';
const DIM = 1024;

schema.register({
  name: 'VecDoc',
  collection: 'vec_docs',
  idPrefix: 'vd_',
  timestamps: false,
  fields: {
    _id: { type: 'string' },
    title: { type: 'string' },
    embedding: { type: 'vector', dim: DIM, metric: 'cosine' },
  },
  relations: {},
  datasource: SRC,
});

before(() => {
  permission.setContext(undefined);
});

test('vector e2e: SQLite 建表为 TEXT，1024 维写入后读回数组', async () => {
  const sqliteDdl = ddl.generate('sqlite', ['VecDoc', 'VecDocDeleted']);
  assert.match(sqliteDdl, /"embedding" TEXT/);

  const db = new Database(':memory:');
  db.exec(sqliteDdl);
  await init({ [SRC]: executors.createConnection('sqlite', db) });

  const vec = Array.from({ length: DIM }, (_, i) => i / DIM);
  const doc = await store.insert('VecDoc', { title: 'v', embedding: vec });
  assert.ok(doc && typeof doc._id === 'string' && doc._id.startsWith('vd_'));

  const rows = await store.query('VecDoc{_id, title, embedding}');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._id, doc._id);
  assert.equal(Array.isArray(rows[0].embedding), true, '读回必须是数组');
  assert.equal(rows[0].embedding.length, DIM);
  assert.equal(rows[0].embedding[0], 0);
  assert.equal(rows[0].embedding[DIM - 1], (DIM - 1) / DIM);
});

test('vector e2e: PG / MySQL 列类型', () => {
  assert.match(ddl.generate('postgres', ['VecDoc']), /"embedding" vector\(1024\)/);
  assert.match(ddl.generate('mysql', ['VecDoc']), /`embedding` JSON/);
});
