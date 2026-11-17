'use strict';

/**
 * ddl.generate 用例（D4-4 零语义拆分）。
 *
 * 自 tests/raw-sql-ddl.test.js 原样迁出 ② 段；用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { store, datasource, feedback } = require('../test-support/raw-sql-ddl-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
});

// ─── ② ddl.generate ─────────────────────────────────────────

test('ddl 标量列 + object/array JSON 列 + __present + 归档表', () => {
  store.register({
    name: 'DdlProbe', collection: 'ddl_probes', idPrefix: 'd', timestamps: false,
    fields: {
      _id: { type: 'string' },
      title: { type: 'string' },
      nested: { type: 'object', fields: { x: { type: 'string' } } },
      tags: { type: 'array' },
    },
  });

  const sql = store.generateDdl('mysql', ['DdlProbe', 'DdlProbeDeleted']);

  assert.ok(sql.includes('CREATE TABLE `ddl_probes`'));
  assert.ok(sql.includes('CREATE TABLE `ddl_probes_deleted`'));
  assert.ok(sql.includes('`__present` VARCHAR(255)'));
  // 数据标识符按目标介质翻译（snake_case）：deletedAt → deleted_at
  assert.ok(sql.includes('`deleted_at` BIGINT'));
  assert.ok(sql.includes('PRIMARY KEY (`_id`)'));
  // object / array 建 JSON 列（同 core field_column_ref::Json）
  assert.ok(sql.includes('`nested` JSON'));
  assert.ok(sql.includes('`tags` JSON'));
});

test('ddl timestamps 且生成声明索引', () => {
  store.register({
    name: 'DdlTs', collection: 'ddl_ts', idPrefix: 't', timestamps: true,
    indexes: [{ keys: { name: 1 } }],
    fields: { _id: { type: 'string' }, name: { type: 'string' } },
  });

  const sql = store.generateDdl('postgres', ['DdlTs']);

  // 数据标识符按目标介质翻译（snake_case）：createdAt/updatedAt → created_at/updated_at
  assert.ok(sql.includes('"created_at" BIGINT'));
  assert.ok(sql.includes('"updated_at" BIGINT'));
  assert.ok(sql.includes('"__present" TEXT'));
  // schema.indexes → CREATE INDEX（阶段 3 索引落地；原「仅元数据不建索引」铁律 6
  // 子项按用户裁决放开，见 ddl.js 头注释与事务型能力增补执行文档.md 附录 D）。
  // 旧断言「不生成 INDEX」已随该裁决过期——按实现取证更新为索引形态断言。
  assert.ok(sql.includes('CREATE INDEX "idx_ddl_ts_name" ON "ddl_ts" ("name" ASC)'));
});

test('ddl 三后端类型映射', () => {
  store.register({
    name: 'DdlTypes', collection: 'ddl_types', idPrefix: 'y', timestamps: false,
    fields: {
      _id: { type: 'string' },
      s: { type: 'string' },
      i: { type: 'int' },
      f: { type: 'float' },
      ok: { type: 'bool' },
      at: { type: 'datetime' },
    },
  });

  const my = store.generateDdl('mysql', ['DdlTypes']);
  const pg = store.generateDdl('postgres', ['DdlTypes']);
  const lite = store.generateDdl('sqlite', ['DdlTypes']);

  assert.ok(my.includes('`s` VARCHAR(255)') && my.includes('`f` DOUBLE') && my.includes('`ok` TINYINT(1)'));
  assert.ok(my.includes('`at` BIGINT'));
  assert.ok(pg.includes('"s" TEXT') && pg.includes('"f" DOUBLE PRECISION') && pg.includes('"ok" BOOLEAN'));
  assert.ok(lite.includes('"s" TEXT') && lite.includes('"f" REAL') && lite.includes('"ok" INTEGER'));
  assert.ok(lite.includes('"at" INTEGER'));
});

test('ddl text 字段三后端类型映射（对齐 py_store/ddl.py）', () => {
  store.register({
    name: 'DdlText', collection: 'ddl_text', idPrefix: 'x', timestamps: false,
    fields: { _id: { type: 'string' }, payload: { type: 'text' } },
  });
  const my = store.generateDdl('mysql', ['DdlText']);
  const pg = store.generateDdl('postgres', ['DdlText']);
  const lite = store.generateDdl('sqlite', ['DdlText']);

  assert.ok(my.includes('`payload` MEDIUMTEXT'), `mysql 长文本应为 MEDIUMTEXT（got ${my}）`);
  assert.ok(pg.includes('"payload" TEXT'), pg);
  assert.ok(lite.includes('"payload" TEXT'), lite);
});

test('ddl object/array JSON 列三后端类型映射', () => {
  store.register({
    name: 'DdlJson', collection: 'ddl_json', idPrefix: 'j', timestamps: false,
    fields: {
      _id: { type: 'string' },
      obj: { type: 'object' },
      arr: { type: 'array' },
    },
  });

  const my = store.generateDdl('mysql', ['DdlJson']);
  const pg = store.generateDdl('postgres', ['DdlJson']);
  const lite = store.generateDdl('sqlite', ['DdlJson']);

  assert.ok(my.includes('`obj` JSON') && my.includes('`arr` JSON'));
  assert.ok(pg.includes('"obj" jsonb') && pg.includes('"arr" jsonb'));
  assert.ok(lite.includes('"obj" TEXT') && lite.includes('"arr" TEXT'));
});

test('ddl 未知后端抛错', () => {
  assert.throws(() => store.generateDdl('oracle', ['X']), /不支持的后端/);
});

test('ddl 未知字段类型抛错', () => {
  store.register({
    name: 'DdlBad', collection: 'ddl_bad', idPrefix: 'b', timestamps: false,
    fields: { _id: { type: 'string' }, weird: { type: 'weird' } },
  });
  assert.throws(() => store.generateDdl('mysql', ['DdlBad']), /未知/);
});

test('ddl ownerKey 自定义 + owner 行控补自定义列（三后端）', () => {
  store.register({
    name: 'DdlOwnerCustom', collection: 'ddl_owner_custom', idPrefix: 'o', timestamps: false,
    write: ['creator'], ownerKey: 'creatorId',
    fields: { _id: { type: 'string' }, title: { type: 'string' } },
  });
  const my = store.generateDdl('mysql', ['DdlOwnerCustom']);
  const pg = store.generateDdl('postgres', ['DdlOwnerCustom']);
  const lite = store.generateDdl('sqlite', ['DdlOwnerCustom']);
  assert.ok(my.includes('`creator_id` VARCHAR(255)'), my);
  assert.ok(pg.includes('"creator_id" TEXT'), pg);
  assert.ok(lite.includes('"creator_id" TEXT'), lite);
  assert.ok(!my.includes('created_by'), my);
  assert.ok(!pg.includes('created_by'), pg);
});

test('ddl ownerKey 无 owner 行控不补列', () => {
  store.register({
    name: 'DdlOwnerNoCtl', collection: 'ddl_owner_noctl', idPrefix: 'o', timestamps: false,
    ownerKey: 'creatorId', read: ['admin'],
    fields: { _id: { type: 'string' }, title: { type: 'string' } },
  });
  for (const backend of ['mysql', 'postgres', 'sqlite']) {
    const ddl = store.generateDdl(backend, ['DdlOwnerNoCtl']);
    assert.ok(!ddl.includes('creator_id'), ddl);
    assert.ok(!ddl.includes('created_by'), ddl);
  }
});

test('ddl creator 权限自动补 created_by 列（三后端）', () => {
  // A2：与 core schema/registry.rs::add_creator_field 同口径——注册期补字段声明 +
  // 建表补列，避免写入路径注入 createdBy 时 SQL 1054 Unknown column。
  store.register({
    name: 'DdlCreator', collection: 'ddl_creator', idPrefix: 'c', timestamps: false,
    write: ['creator'],
    fields: { _id: { type: 'string' }, title: { type: 'string' } },
  });

  const my = store.generateDdl('mysql', ['DdlCreator']);
  const pg = store.generateDdl('postgres', ['DdlCreator']);
  const lite = store.generateDdl('sqlite', ['DdlCreator']);

  assert.ok(my.includes('`created_by` VARCHAR(255)'), my);
  assert.ok(pg.includes('"created_by" TEXT'), pg);
  assert.ok(lite.includes('"created_by" TEXT'), lite);
});

test('ddl creator 权限已声明 createdBy 时不重复建列', () => {
  store.register({
    name: 'DdlCreatorDecl', collection: 'ddl_creator_decl', idPrefix: 'c', timestamps: false,
    read: ['creator'],
    fields: { _id: { type: 'string' }, createdBy: { type: 'string' } },
  });

  const sql = store.generateDdl('mysql', ['DdlCreatorDecl']);
  assert.equal((sql.match(/`created_by`/g) || []).length, 1, sql);
});

test('ddl __present 超限告警', () => {
  const events = [];
  feedback.setSink((e) => events.push(e));

  const fields = { _id: { type: 'string' } };
  for (let i = 0; i < 40; i += 1) {
    fields[`verylongfieldname${String(i).padStart(2, '0')}`] = { type: 'string' };
  }
  store.register({
    name: 'DdlWide', collection: 'ddl_wide', idPrefix: 'w', timestamps: false, fields,
  });

  store.generateDdl('mysql', ['DdlWide']);

  assert.ok(events.some((e) => e.code === 'ddlPresentOverflow'), JSON.stringify(events));
});
