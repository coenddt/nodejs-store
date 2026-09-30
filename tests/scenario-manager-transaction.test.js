'use strict';

/**
 * manager-transaction 场景矩阵 · node:test 壳（真实库 e2e；复刻 scenario-course-platform.test.js）
 *
 * 阶段0 基线预期：T1-02/T1-03/T1-04/T2-01/T2-02/T3-01/T3-02 为**红**（能力缺失），
 * T1-01/T1-05 为**守护绿**。用例编号↔增补阶段任务映射见
 * common-store/事务型能力增补执行文档.md 附录 A。
 *
 * 运行：`$env:LOCAL_CORE='1'; $env:NODE_ENV='test'; node --test tests/scenario-manager-transaction.test.js`
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harness = require('../example/manager-transaction/impl/harness');

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
  describe(`manager-transaction · ${kind}`, () => {
    for (const c of CASES) {
      it(`${c.id} ${c.title}`, (t) => {
        if (c.backends && !c.backends.includes(kind)) return t.skip('backends 子集限定');
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

after(() => {
  const today = new Date();
  const year = String(today.getFullYear());
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const iso = `${year}-${month}-${String(today.getDate()).padStart(2, '0')}`;
  const outDir = path.join(ROOT, 'doc', 'test-eval', year, month);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `manager-transaction-场景矩阵-${iso}.md`);

  const L = [];
  L.push(`# manager-transaction 场景矩阵 · 多后端对拍报告（${iso}，nodejs-store）`);
  L.push('');
  L.push('## 一、环境与后端可达性');
  L.push('');
  for (const kind of BACKENDS) {
    const res = RUNS[kind];
    if (!res) L.push(`- \`${kind}\`：未执行`);
    else if (!res.available) L.push(`- \`${kind}\`：**skip** —— ${res.skipReason}`);
    else {
      const p = res.results.filter((r) => r.status === 'pass').length;
      L.push(`- \`${kind}\`：可达，通过 ${p}/${res.results.length}`);
    }
  }
  L.push('');
  L.push('> 本报告只出证据，不修实现。判定规则：SQL 结果集与 Mongo(oracle) 逐行相等'
         + '或显式 Err/unsupported+告警；静默不一致判缺陷。');
  L.push('');
  L.push('## 二、逐用例结果（阶段0：T1/T2/T3 组，红用例为增补路线验收标尺）');
  L.push('');
  L.push('| 用例 | 组 | mongodb | postgres | mysql | sqlite |');
  L.push('|---|---|---|---|---|---|');
  const byCase = {};
  const allIds = [];
  for (const kind of BACKENDS) {
    for (const r of (RUNS[kind] && RUNS[kind].results) || []) {
      byCase[r.id] = byCase[r.id] || {};
      byCase[r.id][kind] = r.status;
      if (!allIds.includes(r.id)) allIds.push(r.id);
    }
  }
  for (const cid of allIds) {
    const row = byCase[cid] || {};
    L.push(`| ${cid} | ${cid.split('-')[0]} | `
      + BACKENDS.map((k) => row[k] || '—').join(' | ') + ' |');
  }
  L.push('');
  L.push('## 三、失败明细（证据原样摘录）');
  L.push('');
  for (const kind of BACKENDS) {
    for (const r of (RUNS[kind] && RUNS[kind].results) || []) {
      if (r.status !== 'pass') {
        L.push(`### [${kind}] ${r.id} ${r.title}`);
        L.push('');
        for (const s of r.steps) {
          if (!s.ok) L.push(`- step${s.idx} × ${s.op}（期望 ${s.expectKind || '-'}）：${s.note}`);
        }
        L.push('');
      }
    }
  }
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  console.log(`报告: ${outPath}`);
});
