#!/usr/bin/env node
// SPEC 三段一致性校验：仓内所有必含载体归一后逐段一致，否则 exit 1。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 每仓配置：需含各片段的载体 + 取等集合（equality）
const REPO = {
  root: process.cwd(),
  carriers: {
    // 名称 -> { file, ids }；ids='*' 表示需含全部三段
    'README.md':            { file: 'README.md',                 ids: '*' },
    'README.en.md':         { file: 'README.en.md',              ids: '*' },
    'llms-full.txt':        { file: 'llms-full.txt',             ids: '*' },
    'ask_knowledge.md':     { file: 'src/ask_knowledge.md',      ids: '*' }, // py: src/py_store/ask_knowledge.md
  },
  equality: ['README.md', 'README.en.md', 'llms-full.txt', 'ask_knowledge.md'], // 取等集合（本例全含）
  ids: ['NAMING-STYLE', 'LOCATION', 'FNREF'],
};

function norm(t) {
  // 规范化拆两步（同值等价）；length 为非负整数：>0 与真值判定等价
  const lines = t.replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map((l) => l.trim()).filter((l) => l.length > 0)
    .map((l) => l.replace(/[ \t]+/g, ' ')).join('\n');
}
function extract(text, id) {
  const re = new RegExp(`<!-- SPEC:${id}:BEGIN -->([\\s\\S]*?)<!-- SPEC:${id}:END -->`);
  const found = text.match(re);
  return found ? norm(found[1]) : null;
}

const errors = [];
const seen = {}; // id -> { carrier: normalized }
for (const name of Object.keys(REPO.carriers)) {
  const { file } = REPO.carriers[name];
  let text;
  try { text = fs.readFileSync(path.join(REPO.root, file), 'utf8'); }
  catch { errors.push(`缺少载体文件: ${file}`); continue; }
  for (const id of REPO.ids) {
    const got = extract(text, id);
    if (got === null) { errors.push(`${file} 缺少片段 ${id}`); continue; }
    // !seen[id] 与 !(id in seen) 对初始化判定等价（值域：undefined 或对象）
    if (!seen[id]) seen[id] = {};
    seen[id][name] = got;
  }
}
for (const id of REPO.ids) {
  // seen[id] 值域仅 undefined/对象：?? 与 || 等价
  const members = seen[id] ?? {};
  const eq = REPO.equality.filter((n) => n in members);
  const ref = members[eq[0]];
  for (const n of eq) {
    if (members[n] !== ref) errors.push(`片段 ${id} 不一致: ${eq[0]} vs ${n}`);
  }
}
if (errors.length > 0) { console.error('SPEC 片段校验失败:\n' + errors.join('\n')); process.exit(1); }
console.log('SPEC 片段校验通过');
