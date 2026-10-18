'use strict';

/**
 * 向量检索降级扫描（03 执行文档 §4.7）
 *
 * 把 `$vectorSearch` 从聚合管道剥离 → 先取候选行 → 交 core `localEval` 精确打分。
 * 适用于不支持 `$vectorSearch` 阶段的后端（MySQL / SQLite / 非 Atlas 的自建 Mongo），
 * 以及 PostgreSQL 带 filter（近似索引退化为后过滤）的场景；
 * PostgreSQL 无过滤走原生 SQL，local / memory 由 core 直接求值，均不进入本模块。
 *
 * 硬约束：
 *  - 候选行必须含向量字段（候选管道只保留 `$match`，不投影 → 全字段天然含 path）；
 *  - 候选行数 > MAX_VECTOR_SCAN_ROWS → Err code=vectorScanOverflow（禁止静默截断）；
 *  - 打分与 TopK 一律调 `core.localEval`，宿主不得自实现余弦。
 */

const MAX_VECTOR_SCAN_ROWS = 100_000;

/** 向量降级统一 hint（05 §4.9，node/py 逐字一致） */
const DEGRADED_HINT = '需要原生 TopK 与更低延迟请改用 postgres(pgvector) 或 MongoDB Atlas（索引声明 options.indexName）';

/** 各后端向量降级文案（05 §4.9，逐字） */
const DEGRADED_MESSAGES = {
  mysql: '数据源 mysql 无原生向量索引，本次按应用层精确检索（结果已按 _score 降序）',
  sqlite: '数据源 sqlite 无原生向量索引（vec0 未启用），本次按应用层精确检索（结果已按 _score 降序）',
  mongodb: '数据源 mongodb 未声明 Atlas Search 索引，本次按应用层精确检索（结果已按 _score 降序）',
  postgres: '数据源 postgres 的 pgvector 近似索引为后过滤，本次降级为精确检索以保证 ACL 与 TopK 正确',
};

/** 默认 Registry 单例（`localEval` 是实例方法；纯函数，可安全复用） */
let _defaultRegistry = null;

function _registry(core) {
  if (core && typeof core.localEval === 'function') return core;
  if (_defaultRegistry === null) {
    const mod = require('./core');
    _defaultRegistry = new mod.Registry();
  }
  return _defaultRegistry;
}

/** 命令是否为 `$vectorSearch` 打头的聚合 */
function isVectorCommand(cmd) {
  return (
    !!cmd &&
    cmd.kind === 'aggregate' &&
    Array.isArray(cmd.pipeline) &&
    cmd.pipeline.length > 0 &&
    !!cmd.pipeline[0] &&
    typeof cmd.pipeline[0] === 'object' &&
    !!cmd.pipeline[0].$vectorSearch
  );
}

/**
 * 该命令能否在本后端走降级扫描。
 *
 * backend 为连接 kind（mysql / postgres / sqlite）或 `'mongo'`；
 * postgres 无过滤时由方言翻译为原生 SQL（pgvector TopK），带过滤时近似索引退化为
 * 后过滤（ACL / TopK 不成立）→ 本后端回退应用层精确扫描（运行期降级，不改静态 native）。
 */
function canScan(cmd, backend) {
  if (!isVectorCommand(cmd)) return false;
  if (backend === 'postgres') return hasFilter(cmd);
  return true;
}

/** `$vectorSearch.filter` 是否有实际条件（缺省 / 空对象视为无过滤） */
function hasFilter(cmd) {
  const spec = cmd && Array.isArray(cmd.pipeline) ? cmd.pipeline[0].$vectorSearch : null;
  const f = spec && spec.filter;
  return !!f && typeof f === 'object' && Object.keys(f).length > 0;
}

/** `$addFields: { _score: { $meta: 'vectorSearchScore' } }`（core 紧随 `$vectorSearch` 产出） */
function _isScoreStage(stage) {
  if (!stage || typeof stage !== 'object' || !stage.$addFields) return false;
  const keys = Object.keys(stage.$addFields);
  if (keys.length !== 1 || keys[0] !== '_score') return false;
  const expr = stage.$addFields._score;
  return !!expr && typeof expr === 'object' && expr.$meta === 'vectorSearchScore';
}

/** 递归剔除 `_score` 条件（未打分前该字段不存在）；空对象返回 null */
function _stripScore(node) {
  if (Array.isArray(node)) {
    const arr = node.map(_stripScore).filter((x) => x !== null);
    return arr.length > 0 ? arr : null;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '_score') continue;
      const s = _stripScore(v);
      if (s === null) continue;
      out[k] = s;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return node;
}

