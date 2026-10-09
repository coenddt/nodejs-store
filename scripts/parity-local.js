'use strict';

/**
 * 本地磁盘数据源 双端对拍（A6）—— 输出一行稳定 JSON。
 *
 * 与 `py-store/scripts/parity_local.py` 输出**逐字节**比对；两侧共用同一份 FIXTURE
 * （`FIXTURE_JSON` 常量文本须与 py 侧逐字相同，由 `tests/parity-local.test.js` 断言）。
 *
 * FIXTURE 约束（两侧导航同一份数据，禁各自改）：
 *   1. 禁时钟 / 随机数：一切写入显式给 `_id`，seed 与 op 顺序固定；
 *   2. 禁「整数值浮点」（如 `2.0`）：Node 无法区分 `2.0` 与 `2`、Python 会输出 `2.0`
 *      → 会破坏逐字节相等；故 `$avg` 的分组均值刻意取非整数（见 S8）；
 *   3. 每个 op 只声明「做什么」（模型 / GQL / params），期望值不落在这里 —— 期望值来自对端。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { init, store, permission, schema, local } = require('../src');
const { readSnapshot } = require('../src/local/store');

const FIXTURE_JSON = `
{
  "schemas": [
    {
      "name": "ParityUser",
      "collection": "parity_users",
      "idPrefix": "pu_",
      "timestamps": false,
      "fields": {
        "name": { "type": "string" },
        "age": { "type": "int" },
        "tag": { "type": "string" },
        "score": { "type": "int" }
      },
      "relations": {
        "notes": { "model": "ParityNote", "type": "many", "localField": "_id", "foreignField": "userId" }
      },
      "computes": {
        "noteCount": { "agg": { "$count": "notes" } }
      },
      "read": null,
      "write": null
    },
    {
      "name": "ParityNote",
      "collection": "parity_notes",
      "idPrefix": "pn_",
      "timestamps": false,
      "fields": {
        "title": { "type": "string" },
        "userId": { "type": "string" },
        "score": { "type": "int" }
      },
      "relations": {
        "owner": { "model": "ParityUser", "type": "one", "localField": "userId", "foreignField": "_id" }
      },
      "read": null,
      "write": null
    }
  ],
  "seed": [
    { "model": "ParityUser", "doc": { "_id": "pu_1", "name": "Ada", "age": 36, "tag": "a", "score": 10 } },
    { "model": "ParityUser", "doc": { "_id": "pu_2", "name": "Bob", "age": 20, "tag": "b", "score": 11 } },
    { "model": "ParityUser", "doc": { "_id": "pu_3", "name": "Ada", "age": 45, "tag": "a", "score": 31 } },
    { "model": "ParityUser", "doc": { "_id": "pu_4", "name": null, "age": 28, "tag": null, "score": 5 } },
    { "model": "ParityUser", "doc": { "_id": "pu_5", "name": "Eve", "age": 50, "score": 1 } },
    { "model": "ParityNote", "doc": { "_id": "pn_1", "title": "N1", "userId": "pu_1", "score": 3 } },
    { "model": "ParityNote", "doc": { "_id": "pn_2", "title": "N2", "userId": "pu_1", "score": 7 } },
    { "model": "ParityNote", "doc": { "_id": "pn_3", "title": "N3", "userId": "pu_2", "score": 5 } },
    { "model": "ParityNote", "doc": { "_id": "pn_4", "title": "N4", "userId": "pu_9", "score": 1 } }
  ],
  "ops": [
    { "s": "S1-eq", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, name, age }", "params": { "c0": { "name": "Ada" }, "s0": { "_id": 1 } } },
    { "s": "S1-in", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, name, age }", "params": { "c0": { "age": { "$in": [20, 28] } }, "s0": { "_id": 1 } } },
    { "s": "S1-range", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, age }", "params": { "c0": { "age": { "$gt": 20, "$lte": 45 } }, "s0": { "_id": 1 } } },
    { "s": "S1-regex", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, name }", "params": { "c0": { "name": { "$regex": "^Ada" } }, "s0": { "_id": 1 } } },
    { "s": "S2-explicit-null", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, tag }", "params": { "c0": { "tag": null }, "s0": { "_id": 1 } } },
    { "s": "S2-missing-exists-false", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, tag }", "params": { "c0": { "tag": { "$exists": false } }, "s0": { "_id": 1 } } },
    { "s": "S2-ne-null", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, tag }", "params": { "c0": { "tag": { "$ne": null } }, "s0": { "_id": 1 } } },
    { "s": "S3-sort-string-asc", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, name }", "params": { "c0": {}, "s0": { "name": 1, "_id": 1 } } },
    { "s": "S3-sort-int-desc", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, score }", "params": { "c0": {}, "s0": { "score": -1, "_id": 1 } } },
    { "s": "S3-sort-tag-asc", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, tag }", "params": { "c0": {}, "s0": { "tag": 1, "_id": 1 } } },
    { "s": "S4-page", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0,$skip:@sk,$limit:@l0){ _id }", "params": { "c0": {}, "s0": { "_id": 1 }, "sk": 1, "l0": 2 } },
    { "s": "S5-one-hit", "op": "query", "gql": "ParityNote($condition:@c0){ _id, title, owner { _id, name } }", "params": { "c0": { "_id": "pn_1" } } },
    { "s": "S5-one-miss", "op": "query", "gql": "ParityNote($condition:@c0){ _id, title, owner { _id, name } }", "params": { "c0": { "_id": "pn_4" } } },
    { "s": "S6-many-hit", "op": "query", "gql": "ParityUser($condition:@c0){ _id, notes { _id, title } }", "params": { "c0": { "_id": "pu_1" } } },
    { "s": "S6-many-miss", "op": "query", "gql": "ParityUser($condition:@c0){ _id, notes { _id, title } }", "params": { "c0": { "_id": "pu_5" } } },
    { "s": "S7-relation-trim", "op": "query", "gql": "ParityUser($condition:@c0){ _id, notes($condition:@c1,$sort:@s1,$limit:@l1){ _id, score } }", "params": { "c0": { "_id": "pu_1" }, "c1": { "score": { "$gt": 2 } }, "s1": { "score": -1 }, "l1": 1 } },
    { "s": "S8-group-by-tag", "op": "query", "gql": "ParityUser($condition:@c0,$group:@g0,$sort:@s0){ tag, n, total, lo, hi }", "params": { "c0": {}, "g0": { "by": ["tag"], "agg": { "n": { "$count": "*" }, "total": { "$sum": "score" }, "lo": { "$min": "score" }, "hi": { "$max": "score" } } }, "s0": { "tag": 1 } } },
    { "s": "S8-group-empty", "op": "query", "gql": "ParityUser($condition:@c0,$group:@g0){ n, total, avg, lo, hi }", "params": { "c0": { "_id": "nope" }, "g0": { "by": [], "agg": { "n": { "$count": "*" }, "total": { "$sum": "score" }, "avg": { "$avg": "score" }, "lo": { "$min": "score" }, "hi": { "$max": "score" } } } } },
    { "s": "S8-group-all-avg", "op": "query", "gql": "ParityUser($condition:@c0,$group:@g0){ n, total, avg, lo, hi }", "params": { "c0": {}, "g0": { "by": [], "agg": { "n": { "$count": "*" }, "total": { "$sum": "score" }, "avg": { "$avg": "score" }, "lo": { "$min": "score" }, "hi": { "$max": "score" } } } } },
    { "s": "S8-having", "op": "query", "gql": "ParityUser($condition:@c0,$group:@g0,$having:@h0,$sort:@s0){ tag, n }", "params": { "c0": {}, "g0": { "by": ["tag"], "agg": { "n": { "$count": "*" } } }, "h0": { "n": { "$gt": 1 } }, "s0": { "tag": 1 } } },
    { "s": "S9-computed-agg", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, name, noteCount }", "params": { "c0": {}, "s0": { "_id": 1 } } },
    { "s": "S10-update-one", "op": "update", "model": "ParityUser", "where": { "_id": "pu_2" }, "data": { "$set": { "tag": "z" }, "$inc": { "score": 4 }, "$unset": { "age": true } } },
    { "s": "S10-update-many", "op": "updateMany", "model": "ParityUser", "where": { "tag": "a" }, "data": { "$inc": { "score": 1 } } },
    { "s": "S10-verify", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, tag, score }", "params": { "c0": { "_id": { "$in": ["pu_1", "pu_2", "pu_3"] } }, "s0": { "_id": 1 } } },
    { "s": "S11-remove", "op": "remove", "model": "ParityNote", "where": { "_id": "pn_4" } },
    { "s": "S11-list-source", "op": "query", "gql": "ParityNote($sort:@s0){ _id }", "params": { "s0": { "_id": 1 } } },
    { "s": "S11-list-archive", "op": "query", "gql": "ParityNoteDeleted($sort:@s0){ _id, title, userId, score }", "params": { "s0": { "_id": 1 } } },
    { "s": "S11-file-stats", "op": "snapshot" },
    { "s": "S12-tx-commit", "op": "txCommit", "model": "ParityUser", "doc": { "_id": "pu_tx1", "name": "TxAda", "age": 1, "tag": "t", "score": 0 } },
    { "s": "S12-tx-rollback", "op": "txRollback", "model": "ParityUser", "doc": { "_id": "pu_tx2", "name": "TxBob", "age": 2, "tag": "t", "score": 0 } },
    { "s": "S12-tx-verify", "op": "query", "gql": "ParityUser($condition:@c0,$sort:@s0){ _id, name }", "params": { "c0": { "_id": { "$in": ["pu_tx1", "pu_tx2"] } }, "s0": { "_id": 1 } } },
    { "s": "S13-upsert-hit", "op": "upsert", "model": "ParityUser", "where": { "_id": "pu_5" }, "data": { "name": "Eve2", "tag": "u", "score": 99 } },
    { "s": "S13-upsert-insert", "op": "upsert", "model": "ParityUser", "where": { "_id": "pu_6" }, "data": { "_id": "pu_6", "name": "New", "age": 7, "tag": "ins", "score": 0 } },
    { "s": "S13-count", "op": "count", "model": "ParityUser", "where": null }
  ]
}
`;

const FIXTURE = JSON.parse(FIXTURE_JSON);

/** 落盘快照 → 排序后的 `[物理集合名, 文档数]` 数组（键序无关，两侧同形） */
function snapshotStats(dir) {
  const snap = readSnapshot(dir);
  return Object.keys(snap).sort().map((name) => [name, snap[name].length]);
}

