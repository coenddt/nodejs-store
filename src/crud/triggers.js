'use strict';

/**
 * 触发链执行器（Host 侧）：占位符替换 → 命中判定 → 依序执行（命令式 / 回调式）。
 *
 * 边界：core 已产出 steps（含占位符、onFields、when）；本模块只做**运行时事实判定**
 * （before/after 实际值）与执行，落在调用方的 runAtomic 作用域内 → 单源同事务。
 * 去重：同一次顶层调用内 `(step.name, _id)` 只执行一次（防重复触发）。
 * 不做级联：触发写不再触发任何触发器（首批契约，见总纲）。
 */

const { _exec } = require('./exec');

let _store = null;                    // 装配期由 index.js 注入（避免循环 require）
let _triggerFns = Object.create(null);
const _fnRefs = new Set();

function setStore(s) { _store = s; }

/** 回调注入：`fnRef → impl(args, ctx, { store })`（可为 async） */
function setTriggerFn(fnRef, impl) {
  if (typeof fnRef !== 'string' || !fnRef) throw new Error('ERR_TRIGGER_FN_REF:fnRef 须为非空字符串');
  if (typeof impl !== 'function') throw new Error('ERR_TRIGGER_FN_IMPL:impl 须为函数');
  _triggerFns[fnRef] = impl;
  _fnRefs.add(fnRef);
}

/** 启动期校验：schema 的 triggers 里声明的 fnRef 必须都有实现（缺则显式抛错，不静默）。
 * 注意：声明形状的 fnRef 在顶层（规划展开后才包成 `callback:{fnRef,args}`），见 core schema/triggers.rs */
function assertTriggerFnsCovered(defns) {
  const missing = [];
  for (const defn of defns || []) {
    for (const list of Object.values((defn && defn.triggers) || {})) {
      for (const t of list || []) {
        const ref = t && typeof t.fnRef === 'string' ? t.fnRef : null;
        if (ref && !_fnRefs.has(ref)) missing.push(ref);
      }
    }
  }
  if (missing.length) {
    const err = new Error(`ERR_TRIGGER_FN_MISSING:未注入触发器回调实现 ${missing.join(', ')}`);
    err.code = 'ERR_TRIGGER_FN_MISSING';
    throw err;
  }
}

// ─── 占位符（整值替换；禁内嵌拼接） ───────────────────────────

const _ROOT_PH = /^\{\{root\.([A-Za-z0-9_.]+)\}\}$/;
const _BEFORE_PH = /^\{\{before\.([A-Za-z0-9_.]+)\}\}$/;
const _NOW_PH = /^\{\{now\}\}$/;

/** 点路径取值；缺失 → undefined（不抛） */
function _dig(obj, path) {
  if (obj === null || obj === undefined) return undefined;
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 深比较（结构相等；顺序无关的比较用递归对象遍历） */
function _deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => _deepEq(a[k], b[k]));
}

/**
 * 深替换触发器步骤中的占位符。
 * 未命中的占位符**显式报错**（`ERR_TRIGGER_PLACEHOLDER`）——占位符必须独占字符串值，
 * 不支持 `"order-{{root._id}}"` 这类内嵌拼接（禁静默漂移）。
 */
function resolveTriggerPlaceholders(value, scope) {
  if (typeof value === 'string') {
    if (_NOW_PH.test(value)) return scope.now;
    let m = value.match(_ROOT_PH);
    if (m) return _dig(scope.root, m[1]);
    m = value.match(_BEFORE_PH);
    if (m) return _dig(scope.before, m[1]);
    if (value.includes('{{root.') || value.includes('{{before.') || value.includes('{{now}}')) {
      throw new Error(
        `ERR_TRIGGER_PLACEHOLDER:占位符必须独占字符串值（不支持内嵌拼接）：${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveTriggerPlaceholders(v, scope));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTriggerPlaceholders(v, scope);
    return out;
  }
  return value;
}

// ─── when 求值（极简文法；未知算子显式 Err） ──────────────────

const _WHEN_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'and', 'or', 'not']);

function evalWhen(when, scope) {
  if (when === null || when === undefined) return true;
  const keys = Object.keys(when);
  if (keys.length !== 1) throw new Error('ERR_TRIGGER_WHEN:when 必须且只能有一个算子键');
  const op = keys[0];
  if (!_WHEN_OPS.has(op)) throw new Error(`ERR_TRIGGER_WHEN:未知算子 ${op}`);
  const arg = when[op];
  const rv = (v) => resolveTriggerPlaceholders(v, scope);
  switch (op) {
    case 'eq': return rv(arg[0]) === rv(arg[1]);
    case 'ne': return rv(arg[0]) !== rv(arg[1]);
    case 'gt': return rv(arg[0]) > rv(arg[1]);
    case 'gte': return rv(arg[0]) >= rv(arg[1]);
    case 'lt': return rv(arg[0]) < rv(arg[1]);
    case 'lte': return rv(arg[0]) <= rv(arg[1]);
    case 'in': return (rv(arg[1]) || []).includes(rv(arg[0]));
    case 'and': return (arg || []).every((w) => evalWhen(w, scope));
    case 'or': return (arg || []).some((w) => evalWhen(w, scope));
    case 'not': return !evalWhen(arg, scope);
    default: throw new Error(`ERR_TRIGGER_WHEN:未知算子 ${op}`);
  }
}

// ─── 命中判定 + 执行器 ───────────────────────────────────────

/**
 * 命中判定：`onFields 值真的变化` → `when 成立`。
 * `onFields` 为空（记录级）或事件为 insert（无 before）时跳过字段级检查。
 */
function hitTrigger(step, { before, after, scope }) {
  const on = step.onFields || [];
  if (on.length && before !== null && before !== undefined) {
    const changed = on.some((f) => !_deepEq(_dig(before, f), _dig(after, f)));   // no-op 抑制
    if (!changed) return false;
  }
  return evalWhen(step.when, scope);
}

/**
 * 依序执行触发链。
 * @param steps core 产出的 triggers 数组
 * @param {{root:any, before:any, now:number, ctx:any, executed:Set<string>}} opts
 */
async function runTriggers(steps, opts) {
  const { root, before, now, ctx, executed } = opts;
  for (const step of steps || []) {
    const key = `${step.name}#${_dig(root, '_id') ?? ''}`;
    if (executed.has(key)) continue;                    // 同事务去重
    const scope = { root, before, now };
    if (!hitTrigger(step, { before, after: root, scope })) continue;
    executed.add(key);
    if (step.command) {
      await _exec(resolveTriggerPlaceholders(step.command, scope));
    } else if (step.callback) {
      const impl = _triggerFns[step.callback.fnRef];
      if (!impl) {
        throw new Error(`ERR_TRIGGER_FN_MISSING:未注入触发器回调 ${step.callback.fnRef}`);
      }
      const args = resolveTriggerPlaceholders(step.callback.args, scope);
      // 回调内 store.* 经 resolveConnection 落到当前事务连接 → 与主写同事务
      await impl(args, ctx, { store: _store });
    }
  }
}

module.exports = {
  setStore, setTriggerFn, assertTriggerFnsCovered,
  resolveTriggerPlaceholders, evalWhen, hitTrigger, runTriggers,
};
