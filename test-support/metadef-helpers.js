'use strict';

/**
 * metadef 用例的内存 SQLite 骨架（D4-4 零语义拆分）。
 *
 * 自 tests/metadef.test.js 原样下沉：内建表自然键分隔符 `_US`、`__schemaDef` 骨架
 * run、`__workflowDef` 骨架 runWf、最小合法 workflow defn 工厂 wfDefn；语句与注释
 * 逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const Database = require('better-sqlite3');

const { init, store, executors, ddl } = require('../src');

const _US = '\u001f';

/** 建内存库 + 建内建 `__schemaDef` 表 → init → 执行 body（每个用例独立库） */
async function run(body) {
  const db = new Database(':memory:');
  db.exec(String(ddl.generate('sqlite', ['__schemaDef'])));
  await init({ default: executors.createConnection('sqlite', db) });
  try {
    return await body();
  } finally {
    db.close();
  }
}

/** 建内存库 + 建内建 `__workflowDef` 表 → init → 执行 body（workflow 定义用） */
async function runWf(body) {
  const db = new Database(':memory:');
  db.exec(String(ddl.generate('sqlite', ['__workflowDef'])));
  await init({ default: executors.createConnection('sqlite', db) });
  // B1 前置：wfDefn 默认 gql `Item(){ _id }` 引用 Item，注册期可规划性校验要求其已注册。
  store.register({
    name: 'Item', collection: 'items', idPrefix: 'it',
    fields: { _id: { type: 'string' }, title: { type: 'string' } },
  });
  try {
    return await body();
  } finally {
    db.close();
  }
}

/** 最小合法 workflow defn（注册期白名单通过；gql 内容不参与注册期校验） */
function wfDefn(name, gql = 'Item(){ _id }') {
  return { name, steps: [{ op: 'query', as: 'a', gql }] };
}

module.exports = { _US, run, runWf, wfDefn };
