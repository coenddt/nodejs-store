'use strict';

/**
 * 触发器规划输出跨端对拍（A10）—— node 侧
 *
 * 读 `rust-store/fixtures/triggers/cases.json` → 新建原生 Registry 注册 schemas
 * → 逐 case 调 planInsert / planUpdate（update 首次取 needsProbe，再携 found/doc 重入）
 * → 输出 `{ "<caseKey>": <plan 片段> }`（JSON，键排序，紧凑分隔符）。
 *
 * 与 `py-store/scripts/parity_triggers.py` 的输出逐字节比对：
 *   node scripts/parity-triggers.js > tmp/parity-triggers-node.json
 *   python scripts/parity_triggers.py > tmp/parity-triggers-py.json
 *   diff 两侧文件（必须零差异）
 */

const fs = require('fs');
const path = require('path');
const native = require('../src/core');

const FIXTURE = path.resolve(__dirname, '../../rust-store/fixtures/triggers/cases.json');
const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const reg = new native.Registry();
for (const s of fx.schemas) reg.register(s);

const out = {};
fx.cases.forEach((c, i) => {
  if (c.fn === 'planInsert') {
    const plan = reg.planInsert(c.schema, c.input, c.now, c.newId || '', null, null);
    out[`case${i}.triggers`] = plan.triggers === undefined ? null : plan.triggers;
  } else if (c.fn === 'planUpdate') {
    const first = reg.planUpdate(c.schema, c.condition, c.input, {}, c.now, null, null, null, null);
    out[`case${i}.first`] = first;
    const plan = reg.planUpdate(
      c.schema, c.condition, c.input, {}, c.now, null, c.found === true, c.doc ?? null, null);
    out[`case${i}.triggers`] = plan.triggers === undefined ? null : plan.triggers;
  } else {
    throw new Error(`未知 case.fn: ${c.fn}`);
  }
});

// 稳定序列化：键排序 + 紧凑分隔符（与 python json.dumps(sort_keys, separators) 对齐）
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
process.stdout.write(stable(out) + '\n');
