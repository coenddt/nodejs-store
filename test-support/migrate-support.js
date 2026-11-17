'use strict';

/**
 * 迁移编排器测试共用支撑（D4-4 零语义拆分）。
 *
 * 自 tests/migrate.test.js 原样下沉：固定分步建议常量、内存库 → init → body 执行器、
 * applied 落点断言、版本行断言与告警 sink 骨架；用例名与断言逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors } = require('../src');

/** 固定分步建议（契约逐字；见 migrate.js _UNSUPPORTED_HINT 与执行文档 04 §4.2 ③） */
const _UNSUPPORTED_HINT = '白名单外变更请分两版走：先加新列并回填，确认切换后再于下一版删除旧列';

/** 内存库 → init → 执行 body（每用例独立库） */
async function run(body) {
  const db = new Database(':memory:');
  await init({ default: executors.createConnection('sqlite', db) });
  try {
    return await body(db);
  } finally {
    db.close();
  }
}

/** 迁移 defn 并断言 applied 落点（0→1 / version 1；⓪系列用例共用骨架），返回 migrate 结果 */
async function migrateAssertApplied(db, key, defn) {
  const r = await store.migrate({ backend: 'sqlite', source: 'default', defs: { [key]: defn }, driver: db });
  assert.deepEqual(r.applied, [{ name: key, from: 0, to: 1, version: 1 }]);
  return r;
}

/** 断言 __schemaMigration 中该 name 已记 version=1（迁移落点收尾断言，⓪系列共用） */
function assertMigrationVersion(db, name) {
  const rows = db.prepare(`SELECT version FROM __schemaMigration WHERE name = '${name}'`).all();
  assert.deepEqual(rows.map((x) => x.version), [1]);
}

/** 迁移告警用例骨架：挂 sink → run 内执行 body → 复位 sink，返回 seen 供告警断言（⓪/⓪b 共用） */
async function runWithMigrationFeedback(body) {
  const { feedback } = require('../src');
  const seen = [];
  feedback.setSink((e) => seen.push(e));
  try {
    await run(body);
  } finally {
    feedback.setSink(null);
  }
  return seen;
}

module.exports = {
  _UNSUPPORTED_HINT,
  run,
  migrateAssertApplied,
  assertMigrationVersion,
  runWithMigrationFeedback,
};