/**
 * 候选过滤管道：`$vectorSearch.filter` → `$match`，加上残余 `$match`；
 * 其余阶段（`$limit` / `$project` / `$sort` …）一律不进入候选阶段
 * （TopK 与投影由第 3 段按原始完整管道重放）。
 */
function _candidatePipeline(filter, rest) {
  const out = [];
  if (filter !== undefined && filter !== null) {
    const f = _stripScore(filter);
    if (f) out.push({ $match: f });
  }
  for (const stage of rest) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) continue;
    const keys = Object.keys(stage);
    if (keys.length !== 1 || keys[0] !== '$match') continue;
    const m = _stripScore(stage.$match);
    if (m) out.push({ $match: m });
  }
  return out;
}

/**
 * 降级扫描：剥离 → 取候选 → core 精确打分。
 *
 * @param {object} cmd     aggregate 命令：`{ kind:'aggregate', collection, pipeline }`（逻辑名）
 * @param {object} options
 * @param {function} options.exec  以候选命令执行普通 aggregate 的函数（返回行数组）
 * @param {object} [options.core]  提供 `localEval(collections, command)` 的对象（缺省 Registry 单例）
 * @param {number} [options.maxRows=MAX_VECTOR_SCAN_ROWS]
 * @returns {Promise<object[]>} 最终行（含 `_score`）
 */
async function scan(cmd, { exec, core, maxRows = MAX_VECTOR_SCAN_ROWS } = {}) {
  if (typeof exec !== 'function') {
    throw new TypeError('vector-scan.scan 需要 exec(candidateCommand)（返回行数组）');
  }
  if (!isVectorCommand(cmd)) {
    throw new Error('vector-scan.scan 只接受首阶段为 $vectorSearch 的 aggregate 命令');
  }
  const pipeline = cmd.pipeline;
  const spec = pipeline[0].$vectorSearch;
  if (!spec || typeof spec !== 'object' || typeof spec.path !== 'string' || spec.path === '') {
    throw new Error('vector-scan.scan: $vectorSearch 缺少 path（向量字段名）');
  }

  // 1. 剥离 `$vectorSearch` 与紧随的 `$addFields._score`
  const rest = pipeline.slice(1);
  if (rest.length > 0 && _isScoreStage(rest[0])) rest.shift();
  const candidate = _candidatePipeline(spec.filter, rest);

  // 2. 取候选（无 $limit；全字段 → 必然包含向量字段）
  const rows = await exec({ ...cmd, pipeline: candidate });
  if (!Array.isArray(rows)) {
    throw new Error(`vector-scan.scan: 候选阶段返回非数组（${typeof rows}）`);
  }
  if (rows.length > maxRows) {
    const err = new Error(
      `vectorScanOverflow：候选行数 ${rows.length} 超过上限 ${maxRows}`
        + '（禁止静默截断，请先缩小过滤条件）',
    );
    err.code = 'vectorScanOverflow';
    err.candidateRows = rows.length;
    err.maxRows = maxRows;
    throw err;
  }

  // 3. 精确打分：原始完整管道（`$vectorSearch` / `_score` / residual `$match` / `$limit`）
  const out = _registry(core).localEval(
    { [cmd.collection]: rows },
    { kind: 'aggregate', collection: cmd.collection, pipeline },
  );
  return out.result;
}

/**
 * 真实 Mongo 驱动执行前剥离 core 内部元数据键 `$vectorSearch.metric`
 * （Atlas 阶段只认官方键；local 求值仍需该键，故只作用于物理命令副本）。
 */
function stripVectorMeta(cmd) {
  if (!cmd || !Array.isArray(cmd.pipeline)) return cmd;
  for (const stage of cmd.pipeline) {
    if (stage && typeof stage === 'object' && stage.$vectorSearch
      && typeof stage.$vectorSearch === 'object') {
      delete stage.$vectorSearch.metric;
    }
  }
  return cmd;
}

/**
 * Mongo 驱动是否因「不认识 `$vectorSearch` 阶段」而报错。
 * 只认该形态（code 40324 或 Unrecognized pipeline stage），其余错误原样上抛。
 */
function isUnsupportedStageError(err) {
  if (!err) return false;
  if (err.code === 40324) return true;
  const msg = String(err.message || err);
  return /unrecognized pipeline stage/i.test(msg) && msg.includes('$vectorSearch');
}

module.exports = {
  MAX_VECTOR_SCAN_ROWS,
  DEGRADED_HINT,
  DEGRADED_MESSAGES,
  canScan,
  hasFilter,
  isVectorCommand,
  scan,
  stripVectorMeta,
  isUnsupportedStageError,
};
