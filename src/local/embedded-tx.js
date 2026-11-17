'use strict';

/**
 * 嵌入式载体（local / memory）的事务骨架共享 —— D4-2 去重提取
 *
 * 两载体的 `openTransaction` 均为「快照隔离」同形实现：读一份数据快照 `staged`，
 * 事务期 handle 读写 `staged`，`commit()` 才整体落盘/写回，`rollback()`/`release()`
 * 丢弃。差异仅在 staged 的来源与 commit 的落盘方式，经 `loadStaged` / `commitStaged`
 * 两个回调注入，控制流（closed 幂等守卫、txIo 缓冲、手柄复用 createDb）零变化。
 * `withTransaction` 为同一便捷包装（与 sqlite 执行器同形）。
 */

const { createDb } = require('./handle');

/**
 * 构造快照隔离开事务骨架
 *
 * @param {object} spec
 * @param {Function} spec.loadStaged () => staged 快照（local: readSnapshot；memory: bound.load()）
 * @param {Function} spec.commitStaged (staged) => void|Promise（commit 落盘：
 *        local 带目录锁写回整目录；memory 整体写回分区）
 * @param {string|null} spec.db 事务绑定的库（null = 单库）
 * @returns {{session, handle, commit, rollback, release}} 与 SQL 执行器事务句柄同形
 */
async function stagedOpenTransaction({ loadStaged, commitStaged, db }) {
  let staged = loadStaged();
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
      await commitStaged(staged);
    },
    async rollback() { closed = true; },
    async release() { closed = true; },
  };
}

/** 便捷包装：`fn(null, tx)` 成功 commit、抛错 rollback（原样上抛）、release 幂等收尾 */
async function withTransaction(openTransaction, fn) {
  const tx = await openTransaction();
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
}

module.exports = { stagedOpenTransaction, withTransaction };
