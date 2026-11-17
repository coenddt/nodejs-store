'use strict';

/**
 * 归一与深比较（D4-4 零语义拆分自 harness-lib.js）。
 *
 * 两场景 harness 的对拍基础：行集归一（剔 ignore 键 / 递归 _id 排序 / 按 sortBy 排序）
 * 与键集严格一致的深比较。纯函数、无 IO、无状态——与后端无关，故独立成模块。
 * 语义说明见 harness-lib.js 模块头「零语义说明」段（逐行核对结论不变）。
 */

/** 递归把「元素全为含 _id 对象的数组」按 _id 归一，保证关系子数组跨后端可比 */
function deepSortValue(v) {
  if (Array.isArray(v)) {
    const out = v.map(deepSortValue);
    if (out.length && out.every((x) => x && typeof x === 'object' && !Array.isArray(x) && '_id' in x)) {
      out.sort((a, b) => compareValues(a._id, b._id));
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepSortValue(v[k]);
    return o;
  }
  return v;
}

/** 键递归排序的稳定序列化（等价 py `json.dumps(sort_keys=True)`） */
function stableKey(v) {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v);
}

/** 0/-0 视为相等（等价 py 数值比较语义），其余严格 */
function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 嵌套键版排序比较（`k.split('.')` 逐段下钻；对平键与直接取键等价） */
function compareRow(a, b, sortBy) {
  for (const k of sortBy) {
    let va = a;
    let vb = b;
    for (const seg of k.split('.')) {
      va = va && typeof va === 'object' ? va[seg] : undefined;
      vb = vb && typeof vb === 'object' ? vb[seg] : undefined;
    }
    const c = compareValues(va, vb);
    if (c !== 0) return c;
  }
  return 0;
}

/** 行集归一：剔 ignore 键 → 递归 _id 排序 → 按 sortBy（缺省 JSON 序列化）排序 */
function normRows(rows, normalize) {
  const ignore = (normalize && normalize.ignore) || [];
  let out = (rows || []).map((r) => {
    const o = {};
    for (const k of Object.keys(r)) if (!ignore.includes(k)) o[k] = r[k];
    return deepSortValue(o);
  });
  const sortBy = normalize && normalize.sortBy;
  if (sortBy && sortBy.length) out.sort((a, b) => compareRow(a, b, sortBy));
  else out.sort((a, b) => compareValues(stableKey(a), stableKey(b)));
  return out;
}

/** 数组分支：长度一致 + 逐位递归 */
function _deepEqArr(a, b) {
  return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
}

/** 普通对象分支：键集严格一致 + 逐键递归 */
function _deepEqObj(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
}

/** 深比较（键集严格一致；数值 0/-0 视为相等，对齐 py 语义） */
function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return _deepEqArr(a, b);
  if (
    a && b && typeof a === 'object' && typeof b === 'object'
    && !Array.isArray(a) && !Array.isArray(b)
  ) {
    return _deepEqObj(a, b);
  }
  return false;
}

const isSqlBackend = (kind) => kind !== 'mongodb';

module.exports = {
  deepSortValue,
  stableKey,
  compareValues,
  compareRow,
  normRows,
  deepEq,
  isSqlBackend,
};
