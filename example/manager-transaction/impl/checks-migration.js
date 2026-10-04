'use strict';

/**
 * 阶段 4：声明式迁移 e2e（T4 组）的 raw 步骤实现。
 * 与 py checks.py 的 migrate_* 一一对应；由 checks.js 合并进 CHECKS。
 * 设计见 common-store/迁移设计文档-阶段4.md：纯函数 diff/generate + 宿主执行；
 * 用例内 ALTER 后必须复原（用例可复跑）。
 */

const fs = require('node:fs');
const path = require('node:path');

const SCEN = path.resolve(__dirname, '..');
let ORDER_DEFS = null;

function orderDef() {
  if (!ORDER_DEFS) {
    ORDER_DEFS = {};
    for (const d of JSON.parse(fs.readFileSync(path.join(SCEN, 'schema.json'), 'utf8'))) {
      ORDER_DEFS[d.name] = d;
    }
  }
  return ORDER_DEFS.Order;
}

const q = (h, ident) => (h.backend === 'mysql' ? `\`${ident}\`` : `"${ident}"`);

async function execStmts(h, stmts) {
  if (h.backend === 'mongodb') return;
  if (h.backend === 'mysql' || h.backend === 'postgres') {
    for (const s of stmts) await h.driver.query(s);
    return;
  }
  for (const s of stmts) h.driver.exec(s);
}

function orderWithChannel(channelField) {
  const d = JSON.parse(JSON.stringify(orderDef()));
  d.fields.channel = channelField;
  return d;
}

/** T4-01：加列 → 存量缺失语义 / 新插入行生效 / 归档跟随；末尾 DROP COLUMN 复原 */
async function migrate_add_column(h) {
  const { ddl, store } = require('../../../src');
  const oldDef = JSON.parse(JSON.stringify(orderDef()));
  const newDef = orderWithChannel({ type: 'string' });
  const stmts = ddl.generateMigration(h.backend, oldDef, newDef);
  await execStmts(h, stmts);
  const { schema: sc } = require('../../../src');
  sc.register(newDef); // 契约同步：新列过写白名单（否则 channel 被剔除）
  try {
    const n = await store.count('Order', { channel: { $exists: false } });
    if (n !== 2) return { ok: false, note: `存量行缺失语义断言失败：$exists:false 命中 ${n}（期望 2）` };
    await store.insert('Order', { _id: 'oT4', orderNo: 'T4001', buyerId: 'u1', status: 'paid', channel: 'app' });
    const doc = await store.queryOne('Order($condition:@c){_id, channel}', { c: { _id: 'oT4' } });
    if (!doc || doc.channel !== 'app') return { ok: false, note: `新插入行 channel 断言失败: ${JSON.stringify(doc)}` };
    const r = await store.remove('Order', { _id: 'oT4' });
    if (r.archivedCount !== 1) return { ok: false, note: `归档跟随断言失败: ${JSON.stringify(r)}` };
    return { ok: true, note: `加列迁移 + 存量缺失语义 + 归档跟随通过（${h.backend}，${stmts.length} 条语句）` };
  } finally {
    await execStmts(h, [
      `ALTER TABLE ${q(h, 'orders')} DROP COLUMN ${q(h, 'channel')}`,
      `ALTER TABLE ${q(h, 'orders_deleted')} DROP COLUMN ${q(h, 'channel')}`,
    ]);
    sc.register(orderDef()); // 契约复原
  }
}

/** T4-02：加唯一索引迁移 → 重复值显式报错；末尾 DROP INDEX 复原。
 *  载体用 status unique 索引（库中尚不存在；orderNo/buyerId 已由阶段3 建表闭环落过）。 */
async function migrate_add_unique_index(h) {
  const { ddl } = require('../../../src');
  const oldDef = JSON.parse(JSON.stringify(orderDef()));
  const newDef = JSON.parse(JSON.stringify(orderDef()));
  newDef.indexes = [...(newDef.indexes || []), { keys: { status: 1 }, unique: true }];
  const stmts = ddl.generateMigration(h.backend, oldDef, newDef);
  if (stmts.length !== 1 || !stmts[0].includes('idx_orders_status')) {
    return { ok: false, note: `加索引迁移语句断言失败: ${JSON.stringify(stmts)}` };
  }
  await execStmts(h, stmts);
  try {
    const { store } = require('../../../src');
    try {
      await store.insert('Order', { _id: 'oDup', orderNo: 'B900', buyerId: 'u1', status: 'paid' });
      return { ok: false, note: 'unique 索引落库后重复 status 未报错' };
    } catch (e) {
      return { ok: true, note: `unique 索引生效（${h.backend}）: ${e.name || 'Error'}` };
    }
  } finally {
    await execStmts(h, [h.backend === 'mysql'
      ? 'DROP INDEX idx_orders_status ON `orders`'
      : `DROP INDEX ${q(h, 'idx_orders_status')}`]);
  }
}

