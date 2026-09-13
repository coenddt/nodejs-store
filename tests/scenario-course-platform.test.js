'use strict';

/**
 * course-platform 场景矩阵 · node:test 壳（真实库 e2e）
 *
 * 逐后端调用 `example/course-platform/impl/harness.js` 的 `runBackend`：
 * 先跑 MongoDB 产出 oracle，再跑三个 SQL 后端与 oracle 对拍；把结果写进
 * `nodejs-store/doc/test-eval/<YYYY>/<MM>/` 报告（`未处理-` 前缀）并转成断言。
 *
 * Registry 为进程级单例、`(source, namespace, collection)` 跨后端同名（同 triple），
 * 靠 `init({default: 连接})` 换后端 —— 故**必须串行**执行：四个后端在同一个
 * 顶层 `before` 钩子里按顺序跑完，再挂断言（避免读路径/连接映射互相踩踏）。
 *
 * 后端不可达 → `t.skip(reason)`，原因写入报告，绝不静默。
 *
 * 运行：`$env:LOCAL_CORE='1'; $env:NODE_ENV='test'; node --test tests/scenario-course-platform.test.js`
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harness = require('../example/course-platform/impl/harness');

const BACKENDS = harness.BACKENDS;
const CASES = harness.loadCases();
const ROOT = path.resolve(__dirname, '..');

const RUNS = {};

before(async () => {
  let oracle = null;
  for (const kind of BACKENDS) {
    const res = await harness.runBackend(kind, oracle); // 串行：mongo 先行产 oracle
    RUNS[kind] = res;
    if (kind === 'mongodb' && res.available) oracle = res.oracle;
  }
});

function stepsNote(step) {
  return `step${step.idx}(${step.op}/${step.expectKind || '-'}): ${step.note}`;
}

for (const kind of BACKENDS) {
  describe(`course-platform · ${kind}`, () => {
    for (const c of CASES) {
      it(`${c.id} ${c.title}`, (t) => {
        const res = RUNS[kind];
        assert.ok(res, `${kind} 未执行`);
        if (!res.available) return t.skip(res.skipReason);
        const r = res.results.find((x) => x.id === c.id);
        assert.ok(r, `${kind} 缺少用例结果 ${c.id}`);
        const failing = r.steps.filter((s) => !s.ok);
        assert.deepEqual(failing.map(stepsNote), [], `[${kind}] ${c.id} ${c.title} 断言失败`);
      });
    }
  });
}

// ──────────────────────────────────────────────────────────── 报告 ──

const GROUP_LABEL = {
  A: 'A 字段形态', B: 'B 写路径', C: 'C 关系/自关联/嵌套/分页', D: 'D 计算列',
  E: 'E 权限矩阵', F: 'F 边界（时间/数值/布尔/三态）', G: 'G 不可翻译必须显式',
  H: 'H 多后端一致性', J: 'J 根级 $group/$having/关系聚合谓词',
};

after(() => {
  const today = new Date();
  const year = String(today.getFullYear());
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const iso = `${year}-${month}-${String(today.getDate()).padStart(2, '0')}`;
  const outDir = path.join(ROOT, 'doc', 'test-eval', year, month);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `未处理-course-platform-场景矩阵-${iso}.md`);

  const L = [];
  L.push(`# course-platform 场景矩阵 · 多后端对拍报告（${iso}）`);
  L.push('');
  L.push('## 一、环境与后端可达性');
  L.push('');
  L.push('| 后端 | 可达 | 断言通过 | 用例总数 | skip 原因 |');
  L.push('|---|---|---|---|---|');
  const skipped = [];
  for (const kind of BACKENDS) {
    const r = RUNS[kind];
    if (!r) {
      L.push(`| \`${kind}\` | 未执行 | - | - | - |`);
      continue;
    }
    if (!r.available) {
      L.push(`| \`${kind}\` | **skip** | - | - | ${r.skipReason} |`);
      skipped.push(`${kind}（${r.skipReason}）`);
      continue;
    }
    const passed = r.results.filter((x) => x.status === 'pass').length;
    L.push(`| \`${kind}\` | 可达 | ${passed}/${r.results.length} | ${r.results.length} | - |`);
  }
  L.push('');
  L.push('> 本报告只出证据，不修实现。判定规则：SQL 结果集与 Mongo(oracle) 逐行相等，'
    + '或显式 Err / `unsupported` + feedback 告警；静默不一致判缺陷。');
  L.push('');
  L.push('## 二、覆盖度表（A~J 组）');
  L.push('');
  L.push('| 组 | 用例数 | 后端 | 通过 | 失败 | skip(不可达) |');
  L.push('|---|----|----|----|----|----|');
  const groups = [...new Set(CASES.map((c) => c.group))].sort();
  for (const g of groups) {
    const caseCount = CASES.filter((c) => c.group === g).length;
    const kinds = BACKENDS.filter((k) => RUNS[k] && RUNS[k].available);
    let pass = 0;
    let fail = 0;
    for (const k of kinds) {
      for (const r of RUNS[k].results) {
        if (r.group !== g) continue;
        if (r.status === 'pass') pass += 1;
        else fail += 1;
      }
    }
    L.push(`| ${g} | ${caseCount} | ${kinds.join(',') || '-'} | ${pass} | ${fail} | ${kinds.length ? '-' : '全部不可达'} |`);
  }
  L.push('');
  L.push('分组含义：' + Object.entries(GROUP_LABEL).map(([k, v]) => `${k}=${v}`).join('；') + '。');
  L.push('');
  L.push('未覆盖组：**I(联邦/跨源)** —— 原因与既有覆盖见第四节「未覆盖项 / 已知覆盖缺口」。');
  L.push('');
  L.push('## 三、缺陷清单（按 静默失真 > 越权 > 其它 排序）');
  L.push('');
  const defects = [];
  for (const kind of BACKENDS) {
    const r = RUNS[kind];
    if (!r || !r.available) continue;
    for (const c of r.results) {
      if (c.status === 'pass') continue;
      for (const s of c.steps.filter((x) => !x.ok)) {
        defects.push({ kind, id: c.id, group: c.group, title: c.title, note: s.note });
      }
    }
  }
  if (!defects.length) {
    L.push('无失败用例。');
  } else {
    for (const d of defects) {
      L.push(`- **${d.id}** \`[${d.kind}]\` group=${d.group} ${d.title}`);
      L.push('  ```');
      L.push(`  ${String(d.note).split('\n').join('\n  ')}`);
      L.push('  ```');
    }
  }
  L.push('');
  L.push('## 四、未覆盖项 / 已知覆盖缺口');
  L.push('');
  L.push('1. **I 组（联邦 / 跨源）** —— 本场景是单源 harness（每后端单个 `default` 源，'
    + '同进程内换连接串行复跑），不铺设双可写源。跨源联邦已由既有 '
    + '`tests/federation-e2e.test.js`（Mongo 根 → MySQL 子 + 跨源 `asyncFn`，对应 I-01/I-03/I-04）'
    + '与 `tests/multi-datasource.test.js`（多源定位 / namespace / routeOverride）覆盖，'
    + '本场景不重复；I 组其余条目（联邦降级告警、`MAX_FEDERATION_ROWS` 上限保护、'
    + '联邦权限一致、源失败不静默）**本轮未覆盖**。');
  L.push('2. **`op:"raw"` 断言中 `fn` 写在 step 级（非 `expect.fn`）的 6 步为 no-op** —— '
    + '`E-13` / `E-14` / `E-16`（`check_require_context` / `check_privileged_roles` / '
    + '`check_write_owner`）与 `F-06 step1` / `H-04 step1` / `H-05 step1`'
    + '（`check_bool_rows` / `check_numeric_rows`）：两宿主 harness 的 `assert_step` 只读 '
    + '`expect.kind`，用例 JSON 未把 `fn` 放进 `expect`，故这 6 步返回 `no assertion`'
    + '（py 侧 `.out/*.json` 同为 `"expectKind": null, "note": "no assertion"`）。'
    + '本场景**严格沿 py 语义**未改动用例资产，故 `setRequireContext` 开关、特权角色放行、'
    + '写路径 owner 校验、布尔/数值回读类型 4 类断言在 raw 层**未被实际执行**，'
    + '仅有 A-18 / D-06 / F-05 三步的 raw 断言（`expect.kind=raw`）真正生效。');
  L.push('3. **`D-06`** 在 Py 与 Node 两宿主均只覆盖「依赖不可读字段时 secret 不外泄」，'
    + '未覆盖「计算列因依赖不可读而显式 Err」分支（该分支要求 Host/core 主动拒算）。');
  L.push('');
  L.push('## 五、复跑命令与环境变量');
  L.push('');
  L.push('```powershell');
  L.push('cd nodejs-store');
  L.push("$env:LOCAL_CORE='1'; $env:NODE_ENV='test'");
  L.push('# 本场景（四真实库串行对拍）');
  L.push('node --test tests/scenario-course-platform.test.js');
  L.push('# 全量回归（既有 + 新增）');
  L.push('npm test');
  L.push('```');
  L.push('');
  L.push('- `LOCAL_CORE=1`：从相邻 `rust-store/core-node/dist/` 加载原生核心；'
    + '**不要**设 `NODE_ENV=production`（会使本地兜底失效，回落 npm 依赖）。');
  L.push(`- 后端可达性可用 \`MYSQL_URI\` / \`PG_URI\` / \`MONGO_URI\` 覆盖；缺省：MySQL `
    + `\`${harness.MYSQL_URI}\`、PostgreSQL \`${harness.PG_URI}\`、MongoDB `
    + `\`${harness.MONGO_URI}\`；SQLite 为 better-sqlite3 内存库。`);
  L.push('- 每个用例前 `reset → seed`（seed 走 `store.insert` 真实写路径），ctx 三态齐备。');
  if (skipped.length) L.push(`- 本轮 skip 的后端：${skipped.join('；')}`);
  L.push('');

  fs.writeFileSync(outPath, `${L.join('\n')}\n`, 'utf8');
  console.log(`\n[报告] 已写入 ${outPath}`);
});
