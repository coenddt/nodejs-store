'use strict';

/**
 * 驱动原始值归一（SQL 执行器共用）
 *
 * `pg` / `mysql2` 对**精确数值列**默认返回**字符串**：
 * - `pg`：`int8`(20) / `numeric`(1700) → string；
 * - `mysql2`：`DECIMAL` / `NEWDECIMAL`(246) → string。
 *
 * 而 Mongo 驱动对这些值返回 `number`。未归一 → 同一查询在 SQL 后端返回 `"8"`、Mongo 返回
 * `8`（**静默类型失真**，`JSON.stringify` 对拍与用户代码都能看到差异）。
 *
 * 归一**只依据驱动给出的列类型元数据**（`pg` 的 `res.fields[].dataTypeID`、`mysql2` 的
 * `fields[].columnType`），因此**不会**误伤真正的字符串列（如 `_id` / `status`）。
 *
 * 与 py-store 的 `py_store/executors/_values.py`（`Decimal` → 数值）同源同责。
 */

/** pg 的数值类型 OID（int2/int4/int8/float4/float8/numeric） */
const PG_NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);

/** mysql2 的数值 columnType（DECIMAL/TINY/SHORT/LONG/FLOAT/DOUBLE/LONGLONG/INT24/NEWDECIMAL） */
const MYSQL_NUMERIC_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 246]);

/** 字符串数值 → number；非有限数值（如超长整数溢出为 Infinity）保持原样，不静默改值 */
function toNumber(v) {
  if (typeof v !== 'string' || v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/**
 * 行集归一：按列类型元数据把**数值列**的字符串值转 `number`。
 *
 * @param {object[]} rows   驱动返回的行
 * @param {object[]|undefined} fields 列元数据（`dataTypeID` for pg / `columnType` for mysql2）
 * @param {'postgres'|'mysql'} kind 驱动种类
 */
function normalizeRows(rows, fields, kind) {
  if (!rows || !rows.length || !fields || !fields.length) return rows;
  const numeric = [];
  for (let i = 0; i < fields.length; i += 1) {
    const t = kind === 'postgres' ? fields[i].dataTypeID : fields[i].columnType;
    const hit = kind === 'postgres' ? PG_NUMERIC_OIDS.has(t) : MYSQL_NUMERIC_TYPES.has(t);
    if (hit) numeric.push(fields[i].name);
  }
  if (!numeric.length) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const k of numeric) out[k] = toNumber(out[k]);
    return out;
  });
}

module.exports = { MYSQL_NUMERIC_TYPES, PG_NUMERIC_OIDS, normalizeRows, toNumber };