/** 单步：声明式 op → store 调用（两侧同名同义；只做「做什么」，不判期望值） */
async function step(op, dir) {
  switch (op.op) {
    case 'query':
      return store.query(op.gql, op.params || {});
    case 'update':
      return store.update(op.model, op.where, op.data);
    case 'updateMany':
      return store.updateMany(op.model, op.where, op.data);
    case 'remove':
      return store.remove(op.model, op.where);
    case 'count':
      return store.count(op.model, op.where || null);
    case 'upsert':
      return store.upsert(op.model, op.where, op.data);
    case 'snapshot':
      return snapshotStats(dir);
    case 'txCommit':
      return store.transaction('default', async () => {
        await store.insert(op.model, op.doc);
        return store.count(op.model, null);
      });
    case 'txRollback':
      try {
        await store.transaction('default', async () => {
          await store.insert(op.model, op.doc);
          throw new Error('parity-rollback');
        });
      } catch (e) {
        if (!String((e && e.message) || e).includes('parity-rollback')) throw e;
      }
      return store.count(op.model, null);
    default:
      throw new Error('未知对拍 op: ' + op.op);
  }
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-parity-'));
  try {
    permission.setContext(undefined);
    for (const d of FIXTURE.schemas) schema.register(d);
    await init({ default: local.connect({ dir }) });

    for (const s of FIXTURE.seed) await store.insert(s.model, s.doc);

    const out = [];
    for (const op of FIXTURE.ops) out.push(await step(op, dir));
    process.stdout.write(JSON.stringify(out) + '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().catch((e) => {
  process.stdout.write('ERR:' + ((e && e.message) || e) + '\n');
  process.exit(1);
});