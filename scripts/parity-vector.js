'use strict';

/**
 * 向量 conformance 文本对拍：抽取两宿主测试文件内 VECTOR-CONFORMANCE 标记之间的
 * 内容（去掉语言外壳行），比较 sha256；同级 py-store 缺失时 skip（退出码 0）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NODE_FILE = path.join(__dirname, '..', 'tests', 'vector-conformance.test.js');
const PY_FILE = process.env.PY_STORE_DIR
  ? path.join(process.env.PY_STORE_DIR, 'tests', 'test_vector_conformance.py')
  : path.join(__dirname, '..', '..', 'py-store', 'tests', 'test_vector_conformance.py');

function body(file, open, close) {
  const text = fs.readFileSync(file, 'utf8');
  const s = text.indexOf(open);
  const e = text.indexOf(close);
  if (s < 0 || e < 0 || e < s) throw new Error(`ERR_PARITY_MARKER:${file} 缺少标记`);
  // 只取 JSON 原文：从第一个 '{' 到最后一个 '}'
  const seg = text.slice(s + open.length, e);
  const a = seg.indexOf('{');
  const b = seg.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error(`ERR_PARITY_JSON:${file} 标记内无 JSON 对象`);
  return JSON.stringify(JSON.parse(seg.slice(a, b + 1)));
}

if (!fs.existsSync(PY_FILE)) {
  console.log(`[parity-vector] skip: 未找到 ${PY_FILE}`);
  process.exit(0);
}
const h = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const n = h(body(NODE_FILE, 'VECTOR-CONFORMANCE-BEGIN', 'VECTOR-CONFORMANCE-END'));
const p = h(body(PY_FILE, 'VECTOR-CONFORMANCE-BEGIN', 'VECTOR-CONFORMANCE-END'));
if (n !== p) {
  console.error(`[parity-vector] 不一致\n  node=${n}\n  py  =${p}`);
  process.exit(1);
}
console.log(`[parity-vector] ok ${n}`);
