'use strict';

/**
 * PostgreSQL introspection（驱动：pg）
 *
 * 只发 `information_schema` / `pg_catalog` 只读查询（铁律 6：绝不写 DDL 回库），
 * 产出规范化行 JSON，交 core `schemaFromRows` 做纯映射。建议使用只读账号。
 */

const _TABLES = `
  SELECT table_name AS name
  FROM information_schema.tables
  WHERE table_schema = $1 AND table_type = 'BASE TABLE'
  ORDER BY table_name`;

const _COLUMNS = `
  SELECT c.table_name AS "table",
         c.column_name AS name,
         c.data_type   AS type,
         c.is_nullable AS nullable,
         CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END AS pk
  FROM information_schema.columns c
  LEFT JOIN (
    SELECT kcu.table_schema, kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
  ) pk
    ON pk.table_schema = c.table_schema
   AND pk.table_name = c.table_name
   AND pk.column_name = c.column_name
  WHERE c.table_schema = $1
  ORDER BY c.table_name, c.ordinal_position`;

const _FKS = `
  SELECT src.relname AS "table",
         sa.attname  AS column,
         ref.relname AS "refTable",
         ra.attname  AS "refColumn"
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_class ref ON ref.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
  JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.attnum
  JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = f.attnum
  WHERE con.contype = 'f' AND ns.nspname = $1
  ORDER BY src.relname, k.ord`;

const _INDEXES = `
  SELECT t.relname AS "table",
         i.relname AS name,
         CASE WHEN ix.indisunique THEN 1 ELSE 0 END AS unique,
         a.attname AS column
  FROM pg_index ix
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_namespace ns ON ns.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
  WHERE ns.nspname = $1 AND NOT ix.indisprimary
  ORDER BY t.relname, i.relname`;

/** 把 `{table,name,unique,column}` 行按索引名归并出 columns 数组 */
function _groupIndexes(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.table}::${r.name}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { table: r.table, name: r.name, columns: [], unique: Number(r.unique) };
      byKey.set(key, entry);
    }
    entry.columns.push(r.column);
  }
  return [...byKey.values()];
}

async function introspect(driver, { schema = 'public' } = {}) {
  if (!driver || typeof driver.query !== 'function') {
    throw new TypeError('postgres introspection 需要 pg 的 Pool/Client 实例');
  }
  const [tables, columns, fks, indexRows] = await Promise.all([
    driver.query(_TABLES, [schema]),
    driver.query(_COLUMNS, [schema]),
    driver.query(_FKS, [schema]),
    driver.query(_INDEXES, [schema]),
  ]);

  return {
    tables: tables.rows,
    columns: columns.rows.map((c) => ({
      table: c.table,
      name: c.name,
      type: c.type || '',
      notnull: c.nullable === 'NO' ? 1 : 0,
      pk: Number(c.pk) || 0,
    })),
    fks: fks.rows,
    indexes: _groupIndexes(indexRows.rows),
  };
}

module.exports = { introspect };
