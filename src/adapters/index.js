'use strict';

/**
 * 适配器门面 —— 第三方接口适配器统一入口（对齐执行文档 03 §4.2）
 *
 * 职责：把「拉取 → 规范化」的结果落到主链路——**必须**经既有 CRUD
 * （`store.insertMany` → core 计划 → 宿主执行），禁绕过 core 直连驱动写库。
 * 本模块只做编排，不含任何 filter / 聚合求值（求值只在 core）。
 */

const { createHttpAdapter, HttpAdapterError } = require('./http');

/**
 * 拉取 → 落主链路：调既有 CRUD（由 core 计划决定落点），不自行写库。
 * @param {{adapter: {fetch: Function}, schemaName: string, params?: object,
 *          store: object, routeOverride?: any}} opts
 * @returns {Promise<{pulled: number, written: any}>}
 */
async function pullInto({ adapter, schemaName, params = {}, store, routeOverride = null }) {
  if (!adapter || typeof adapter.fetch !== 'function') {
    throw new TypeError('pullInto 需要 adapter.fetch');
  }
  if (typeof schemaName !== 'string' || !schemaName) {
    throw new TypeError('pullInto 需要 schemaName');
  }
  if (!store || typeof store.insertMany !== 'function') {
    throw new TypeError('pullInto 需要 store.insertMany');
  }

  const docs = await adapter.fetch(params);
  const pulled = docs.length;
  // 成功且 0 条 ⇒ 合法结果，直接返回，不调用写路径（与失败可区分）
  if (pulled === 0) {
    return { pulled: 0, written: null };
  }
  // routeOverride 缺省 null ⇒ 走 schema 绑定的主链路（links[0]）；写失败原样上抛
  const written = await store.insertMany(schemaName, docs, routeOverride);
  return { pulled, written };
}

module.exports = { createHttpAdapter, HttpAdapterError, pullInto };
