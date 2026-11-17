'use strict';

/**
 * manager-transaction 场景矩阵 · node:test 壳（真实库 e2e；与 scenario-course-platform.test.js 共用 helpers/scenario-shell 壳）
 *
 * 阶段0 基线预期：T1-02/T1-03/T1-04/T2-01/T2-02/T3-01/T3-02 为**红**（能力缺失），
 * T1-01/T1-05 为**守护绿**。用例编号↔增补阶段任务映射见
 * common-store/事务型能力增补执行文档.md 附录 A。
 *
 * 运行：`$env:LOCAL_CORE='1'; $env:NODE_ENV='test'; node --test tests/scenario-manager-transaction.test.js`
 */

const fs = require('node:fs');
const path = require('node:path');

const harness = require('../example/manager-transaction/impl/harness');
// test 壳骨架（before 串行跑后端 + describe 断言 + 报告落点）收编至 helpers/scenario-shell
const { mountScenarioMatrix, reportPaths } = require('./helpers/scenario-shell');

const BACKENDS = harness.BACKENDS;
const CASES = harness.loadCases();
const ROOT = path.resolve(__dirname, '..');

// ──────────────────────────────────────────────────────────── 报告 ──

/** 报告一：环境与后端可达性列表 + 判定规则引文 */
function _mtSection1(RUNS) {
  const L = [];
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
  return L;
}

/** 逐用例状态累积：`byCase[id][kind] = status`、`allIds` 按首见序 */
function _mtByCase(RUNS) {
  const byCase = {};
  const allIds = [];
  for (const kind of BACKENDS) {
    for (const r of (RUNS[kind] && RUNS[kind].results) || []) {
      byCase[r.id] = byCase[r.id] || {};
      byCase[r.id][kind] = r.status;
      if (!allIds.includes(r.id)) allIds.push(r.id);
    }
  }
  return { byCase, allIds };
}

/** 报告二：逐用例结果矩阵表 */
function _mtSection2(RUNS) {
  const L = [];
  L.push('## 二、逐用例结果（阶段0：T1/T2/T3 组，红用例为增补路线验收标尺）');
  L.push('');
  L.push('| 用例 | 组 | mongodb | postgres | mysql | sqlite |');
  L.push('|---|---|---|---|---|---|');
  const { byCase, allIds } = _mtByCase(RUNS);
  for (const cid of allIds) {
    const row = byCase[cid] || {};
    L.push(`| ${cid} | ${cid.split('-')[0]} | `
      + BACKENDS.map((k) => row[k] || '—').join(' | ') + ' |');
  }
  L.push('');
  return L;
}

/** 报告三：失败明细（证据原样摘录） */
function _mtSection3(RUNS) {
  const L = [];
  L.push('## 三、失败明细（证据原样摘录）');
  L.push('');
  for (const kind of BACKENDS) {
    const rows = (RUNS[kind] && RUNS[kind].results) || [];
    for (const r of rows) {
      if (r.status === 'pass') continue;
      L.push(`### [${kind}] ${r.id} ${r.title}`);
      L.push('');
      for (const s of r.steps) {
        if (!s.ok) L.push(`- step${s.idx} × ${s.op}（期望 ${s.expectKind || '-'}）：${s.note}`);
      }
      L.push('');
    }
  }
  return L;
}

function writeManagerReport(RUNS) {
  const { iso, outPath } = reportPaths(ROOT, 'manager-transaction');

  const L = [];
  L.push(`# manager-transaction 场景矩阵 · 多后端对拍报告（${iso}，nodejs-store）`);
  L.push('');
  L.push(..._mtSection1(RUNS));
  L.push(..._mtSection2(RUNS));
  L.push(..._mtSection3(RUNS));
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  console.log(`报告: ${outPath}`);
}

mountScenarioMatrix({
  harness,
  cases: CASES,
  suiteLabel: 'manager-transaction',
  extraSkip: (kind, c) => (c.backends && !c.backends.includes(kind) ? '[环境依赖] 用例 backends 白名单不含此后端（跨后端语义差异，非缺测）' : null),
  writeReport: writeManagerReport,
});