/** T4-03：int→float 放宽（MySQL/PG 生效；SQLite 显式 MIGRATION_UNSUPPORTED） */
async function migrate_widen(h) {
  const { ddl, store } = require('../../../src');
  const invOld = {
    name: 'Inventory', collection: 'inventories', idPrefix: 'inv', timestamps: false,
    fields: {
      _id: { type: 'string' }, productId: { type: 'string' },
      warehouse: { type: 'string' }, stock: { type: 'int' },
      warnLine: { type: 'int' }, createdBy: { type: 'string' },
    },
  };
  const invNew = JSON.parse(JSON.stringify(invOld));
  invNew.fields.stock = { type: 'float' };
  if (h.backend === 'sqlite') {
    try {
      ddl.generateMigration('sqlite', invOld, invNew);
      return { ok: false, note: 'SQLite 类型变更未拒绝' };
    } catch (e) {
      if (!String(e.message || e).includes('MIGRATION_UNSUPPORTED')) {
        return { ok: false, note: `SQLite 拒绝文案缺语义码: ${e.message || e}` };
      }
      return { ok: true, note: 'SQLite 显式拒绝类型变更（MIGRATION_UNSUPPORTED）' };
    }
  }
  const stmts = ddl.generateMigration(h.backend, invOld, invNew);
  await execStmts(h, stmts);
  try {
    // 直连 SQL 插 float 行（绕过 core 契约：stock 在 schema 里仍是 int）
    const floatRow = 'VALUES (\'invT4\', \'p1\', \'w9\', 3.5, 1, \'u1\', \',_id,productId,warehouse,stock,warnLine,\')';
    const cols = h.backend === 'mysql'
      ? '(_id, `product_id`, `warehouse`, stock, `warn_line`, `created_by`, __present)'
      : '(_id, "product_id", "warehouse", stock, "warn_line", "created_by", __present)';
    const sql = `INSERT INTO inventories ${cols} ${floatRow}`;
    if (h.backend === 'mysql' || h.backend === 'postgres') await h.driver.query(sql);
    else h.driver.exec(sql);
    const rows = await store.query('Inventory($condition:@c){_id, stock}', { c: { _id: 'invT4' } });
    const val = rows.length ? rows[0].stock : undefined;
    if (val !== 3.5) return { ok: false, note: `放宽后 float 写读断言失败: ${JSON.stringify(rows)}` };
    return { ok: true, note: `int→float 放宽生效（${h.backend}）` };
  } finally {
    await execStmts(h, [`DELETE FROM ${q(h, 'inventories')} WHERE ${q(h, '_id')} = 'invT4'`]);
  }
}

/** T4-04：破坏性变更显式拒绝（纯函数，sqlite 单后端） */
async function migrate_destructive(_h) {
  const { ddl } = require('../../../src');
  const oldDef = JSON.parse(JSON.stringify(orderDef()));
  const dropped = JSON.parse(JSON.stringify(oldDef));
  delete dropped.fields.status;
  let plan = ddl.diffDefs(oldDef, dropped);
  if (!plan.errors.some((e) => e.includes('删除字段'))) {
    return { ok: false, note: `删列未被拒: ${JSON.stringify(plan.errors)}` };
  }
  const narrowed = JSON.parse(JSON.stringify(oldDef));
  narrowed.fields.status = { type: 'int' }; // string → int 跨大类
  plan = ddl.diffDefs(oldDef, narrowed);
  if (!plan.errors.some((e) => e.includes('非放宽'))) {
    return { ok: false, note: `收窄未被拒: ${JSON.stringify(plan.errors)}` };
  }
  const renamed = JSON.parse(JSON.stringify(oldDef));
  renamed.collection = 'orders_v2';
  plan = ddl.diffDefs(oldDef, renamed);
  if (!plan.errors.some((e) => e.includes('collection 改名'))) {
    return { ok: false, note: `改名未被拒: ${JSON.stringify(plan.errors)}` };
  }
  const idChanged = JSON.parse(JSON.stringify(oldDef));
  idChanged.fields._id = { type: 'int', strategy: 'autoincrement' };
  plan = ddl.diffDefs(oldDef, idChanged);
  if (!plan.errors.length) return { ok: false, note: '主键变更未被拒' };
  return { ok: true, note: `破坏性变更全部显式拒绝（${plan.errors.length} 类）` };
}

/** T4-05（sqlite 内存库）：old=null → 建表+索引+归档；注册后自增可读写 */
async function migrate_add_table(h) {
  const { ddl, schema: sc, store } = require('../../../src');
  const fresh = {
    name: 'MigOrder', collection: 'mig_orders', idPrefix: '', timestamps: false,
    read: ['admin', 'seller', 'buyer'], write: ['admin', 'seller'],
    fields: {
      _id: { type: 'int', strategy: 'autoincrement' },
      orderNo: { type: 'string' }, amount: { type: 'float' },
    },
    relations: {}, computes: {},
    indexes: [{ keys: { orderNo: 1 }, unique: true }],
  };
  const stmts = ddl.generateMigration('sqlite', null, fresh);
  if (stmts.length !== 4) return { ok: false, note: `新表语句数断言失败: ${stmts.length}` };
  await execStmts(h, stmts);
  sc.register(fresh);
  const r1 = await store.insert('MigOrder', { orderNo: 'M1', amount: 1.5 });
  if (!Number.isInteger(r1._id)) return { ok: false, note: `新表自增 _id 断言失败: ${JSON.stringify(r1)}` };
  const r2 = await store.remove('MigOrder', { orderNo: 'M1' });
  if (r2.archivedCount !== 1) return { ok: false, note: `新表归档跟随断言失败: ${JSON.stringify(r2)}` };
  return { ok: true, note: '新表迁移 + 自增 + 归档跟随通过（sqlite 内存库）' };
}

module.exports = {
  migrate_add_column,
  migrate_add_unique_index,
  migrate_widen,
  migrate_destructive,
  migrate_add_table,
};
