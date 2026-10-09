'use strict';

/**
 * 双端作用域对拍（A6 子集）—— 输出一行规范化 JSON：视图覆盖 × 输入的逐字段快照。
 *
 * 与 `py-store/scripts/parity_scope.py` 输出**逐字节**比对（两侧共用同一份
 * `FIXTURE_JSON`，由 `tests/parity-scope.test.js` / `tests/test_parity_scope.py`
 * 断言文本一致）。覆盖：`planQuery` 命令 JSON、`profile()`、`canReadSchema`、`rbacCan`、
 * 非法视图覆盖的拒绝文案（原文，禁改文案对齐）。
 *
 * 对拍失真防线（fail-loud，禁静默）：
 *   - 数字：两侧只允许整数（JS `1` 与 Python `1.0` 的表示差异不是语义差异）；
 *   - 键序：两侧统一按键排序 + 紧凑分隔符。
 *
 * 环境：开发期须 `LOCAL_CORE=1`（默认绑定为旧版、无 `withPolicy`）；缺失时输出
 * `ERR:` 前缀（显式失守，不静默降级）。
 */

const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const { schema, permission, store, withScope } = require(SRC);

const FIXTURE_JSON = `
{
  "schemas": [
    {
      "name": "ScopePost",
      "collection": "scope_posts",
      "timestamps": false,
      "fields": { "title": { "type": "string" }, "status": { "type": "string" } },
      "relations": {}
    },
    {
      "name": "ScopeAudit",
      "collection": "scope_audits",
      "timestamps": false,
      "read": ["viewer"],
      "fields": { "title": { "type": "string" } },
      "relations": {}
    }
  ],
  "views": [
    { "name": "standard", "overrides": {} },
    { "name": "text2query", "overrides": { "profile": "text2query" } },
    {
      "name": "rbacGranted",
      "overrides": {
        "rbac": {
          "mode": "enforce",
          "roles": { "viewer": {} },
          "grants": [{ "role": "viewer", "model": "ScopePost", "actions": ["read"] }]
        }
      }
    },
    {
      "name": "rbacDenied",
      "overrides": { "rbac": { "mode": "enforce", "roles": { "viewer": {} }, "grants": [] } }
    },
    {
      "name": "locked",
      "overrides": {
        "requireContext": true,
        "roleRules": { "unconfigured": "closed" },
        "metaPolicy": { "closed": true, "roles": ["admin"] }
      }
    }
  ],
  "badViews": [
    { "name": "unknownKey", "overrides": { "noSuchKey": 1 } },
    { "name": "badProfile", "overrides": { "profile": "noSuchProfile" } },
    { "name": "unknownRoleRule", "overrides": { "roleRules": { "noSuchRule": ["x"] } } },
    { "name": "unknownMetaPolicy", "overrides": { "metaPolicy": { "noSuchKey": true } } },
    { "name": "notObject", "overrides": "not-an-object" }
  ],
  "contexts": [
    { "name": "viewer", "value": { "userId": "u1", "roles": ["viewer"] } },
    { "name": "other", "value": { "userId": "u2", "roles": ["other"] } },
    { "name": "none", "value": null }
  ],
  "queries": [
    {
      "name": "condition",
      "gql": "ScopePost($condition:@c){ _id title }",
      "params": { "c": { "status": "open" } }
    },
    {
      "name": "sortLimit",
      "gql": "ScopePost($sort:@s, $limit:@l){ _id title }",
      "params": { "s": { "title": 1 }, "l": 2 }
    },
    { "name": "auditAll", "gql": "ScopeAudit{ _id title }", "params": {} }
  ],
  "reads": [
    { "model": "ScopePost", "ctx": "viewer" },
    { "model": "ScopeAudit", "ctx": "viewer" },
    { "model": "ScopeAudit", "ctx": "other" },
    { "model": "ScopeAudit", "ctx": "none" }
  ],
  "rbac": [
    { "model": "ScopePost", "action": "read", "ctx": "viewer" },
    { "model": "ScopeAudit", "action": "read", "ctx": "viewer" },
    { "model": "ScopePost", "action": "read", "ctx": "none" }
  ]
}
`;

/** 规范化 JSON：键排序 + 紧凑分隔符（与 py 侧 `_canon` 同序同形） */
function canonical(v) {
  if (v === undefined) throw new Error('canonical: undefined 不可序列化（对拍失真防线）');
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isInteger(v)) {
      throw new Error(`canonical: 非整数 ${v}（py 1.0 与 js 1 表示差异不是语义差异）`);
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** 成功 → `{ok: true, value}`；异常 → `{ok: false, error: 原文}` */
function outcome(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function ctxOf(fx, name) {
  const found = fx.contexts.find((c) => c.name === name);
  if (!found) throw new Error(`fixture 未声明 ctx: ${name}`);
  return found.value;
}

/** 当前 core（作用域内 = 视图；作用域外 = base）上的观测快照 */
function snapshot(fx) {
  const row = { profile: schema.getProfile() };
  for (const r of fx.reads) {
    row[`read:${r.model}:${r.ctx}`] = outcome(() => permission.canReadSchema(r.model, ctxOf(fx, r.ctx)));
  }
  for (const r of fx.rbac) {
    row[`rbac:${r.model}:${r.action}:${r.ctx}`] = outcome(
      () => store.rbacCan(r.model, r.action, ctxOf(fx, r.ctx)),
    );
  }
  for (const q of fx.queries) {
    for (const c of fx.contexts) {
      row[`plan:${q.name}:${c.name}`] = outcome(
        () => canonical(schema.getCore().planQuery(q.gql, q.params, c.value, null)),
      );
    }
  }
  return row;
}

/** 派生视图覆盖；成功返回占位串（不应发生，出现即测试判失败） */
function derive(viewDef) {
  schema.core.withPolicy(viewDef.overrides);
  return 'DERIVED-OK';
}

async function main() {
  if (typeof schema.core.withPolicy !== 'function') {
    process.stdout.write('ERR: 当前 core 绑定无 withPolicy（开发期须 LOCAL_CORE=1）\n');
    return;
  }
  const fx = JSON.parse(FIXTURE_JSON);
  for (const defn of fx.schemas) schema.register(defn);

  const out = { base: snapshot(fx), views: [], badViews: [], baseAfter: null };
  for (const v of fx.views) {
    const view = schema.core.withPolicy(v.overrides);
    // 用例须按 fixture 顺序串行（对拍可比性）
    await withScope({ view }, () => {
      out.views.push({ view: v.name, snapshot: snapshot(fx) });
    });
  }
  out.badViews = fx.badViews.map((b) => ({ view: b.name, ...outcome(() => derive(b)) }));
  out.baseAfter = snapshot(fx);

  process.stdout.write(`${canonical(out)}\n`);
}

main().catch((e) => {
  process.stdout.write(`ERR: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 1;
});
