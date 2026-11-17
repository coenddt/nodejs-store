'use strict';

/**
 * triggers 用例的物理建表与 schema 注册夹具（D4-4 零语义拆分）。
 *
 * 自 tests/triggers.test.js 原样下沉：SRC_A / SRC_B 源名常量、物理表建表 createDb、
 * 六个 schema 注册块（TOrder 的 insert/update/remove 触发器契约，TAudit / TBoom /
 * TGhost / TCmdFail / TXOrder / TXAudit）；语句与注释逐字未改。require 本模块即
 * 完成注册（模块级副作用），主文件在用例之前 require，注册顺序与原文件一致。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const Database = require('better-sqlite3');

const { schema: _sc } = require('../src');

const SRC_A = 'trg_a';
const SRC_B = 'trg_b';

/** 测试用物理表（标量范式；触发目标表 tAudit 供命令式触发写） */
function createDb() {
  const db = new Database(':memory:');
  // 表名 = SQL 方言物理名（snake_case；_id/__present 保留）
  db.exec(`
    CREATE TABLE t_order (_id TEXT PRIMARY KEY, amount REAL, status TEXT, note TEXT, __present TEXT);
    CREATE TABLE t_order_deleted (_id TEXT PRIMARY KEY, amount REAL, status TEXT, note TEXT, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_audit (_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, amount REAL, __present TEXT);
    CREATE TABLE t_audit_deleted (_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, amount REAL, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_boom (_id TEXT PRIMARY KEY, __present TEXT);
    CREATE TABLE t_boom_deleted (_id TEXT PRIMARY KEY, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_ghost (_id TEXT PRIMARY KEY, __present TEXT);
    CREATE TABLE t_ghost_deleted (_id TEXT PRIMARY KEY, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_cmd_fail (_id TEXT PRIMARY KEY, amount REAL, __present TEXT);
    CREATE TABLE t_cmd_fail_deleted (_id TEXT PRIMARY KEY, amount REAL, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_x_order (_id TEXT PRIMARY KEY, amount REAL, __present TEXT);
    CREATE TABLE t_x_order_deleted (_id TEXT PRIMARY KEY, amount REAL, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_x_audit (_id TEXT PRIMARY KEY, ref TEXT, __present TEXT);
    CREATE TABLE t_x_audit_deleted (_id TEXT PRIMARY KEY, ref TEXT, deleted_at INTEGER, __present TEXT);
  `);
  return db;
}

// ─── schema 注册（模块级；triggers 契约见总纲 T 字段表） ────────

_sc.register({
  name: 'TOrder', collection: 'tOrder', idPrefix: 'o_', timestamps: false, datasource: SRC_A,
  fields: { amount: { type: 'number' }, status: { type: 'string' }, note: { type: 'string' } },
  triggers: {
    insert: [
      // A8：aud_cmd 与 aud_dup 同名 —— 同事务 (name, _id) 去重，只执行一次
      // （若不去重，第二次同 _id insertOne 主键冲突 → 整体失败）
      { name: 'aud_cmd', into: 'TAudit', op: 'insert',
        data: { _id: '{{root._id}}', kind: 'cmd', ref: '{{root._id}}', amount: '{{root.amount}}' } },
      { name: 'aud_cmd', into: 'TAudit', op: 'insert',
        data: { _id: '{{root._id}}', kind: 'cmd', ref: '{{root._id}}', amount: '{{root.amount}}' } },
      { name: 'aud_cb', fnRef: 'audRecorder', args: { ref: '{{root._id}}' } },
    ],
    update: [
      { name: 'aud_upd', onFields: ['amount'], into: 'TAudit', op: 'insert',
        data: { _id: '{{now}}', kind: 'upd', ref: '{{root._id}}', amount: '{{root.amount}}' } },
    ],
    remove: [
      // 命令式 op:"remove"：删 t_audit 中 ref = 被删文档 _id 的行
      { name: 'aud_del', into: 'TAudit', op: 'remove', condition: { ref: '{{before._id}}' } },
      // 回调式：before 占位符（被删文档删除前值）
      { name: 'del_cb', fnRef: 'delRecorder',
        args: { id: '{{before._id}}', amount: '{{before.amount}}' } },
    ],
  },
});

_sc.register({
  name: 'TAudit', collection: 'tAudit', idPrefix: 'a_', timestamps: false, datasource: SRC_A,
  fields: { kind: { type: 'string' }, ref: { type: 'string' }, amount: { type: 'number' } },
});

_sc.register({
  name: 'TBoom', collection: 'tBoom', idPrefix: 'b_', timestamps: false, datasource: SRC_A,
  fields: {},
  triggers: {
    insert: [{ name: 'boom', fnRef: 'boom' }],
    // remove 触发回调失败 → 主删除整体回滚
    remove: [{ name: 'boomDel', fnRef: 'boom' }],
  },
});

_sc.register({
  name: 'TGhost', collection: 'tGhost', idPrefix: 'g_', timestamps: false, datasource: SRC_A,
  fields: {},
  triggers: { insert: [{ name: 'ghost', fnRef: 'ghost' }] },
});

_sc.register({
  name: 'TCmdFail', collection: 'tCmdFail', idPrefix: 'cf_', timestamps: false, datasource: SRC_A,
  fields: { amount: { type: 'number' } },
  // A5：命令式触发写失败（data._id 固定字面量，与预置行冲突）
  triggers: {
    insert: [{ name: 'cf_aud', into: 'TAudit', op: 'insert',
      data: { _id: 'fixed-collision', kind: 'cf', ref: '{{root._id}}' } }],
  },
});

_sc.register({
  name: 'TXOrder', collection: 'tXOrder', idPrefix: 'x_', timestamps: false, datasource: SRC_A,
  fields: { amount: { type: 'number' } },
  // A6：跨源触发链（目标在 SRC_B）
  triggers: {
    insert: [{ name: 'x_aud', into: 'TXAudit', op: 'insert',
      data: { _id: '{{root._id}}', ref: '{{root._id}}' } }],
  },
});

_sc.register({
  name: 'TXAudit', collection: 'tXAudit', idPrefix: 'xa_', timestamps: false, datasource: SRC_B,
  fields: { ref: { type: 'string' } },
});

module.exports = { SRC_A, SRC_B, createDb };
