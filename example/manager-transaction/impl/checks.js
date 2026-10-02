'use strict';

/**
 * manager-transaction 场景 raw 断言 / 裸步骤实现（键 = cases 里 `{"op":"raw","fn":...}` 的 fn）。
 * 与 py-store/example/manager-transaction/impl/checks.py 一一对应。
 */

let lastAutoId = null;

function autoDef() {
  return {
    name: 'AutoOrder',
    collection: 'auto_orders',
    idPrefix: '',
    timestamps: false,
    read: ['admin', 'seller', 'buyer'],
    write: ['admin', 'seller'],
    fields: {
      _id: { type: 'int', strategy: 'autoincrement' },
      orderNo: { type: 'string' },
      amount: { type: 'float' },
    },
    relations: {},
    computes: {},
  };
}

/** 注册 autoincrement 探针 schema（nodejs 同名重复注册 = 更新语义，天然幂等） */
async function register_auto_schema(_h) {
  const { schema: sc } = require('../../../src');
  try {
    sc.register(autoDef());
    return { ok: true, note: 'AutoOrder 已注册' };
  } catch (e) {
    return { ok: false, note: `AutoOrder 注册失败: ${e.message || e}` };
  }
}

/** insert（无 _id）后：返回 _id 必须是 number（数据库自增列赋值） */
async function check_autoincrement_started(h) {
  lastAutoId = null;
  const r = h.result;
  if (!r || typeof r !== 'object') return { ok: false, note: `insert 返回非对象: ${JSON.stringify(r)}` };
  const val = r._id;
  if (!Number.isInteger(val)) {
    return { ok: false, note: `_id 非 int（目标态=数据库自增赋值）: ${JSON.stringify(val)}` };
  }
  lastAutoId = val;
  return { ok: true, note: `首个自增 _id=${val}` };
}

/** 第二次 insert 后：_id 为 int 且严格大于上一次（连续自增） */
async function check_autoincrement_increments(h) {
  const r = h.result;
  if (!r || typeof r !== 'object') return { ok: false, note: `insert 返回非对象: ${JSON.stringify(r)}` };
  const val = r._id;
  if (!Number.isInteger(val)) return { ok: false, note: `_id 非 int: ${JSON.stringify(val)}` };
  if (lastAutoId === null) return { ok: false, note: '未先执行 check_autoincrement_started' };
  if (val <= lastAutoId) return { ok: false, note: `_id 未递增: 上次 ${lastAutoId}，本次 ${val}` };
  lastAutoId = val;
  return { ok: true, note: `自增连续: 递增至 ${val}` };
}

/** ddl.generate 必须为 schema.indexes 产出 CREATE [UNIQUE] INDEX（Mongo 后端要求三方言全过） */
async function check_ddl_create_index(h) {
  const { ddl } = require('../../../src');
  const backends = h.backend === 'mongodb' ? ['mysql', 'postgres', 'sqlite'] : [h.backend];
  const bad = [];
  for (const bk of backends) {
    // nodejs ddl.generate 返回多表拼接文本（'\n\n' 分隔），切分为语句数组
    const sqls = String(ddl.generate(bk, ['Order'])).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const hits = sqls.filter((s) => /CREATE (UNIQUE )?INDEX/i.test(s));
    if (!hits.length) {
      bad.push(`${bk}: 0 条 CREATE INDEX（共 ${sqls.length} 条语句）`);
    } else if (h.backend !== 'mongodb' && !hits.join(' ').toLowerCase().includes('orders')) {
      bad.push(`${bk}: CREATE INDEX 未落在 orders 表: ${hits}`);
    }
  }
  if (bad.length) return { ok: false, note: bad.join('；') };
  return { ok: true, note: `${backends} 方言均产出 CREATE INDEX` };
}

const CHECKS = {
  register_auto_schema,
  check_autoincrement_started,
  check_autoincrement_increments,
  check_ddl_create_index,
};

Object.assign(CHECKS, require('./checks-migration'));

module.exports = { CHECKS };
