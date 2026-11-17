'use strict';

/**
 * 原生 SQL / 原生命令 / DDL 用例的共用支撑（D4-4 零语义拆分）。
 *
 * 自 tests/raw-sql-ddl.test.js 原样下沉：非 Mongo 源桩、execMongo 打桩器、
 * Mongo 事务视图桩与其调用断言、execMongo aggregate db 桩。用例文件只保留用例块，
 * 用例名与断言逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const assert = require('node:assert/strict');

const { store, datasource, feedback, init } = require('../src');

class FakeMongo {}

// ─── ①″ executeNative（原生 Mongo 聚合逃生口，对拍 py ①″）───

const mongoExecutor = require('../src/executors/mongo');

function patchExecMongo(stub) {
  const original = mongoExecutor.execMongo;
  mongoExecutor.execMongo = stub;
  return () => { mongoExecutor.execMongo = original; };
}

// Mongo 事务视图（store.transaction 内）经 resolveConnection 返回
// `{ kind:'mongo', conn, session, tx }`：executeNative 透传 view.session 且强制覆盖用户值。
// fake client 经 hello 探测为 replica set（setName）→ 走真实 openTransaction 路径
function fakeTxMongo(captured) {
  const txSession = {
    startTransaction() {},
    async commitTransaction() {},
    async abortTransaction() {},
    async endSession() {},
  };
  const client = {
    db: () => ({ command: async () => ({ setName: 'rs0' }) }),
    startSession: () => txSession,
  };
  return {
    txSession,
    db: {
      client,
      collection: (name) => ({
        listIndexes: () => ({ toArray: async () => [] }),
        aggregate: (pipeline, opts) => {
          captured.calls.push({ name, pipeline, opts });
          return { toArray: async () => [{ n: 1 }] };
        },
      }),
    },
  };
}

/** 事务视图单次调用断言：恰好一次且 session 为事务会话（executeNative/aggregate 事务用例共用） */
function assertOneCallOnTxSession(fake, captured) {
  assert.equal(captured.calls.length, 1);
  assert.equal(captured.calls[0].opts.session, fake.txSession);
}

/** execMongo aggregate db 桩：collection(name).aggregate(pipeline, opts) 记录调用并返回 toArray rows（转发用例共用） */
function fakeAggDb(rows) {
  const calls = [];
  const db = {
    collection: (name) => ({
      aggregate: (pipeline, opts) => {
        calls.push({ name, pipeline, opts });
        return { toArray: async () => rows };
      },
    }),
  };
  return { db, calls };
}

module.exports = {
  FakeMongo,
  mongoExecutor,
  patchExecMongo,
  fakeTxMongo,
  assertOneCallOnTxSession,
  fakeAggDb,
  store,
  datasource,
  feedback,
  init,
};
