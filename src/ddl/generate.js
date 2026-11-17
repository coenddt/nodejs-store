'use strict';

/**
 * DDL 文本生成入口（D4-4 零语义拆分自 ddl.js）：后端总校验 + 逐表 CREATE TABLE
 * 与索引拼装（按表名去重，上游失守即告警）。纯函数，与拆分前逐字同语义。
 */

const { emit: _emitFeedback } = require('../feedback-core');
const schema = require('../schema');
const { BACKENDS } = require('./base');
const { createTable, indexStmts } = require('./table');

/** 生成 DDL 文本（多表以空行分隔，每表 CREATE TABLE 后跟其 CREATE INDEX）；backend ∈ mysql/postgres/sqlite
 *
 * 按表名去重：同名表只出一次 CREATE TABLE + 索引（防御 core 注册表出现重复名 ——
 * 上游失守即告警，禁静默；对齐 py_store/ddl.py 的 seen_tables 防御）。 */
function generate(backend, names) {
  if (!BACKENDS.includes(backend)) {
    throw new Error(`DDL 生成：不支持的后端 ${JSON.stringify(backend)}（支持 ${BACKENDS.join('/')}）`);
  }
  const targets = names && names.length ? Array.from(names) : schema.list();
  const blocks = [];
  const seenTables = new Set();
  const dup = [];
  for (const n of targets) {
    const defn = schema.get(n);
    const table = defn.collection || n;
    if (seenTables.has(table)) {
      dup.push(table);
      continue;
    }
    seenTables.add(table);
    blocks.push(createTable(defn, backend));
    blocks.push(...indexStmts(defn, backend));
  }
  if (dup.length) {
    _emitFeedback({
      type: 'ddl_duplicate_table',
      code: 'ddlDuplicateTable',
      layer: 'host',
      message: `DDL 生成：表 ${[...new Set(dup)].sort()} 重复注册，已去重`,
      hint: 'schema 注册表出现重复名（见 schemaDuplicateName 告警）；修复注册侧根因',
      backend,
    });
  }
  return blocks.join('\n\n');
}

module.exports = { generate };
