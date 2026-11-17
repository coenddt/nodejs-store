'use strict';

/**
 * manager-transaction 场景 harness —— 真实库逐后端执行 T1/T2/T3 组用例。
 *
 * 复刻 course-platform/impl/harness.js（同构简化：无 probes、无 fn/asyncFn 计算列），
 * 差异点：① 新增「裸 raw 步骤」`{"op":"raw","fn":...}`（调 impl/checks.js 的同名协程，
 * 自身执行操作与断言）；② 用例支持 `backends` 子集限定（T2-01 仅 SQL 三后端 / T2-02 仅 Mongo）。
 *
 * 设计约束不变：
 *   - Registry 进程级单例、同名 schema 重复注册为「更新语义」→ 单进程内串行跑 4 后端；
 *   - MongoDB 为语义基准(oracle)，SQL 后端对拍；不可达 → available=false + skipReason，绝不静默；
 *   - 本脚本只出证据，不修实现。
 *
 * 本文件只承载场景差异（内建 __workflowRun DDL / CREATE INDEX 前置 / Mongo 先清空 /
 * backends 过滤 / 裸 raw 协程），执行管线与断言骨架下沉 `example/_shared/harness-lib.js`
 * （D4-2 去重提取，零语义说明见该文件头注释）。
 */

const path = require('node:path');

const { schema: sc, ddl } = require('../../../src');
const { CHECKS } = require('./checks');
const { createHarness } = require('../../_shared/harness-lib');

/** 主场景表（归档表同名单 + `_deleted` 后缀） */
const MAIN_TABLES = [
  'users', 'products', 'inventories', 'orders', 'order_items', 'auto_orders',
];

/** 内建 schema（__workflowRun）建表语句——与业务表同一 DDL 生成器产出，零特判。
 *
 * 前置 DROP IF EXISTS：e2e 库随业务表一起可重入重建（生产启用工作流时由
 * ddl.generate(backend, ['__workflowRun']) 一次性建表，见 README「事务边界」）。
 */
function builtinDdl(kind) {
  const stmts = String(ddl.generate(kind, ['__workflowRun']))
    .split('\n\n')
    .filter((x) => x.trim());
  const table = kind === 'mysql' ? '`__workflowRun`' : '"__workflowRun"';
  return [`DROP TABLE IF EXISTS ${table}`].concat(stmts);
}

const harness = createHarness({
  root: path.resolve(__dirname, '..'),
  tables: { main: MAIN_TABLES, archive: MAIN_TABLES.map((t) => `${t}_deleted`) },
  // 独立库 mongo_store_e2e_mgrtx：与 course-platform harness（mongo_store_e2e）隔离——
  // node --test 并发跑多文件时两 harness 各自 reset/seed，同库即互踩（E11000 dup key）。
  // 库名与 py 版对照关系见各 harness 头注释；可用环境变量整串覆盖
  uris: {
    mysql: process.env.MYSQL_URI
      || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e_mgrtx?charset=utf8mb4',
    pg: process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e_mgrtx',
    mongo: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e_mgrtx',
  },
  checks: CHECKS,
  registerAll: ({ loadSchemas }) => {
    for (const defn of loadSchemas()) sc.register(defn);
  },
  // 建表 DDL 追加内建 __workflowRun 表（随业务表一起可重入重建）
  extraDdl: (kind) => builtinDdl(kind),
  postSetup: async (kind, driver, helpers) => {
    if (kind !== 'mongodb') {
      // 阶段3 建→读闭环：手工 DDL 建表后，执行引擎 ddl.generate 产的 CREATE INDEX
      // （unique 索引物理生效 → T3-02 重复键显式报错）
      const idxStmts = ddl.generate(kind)
        .split('\n\n')
        .map((x) => x.trim())
        .filter((x) => /^CREATE (UNIQUE )?INDEX/i.test(x));
      for (const st of idxStmts) {
        if (kind === 'sqlite') driver.exec(st);
        else await driver.query(st);
      }
    }
    if (kind === 'mongodb') {
      // init 的 Mongo unique 索引构建对已有重复数据会失败（E11000 仅告警）→
      // 先清空集合再 init，保证索引在空集合上构建成功
      await helpers.reset(kind, driver);
    }
  },
  filterCase: (c, kind) => !(c.backends && !c.backends.includes(kind)), // backends 子集限定
  /** 裸 raw 步骤：调 checks 同名协程（自身执行操作与断言，复用 h.result） */
  onRaw: async (h, step) => {
    const fn = CHECKS[step.fn];
    if (!fn) return { ok: false, note: `未知裸 raw 步骤 ${step.fn}` };
    return fn(h, step);
  },
});

module.exports = {
  BACKENDS: harness.BACKENDS,
  MYSQL_URI: harness.MYSQL_URI,
  PG_URI: harness.PG_URI,
  MONGO_URI: harness.MONGO_URI,
  loadCases: harness.loadCases,
  runBackend: harness.runBackend,
};
