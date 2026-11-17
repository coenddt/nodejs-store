'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 场景矩阵 test 壳（course-platform / manager-transaction 两 harness 共用）：
 * 同一顶层 before 串行跑全部后端（mongo 先行产 oracle）→ 逐后端挂 describe 断言
 * → after 落报告（报告体由各文件传入，格式互不相同）。
 */

/** step 的 note 文本（describe 断言逐条列出失败明细） */
function stepsNote(step) {
  return `step${step.idx}(${step.op}/${step.expectKind || '-'}): ${step.note}`;
}

/** 串行跑全部后端：mongo 先行产 oracle，返回 { 后端: 运行结果 } */
async function runBackendsSerial(harness) {
  const RUNS = {};
  let oracle = null;
  for (const kind of harness.BACKENDS) {
    const res = await harness.runBackend(kind, oracle); // 串行：mongo 先行产 oracle
    RUNS[kind] = res;
    if (kind === 'mongodb' && res.available) oracle = res.oracle;
  }
  return RUNS;
}

/** 逐后端挂 describe 断言：extraSkip(kind, c) 返回 skip 文案或 null（manager 有 backends 子集限定，course 不传） */
function mountBackendDescribes({ harness, runs, cases, suiteLabel, extraSkip }) {
  for (const kind of harness.BACKENDS) {
    describe(`${suiteLabel} · ${kind}`, () => {
      for (const c of cases) {
        it(`${c.id} ${c.title}`, (t) => {
          const skip = extraSkip ? extraSkip(kind, c) : null;
          if (skip) return t.skip(skip);
          const res = runs[kind];
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
}

/** 报告落点：doc/test-eval/<YYYY>/<MM>/<name>-场景矩阵-<iso>.md（目录不存在则建） */
function reportPaths(root, name) {
  const today = new Date();
  const year = String(today.getFullYear());
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const iso = `${year}-${month}-${String(today.getDate()).padStart(2, '0')}`;
  const outDir = path.join(root, 'doc', 'test-eval', year, month);
  fs.mkdirSync(outDir, { recursive: true });
  return { iso, outDir, outPath: path.join(outDir, `${name}-场景矩阵-${iso}.md`) };
}

/** 一键装配：before 串行跑后端 + describe 断言 + after 落报告（writeReport(runs) 由各文件给报告体） */
function mountScenarioMatrix({ harness, cases, suiteLabel, extraSkip, writeReport }) {
  const RUNS = {};
  before(async () => {
    Object.assign(RUNS, await runBackendsSerial(harness));
  });
  mountBackendDescribes({ harness, runs: RUNS, cases, suiteLabel, extraSkip });
  after(() => writeReport(RUNS));
  return RUNS;
}

module.exports = { runBackendsSerial, mountBackendDescribes, reportPaths, mountScenarioMatrix };
