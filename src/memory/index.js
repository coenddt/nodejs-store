'use strict';

/**
 * 进程内内存数据源 —— 宿主门面
 *
 * `connect({ database, store, io })` 产出一个**连接描述符**（`kind === 'memory'`），供
 * `init`/`setConnections` 注册为数据源；命令求值一律经 `handle` → `core.localEval`
 * （与 `local` 同族：core 侧两者都归 `DataSource::Local`）。
 *
 * 描述符契约：
 *   `{ kind:'memory', database, handle, handleFor(database), openTransaction(database), withTransaction(fn, database) }`
 *   - `handle` 复用 `../local/handle` 的 `createDb`（**手柄与介质无关，禁复制**）；
 *   - **io 注入点（04 固化）**：整量 io 契约 `{ load(database), save(database, changed, collections) }`
 *     —— `load`/`save` **必须带 `database` 形参**，使同一 io 可服务多个库（消除静默串源）；
 *     缺省实现用进程内 `Map` 分键（`options.store`），`options.io` 可注入（Redis 由此接入）；
 *     io 方法抛错原样上抛（禁吞）；`save` 可为 `void|Promise`（照 `local/handle.js` 约定）；
 *   - `openTransaction(db)`：取该分区深拷贝为 `staged`，`commit()` 以 `staged` 整体替换分区，
 *     `rollback()` 丢弃（与 `local/index.js` 同形）。
 *
 * 键空间 = `database` 非空 ⇒ `<database>/<collection>`，否则 `<collection>`；
 * io 的 `database` 为空 ⇒ key 不带前缀（与载体键空间规则一致）。
 *
 * 边界（继承 `local` 既有硬边界）：单集合文档量上限 / 无索引 / **单进程语义**（跨进程不保证）。
 * 本模块**只做 IO**：禁止实现 filter / 管道 / 算子（求值全部下沉 `core.localEval`）。
 */

const { createDb } = require('../local/handle');

const MEMORY_KIND = 'memory';

/** 进程内键空间：`<database>/<collection>`（`database` 空则 `<collection>`）→ 文档数组 */
const _defStore = new Map();

/** 深拷贝（与落盘 JSON 语义一致：与调用方隔离，模拟 local 每次读盘的新对象） */
function _clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function _key(database, collection) {
  return database ? `${database}/${collection}` : collection;
}

/**
 * 默认 io：进程内 `Map` 分键（按 `<database>/<collection>` 界定分区）。
 * @returns {{load: (database: string|null) => object,
 *            save: (database: string|null, changed: string[], collections: object) => void}}
 */
function _mapIo(store) {
  return {
    load(database) {
      const prefix = database ? `${database}/` : '';
      const out = {};
      for (const [k, docs] of store) {
        if (!k.startsWith(prefix)) continue;
        const coll = k.slice(prefix.length);
        if (database && coll.includes('/')) continue; // 同前缀但不属本库分区（如 db='a' 不命中 'a/b/c'）
        out[coll] = _clone(docs);
      }
      return out;
    },
    save(database, changed, collections) {
      for (const name of Array.from(changed)) {
        store.set(_key(database, name), _clone(collections[name] ?? []));
      }
    },
  };
}

/** 把带 `database` 形参的整量 io 适配为 createDb 需要的「已绑定库的 io」（与 local/handle 同形） */
function _bindIo(io, database) {
  const db = database ?? null;
  return {
    load: () => io.load(db),
    save: (changed, collections) => io.save(db, changed, collections),
  };
}

/**
 * 创建进程内内存数据源连接（描述符）。
 * @param {{database?: string, store?: Map,
 *          io?: { load(database: string|null): object,
 *                 save(database: string|null, changed: string[], collections: object): (void|Promise<void>) }}} options
 *        `store` 为默认 io 的底层 Map；`io` 注入时优先（Redis 由此接入）
 * @returns {{kind: string, database: string|null, handle: object, handleFor: Function,
 *            openTransaction: Function, withTransaction: Function}}
 */
function connect(options = {}) {
  const io = options.io || _mapIo(options.store || _defStore);
  const database = options.database ?? null;

  const handleFor = (db) => createDb(_bindIo(io, db), db ?? null);

  const descriptor = {
    kind: MEMORY_KIND,
    database,
    handle: handleFor(database),
    handleFor,

    /** 事务原语：快照隔离（读 io 快照 `staged`，commit 才整体写回分区） */
    async openTransaction(db = database) {
      const bound = _bindIo(io, db);
      let staged = bound.load();
      let closed = false;
      const txIo = {
        load: () => staged,
        save: (_changed, collections) => { staged = collections; },
      };
      return {
        session: { snapshot: () => staged },
        handle: createDb(txIo, db ?? null),
        async commit() {
          if (closed) return;
          closed = true;
          await bound.save(Object.keys(staged), staged);
        },
        async rollback() { closed = true; },
        async release() { closed = true; },
      };
    },

    /** 便捷包装（与 sqlite / local 执行器 withTransaction 同形） */
    async withTransaction(fn, db = database) {
      const tx = await descriptor.openTransaction(db);
      try {
        const out = await fn(null, tx);
        await tx.commit();
        return out;
      } catch (e) {
        await tx.rollback();
        throw e;
      } finally {
        await tx.release();
      }
    },
  };

  return descriptor;
}

module.exports = { connect, MEMORY_KIND };
