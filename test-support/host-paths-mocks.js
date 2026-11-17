'use strict';

/**
 * host-paths 用例的共用夹具与内存驱动 mock（D4-4 零语义拆分）。
 *
 * 自 tests/host-paths.test.js 原样下沉：四个逻辑模型注册（HpPost / HpComment /
 * HpUser / HpOrder）、全局状态复位、phase-1/phase-2 两阶段读路径 mock
 * （Cursor / phase1Ids / applyPhase1 / ScriptedColl / FakeDb）、种子与 dbWithPosts；
 * 语句与注释逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { schema: _sc, permission, feedback, datasource } = require('../src');

// ─────────────────────────────────────────────────────────────
// schema（两阶段读路径需要「根 + 关系子表」）
// ─────────────────────────────────────────────────────────────

_sc.register({
  name: 'HpPost', collection: 'hp_posts', idPrefix: 'HP', timestamps: false,
  fields: { title: { type: 'string' }, seq: { type: 'int' } },
  relations: {
    comments: {
      model: 'HpComment', type: 'many', localField: '_id', foreignField: 'postId',
    },
  },
  read: null, write: null,
});
_sc.register({
  name: 'HpComment', collection: 'hp_comments', timestamps: false,
  fields: { postId: { type: 'string' }, body: { type: 'string' } },
  relations: {}, read: null, write: null,
});
// 联邦降级：根与子表分属两个数据源（跨源子级 $limit 无法下推）
_sc.register({
  name: 'HpUser', collection: 'hp_users', datasource: 'hp_mongo_a',
  idPrefix: 'HU', timestamps: false,
  fields: { name: { type: 'string' } },
  relations: {
    orders: {
      model: 'HpOrder', type: 'many', localField: '_id', foreignField: 'userId',
    },
  },
  read: null, write: null,
});
_sc.register({
  name: 'HpOrder', collection: 'hp_orders', datasource: 'hp_mongo_b',
  timestamps: false,
  fields: { userId: { type: 'string' }, code: { type: 'string' } },
  relations: {}, read: null, write: null,
});

/** 每个用例前后的全局状态复位（档位 / 上下文 / sink / 连接） */
function resetGlobals () {
  _sc.setProfile('standard');
  permission.setContext(undefined);
  feedback.setSink(null);
  datasource.setConnections({});
}

// ─────────────────────────────────────────────────────────────
// 内存驱动 mock：phase-1 取 ID / phase-2 回表（按 pipeline 形态分派）
// ─────────────────────────────────────────────────────────────

class Cursor {
  constructor (docs) { this.docs = docs; }

  async toArray () { return [...this.docs]; }
}

/** phase-2 命令首段 `$match._id.$in` → id 数组；非两阶段返回 null */
function phase1Ids (pipeline) {
  const first = Array.isArray(pipeline) ? pipeline[0] : null;
  const match = first && typeof first === 'object' ? first.$match : null;
  const inClause = match && typeof match === 'object' ? match._id : null;
  const val = inClause && typeof inClause === 'object' ? inClause.$in : null;
  return Array.isArray(val) ? val : null;
}

/** 极简阶段模拟（仅本用例所需）：$sort / $skip / $limit / $project */
function applyPhase1 (pipeline, docs) {
  let cur = docs.map((d) => ({ ...d }));
  for (const stage of pipeline) {
    if (stage.$sort) {
      const entries = Object.entries(stage.$sort).reverse();
      for (const [key, dir] of entries) {
        cur.sort((a, b) => {
          const x = a[key]; const y = b[key];
          if (x === y) return 0;
          return (x === undefined || x === null ? 1 : y === undefined || y === null ? -1
            : (x < y ? -1 : 1)) * (dir < 0 ? -1 : 1);
        });
      }
    } else if (stage.$skip !== undefined) {
      cur = cur.slice(Number(stage.$skip));
    } else if (stage.$limit !== undefined) {
      cur = cur.slice(0, Number(stage.$limit));
    } else if (stage.$project) {
      const keys = Object.entries(stage.$project).filter(([, v]) => v).map(([k]) => k);
      cur = cur.map((d) => Object.fromEntries(keys.map((k) => [k, d[k]])));
    }
  }
  return cur;
}

/** 两阶段读路径 mock：phase-1 取 ID、phase-2 按 `$in` 回表（可强制乱序返回） */
class ScriptedColl {
  constructor (docs, { reversePhase2 = false } = {}) {
    this.docs = docs;
    this.pipelines = [];
    this.reversePhase2 = reversePhase2;
    this.phase2RawIds = null;
  }

  find () { return new Cursor(this.docs); }

  aggregate (pipeline) {
    this.pipelines.push(pipeline);
    const ids = phase1Ids(pipeline);
    if (ids === null) return new Cursor(applyPhase1(pipeline, this.docs));
    const byId = new Map(this.docs.map((d) => [d._id, { ...d }]));
    const picked = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
    if (this.reversePhase2) picked.reverse();
    this.phase2RawIds = picked.map((d) => d._id);
    return new Cursor(picked);
  }

  async countDocuments () { return this.docs.length; }
}

/** 按 collection 名分派独立 coll 的 Mongo db 桩 */
class FakeDb {
  constructor (mapping = {}) { this.colls = { ...mapping }; }

  collection (name) {
    if (!this.colls[name]) this.colls[name] = new ScriptedColl([]);
    return this.colls[name];
  }
}

const POSTS = [
  { _id: 'p1', title: 'A', seq: 1 },
  { _id: 'p2', title: 'B', seq: 2 },
  { _id: 'p3', title: 'C', seq: 3 },
];

function dbWithPosts ({ posts = POSTS, reversePhase2 = false } = {}) {
  const coll = new ScriptedColl(posts, { reversePhase2 });
  return { db: new FakeDb({ hpPosts: coll }), coll };
}

module.exports = {
  resetGlobals, dbWithPosts, FakeDb, ScriptedColl,
};
