'use strict';

/**
 * Mongo session 用例的假驱动与注册夹具（D4-4 零语义拆分）。
 *
 * 自 tests/mongo-session.test.js 原样下沉：假 Mongo 驱动（makeRecColl / makeDb，
 * 记录 session 与事务调用）与 registerMongo 注册入口；语句与注释逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { schema: _sc } = require('../src');

// ─── 假 Mongo 驱动（能力 + session 记录） ─────────────────────

function makeRecColl(rec, name) {
  const opt = (opts) => (opts || {}).session || null;
  return {
    find(f, opts) { rec.ops.push([name, 'find', opt(opts)]); return { toArray: async () => [] }; },
    aggregate(p, opts) { rec.ops.push([name, 'aggregate', opt(opts)]); return { toArray: async () => [] }; },
    async countDocuments(f, opts) { rec.ops.push([name, 'countDocuments', opt(opts)]); return 0; },
    async findOne(f, opts) { rec.ops.push([name, 'findOne', opt(opts)]); return null; },
    async insertOne(doc, opts) { rec.ops.push([name, 'insertOne', opt(opts)]); return doc; },
    async insertMany(docs, opts) { rec.ops.push([name, 'insertMany', opt(opts)]); return { insertedCount: docs.length }; },
    async replaceOne(f, doc, opts) { rec.ops.push([name, 'replaceOne', opt(opts)]); return { modifiedCount: 1 }; },
    async findOneAndUpdate(f, u, opts) { rec.ops.push([name, 'findOneAndUpdate', opt(opts)]); return null; },
    async updateMany(f, u, opts) { rec.ops.push([name, 'updateMany', opt(opts)]); return { modifiedCount: 1 }; },
    async deleteMany(f, opts) { rec.ops.push([name, 'deleteMany', opt(opts)]); return { deletedCount: 1 }; },
  };
}

function makeDb(hello) {
  const rec = { ops: [], tx: [], sessions: [], hello: 0 };
  const client = {
    // node 原生驱动：startSession / startTransaction 为同步，commit/abort/endSession 为 async
    startSession() {
      const s = {
        startTransaction() { rec.tx.push('start'); },
        async commitTransaction() { rec.tx.push('commit'); },
        async abortTransaction() { rec.tx.push('abort'); },
        async endSession() { rec.tx.push('end'); },
      };
      rec.sessions.push(s);
      return s;
    },
    db() {
      return {
        async command() {
          rec.hello += 1;
          if (hello instanceof Error) throw hello;
          return hello;
        },
      };
    },
    _counter: () => rec.hello,
  };
  const db = {
    client,
    collection(name) { return makeRecColl(rec, name); },
  };
  return { db, rec, client };
}

function registerMongo(name, source, collection) {
  _sc.register({
    name, collection: collection || name.toLowerCase(), timestamps: false, idPrefix: 'MX',
    fields: { v: { type: 'string' } }, relations: {}, datasource: source,
  });
}

module.exports = { makeRecColl, makeDb, registerMongo };
