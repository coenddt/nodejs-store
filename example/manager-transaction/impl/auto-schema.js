'use strict';

/**
 * autoincrement 探针 schema 工厂 —— checks.js（AutoOrder，T3 自增组）与
 * checks-migration.js（MigOrder，T4 迁移组）共用同一定义（D4-2 去重）。
 * 独立成文件以避免 checks ↔ checks-migration 相互 require 成环
 * （既有依赖方向：checks.js 合并 checks-migration 的协程表）。
 */

/** 生成 autoincrement 探针 schema 定义（idPrefix 空 + 无时间戳 = 纯库端自增赋值） */
function autoSchema(name, collection, indexes) {
  const defn = {
    name,
    collection,
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
  if (indexes) defn.indexes = indexes;
  return defn;
}

module.exports = { autoSchema };
