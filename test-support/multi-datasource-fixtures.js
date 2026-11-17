'use strict';

/**
 * 多数据源定位用例的 Mongo 双形态桩与全局上下文前置（D4-4 零语义拆分）。
 *
 * 自 tests/multi-datasource.test.js 原样下沉：Mongo db 实形态 FakeDb、MongoClient
 * 形态 FakeClient，以及清空 permission 上下文的 before 钩子（require 本模块即注册，
 * 主文件在用例之前 require，注册顺序与原文件一致）；语句与注释逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const boot = require('../tests/helpers/boot');
const { before, src: { permission } } = boot;
// 内存 Mongo 桩改用 tests 共享超集版（零语义论证见 helpers/mem-mongo.js 头注释）
const { MemColl } = require('../tests/helpers/mem-mongo');

/** Mongo db 实形态（collection 为函数）：固定库，无法跨库 */
class FakeDb {
  /** colls: { 集合名: docs[] } */
  constructor(colls) {
    this.colls = colls || {};
    this.accessed = [];
  }

  collection(name) {
    this.accessed.push(name);
    return new MemColl(this.colls[name]);
  }
}

/** MongoClient 形态（db 为函数且无 collection）：按 database 动态取库 */
class FakeClient {
  constructor() {
    this.dbs = Object.create(null);
    this.dbNames = [];
  }

  db(name) {
    this.dbNames.push(name);
    if (!this.dbs[name]) this.dbs[name] = new FakeDb({});
    return this.dbs[name];
  }
}

before(() => {
  permission.setContext(undefined);
});

module.exports = { FakeDb, FakeClient };
