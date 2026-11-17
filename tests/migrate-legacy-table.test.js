'use strict';

/**
 * 迁移编排器 · 老表补列 / 补建归档表分册（D4-4 零语义拆分）。
 *
 * 自 tests/migrate.test.js 原样迁出 ⓪ 系列：老表缺内建列自动补列 + 可定位告警、
 * 按指引补列后可正常迁移、归属键 NULL 告警、归档表补建 / 补列后 remove 可用；
 * 共用骨架见 ../test-support/migrate-support.js；用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { store, schema: _sc } = require('../src');
const {
  run, migrateAssertApplied, assertMigrationVersion, runWithMigrationFeedback,
} = require('../test-support/migrate-support');

function legacyNoteDefn() {
  // camelCase 时代的表：默认 timestamps + read/write creator（隐含 created_by），
  // 但物理列只有 _id/title/status/createdAt/updatedAt，没有 __present / created_at 等。
  return {
    name: 'LegacyNote', collection: 'legacy_notes', idPrefix: 'ln',
    read: ['creator'], write: ['creator'],
    fields: {
      _id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' },
    },
  };
}

function createLegacyTable(db) {
  db.exec(`CREATE TABLE legacy_notes (
    _id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  )`);
}

test('⓪ 老表缺内建列：迁移先自动补列再继续，并发出可定位告警', async () => {
  const seen = await runWithMigrationFeedback(async (db) => {
    createLegacyTable(db);
    await migrateAssertApplied(db, 'LegacyNote', legacyNoteDefn());
    const cols = db.prepare("SELECT name FROM pragma_table_info('legacy_notes')").all().map((x) => x.name);
    for (const col of ['__present', 'created_at', 'updated_at', 'created_by']) {
      assert.ok(cols.includes(col), `应自动补列 ${col}（got ${cols}）`);
    }
    assertMigrationVersion(db, 'LegacyNote');
  });
  const hit = seen.filter((e) => e.code === 'migrationAutoAddBuiltinColumns');
  assert.ok(hit.length, `必须发出自动补列告警（got ${JSON.stringify(seen)}）`);
  assert.match(hit[0].message, /legacy_notes/);
  for (const col of ['__present', 'created_at', 'updated_at', 'created_by']) {
    assert.ok(hit[0].message.includes(col), `告警应列出 ${col}（got: ${hit[0].message}）`);
  }
});

test('⓪ 边界：按指引补列后同一 defn 可正常迁移（检测不是永久阻断）', async () => {
  await run(async (db) => {
    createLegacyTable(db);
    db.exec('ALTER TABLE legacy_notes ADD COLUMN created_at INTEGER');
    db.exec('ALTER TABLE legacy_notes ADD COLUMN updated_at INTEGER');
    db.exec('ALTER TABLE legacy_notes ADD COLUMN created_by TEXT');
    db.exec('ALTER TABLE legacy_notes ADD COLUMN __present TEXT');
    const r = await migrateAssertApplied(db, 'LegacyNote', legacyNoteDefn());
    // 用例关注点：补列后仍是「同一 defn」被 applied（检测不是永久阻断，也无改名副作用）
    assert.equal(r.applied[0].name, 'LegacyNote', '补列后应 applied 同一 defn');
    assertMigrationVersion(db, 'LegacyNote');
  });
});

test('⓪b 归属键漏回填：created_by 全 NULL 时迁移继续，但必须告警', async () => {
  const seen = await runWithMigrationFeedback(async (db) => {
    db.exec(`CREATE TABLE null_owner (
      _id TEXT PRIMARY KEY, title TEXT,
      created_at INTEGER, updated_at INTEGER, created_by TEXT, __present TEXT
    )`);
    db.prepare('INSERT INTO null_owner (_id, title, created_by) VALUES (?, ?, ?)').run('no_1', 'a', null);
    const defn = {
      name: 'NullOwner', collection: 'null_owner', idPrefix: 'no',
      read: ['creator'], write: ['creator'],
      fields: { _id: { type: 'string' }, title: { type: 'string' } },
    };
    await migrateAssertApplied(db, 'NullOwner', defn);
    assertMigrationVersion(db, 'NullOwner');
  });
  const hit = seen.filter((e) => e.code === 'migrationOwnerKeyNullRows');
  assert.ok(hit.length, `必须发出归属键 NULL 告警（got ${JSON.stringify(seen)}）`);
  assert.match(hit[0].message, /null_owner/);
  assert.match(hit[0].message, /created_by/);
});

test('⓪c 老表已存在但归档表缺失：迁移补建 <table>_deleted，remove 可用', async () => {
  await run(async (db) => {
    db.exec(`CREATE TABLE arch_notes (
      _id TEXT PRIMARY KEY, title TEXT,
      created_at INTEGER, updated_at INTEGER, created_by TEXT, __present TEXT
    )`);
    db.prepare('INSERT INTO arch_notes (_id, title, created_at, updated_at, created_by, __present) '
      + 'VALUES (?, ?, ?, ?, ?, ?)')
      .run('an_1', '待删', Date.now(), Date.now(), 'u1', ',_id,title,');
    const defn = {
      name: 'ArchNote', collection: 'arch_notes', idPrefix: 'an', write: ['creator'],
      fields: { _id: { type: 'string' }, title: { type: 'string' } },
    };
    _sc.register(defn);
    await migrateAssertApplied(db, 'ArchNote', defn);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((x) => x.name);
    assert.ok(tables.includes('arch_notes_deleted'), `归档表应补建（got ${tables}）`);
    // 归档表可用：remove 物理删除主表行并写入归档表
    const rd = await store.remove('ArchNote', { _id: 'an_1' });
    assert.deepEqual(rd, { deletedCount: 1, archivedCount: 1 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM arch_notes').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM arch_notes_deleted').get().n, 1);
  });
});

test('⓪d 存量归档表缺 timestamps 列（旧版 DDL 建出）：迁移补列后 remove 可用', async () => {
  await run(async (db) => {
    db.exec(`CREATE TABLE legacy_arch (
      _id TEXT PRIMARY KEY, title TEXT,
      created_at INTEGER, updated_at INTEGER, created_by TEXT, __present TEXT
    )`);
    // 旧版 archiveDefnOf 固定 timestamps:false → 归档表无 created_at / updated_at
    db.exec(`CREATE TABLE legacy_arch_deleted (
      _id TEXT PRIMARY KEY, title TEXT, created_by TEXT, __present TEXT, deleted_at INTEGER
    )`);
    db.prepare('INSERT INTO legacy_arch (_id, title, created_at, updated_at, created_by, __present) '
      + 'VALUES (?, ?, ?, ?, ?, ?)')
      .run('la_1', '待删', Date.now(), Date.now(), 'u1', ',_id,title,');
    const defn = {
      name: 'LegacyArch', collection: 'legacy_arch', idPrefix: 'la', write: ['creator'],
      fields: { _id: { type: 'string' }, title: { type: 'string' } },
    };
    _sc.register(defn);
    await migrateAssertApplied(db, 'LegacyArch', defn);
    const cols = db.prepare("SELECT name FROM pragma_table_info('legacy_arch_deleted')").all()
      .map((x) => x.name);
    for (const col of ['created_at', 'updated_at', 'created_by', '__present']) {
      assert.ok(cols.includes(col), `归档表应补齐 ${col}（got ${cols}）`);
    }
    const rd = await store.remove('LegacyArch', { _id: 'la_1' });
    assert.deepEqual(rd, { deletedCount: 1, archivedCount: 1 });
  });
});
