'use strict';

/**
 * 迁移编排器（C3/A4）测试：SQLite 真库（better-sqlite3 内存库）
 *
 * 对拍 py-store/tests/test_migrate.py；执行文档 04 §4.4 四用例 + oldDefs 显式传入补充用例。
 * 运行：node --test tests/migrate.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, MetaDefError } = require('../src');
const migrateMod = require('../src/migrate');

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

function noteV1() {
  return {
    name: 'Note', collection: 'notes', idPrefix: 'n', timestamps: true,
    fields: { _id: { type: 'string' }, title: { type: 'string' } },
  };
}

test('① 加表：oldDefs=null（introspect 探测）→ applied 且版本行落库、物理表存在', async () => {
  await run(async (db) => {
    const r = await store.migrate({
      backend: 'sqlite', source: 'default', defs: { Note: noteV1() }, driver: db,
    });
    assert.deepEqual(r, {
      applied: [{ name: 'Note', from: 0, to: 1, version: 1 }],
      skipped: [],
    });
    // 物理表 + 版本表 + 版本行
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((x) => x.name);
    assert.ok(tables.includes('notes'), `物理表 notes 应存在（got ${tables}）`);
    assert.ok(tables.includes('__schemaMigration'), '版本表 __schemaMigration 应存在');
    const rows = db.prepare('SELECT tenant, env, backend, name, version, sqls FROM __schemaMigration').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].backend, 'sqlite');
    assert.equal(rows[0].name, 'Note');
    assert.equal(rows[0].version, 1);
    assert.ok(Array.isArray(JSON.parse(rows[0].sqls)) === false || rows[0].sqls.length > 0, 'sqls 应留存');
  });
});

test('② 加列 applied → 重跑同 defs skipped unchanged，物理列落库', async () => {
  await run(async (db) => {
    const v1 = noteV1();
    await store.migrate({ backend: 'sqlite', source: 'default', defs: { Note: v1 }, driver: db });
    const v2 = { ...v1, fields: { ...v1.fields, viewCount: { type: 'int' } } };
    const r2 = await store.migrate({ backend: 'sqlite', source: 'default', defs: { Note: v2 }, driver: db });
    assert.deepEqual(r2.applied, [{ name: 'Note', from: 1, to: 2, version: 2 }]);
    // 物理列（snake_case 翻译）
    const cols = db.prepare("SELECT name FROM pragma_table_info('notes')").all().map((x) => x.name);
    assert.ok(cols.includes('view_count'), `view_count 列应存在（got ${cols}）`);
    // 重跑同 defs：幂等闸 hash 相同 → skipped unchanged（不再 diff）
    const r3 = await store.migrate({ backend: 'sqlite', source: 'default', defs: { Note: v2 }, driver: db });
    assert.deepEqual(r3, { applied: [], skipped: [{ name: 'Note', reason: 'unchanged' }] });
    // 版本行不增
    const n = db.prepare('SELECT count(*) AS n FROM __schemaMigration').get().n;
    assert.equal(n, 2);
  });
});

test('③ 删字段（白名单外）：抛 MigrationUnsupported 含固定分步建议逐字', async () => {
  await run(async (db) => {
    const v1 = noteV1();
    await store.migrate({ backend: 'sqlite', source: 'default', defs: { Note: v1 }, driver: db });
    const v2 = { ...v1, fields: { _id: { type: 'string' } } }; // 删 title
    await assert.rejects(
      () => store.migrate({ backend: 'sqlite', source: 'default', defs: { Note: v2 }, driver: db }),
      (e) => {
        assert.ok(e instanceof migrateMod.MigrationUnsupported, '应为 MigrationUnsupported 实例');
        assert.ok(e instanceof MetaDefError, '应为 MetaDefError 子类');
        assert.ok(
          e.message.includes(_UNSUPPORTED_HINT),
          `消息应逐字含固定分步建议（got: ${e.message}）`,
        );
        assert.deepEqual(e.skipped, [{ name: 'Note', reason: e.skipped[0].reason }]);
        assert.ok(/删除字段/.test(e.skipped[0].reason.join('；')));
        return true;
      },
    );
    // 被拦后物理表不变、无新版本行
    const n = db.prepare('SELECT count(*) AS n FROM __schemaMigration').get().n;
    assert.equal(n, 1);
  });
});

test('④ 中途失败回滚：第二条语句失败 → 首条已回滚、无孤儿版本行', async () => {
  await run(async (db) => {
    const base = {
      name: 'Item', collection: 'items', idPrefix: 'i', timestamps: false,
      fields: { _id: { type: 'string' }, title: { type: 'string' } },
    };
    await store.migrate({ backend: 'sqlite', source: 'default', defs: { Item: base }, oldDefs: null, driver: db });
    // 预置撞名索引：v2 的 addIndex 语句（语句序在 addColumn 之后）必然失败 → 事务整体回滚
    db.exec('CREATE INDEX idx_items_title ON items(title)');
    const bump = {
      ...base,
      fields: { ...base.fields, score: { type: 'int' } },
      indexes: [{ keys: { title: 1 } }],
    };
    await assert.rejects(
      () => store.migrate({ backend: 'sqlite', source: 'default', defs: { Item: bump }, oldDefs: null, driver: db }),
      /already exists/,
    );
    // score 列未落库（首条 ALTER 已随事务回滚）
    const cols = db.prepare("SELECT name FROM pragma_table_info('items')").all().map((x) => x.name);
    assert.ok(!cols.includes('score'), `score 列应已回滚（got ${cols}）`);
    // 无孤儿版本行（仅 v1 一条）
    const rows = db.prepare('SELECT version FROM __schemaMigration ORDER BY version').all();
    assert.deepEqual(rows.map((x) => x.version), [1]);
  });
});

test('⑤ oldDefs 显式传入：跳过 introspect，from/to 取自版本行演进', async () => {
  await run(async (db) => {
    const v1 = noteV1();
    await store.migrate({ backend: 'sqlite', source: 'default', defs: { Note: v1 }, driver: db });
    const v2 = { ...v1, fields: { ...v1.fields, tag: { type: 'string' } } };
    const r = await store.migrate({
      backend: 'sqlite', source: 'default', defs: { Note: v2 }, oldDefs: { Note: v1 },
    });
    assert.deepEqual(r.applied, [{ name: 'Note', from: 1, to: 2, version: 2 }]);
    const cols = db.prepare("SELECT name FROM pragma_table_info('notes')").all().map((x) => x.name);
    assert.ok(cols.includes('tag'), `tag 列应存在（got ${cols}）`);
  });
});

test('⑥ 参数校验：oldDefs=null 且缺 driver 显式报错（不静默）', async () => {
  await run(async () => {
    await assert.rejects(
      () => store.migrate({ backend: 'sqlite', source: 'default', defs: { Note: noteV1() } }),
      (e) => /oldDefs 为 null 时需传 driver/.test(e.message),
    );
  });
});

test('D3：内省反推 number 的 datetime / bool 列不得判「非放宽变更」', async () => {
  await run(async (db) => {
    const v1 = {
      name: 'Post', collection: 'posts', idPrefix: 'p', timestamps: false,
      fields: {
        _id: { type: 'string' },
        publishedAt: { type: 'datetime' },
        active: { type: 'bool' },
      },
    };
    await store.migrate({ backend: 'sqlite', source: 'default', defs: { Post: v1 }, oldDefs: null, driver: db });
    const v2 = { ...v1, fields: { ...v1.fields, title: { type: 'string' } } };
    const r = await store.migrate({ backend: 'sqlite', source: 'default', defs: { Post: v2 }, oldDefs: null, driver: db });
    assert.deepEqual(r.applied, [{ name: 'Post', from: 1, to: 2, version: 2 }]);
    const cols = db.prepare("SELECT name FROM pragma_table_info('posts')").all().map((x) => x.name);
    assert.ok(cols.includes('title'), `title 列应存在（got ${cols}）`);
    assert.equal(cols.filter((c) => c === 'published_at').length, 1);
    assert.equal(cols.filter((c) => c === 'active').length, 1);
  });
});

function defaultTsCreatorV1() {
  return {
    name: 'Task', collection: 'tasks', idPrefix: 't',
    write: ['creator'],
    fields: { _id: { type: 'string' }, title: { type: 'string' } },
  };
}

test('D1/D2：默认 timestamps + creator 权限的内建列不得被当作「待删字段」', async () => {
  await run(async (db) => {
    const v1 = defaultTsCreatorV1();
    await store.migrate({ backend: 'sqlite', source: 'default', defs: { Task: v1 }, oldDefs: null, driver: db });
    const v2 = { ...v1, fields: { ...v1.fields, priority: { type: 'int' } } };
    const r = await store.migrate({ backend: 'sqlite', source: 'default', defs: { Task: v2 }, oldDefs: null, driver: db });
    assert.deepEqual(r.applied, [{ name: 'Task', from: 1, to: 2, version: 2 }]);
    const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((x) => x.name);
    assert.ok(cols.includes('priority'), `priority 列应存在（got ${cols}）`);
    for (const builtin of ['created_at', 'updated_at', 'created_by', '__present']) {
      assert.ok(cols.includes(builtin), `${builtin} 应保留（got ${cols}）`);
    }
    assert.equal(cols.filter((c) => c === 'created_at').length, 1);
    assert.equal(cols.filter((c) => c === 'created_by').length, 1);
    // 再迁移（同 defs 重跑）：幂等闸命中 → skipped unchanged，不产生第三次 DDL
    const r3 = await store.migrate({
      backend: 'sqlite', source: 'default', defs: { Task: v2 }, oldDefs: null, driver: db,
    });
    assert.deepEqual(r3, { applied: [], skipped: [{ name: 'Task', reason: 'unchanged' }] });
    const n = db.prepare('SELECT count(*) AS n FROM __schemaMigration').get().n;
    assert.equal(n, 2, `版本行应保持 2 条（got ${n}）`);
  });
});

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

test('⓪ 老表缺内建列（camelCase 时代）：introspect 迁移显式失败、不隐式补列、无孤儿版本行', async () => {
  await run(async (db) => {
    createLegacyTable(db);
    await assert.rejects(
      () => store.migrate({
        backend: 'sqlite', source: 'default', defs: { LegacyNote: legacyNoteDefn() }, driver: db,
      }),
      (e) => {
        assert.ok(e instanceof migrateMod.MigrationUnsupported, '应为 MigrationUnsupported 实例');
        assert.match(e.message, /缺内建列/);
        for (const col of ['__present', 'created_at', 'updated_at', 'created_by']) {
          assert.ok(e.message.includes(col), `消息应列出缺失列 ${col}（got: ${e.message}）`);
        }
        assert.ok(e.message.includes(_UNSUPPORTED_HINT), '应携带固定分步建议');
        return true;
      },
    );
    // 迁移不隐式补列：物理列保持老表原样
    const cols = db.prepare("SELECT name FROM pragma_table_info('legacy_notes')").all().map((x) => x.name);
    for (const col of ['__present', 'created_at', 'updated_at', 'created_by']) {
      assert.ok(!cols.includes(col), `不得自动补列 ${col}（got ${cols}）`);
    }
    // 无孤儿版本行
    const rows = db.prepare("SELECT name FROM __schemaMigration WHERE name = 'LegacyNote'").all();
    assert.equal(rows.length, 0, '被拦后不得写版本行');
  });
});

test('⓪ 边界：按指引补列后同一 defn 可正常迁移（检测不是永久阻断）', async () => {
  await run(async (db) => {
    createLegacyTable(db);
    db.exec('ALTER TABLE legacy_notes ADD COLUMN created_at INTEGER');
    db.exec('ALTER TABLE legacy_notes ADD COLUMN updated_at INTEGER');
    db.exec('ALTER TABLE legacy_notes ADD COLUMN created_by TEXT');
    db.exec('ALTER TABLE legacy_notes ADD COLUMN __present TEXT');
    const r = await store.migrate({
      backend: 'sqlite', source: 'default', defs: { LegacyNote: legacyNoteDefn() }, driver: db,
    });
    assert.deepEqual(r.applied, [{ name: 'LegacyNote', from: 0, to: 1, version: 1 }]);
    const rows = db.prepare("SELECT version FROM __schemaMigration WHERE name = 'LegacyNote'").all();
    assert.deepEqual(rows.map((x) => x.version), [1]);
  });
});

test('⓪b 归属键漏回填：created_by 全 NULL 时迁移显式失败（禁止静默全表不可见）', async () => {
  await run(async (db) => {
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
    await assert.rejects(
      () => store.migrate({ backend: 'sqlite', source: 'default', defs: { NullOwner: defn }, driver: db }),
      (e) => {
        assert.ok(e instanceof migrateMod.MigrationUnsupported, '应为 MigrationUnsupported 实例');
        assert.match(e.message, /归属键 created_by 存在未回填行/);
        assert.match(e.message, /不可见/);
        return true;
      },
    );
    const rows = db.prepare("SELECT name FROM __schemaMigration WHERE name = 'NullOwner'").all();
    assert.equal(rows.length, 0, '被拦后不得写版本行');
  });
});

test('D1/D2 边界：用户显式声明 createdAt / createdBy ⇒ 不剔除（不得重复 ADD COLUMN）', async () => {
  await run(async (db) => {
    const v1 = {
      name: 'Decl', collection: 'decls', idPrefix: 'd',
      timestamps: false, write: ['creator'],
      fields: {
        _id: { type: 'string' },
        createdAt: { type: 'number' },
        createdBy: { type: 'string' },
      },
    };
    await store.migrate({ backend: 'sqlite', source: 'default', defs: { Decl: v1 }, oldDefs: null, driver: db });
    const v2 = { ...v1, fields: { ...v1.fields, note: { type: 'string' } } };
    const r = await store.migrate({ backend: 'sqlite', source: 'default', defs: { Decl: v2 }, oldDefs: null, driver: db });
    assert.deepEqual(r.applied, [{ name: 'Decl', from: 1, to: 2, version: 2 }]);
    const cols = db.prepare("SELECT name FROM pragma_table_info('decls')").all().map((x) => x.name);
    assert.equal(cols.filter((c) => c === 'created_at').length, 1, `created_at 不得重复（got ${cols}）`);
    assert.equal(cols.filter((c) => c === 'created_by').length, 1, `created_by 不得重复（got ${cols}）`);
  });
});
