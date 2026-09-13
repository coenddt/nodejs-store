'use strict';

/**
 * MySQL introspection（驱动：mysql2/promise）
 *
 * 只发 `information_schema` 只读查询（铁律 6：绝不写 DDL 回库），产出规范化行 JSON，
 * 交 core `schemaFromRows` 做纯映射。建议使用只读账号；库名取当前连接的 `DATABASE()`。
 */

const { groupIndexes } = require('./_shared');

const _TABLES = `
  SELECT table_name AS name
  FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
  ORDER BY table_name`;

const _COLUMNS = `
  SELECT table_name  AS "table",
         column_name AS name,
         column_type AS type,
         is_nullable AS nullable,
         column_key  AS columnKey
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
  ORDER BY table_name, ordinal_position`;

const _FKS = `
  SELECT table_name            AS "table",
         column_name           AS \`column\`,
         referenced_table_name AS "refTable",
         referenced_column_name AS "refColumn"
  FROM information_schema.key_column_usage
  WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL
  ORDER BY table_name, ordinal_position`;

const _INDEXES = `
  SELECT table_name  AS "table",
         index_name  AS name,
         non_unique  AS nonUnique,
         seq_in_index AS seq,
         column_name AS \`column\`
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
  ORDER BY table_name, index_name, seq_in_index`;

// MySQL 行携带 nonUnique（1=非唯一）→ 取反为 unique 标志；归并逻辑共享见 _shared.js
const _uniqueOf = (r) => (Number(r.nonUnique) ? 0 : 1);

async function introspect(driver, { database = null } = {}) {
  if (!driver || typeof driver.execute !== 'function') {
    throw new TypeError('mysql introspection 需要 mysql2/promise 的连接或连接池');
  }
  // 显式传 database（连接串不带库或跨库同步）→ 参数化 table_schema；
  // 缺省用当前连接的 DATABASE()。显式库名会作为 namespace 透出到 def。
  const schemaFilter = database != null ? 'table_schema = ?' : 'table_schema = DATABASE()';
  const params = database != null ? [database] : [];
  const tablesSql = (base) => base.replace('table_schema = DATABASE()', schemaFilter);

  const run = async (sql, args = []) => {
    const [rows] = await driver.execute(sql, args);
    return rows;
  };
  const [tables, columns, fks, indexRows] = await Promise.all([
    run(tablesSql(_TABLES), params),
    run(tablesSql(_COLUMNS), params),
    run(tablesSql(_FKS), params),
    run(tablesSql(_INDEXES), params),
  ]);

  return {
    // 显式库名 → 行携带 namespace（core schemaFromRows 会写进 def）
    tables: database != null
      ? tables.map((t) => ({ ...t, namespace: database }))
      : tables,
    columns: columns.map((c) => ({
      table: c.table,
      name: c.name,
      type: c.type || '',
      notnull: c.nullable === 'NO' ? 1 : 0,
      pk: c.columnKey === 'PRI' ? 1 : 0,
    })),
    fks,
    indexes: groupIndexes(indexRows, _uniqueOf),
  };
}

module.exports = { introspect };
