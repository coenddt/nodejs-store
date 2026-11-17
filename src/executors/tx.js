'use strict';

/**
 * 显式事务骨架 —— mysql / postgres 执行器共享（D4-2 去重提取）
 *
 * 两份 `openTransaction` / `withTransaction` 原先逐字重复（jscpd 三对 73 行），
 * 提取后仅方言差异（BEGIN/COMMIT/ROLLBACK 的驱动调用形态）参数化；
 * 控制流（closed 幂等守卫、rollback 失败不掩盖原始错误、finally release、
 * openAcquire 显式 checkout）零变化。sqlite 执行器为同步单连接形态
 * （无池 checkout、savepoint 走 db.exec），只复用本模块的 withTransaction 骨架。
 */

/**
 * 构造显式事务句柄（池 checkout 版）
 *
 * @param {object} spec
 * @param {string} spec.driver 执行器 kind（openAcquire 的池判别依据）
 * @param {Function} spec.execOn (conn, plan) => 中立包络（该方言的语句执行器）
 * @param {Function} spec.begin async (conn) => void（事务开启）
 * @param {Function} spec.commit async (conn) => void
 * @param {Function} spec.rollback async (conn) => void
 */
async function pooledTransaction({ driver, execOn, begin, commit, rollback }) {
  const { openAcquire } = require('./open'); // D4-1 解环：openAcquire 下沉零依赖模块
  const { conn, release } = await openAcquire(driver); // 失败直接上抛，无静默兜底
  await begin(conn);
  let closed = false;
  return {
    exec: (plan) => execOn(conn, plan),
    async savepoint(name) {
      /* 保存点（嵌套事务用）；name 由 Host 生成（sp_<n>），非用户输入。
         MySQL 预备语句协议不支持 SAVEPOINT，必须走 conn.query 文本协议（pg 同形态） */
      await conn.query(`SAVEPOINT ${name}`);
    },
    async releaseSavepoint(name) {
      await conn.query(`RELEASE SAVEPOINT ${name}`);
    },
    async rollbackToSavepoint(name) {
      await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
    },
    async commit() {
      if (closed) return;
      closed = true;
      await commit(conn);
    },
    async rollback() {
      if (closed) return;
      closed = true;
      await rollback(conn);
    },
    release,
  };
}

/**
 * 事务执行骨架：mysql / postgres / sqlite 三执行器共享（无第二套事务路径，
 * 任一失败整体回滚）。body 收到 `(execOnTx, tx)`；commit 成功才返回；
 * 异常 rollback 后原样上抛（rollback 失败不掩盖原始错误），release 幂等收尾。
 */
async function withTransaction(openTransaction, body) {
  const tx = await openTransaction();
  try {
    const out = await body(tx.exec, tx);
    await tx.commit();
    return out;
  } catch (e) {
    try {
      await tx.rollback();
    } catch (_) {
      /* rollback 失败不掩盖原始错误 */
    }
    throw e;
  } finally {
    await tx.release();
  }
}

module.exports = { pooledTransaction, withTransaction };
