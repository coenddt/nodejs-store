'use strict';

/**
 * 宿主定时任务插件 —— schema `triggers.schedule` 的运行时
 *
 * 职责：自写 5 段 cron 匹配（分 时 日 月 周；`* , - /` 与数字；禁秒级/宏/新依赖）
 * → 分钟对齐循环 → 到点经 core `expandScheduleTriggers` 枚举 step 并复用触发链
 * 执行器（`crud/triggers.js`）执行。判决唯一在 core（cron 合法性注册期已校验），
 * 本模块只消费 step（总纲 §5）。
 *
 * 语义边界：
 *   - `{{now}}` 占位符 = 毫秒时间戳（schedule body 仅 `{{now}}` 合法，core 注册期
 *     已禁 `{{root.` / `{{before.`）；`root`/`before` 恒 null；
 *   - 到点执行失败**上抛**（tickOnce fail-fast）；分钟循环内 catch 后走统一反馈
 *     通道告警并继续下一轮（禁静默跳过，也不让循环死掉）；
 *   - 错过即跳过、不补跑（无持久化，见总纲 §0）；
 *   - 不做级联：schedule step 的触发写不再触发任何触发器（与写链一致）。
 *
 * 对齐 `py-store/src/py_store/scheduler/__init__.py`（同语义驼峰实现）。
 */

const { core: _core } = require('../schema');
const { _ctx } = require('../crud/exec');
const { runTriggers } = require('../crud/triggers');
const { emit: _emitFeedback } = require('../feedback');

// ─── cron 5 段匹配器（分 时 日 月 周） ─────────────────────────

// 各段取值范围（周 0-7：0 与 7 均为周日，归一到 0）
const _RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function _bad(msg) {
  const err = new Error(`ERR_CRON:${msg}`);
  err.code = 'ERR_CRON';
  return err;
}

/** 解析单段为取值集合（`*` | `n` | `a-b` | `*`/s | `a-b`/s | `a`/s；列表 `,`） */
function _parseField(spec, idx) {
  const [min, max] = _RANGES[idx];
  const out = new Set();
  for (const part of String(spec).split(',')) {
    if (!part) throw _bad(`第 ${idx + 1} 段存在空项：「${spec}」`);
    const slash = part.split('/');
    if (slash.length > 2) throw _bad(`步长段非法：「${part}」`);
    let base = slash[0];
    let step = 1;
    if (slash.length === 2) {
      if (!/^\d+$/.test(slash[1]) || Number(slash[1]) < 1) throw _bad(`步长非法：「${part}」`);
      step = Number(slash[1]);
    }
    let lo;
    let hi;
    if (base === '*') {
      lo = min; hi = max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw _bad(`范围非法：「${part}」`);
      lo = Number(a); hi = Number(b);
      if (lo > hi) throw _bad(`范围起点大于终点：「${part}」`);
    } else {
      if (!/^\d+$/.test(base)) throw _bad(`非法字符：「${part}」`);
      lo = Number(base);
      // `a/s` 等价 `a-max/s`（从 a 起按步长到段末）
      hi = slash.length === 2 ? max : lo;
    }
    if (lo < min || hi > max) throw _bad(`超出范围（${min}-${max}）：「${part}」`);
    for (let v = lo; v <= hi; v += step) out.add(idx === 4 && v === 7 ? 0 : v);
  }
  return out;
}

/** 解析 5 段 cron → 段集合数组（`[{anyDom, anyDow, sets}]` 由 cronMatches 消费） */
function parseCron(expr) {
  const segs = String(expr).trim().split(/\s+/);
  if (segs.length !== 5) throw _bad(`必须为 5 段（分 时 日 月 周）：「${expr}」`);
  return {
    sets: segs.map((s, i) => _parseField(s, i)),
    // 日/周组合（Vixie 语义）：两段都限定（非 `*`）时任一命中即触发，否则都要命中
    anyDom: segs[2] !== '*',
    anyDow: segs[4] !== '*',
  };
}

/** cron 与时刻（本地时间分量）是否匹配 */
function cronMatches(expr, date) {
  const { sets, anyDom, anyDow } = parseCron(expr);
  if (!sets[0].has(date.getMinutes())) return false;
  if (!sets[1].has(date.getHours())) return false;
  if (!sets[3].has(date.getMonth() + 1)) return false;
  const domOk = sets[2].has(date.getDate());
  const dowOk = sets[4].has(date.getDay());      // getDay：0=周日（与归一一致）
  if (anyDom && anyDow) return domOk || dowOk;
  return domOk && dowOk;
}

// ─── tickOnce：枚举到期 schedule 触发器并执行 ──────────────────

/**
 * 执行一轮：枚举全部 schedule 触发器，cron 命中 `now` 的依序执行 step。
 * @param {number} [nowMs] 毫秒时刻（缺省 Date.now()；测试注入固定时刻）
 * @returns {Promise<Array<{schema, name}>>} 本轮实际触发清单
 */
async function tickOnce(nowMs = null) {
  const now = nowMs ?? Date.now();
  const date = new Date(now);
  const entries = _core.expandScheduleTriggers(_ctx());
  const fired = [];
  for (const entry of entries) {
    if (!cronMatches(entry.cron, date)) continue;
    // 每条独立去重集合：跨条目同名 step 互不去重（去重键不含 schema，撞键会误跳）
    await runTriggers([entry.step],
      { root: null, before: null, now, ctx: _ctx(), executed: new Set() });
    fired.push({ schema: entry.schema, name: entry.name });
  }
  return fired;
}

// ─── 分钟对齐循环 ─────────────────────────────────────────────

let _timer = null;

/** 距下一分钟边界的毫秒数 */
function _msToNextMinute() {
  return 60000 - (Date.now() % 60000);
}

/** 启动分钟对齐循环（幂等）；单轮失败走反馈通道告警，循环继续（禁静默失守） */
function start() {
  if (_timer !== null) return;
  const loop = async () => {
    try {
      await tickOnce();
    } catch (e) {
      _emitFeedback({
        type: 'schedule_tick_failed',
        code: 'scheduleTickFailed',
        layer: 'host',
        message: `定时触发器执行失败：${e && e.message ? e.message : e}`,
        hint: 'schedule step 执行失败已上抛并在循环内告警；修复触发器声明或回调实现后重启循环',
      });
    }
    _timer = setTimeout(loop, _msToNextMinute());
  };
  _timer = setTimeout(loop, _msToNextMinute());
}

/** 停止循环（幂等） */
function stop() {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}

module.exports = { parseCron, cronMatches, tickOnce, start, stop };
