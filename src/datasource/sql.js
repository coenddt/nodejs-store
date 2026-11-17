'use strict';

/**
 * SQL 执行路径（D4-4 零语义拆分自 datasource.js）
 *
 * 承载：translate → exec → 结果塑形、向量检索降级回退、MySQL 两步化 claim /
 * compareAndSet 的占位符回填。本模块只依赖 schema / executors / 错误类，不反向指向
 * 连接层（connection 由调用方传入），是加载图叶子。
 */

const { getCore } = require('../schema');
const { emit: _emitFeedback } = require('../feedback-core');
const { PushdownUnsupportedError } = require('../errors');
const executors = require('../executors');
const vectorScan = require('../vector-scan');
const degraded = require('../degraded');

/**
 * SQL 路径：translate（core 纯逻辑）→ exec（连接执行器）→ 结果塑形
 *
 * 执行器只做「绑定参数 + 执行 + restoreRows」，返回中立包络；此处依 command.kind
 * 塑形为 Mongo 驱动等价返回值（见 `./executors/index.js#shapeResult`），
 * 使上层（crud/*）对 Mongo / SQL 两条路径无感。
 */
async function execSql(source, connection, cmd) {
  // 向量检索降级（03 §4.7 / 05 §4.9）：MySQL / SQLite 不支持 `$vectorSearch` → 取候选 + core 精确打分；
  // PostgreSQL 无过滤由方言翻译为 pgvector SQL；带过滤时近似索引退化为后过滤（ACL / TopK 不成立），
  // 同样回退应用层精确扫描 —— 均为运行期降级，不改变静态 native 判定
  if (vectorScan.canScan(cmd, connection.kind)) {
    const spec = cmd.pipeline[0].$vectorSearch;
    degraded.vectorDegraded({
      backend: connection.kind,
      field: spec.path,
      metric: spec.metric,
      message: vectorScan.DEGRADED_MESSAGES[connection.kind],
      hint: vectorScan.DEGRADED_HINT,
    });
    return vectorScan.scan(cmd, {
      exec: (candidate) => _execSqlDirect(source, connection, candidate),
    });
  }
  return _execSqlDirect(source, connection, cmd);
}

/** MySQL 两步化 claim / compareAndSet 的 SQL 文本占位符（core 规划产物；
 * 领取结果在下一条 stmt 文本中占位，由 `_execClaim` 回填） */
const _CLAIMED_IDS = '___claimed_ids___';

/** `_id` 列表 → SQL IN **列表字面量**（不含外层括号；core 模板已写作 `IN (___claimed_ids___)`）。
 *
 * 单引号转义（`_id` 为框架生成值，转义为防御）。带括号回填后成 `IN (('a','b'))`——
 * MySQL 视作单个行构造器，与非行操作数比较报 1241。
 */
function _renderClaimedIds(ids) {
  return ids.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
}

/** 识别 MySQL 两步化 claim / compareAndSet 计划。
 *
 * 返回 `[stmt0, stmt1]`；非两步化计划返回 null。PG/SQLite 走单条 UPDATE…RETURNING
 * 或 IN(子查询)，不出现该形态。
 * @returns {[any, any]|null}
 */
function _claimTwoStep(plan) {
  const stmts = (plan && plan.stmts) || [];
  if (stmts.length < 2) return null;
  const text = typeof stmts[1].text === 'string' ? stmts[1].text : '';
  if (!text.includes(_CLAIMED_IDS)) return null;
  return [stmts[0], stmts[1]];
}

/** 执行两步化 claim：先取命中 `_id`，回填 SQL 文本占位符后再执行置标语句。
 *
 * 跳过回填会让驱动直接报 `1054 Unknown column '___claimed_ids___'`（禁静默失守）。
 * 零领取不执行置标语句（与 runAtomicCommands 零领取直接返回空一致）。
 */
async function _execClaim(connection, cmd, [first, second]) {
  const env = await connection.exec({ stmts: [first] });
  const ids = ((env && env.rows) || [])
    .filter((r) => r && typeof r === 'object' && '_id' in r)
    .map((r) => r._id);
  if (ids.length === 0) {
    return executors.shapeResult(cmd, { docs: null, rows: [], affectedRows: 0, insertId: null });
  }
  const stmt = { ...second, text: second.text.replace(_CLAIMED_IDS, _renderClaimedIds(ids)) };
  const out = await connection.exec({ stmts: [stmt] });
  // docs 置 null：首条只取 _id，其 restore 出的残行不能当作完整领取结果
  // （「docs 直返」分支专为 SQLite UPDATE…RETURNING 设计）
  return executors.shapeResult(cmd, {
    docs: null, rows: env.rows, affectedRows: out.affectedRows, insertId: null,
  });
}

/** `execSql` 的直通路径（不做向量降级） */
async function _execSqlDirect(source, connection, cmd) {
  const plan = getCore().dialectTranslate(connection.kind, cmd);
  // Host 兜底：core 标记了无法安全下推的组合（如 $lookup 子 $limit 每父 top-N）时，
  // 绝不执行「缺少该段」的 SQL（会静默返回错误结果），改为显式报错，由调用方降级重查。
  // 先于执行器检查 —— 命令本身不可安全下推时，报下推不支持而非「执行器未接入」
  // （对齐 py_store/datasource.py#exec_sql 的检查次序）。
  if (Array.isArray(plan.unsupported) && plan.unsupported.length > 0) {
    const err = new PushdownUnsupportedError(
      source,
      connection.kind,
      plan.unsupported.map((u) => (u && u.code) || String(u)),
      (plan.warnings || []).map((w) => String(w)),
    );
    // 自动反馈：拦截即告警（无 sink 时打 stderr），禁止静默失守
    _emitFeedback(err.feedback());
    throw err;
  }
  if (typeof connection.exec !== 'function') {
    throw new Error(
      `SQL 数据源 ${source}(${connection.kind}) 的执行器未接入（见执行文档 Phase 4）`,
    );
  }
  const step = _claimTwoStep(plan);
  if (step) return _execClaim(connection, cmd, step);
  const out = await connection.exec(plan);
  return executors.shapeResult(cmd, out);
}

module.exports = {
  execSql,
  _execSqlDirect,
  _claimTwoStep,
  _execClaim,
  _renderClaimedIds,
};
