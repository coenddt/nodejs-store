'use strict';

/**
 * 本地磁盘数据源 —— 宿主门面
 *
 * `connect({ dir })` 产出一个**连接描述符**（`kind === 'local'`），供 `init`/`setConnections`
 * 注册为数据源；命令求值一律经 `handle` → `core.localEval`（宿主只做 IO 与手柄适配）。
 *
 * 描述符契约（与执行文档 §4.1 逐字对齐）：
 *   `{ kind:'local', dir, handle, openTransaction(), withTransaction() }`
 *   - `handle`：Mongo 兼容 db（`collection(name)`），直连 IO（即时读写磁盘）；
 *   - `openTransaction()`：返回 `{ session, handle, commit, rollback, release }`
 *     （与既有 SQL 执行器事务句柄同形）；事务期 `handle` 读写**内存快照** `staged`，
 *     `commit()` 才整目录落盘，`rollback()` 丢弃 —— 快照隔离天然提供原子性。
 *   - `withTransaction(fn)`：便捷包装（与 sqlite 执行器同形）。
 *
 * 并发写经 `store.withDirLock` 串行化（**单进程**；跨进程不在 v1 保证范围，见执行文档 §8-1）。
 */

const path = require('node:path');
const { createDb } = require('./handle');
const { readSnapshot, writeCollections, withDirLock } = require('./store');

const LOCAL_KIND = 'local';

/**
 * 创建本地磁盘数据源连接（描述符）。
 * @param {{dir?: string, baseDir?: string}} options  `dir` 缺省 `.store-local`（相对 cwd）
 * @returns {{kind: string, dir: string, handle: object, openTransaction: Function, withTransaction: Function}}
 */
function connect(options = {}) {
  const dir = path.resolve(options.dir || options.baseDir || '.store-local');

  const directIo = {
    load: () => readSnapshot(dir),
    save: (changed, collections) => withDirLock(
      dir,
      () => writeCollections(dir, changed, collections),
    ),
  };

  const descriptor = {
    kind: LOCAL_KIND,
    dir,
    handle: createDb(directIo),

    /** 事务原语：快照隔离（读内存 `staged`，commit 才落盘） */
    async openTransaction() {
      let staged = readSnapshot(dir);
      let closed = false;
      const txIo = {
        load: () => staged,
        save: (_changed, collections) => { staged = collections; },
      };
      return {
        session: { snapshot: () => staged },
        handle: createDb(txIo),
        async commit() {
          if (closed) return;
          closed = true;
          const snapshot = staged;
          await withDirLock(dir, () => writeCollections(dir, Object.keys(snapshot), snapshot));
        },
        async rollback() { closed = true; },
        async release() { closed = true; },
      };
    },

    /** 便捷包装（与 sqlite 执行器 withTransaction 同形） */
    async withTransaction(fn) {
      const tx = await descriptor.openTransaction();
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

module.exports = { connect, LOCAL_KIND };