'use strict';

/**
 * course-platform 场景 harness —— 真实库逐后端执行 A~J 组矩阵（`harness.py` 的 Node 版）。
 *
 * 设计约束（与 py 版一一对应）：
 *   - Rust core Registry 为进程级单例、同名 schema 重复注册为「更新语义」（放行），
 *     故单进程内可依次跑 4 个后端：每后端 `建表 → register → init({default}) → seed →
 *     逐步执行用例 → 断言 → teardown`（`(source,namespace,collection)` 三元组在四个后端
 *     间完全相同，同名覆盖允许；后端切换靠 `init` 换 `default` 连接）。
 *   - MongoDB 为语义基准(oracle)：先跑 mongodb 产出 oracle（每个 rows 步骤的规范化结果集），
 *     再跑 SQL 后端比对（sqlPolicy=explicit-or-parity 时允许显式 Err，静默不一致判失败）。
 *   - 不可达后端 → available=false + skipReason，绝不静默。
 *   - 本脚本只出证据，不修实现。
 *
 * 用法（由 tests/scenario-course-platform.test.js 调用）：
 *   const h = require('../../example/course-platform/impl/harness');
 *   const mongo = await h.runBackend('mongodb');
 *   const mysql = await h.runBackend('mysql', mongo.oracle);
 *
 * 本文件只承载场景差异（表集 / FNS 计算列 / PROBES 探针 / 豁免清单 / oracleOnly 步骤
 * 标记 / raw 断言协程），执行管线与断言骨架下沉 `example/_shared/harness-lib.js`
 * （D4-2 去重提取，零语义说明见该文件头注释）。
 */

const path = require('node:path');

const { schema: sc } = require('../../../src');
const { FNS } = require('./fns');
const { PROBES } = require('./probes');
const { CHECKS } = require('./checks');
const { createHarness } = require('../../_shared/harness-lib');

const harness = createHarness({
  root: path.resolve(__dirname, '..'),
  // 主场景 + 探针的 reset 表/集合（探针表无归档 DDL，不参与归档清理）
  tables: {
    main: [
      'users', 'categories', 'courses', 'lessons', 'enrollments',
      'reviews', 'study_notes', 'audit_logs',
      'probe_grades', 'probe_holders', 'probe_memos', 'probe_notes', 'probe_computes',
    ],
    archive: [
      'users_deleted', 'categories_deleted', 'courses_deleted', 'lessons_deleted',
      'enrollments_deleted', 'reviews_deleted', 'study_notes_deleted', 'audit_logs_deleted',
    ],
  },
  // 与 py 版同一批库名，保证两宿主可对照；可用环境变量整串覆盖
  uris: {
    mysql: process.env.MYSQL_URI
      || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e?charset=utf8mb4',
    pg: process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e',
    mongo: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e',
  },
  checks: CHECKS,
  /** 注册主场景 schema + 探针 schema（同名重复注册 = 更新语义，可重复调用） */
  registerAll: ({ loadSchemas, applyFns }) => {
    for (const defn of loadSchemas()) {
      applyFns(defn, FNS);
      sc.register(defn);
    }
    for (const defn of PROBES) {
      applyFns(defn, FNS);
      sc.register(defn);
    }
    // 清单化语义（设计 §11.5）：super_admin/admin 不再默认放行，
    // E-14 的三 ctx 全放行由显式豁免清单承载（判决 = 用户可见配置）
    sc.setExemptRoles(['super_admin', 'admin']);
  },
  /** stepsOut 附加标记：rows 断言且无显式期望（仅作 mongo oracle 采集点） */
  stepMeta: (step) => ({
    oracleOnly: Boolean((step.expect || {}).kind === 'rows'
      && ((step.expect || {}).rows === undefined || (step.expect || {}).rows === null)),
  }),
});

module.exports = {
  BACKENDS: harness.BACKENDS,
  MYSQL_URI: harness.MYSQL_URI,
  PG_URI: harness.PG_URI,
  MONGO_URI: harness.MONGO_URI,
  loadCases: harness.loadCases,
  runBackend: harness.runBackend,
};
