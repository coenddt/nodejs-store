'use strict';

/**
 * 连接显式 checkout（mysql/pg 池 → 单连接 + 幂等 release）—— D4-1 解环提取
 *
 * 从 executors/index.js 平移至此（零行为变化）：mysql/postgres 执行器只需
 * `openAcquire` 一个纯鸭子类型函数（判 `getConnection` / `connect+totalCount`，
 * 不依赖任何驱动模块），却因此函数内 require('./index') 形成驱动↔索引加载环
 * （madge 环 7/8）。下沉为零依赖模块后驱动改指本文件；index.js re-export
 * `openAcquire`，对外导出面不变。
 */

/**
 * 显式 checkout：返回 `{ conn, release }`；`release` 为 async 幂等函数。
 *
 * 池形态（mysql2 Pool → `getConnection()` / pg Pool → `connect()` + 池统计）
 * 失败**直接上抛**，禁「静默退回 driver 本体」——退回本体可能落到池上另一连接，
 * 使事务语义错乱；单连接形态直用 driver，release 为 no-op。
 * pg / mysql 执行器的显式事务句柄均以此为基础（禁第二套 checkout 路径）。
 *
 * 判据精确性：mysql2 单连接 PromiseConnection 也有 `connect()`（且已握手时
 * `connect(cb)` 回调 `(null, this)` resolve 内层回调连接，其 `beginTransaction()`
 * 无回调返回 Query 对象——await 即抛 "not a promise"），故 pg Pool 判据必须是
 * `connect + totalCount` 双条件；`getConnection` 为 mysql2 Pool 专属，单条件即可。
 */
async function openAcquire(driver) {
  if (driver && typeof driver.getConnection === 'function') {
    const conn = await driver.getConnection(); // mysql2 Pool：失败直接上抛
    let released = false;
    return {
      conn,
      release: async () => {
        if (released) return;
        released = true;
        conn.release();
      },
    };
  }
  if (driver && typeof driver.connect === 'function'
    && typeof driver.totalCount === 'number') {
    const conn = await driver.connect(); // pg Pool：失败直接上抛
    let released = false;
    return {
      conn,
      release: async () => {
        if (released) return;
        released = true;
        // pg Client（单连接）无 totalCount → 不进本分支；池化 PoolClient 有 release()
        if (typeof conn.release === 'function') conn.release();
      },
    };
  }
  return { conn: driver, release: async () => {} }; // 单连接形态
}

module.exports = { openAcquire };
