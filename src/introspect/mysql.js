'use strict';

/**
 * MySQL introspection（驱动：mysql2/promise）
 *
 * 只发 `information_schema` 只读查询（铁律 6：绝不写 DDL 回库），产出规范化行 JSON，
 * 交 core `schemaFromRows` 做纯映射。建议使用只读账号；库名取当前连接的 `DATABASE()`。
 */

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

/** 把 `{table,name,nonUnique,column}` 行按索引名归并出 columns 数组 */
function _groupIndexes(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.table}::${r.name}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { table: r.table, name: r.name, columns: [], unique: Number(r.nonUnique) ? 0 : 1 };
      byKey.set(key, entry);
    }
    entry.columns.push(r.column);
  }
  return [...byKey.values()];
}

async function introspect(driver, { _schema = null } = {}) {
  if (!driver || typeof driver.execute !== 'function') {
    throw new TypeError('mysql introspection 需要 mysql2/promise 的连接或连接池');
  }
  const run = async (sql) => {
    const [rows] = await driver.execute(sql);
    return rows;
  };
  const [tables, columns, fks, indexRows] = await Promise.all([
    run(_TABLES),
    run(_COLUMNS),
    run(_FKS),
    run(_INDEXES),
  ]);

  return {
    tables,
    columns: columns.map((c) => ({
      table: c.table,
      name: c.name,
      type: c.type || '',
      notnull: c.nullable === 'NO' ? 1 : 0,
      pk: c.columnKey === 'PRI' ? 1 : 0,
    })),
    fks,
    indexes: _groupIndexes(indexRows),
  };
}

module.exports = { introspect };
