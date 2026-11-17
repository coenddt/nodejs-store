'use strict';

/**
 * 执行作用域并发隔离用例的共用夹具（D4-4 零语义拆分）。
 *
 * 自 tests/policy-isolation.test.js 原样下沉：档位常量、rbac 判决上下文、
 * base 模型注册（IsoPost / IsoAudit）、两套 rbac 策略、策略视图派生入口、
 * n 方并发栅栏与双 emit 辅助；语句与注释逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { schema, feedback } = require('../src');

const PROFILE_STD = 'standard';
const PROFILE_AI = 'text2query';
const CTX_VIEWER = { userId: 'u1', roles: ['viewer'] };
const CTX_OTHER = { userId: 'u2', roles: ['other'] };

// ── 夹具：base 注册（域外一次性；本文件只读不放宽任何 base 策略）──

schema.register({
  name: 'IsoPost',
  collection: 'iso_posts',
  timestamps: false,
  fields: { title: { type: 'string' } },
  relations: {},
});

/** 静态读白名单 schema：用于断言 canRead 静态面不被 rbac 视图扰动 */
schema.register({
  name: 'IsoAudit',
  collection: 'iso_audits',
  timestamps: false,
  read: ['viewer'],
  fields: { title: { type: 'string' } },
  relations: {},
});

/** rbac 策略：viewer 可读 IsoPost */
const RBAC_GRANTED = {
  mode: 'enforce',
  roles: { viewer: {} },
  grants: [{ role: 'viewer', model: 'IsoPost', actions: ['read'] }],
};
/** rbac 策略：无任何授权（enforce 下该角色被拒） */
const RBAC_DENIED = { mode: 'enforce', roles: { viewer: {} }, grants: [] };

/** 从 base 派生策略视图（作用域 store.view 的构造入口） */
function viewOf(overrides) {
  return schema.core.withPolicy(overrides);
}

/** n 方栅栏：全部到达后同时放行——保证两个作用域真实重叠（并发交错，而非先后串行） */
function barrier(n) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async function wait() {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

/** worker 内双 emit 夹 barrier 等待：两次隔离事件由并发时钟对齐（A1/A5 用例共用） */
async function emitPairWithBarrier(tag, wait) {
  feedback.emit({ type: 'isolation', code: `${tag}-1`, layer: 'host' });
  await wait();
  feedback.emit({ type: 'isolation', code: `${tag}-2`, layer: 'host' });
}

module.exports = {
  PROFILE_STD, PROFILE_AI, CTX_VIEWER, CTX_OTHER, RBAC_GRANTED, RBAC_DENIED,
  viewOf, barrier, emitPairWithBarrier,
};
