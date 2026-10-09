'use strict';

/**
 * 本地磁盘数据源 —— Mongo 兼容手柄（Host 侧的「驱动替身」）
 *
 * `createDb(io)` 产出一个 **Mongo 兼容 db**（`collection(name)` → 集合对象），
 * 使 local 源可**复用** `src/executors/mongo.js#execMongo` —— 命令求值一律下沉
 * `core.localEval`，本模块只做手柄适配与 IO 编排（禁在宿主编写 filter/管道/算子）。
 *
 * io 契约：`{ load(): snapshot, save(changed: string[], collections: snapshot): void|Promise }`
 *   - `load()` 取当前「整目录集合快照」`{ 集合名: [文档…] }`；
 *   - `save()` 在 core 判定有变更时回写变更集合（changed 非空才调用）。
 *
 * ★ 实况修正（对执行文档 §4.3）：`localEval` 是 `Registry` 的**实例方法**，非模块级
 *   导出；故持有单例 `new core.Registry()` 调用 `reg.localEval(...)`（见 02 账本步骤 1）。
 *
 * 写方法（insertOne / insertMany / replaceOne / findOneAndUpdate / updateMany / deleteMany）
 * —— 保证「命令 resolve 时变更已落盘」；读方法（find/aggregate/countDocuments/findOne）
 * 走同步求值（`changed` 恒空），`find`/`aggregate` 返回 `{ toArray }` 游标以匹配驱动。
 *
 * 忽略 `opts.session`：local 的事务快照已绑定在 `handle` 上（见 `src/local/index.js`）。
 */

const core = require('../core');

const _registry = new core.Registry(); // localEval 为纯函数（不读 self.core），单例复用

/** @param {{load(): object, save(changed: string[], collections: object): (void|Promise<void>)}} io */
function createDb(io) {
  return { collection: (name) => new LocalColl(io, name) };
}

function cursor(docs) {
  return { toArray: async () => docs };
}

class LocalColl {
  constructor(io, name) {
    this.io = io;
    this.name = name;
  }

  /** 单命令求值（同步）：load 快照 → core.localEval → 返回包络 { result, changed, collections } */
  _eval(cmd) {
    return _registry.localEval(this.io.load(), { collection: this.name, ...cmd });
  }

  /** 读命令：changed 恒空，直接取 result */
  _read(cmd) {
    return this._eval(cmd).result;
  }

  /** 写命令：changed 非空则回写，返回 result（await 落盘后再返回） */
  async _write(cmd) {
    const out = this._eval(cmd);
    if (out.changed && out.changed.length) await this.io.save(out.changed, out.collections);
    return out.result;
  }

  // ── 读 ────────────────────────────────────────────────────
  find(filter, opts = {}) {
    return cursor(this._read({
      kind: 'find', filter: filter ?? {}, projection: opts.projection ?? null,
    }));
  }
  findOne(filter, opts = {}) {
    return Promise.resolve(this._read({
      kind: 'findOne', filter: filter ?? {}, projection: opts.projection ?? null,
    }));
  }
  countDocuments(filter) {
    return Promise.resolve(this._read({ kind: 'countDocuments', filter: filter ?? {} }));
  }
  aggregate(pipeline, opts = {}) {
    return cursor(this._read({
      kind: 'aggregate', pipeline: Array.from(pipeline || []), options: opts ?? {},
    }));
  }
  listIndexes() {
    return cursor([]); // local v1 无索引
  }
  // eslint-disable-next-line class-methods-use-this
  async createIndex() {} // 声明即告警（由 src/index.js 发 localIndexesIgnored），此处不静默建索引

  // ── 写 ────────────────────────────────────────────────────
  insertOne(doc) {
    return this._write({ kind: 'insertOne', doc });
  }
  insertMany(docs, opts = {}) {
    return this._write({ kind: 'insertMany', docs, upsertById: !!opts.upsertById });
  }
  replaceOne(filter, doc, opts = {}) {
    // core 无独立 `replaceOne`：其语义 = 「按 _id 命中则覆盖、未命中则插入」，即
    // core `insertMany(upsertById=true)` 的单元素形态。execMongo 的
    // `insertMany(upsertById)` 逐条走 `replaceOne({_id}, doc, {upsert:true})`，
    // 归档幂等由此承接（返回值被 execMongo 忽略）。
    if (!(opts && opts.upsert)) {
      throw new Error('local replaceOne 仅支持 upsert 语义（upsertById 路径）；请勿它用');
    }
    return this._write({ kind: 'insertMany', docs: [doc], upsertById: true });
  }
  findOneAndUpdate(filter, update, opts = {}) {
    return this._write({ kind: 'findOneAndUpdate', filter, update, options: opts ?? {} });
  }
  updateMany(filter, update) {
    return this._write({ kind: 'updateMany', filter, update });
  }
  deleteMany(filter) {
    return this._write({ kind: 'deleteMany', filter });
  }
}

module.exports = { createDb };