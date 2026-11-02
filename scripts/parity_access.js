'use strict';

/**
 * accessKeys 双端对拍脚本（node 侧）
 *
 * 契约（执行文档 03 §4.4）：
 *   - `FIXTURE_JSON` 与 py 侧 `py-store/scripts/parity_access.py` **逐字节一致**；
 *   - 每脚本打印单行 JSON：`{"results": [ {name, ok, value|error}, ... ]}`；
 *   - 行为用例走内存后端（同一 fixture 数据），方言用例只输出 core 计划中的 SQL/参数。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node scripts/parity_access.js`
 */

const { init, store, permission, schema: _sc } = require('../src');
const datasource = require('../src/datasource');
const { connect } = require('../src/memory');
const { getCore } = require('../src/schema');

const FIXTURE_JSON = String.raw`
{
  "schemas": [
    {
      "defn": {
        "name": "AkItem",
        "collection": "ak_items",
        "idPrefix": "ak_",
        "timestamps": false,
        "fields": {
          "satCode": {"type": "string"},
          "title": {"type": "string"},
          "tags": {"type": "array"},
          "createdBy": {"type": "string"}
        },
        "relations": {},
        "accessKeys": {
          "satCode": {"read": "satsRead", "write": "satsWrite", "bypassRoles": ["admin"]},
          "tags": {"read": "tagsRead", "write": "tagsWrite"}
        }
      },
      "rows": [
        {"_id": "ak_r1", "satCode": "GEO", "title": "a", "tags": ["x"], "createdBy": "u1"},
        {"_id": "ak_r2", "satCode": "LEO", "title": "b", "tags": ["x", "y"], "createdBy": "u2"},
        {"_id": "ak_r3", "satCode": "MARS", "title": "c", "tags": ["y"], "createdBy": "u1"}
      ]
    },
    {
      "defn": {
        "name": "AkOwned",
        "collection": "ak_owned",
        "idPrefix": "ako_",
        "timestamps": false,
        "read": ["creator"],
        "fields": {
          "satCode": {"type": "string"},
          "title": {"type": "string"},
          "createdBy": {"type": "string"}
        },
        "relations": {},
        "accessKeys": {
          "satCode": {"read": "satsRead", "write": "satsWrite", "bypassRoles": ["admin"]}
        }
      },
      "rows": [
        {"_id": "ako_1", "satCode": "GEO", "title": "o1", "createdBy": "u1"},
        {"_id": "ako_2", "satCode": "GEO", "title": "o2", "createdBy": "u2"},
        {"_id": "ako_3", "satCode": "MARS", "title": "o3", "createdBy": "u1"}
      ]
    }
  ],
  "cases": [
    {"name": "read_single_hit", "op": "query", "ctx": {"userId": "u1", "roles": ["viewer"], "satsRead": ["GEO", "LEO"], "tagsRead": ["x"]}, "gql": "AkItem{ _id }"},
    {"name": "read_single_miss", "op": "query", "ctx": {"userId": "u1", "roles": ["viewer"], "satsRead": ["MARS"], "tagsRead": ["x", "y"]}, "gql": "AkItem{ _id }"},
    {"name": "read_array_partial", "op": "query", "ctx": {"userId": "u1", "roles": ["viewer"], "satsRead": ["GEO", "LEO"], "tagsRead": ["y"]}, "gql": "AkItem{ _id }"},
    {"name": "write_scalar_deny", "op": "insert", "ctx": {"userId": "u1", "roles": ["viewer"], "satsWrite": ["GEO", "LEO"], "tagsWrite": ["x"]}, "data": {"_id": "ak_w1", "satCode": "MARS", "title": "n", "tags": ["x"]}},
    {"name": "write_array_not_subset", "op": "insert", "ctx": {"userId": "u1", "roles": ["viewer"], "satsWrite": ["GEO", "LEO"], "tagsWrite": ["x"]}, "data": {"_id": "ak_w2", "satCode": "GEO", "title": "n", "tags": ["x", "z"]}},
    {"name": "write_subset_ok", "op": "insert", "ctx": {"userId": "u1", "roles": ["viewer"], "satsWrite": ["GEO", "LEO"], "tagsWrite": ["x"]}, "data": {"_id": "ak_w3", "satCode": "GEO", "title": "n", "tags": ["x"]}},
    {"name": "bypass_read", "op": "query", "ctx": {"userId": "u1", "roles": ["admin"]}, "gql": "AkOwned{ _id }"},
    {"name": "missing_key_read_error", "op": "query", "ctx": {"userId": "u1", "roles": ["viewer"], "tagsRead": ["x"]}, "gql": "AkItem{ _id }"},
    {"name": "empty_list_read_empty", "op": "query", "ctx": {"userId": "u1", "roles": ["viewer"], "satsRead": [], "tagsRead": ["x"]}, "gql": "AkItem{ _id }"},
    {"name": "owner_and_access", "op": "query", "ctx": {"userId": "u1", "roles": ["viewer"], "satsRead": ["GEO"], "tagsRead": ["x"]}, "gql": "AkOwned{ _id }"},
    {"name": "dialect_mysql_overlaps", "op": "sql", "backend": "mysql"},
    {"name": "dialect_pg_overlaps", "op": "sql", "backend": "postgres"},
    {"name": "dialect_sqlite_overlaps", "op": "sql", "backend": "sqlite"}
  ]
}
`;

// 方言用例的固定命令：数组字段 `$in`（accessKeys 清单 → 交集命中）
const SQL_CMD = {
  kind: 'find',
  collection: 'ak_items',
  filter: { tags: { $in: ['GEO', 'LEO'] } },
  projection: { _id: 1 },
};

function sortRows(rows) {
  return rows.slice().sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
}

function sqlFragment(backend) {
  const plan = getCore().dialectTranslate(backend, SQL_CMD);
  const stmt = plan.stmts[0];
  return { text: stmt.text, params: stmt.params };
}

async function execute(c, fixture) {
  if (c.op === 'sql') {
    return { name: c.name, ok: true, value: sqlFragment(c.backend) };
  }
  permission.setContext(c.ctx === undefined ? undefined : c.ctx);
  try {
    if (c.op === 'query') {
      const rows = await store.query(c.gql);
      return { name: c.name, ok: true, value: sortRows(rows) };
    }
    if (c.op === 'insert') {
      const row = await store.insert('AkItem', c.data);
      // 只回归显式 _id（两端 ID 生成策略不同，不参与对拍）
      return { name: c.name, ok: true, value: { _id: row._id } };
    }
    throw new Error(`未知 op: ${c.op}`);
  } catch (e) {
    // 拒绝路径同样参与逐字节对拍
    return { name: c.name, ok: false, error: String(e.message) };
  } finally {
    permission.setContext(undefined);
  }
}

async function main() {
  const fixture = JSON.parse(FIXTURE_JSON);
  await init(connect({ database: 'akdb', store: new Map() }));
  for (const entry of fixture.schemas) _sc.register(entry.defn);
  for (const entry of fixture.schemas) {
    for (const row of entry.rows) await store.insert(entry.defn.name, row);
  }

  const results = [];
  for (const c of fixture.cases) results.push(await execute(c, fixture));

  datasource.setConnections({});
  process.stdout.write(`${JSON.stringify({ results })}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
