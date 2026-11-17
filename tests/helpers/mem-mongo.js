'use strict';

/**
 * 内存 Mongo 桩（tests 共享，D4-2 去重）——guards / test-nodejs-store /
 * multi-datasource / naming-mongo / host-contract 五个测试文件原先各自内联
 * 同构的 MemCursor/MemColl 桩类，现统一为本超集版。各文件以别名解构保留原
 * 变量名（如 `const { MemColl: _MemColl } = require('./helpers/mem-mongo')`），
 * 调用点零改动。
 *
 * 零语义论证（超集版对每个原版行为等价）：
 * 1. find/aggregate 统一返回 MemCursor（原 guards 版返回 `{toArray}` 字面量）：
 *    两者 toArray 均为 async 返回 `[...this.docs]` 浅拷贝；调用方仅
 *    `await cursor.toArray()`（src 执行器对桩只走该路径，五文件测试此前全绿）。
 * 2. insertOne 统一返回 `{ insertedId: doc._id }`（原 multi-datasource 版无
 *    返回值）：该文件调用方不读返回值（全文无对 insertOne 结果的赋值/断言）。
 * 3. listIndexes 统一返回 MemCursor([])（原 guards 版返回
 *    `{ toArray: async () => [] }`）：await toArray() 均得 []。
 * 4. replaceOne/updateMany/deleteMany/findOneAndUpdate/insertMany/createIndex
 *    为超集方法：部分原版桩未实现且其测试路径从不触发（该批测试此前全绿），
 *    补齐不改变现有行为。
 * 5. 方法体逐字节取自原五版中最全的实现（test-nodejs-store 版为基），无改写。
 */

class MemCursor {
  constructor(docs) {
    this.docs = docs;
  }

  async toArray() {
    return [...this.docs];
  }
}

class MemColl {
  /** 内存版 collection：覆盖 crud 读/写路径所需全部方法（五文件桩的并集） */
  constructor(docs) {
    this.docs = docs !== undefined ? docs : [];
  }

  find() {
    return new MemCursor(this.docs);
  }

  aggregate() {
    return new MemCursor(this.docs);
  }

  async findOne() {
    return this.docs.length ? { ...this.docs[0] } : null;
  }

  async countDocuments() {
    return this.docs.length;
  }

  async insertOne(doc) {
    this.docs.push(doc);
    return { insertedId: doc._id };
  }

  async insertMany(docs) {
    this.docs.push(...docs);
    return { insertedCount: docs.length };
  }

  /** 归档幂等（insertMany + upsertById）走 replaceOne(upsert)（对齐 exec.js） */
  async replaceOne(condition, doc, options) {
    const i = this.docs.findIndex((d) => d._id === condition._id);
    if (i >= 0) {
      this.docs[i] = { ...doc };
      return { modifiedCount: 1 };
    }
    if (options && options.upsert) this.docs.push({ ...doc });
    return { modifiedCount: 0 };
  }

  async findOneAndUpdate(condition, update, options) {
    const base = this.docs.length ? { ...this.docs[0] } : {};
    for (const st of Object.values(update)) {
      if (st && typeof st === 'object') Object.assign(base, st);
    }
    if (options && options.upsert && !this.docs.length) this.docs.push(base);
    return base;
  }

  async updateMany() {
    return { modifiedCount: this.docs.length };
  }

  async deleteMany() {
    const n = this.docs.length;
    this.docs = [];
    return { deletedCount: n };
  }

  listIndexes() {
    return new MemCursor([]);
  }

  async createIndex() {}
}

module.exports = { MemCursor, MemColl };
