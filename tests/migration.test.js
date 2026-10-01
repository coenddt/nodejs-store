'use strict';

/**
 * 声明式 schema 迁移单测（阶段 4）：diff 白名单 / 破坏性拒绝 / per-dialect 生成 / 双宿主 parity。
 * parity 锚：py-store/tests/test_migration.py 用同一组输入断言相同输出（逐字节一致）。
 * 运行：node --test tests/migration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ddl, schema } = require('../src');

const OLD = {
  name: 'Order', collection: 'orders', idPrefix: 'o', timestamps: false,
  fields: { _id: { type: 'string' }, orderNo: { type: 'string' }, amount: { type: 'int' } },
  indexes: [{ keys: { orderNo: 1 }, unique: true }],
};
const NEW = {
  name: 'Order', collection: 'orders', idPrefix: 'o', timestamps: false,
  fields: {
    _id: { type: 'string' }, orderNo: { type: 'string' }, amount: { type: 'float' },
    channel: { type: 'string', default: 'web' }, count: { type: 'int' },
  },
  indexes: [{ keys: { orderNo: 1 }, unique: true }, { keys: { channel: 1 } }],
};

test('diff：白名单变更检出，恒等不上报', () => {
  const plan = ddl.diffDefs(OLD, NEW);
  const ops = plan.changes.map((c) => [c.op, c.name]);
  assert.deepEqual(plan.errors, []);
  assert.ok(ops.some(([o, n]) => o === 'addColumn' && n === 'channel'));
  assert.ok(ops.some(([o, n]) => o === 'addColumn' && n === 'count'));
  assert.ok(ops.some(([o, n]) => o === 'widenColumn' && n === 'amount'));
  assert.ok(ops.some(([o]) => o === 'addIndex'));
  assert.ok(!ops.some(([o, n]) => o === 'addColumn' && (n === '_id' || n === 'orderNo')));
});

test('diff：破坏性变更一律记入 errors', () => {
  const dropped = {
    name: 'Order', collection: 'orders', idPrefix: 'o',
    fields: { _id: { type: 'string' }, orderNo: { type: 'string' } },
  };
  let plan = ddl.diffDefs(OLD, dropped);
  assert.deepEqual(plan.changes, []);
  assert.ok(plan.errors.some((e) => e.includes('删除字段')));

  const narrowed = {
    name: 'Order', collection: 'orders', idPrefix: 'o',
    fields: { _id: { type: 'string' }, orderNo: { type: 'string' }, amount: { type: 'int' } },
  };
  plan = ddl.diffDefs(NEW, narrowed); // float → int 收窄
  assert.deepEqual(plan.changes, []);
  assert.ok(plan.errors.some((e) => e.includes('非放宽')));

  plan = ddl.diffDefs(OLD, { ...NEW, collection: 'orders_v2' });
  assert.ok(plan.errors.some((e) => e.includes('collection 改名')));

  const idChanged = {
    name: 'Order', collection: 'orders', idPrefix: '',
    fields: {
      _id: { type: 'int', strategy: 'autoincrement' },
      orderNo: { type: 'string' }, amount: { type: 'int' },
    },
    indexes: OLD.indexes,
  };
  plan = ddl.diffDefs(OLD, idChanged);
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.errors.length, 2); // 类型 + 策略
});

test('generate：加列含 default，归档表跟随', () => {
  const onlyAdd = {
    name: 'Order', collection: 'orders', idPrefix: 'o',
    fields: { ...OLD.fields, channel: { type: 'string', default: 'web' } },
    indexes: OLD.indexes,
  };
  assert.deepEqual(ddl.generateMigration('sqlite', OLD, onlyAdd), [
    'ALTER TABLE "orders" ADD COLUMN "channel" TEXT DEFAULT \'web\'',
    'ALTER TABLE "orders_deleted" ADD COLUMN "channel" TEXT DEFAULT \'web\'',
  ]);
});

test('generate：类型放宽 per-dialect；SQLite 显式拒绝', () => {
  const onlyWiden = {
    name: 'Order', collection: 'orders', idPrefix: 'o',
    fields: { ...OLD.fields, amount: { type: 'float' } },
    indexes: OLD.indexes,
  };
  assert.deepEqual(ddl.generateMigration('mysql', OLD, onlyWiden), [
    'ALTER TABLE `orders` MODIFY COLUMN `amount` DOUBLE',
  ]);
  assert.deepEqual(ddl.generateMigration('postgres', OLD, onlyWiden), [
    'ALTER TABLE "orders" ALTER COLUMN "amount" TYPE DOUBLE PRECISION '
    + 'USING "amount"::DOUBLE PRECISION',
  ]);
  assert.throws(() => ddl.generateMigration('sqlite', OLD, onlyWiden), /MIGRATION_UNSUPPORTED/);
});

test('generate：新表含归档派生，归档剔除自增策略', () => {
  const fresh = {
    name: 'Mig', collection: 'mig_t', idPrefix: 'm', timestamps: false,
    fields: { _id: { type: 'int', strategy: 'autoincrement' }, n: { type: 'string' } },
    relations: {}, computes: {},
    indexes: [{ keys: { n: 1 }, unique: true }],
  };
  const stmts = ddl.generateMigration('sqlite', null, fresh);
  assert.equal(stmts.length, 4); // 主表 + 主索引 + 归档表 + 归档索引
  assert.ok(stmts[0].includes('CREATE TABLE "mig_t" ('));
  assert.ok(stmts[0].includes('INTEGER PRIMARY KEY AUTOINCREMENT'));
  assert.ok(stmts[1].includes('CREATE UNIQUE INDEX "idx_mig_t_n" ON "mig_t"'));
  assert.ok(stmts[2].includes('CREATE TABLE "mig_t_deleted" ('));
  assert.ok(!stmts[2].includes('AUTOINCREMENT'));
});

test('generate：非法后端显式报错', () => {
  assert.throws(() => ddl.generateMigration('mongodb', OLD, NEW), /不支持的后端/);
});

test('parity 锚：与 py-store/tests/test_migration.py 同输入逐字节一致', () => {
  assert.throws(() => ddl.generateMigration('sqlite', OLD, NEW), /MIGRATION_UNSUPPORTED/);
  assert.deepEqual(ddl.generateMigration('mysql', OLD, NEW), [
    "ALTER TABLE `orders` ADD COLUMN `channel` VARCHAR(255) DEFAULT 'web'",
    "ALTER TABLE `orders_deleted` ADD COLUMN `channel` VARCHAR(255) DEFAULT 'web'",
    'ALTER TABLE `orders` ADD COLUMN `count` INT',
    'ALTER TABLE `orders_deleted` ADD COLUMN `count` INT',
    'ALTER TABLE `orders` MODIFY COLUMN `amount` DOUBLE',
    'CREATE INDEX `idx_orders_channel` ON `orders` (`channel` ASC)',
  ]);
});

test('generate 与 register 链路可用（冒烟）', () => {
  schema.register(NEW);
  const sqls = ddl.generateMigration('mysql', OLD, NEW);
  assert.ok(sqls.every((s) => typeof s === 'string' && s.length > 0));
});
