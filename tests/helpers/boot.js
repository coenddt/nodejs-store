'use strict';

/**
 * 测试文件公共引导（tests 共享，D4-2 去重）。
 *
 * 1. require 样板：node --test 各测试文件原先重复手写 node:test / assert /
 *    better-sqlite3 / ../src 门面四段 require，现统一为
 *    `const { test, before, assert, Database, src: {...} } = require('./helpers/boot')`。
 *    纯解构 re-export，与原写法逐字等价，零行为差异。
 *
 * 2. bootSingleTable：单表 schema 注册 + before 钩子绑定 SQLite 内存库。
 *    原先 require-context / profile / rbac 各自手写「_sc.register(defn)（8-10 行
 *    对象字面量）+ before(init + setContext(undefined) [+ 文件特有复位])」，现收敛
 *    为本工厂；defn 与特有复位以参数传入，执行顺序（模块加载时 register、
 *    before 内 init → setContext → afterInit）与原手写逐句一致。
 */

const src = require('../../src');

/** 解构 re-export：与各测试文件原 require 写法等价 */
module.exports = {
  test: require('node:test').test,
  before: require('node:test').before,
  assert: require('node:assert/strict'),
  Database: require('better-sqlite3'),
  src,
};

/**
 * 注册单表 schema 并在 before 钩子绑定 SQLite 内存库数据源。
 *
 * @param {object} defn schema 定义（原样传给 schema.register）
 * @param {object} opts
 * @param {Function} opts.createDb 建内存库函数（原各文件 createDb）
 * @param {string} opts.srcName 数据源名（原各文件 SRC 常量值）
 * @param {Function} [opts.afterInit] before 内 setContext 之后的文件特有复位步骤
 */
function bootSingleTable(defn, opts) {
  const { createDb, srcName, afterInit } = opts;
  src.schema.register(defn);
  require('node:test').before(async () => {
    await src.init({ [srcName]: src.executors.createConnection('sqlite', createDb()) });
    src.permission.setContext(undefined);
    if (afterInit) await afterInit();
  });
}

module.exports.bootSingleTable = bootSingleTable;

/**
 * 注册内置最小 schema（CommercialLedger）：guards / test-nodejs-store 两文件的
 * 首个注册定义原先逐字段重复手写，现收敛于此（对象字面量与原两处逐字段等价）。
 * 调用方在模块加载期同步调用，注册时机与原模块级 register 一致。
 */
function registerCommercialLedger() {
  src.schema.register({
    name: 'CommercialLedger', collection: 'commercial_ledger', idPrefix: 'CL', timestamps: true,
    fields: { unit: 'string', income: 'float' }, relations: {}, read: null, write: null,
  });
}

module.exports.registerCommercialLedger = registerCommercialLedger;
