'use strict';

/**
 * 命令执行（唯一 IO 边界） + 占位符替换 + core 调用包装
 *
 * 全部纯逻辑（GQL 解析、权限、命令规划、结果后处理）都在 Rust core；
 * 本模块只做 Host 三件事里最底层的一件：把 core 产出的 Command JSON
 * 路由到对应数据源连接并执行。不确定性输入由本层供给（now 时钟）。
 *
 * 路由规则见 `../datasource`：命令自带 `source` / `database` / `schema` / `collection`
 * 定位四元组，按 `source` 选连接、`database`（PG 另加 `schema`）定位连接内的库/schema
 * （Mongo 双形态严格校验），Mongo 走原生驱动（命令先经 `./naming` 翻译为物理名、
 * 结果再回映射为逻辑名），SQL 走 `translate → exec`。
 */

const { PermissionError, NoContextError, getContext } = require('../permission');
const datasource = require('../datasource');
const { execMongo } = require('../executors/mongo');
const { emit: _emitFeedback } = require('../feedback');
const { get: _getSchema } = require('../schema');
const { _toMongo, _toLogical } = require('../naming');

const _PHASE1_IDS = /^\{\{phase1\.ids\}\}$/;
const _STEP_PH = /^\{\{step\.(\d+)\._id\}\}$/;

/**
 * 权限类错误识别：core 权限错误统一携带 `ERR_PERMISSION:` 稳定前缀（见 core
 * `command/mod.rs::ERR_PERM_PREFIX`），按**前缀**映射而非具体文案 —— core 文案
 * 可自由调整，映射不随文案漂移而静默失效。构造 PermissionError 时剥离前缀。
 */
const _PERM_PREFIX = 'ERR_PERMISSION:';

/**
 * 档位类错误识别：core text2query 档门禁统一携带 `ERR_TEXT2QUERY:` 稳定前缀
 * （见 core `command/mod.rs::ERR_TEXT2QUERY`），同上按前缀映射。命中即 emit
 * 反馈事件 `profile_blocked`（自动反馈原则：允许拦截，禁止静默）。
 */
const _PROFILE_PREFIX = 'ERR_TEXT2QUERY:';

/**
 * 上下文缺失识别：core fail-secure（require_context / secureMode）下无 ctx 时统一携带
 * `ERR_NO_CONTEXT:` 稳定前缀（见 core `command/mod.rs`），同上按前缀映射。命中即抛
 * `NoContextError`（与 PermissionError 同档 403；前缀剥离）。
 */
const _NO_CONTEXT_PREFIX = 'ERR_NO_CONTEXT:';

/**
 * 从 core 文案 `... [$feature]（功能收缩）` 中提取门禁项名；无 `[..]` 时留白
 * （null），不伪造 feature —— 缺值必须显式暴露（禁静默兜底）。
 */
const _FEATURE_RE = /\[(.+?)\]/;

/** 档位拦截反馈的统一提示（反馈事件契约 §4.6 的一部分；单点定义防文案漂移） */
const _PROFILE_HINT = '上游（LLM 产出的 GQL / 调用方入参）越界；text2query 档白名单见 SKILL.md §后端无关性与边界';

/**
 * 档位（profile）拒绝：text2query 档违反功能收缩 / 硬限制
 *
 * 与权限错误（`PermissionError`，403）区分：档位拒绝是**调用方合约违反**（400），
 * 非授权问题（见执行文档 §4.4）。`status` 供上层（HTTP 网关等）映射响应码。
 */
class ProfileViolation extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProfileViolation';
    this.status = status;
  }
}

/** 设置数据源连接映射（对 `../datasource` 的路由入口做包内透出） */
const setConnections = datasource.setConnections;

/** 单库简写：等价于 `setConnections({ default: db })`（对齐 py_store.crud.exec.set_db） */
function setDb(db) {
  datasource.setConnections({ [datasource.DEFAULT_SOURCE]: db });
}

/** 按 schema 的 timestamps 单位产出当前时间戳（'s' → 秒，其余/未启用 → 毫秒） */
function _nowFor(schemaName) {
  const unit = _getSchema(schemaName).timestampUnit;
  return unit === 's' ? Math.floor(Date.now() / 1000) : Date.now();
}

function _ctx() {
  return getContext() ?? null;
}

/**
 * 绑定层调用包装：
 *   - 权限类错误（`ERR_PERMISSION:` 前缀）→ PermissionError
 *   - 上下文缺失（`ERR_NO_CONTEXT:` 前缀）→ NoContextError（同档 403）
 *   - 档位类错误（`ERR_TEXT2QUERY:` 前缀）→ emit `profile_blocked` 反馈 + ProfileViolation
 *
 * 按前缀映射而非具体文案（core 文案可自由调整，映射不随文案漂移而静默失效）。
 * 其余异常原样上抛（不吞错）。
 */
function _call(fn) {
  try {
    return fn();
  } catch (e) {
    const msg = e && e.message;
    if (typeof msg === 'string' && msg.startsWith(_PERM_PREFIX)) {
      throw new PermissionError(msg.slice(_PERM_PREFIX.length));
    }
    if (typeof msg === 'string' && msg.startsWith(_NO_CONTEXT_PREFIX)) {
      throw new NoContextError(msg.slice(_NO_CONTEXT_PREFIX.length));
    }
    if (typeof msg === 'string' && msg.startsWith(_PROFILE_PREFIX)) {
      const detail = msg.slice(_PROFILE_PREFIX.length);
      const m = _FEATURE_RE.exec(detail);
      _emitFeedback({
        type: 'profile_blocked',
        code: 'profileBlocked',
        layer: 'core',
        profile: 'text2query',
        feature: m ? m[1] : null,
        message: detail,
        hint: _PROFILE_HINT,
      });
      throw new ProfileViolation(detail);
    }
    throw e;
  }
}

// ─── 命令执行（唯一 IO 边界） ────────────────────────────────

/** 在指定数据源上执行命令（Mongo 走原生驱动，SQL 走 translate → exec；
 * 事务 / 会话作用域内经 datasource.resolveConnection 落到事务专用连接） */
async function _execOn(source, cmd) {
  const connection = await datasource.resolveConnection(source, datasource.isWriteCommand(cmd));
  // 本地磁盘源：与 Mongo 同路径（复用 execMongo；handle 已绑定事务快照或直连 IO）
  if (datasource.isLocalConnection(connection)) {
    return _toLogical(await execMongo(connection.handle, _toMongo(cmd)), cmd);
  }
  if (connection && connection.kind === 'mongo') {
    // Mongo 事务视图：db 按命令 database 解析，session 透传给驱动
    const db = datasource.mongoDb(connection.conn, source, cmd.database ?? null);
    return _toLogical(await execMongo(db, _toMongo(cmd), connection.session), cmd);
  }
  const db = datasource.mongoDb(connection, source, cmd.database ?? null);
  if (db) {
    // Mongo 物理名翻译（逻辑 → camelCase）；执行后按 schema 逆表回映射（物理 → 逻辑）
    return _toLogical(await execMongo(db, _toMongo(cmd)), cmd);
  }
  return datasource.execSql(source, connection, cmd);
}

/** Command JSON → 按命令自带的 `source` 路由（不按 collection 反查） */
async function _exec(cmd) {
  return _execOn(cmd.source || datasource.DEFAULT_SOURCE, cmd);
}

/** 从规划结果中提取数据源集合（探针 / 写 / 查 / 删 / mutation 步骤命令）
 *
 * `sources` 必须由规划结果提取，不得写死 `default`（多租户路由场景下的
 * 源由 core 规划决定）。
 */
function sourcesOf(plan) {
  const out = new Set();
  for (const key of ['needsProbe', 'command', 'findCommand', 'deleteCommand']) {
    const cmd = (plan || {})[key] || {};
    if (cmd && Object.keys(cmd).length > 0) out.add(cmd.source || datasource.DEFAULT_SOURCE);
  }
  for (const step of (plan || {}).steps || []) {
    const cmd = (step || {}).command || {};
    if (cmd && Object.keys(cmd).length > 0) out.add(cmd.source || datasource.DEFAULT_SOURCE);
  }
  // 触发链命令的源（plan_insert 直接产出 triggers；plan_update 二次规划才产出）
  for (const t of (plan || {}).triggers || []) {
    const cmd = (t || {}).command || {};
    if (cmd && Object.keys(cmd).length > 0) out.add(cmd.source || datasource.DEFAULT_SOURCE);
  }
  return out.size > 0 ? out : new Set([datasource.DEFAULT_SOURCE]);
}

/**
 * 触发链触及源的原子性声明（update 专用：其 triggers 在事务内二次规划后才产出，
 * 顶层 `sourcesOf` 已不及）——触发源超出已声明源集时发 `non_atomic_write`
 * （含全部涉及源），此后顺序执行；会话内不发声明（跨源写由既有 fail-closed 拒绝）。
 */
function declareTriggerSources(baseSources, triggers) {
  const uniq = new Set(baseSources);
  for (const t of triggers || []) {
    const cmd = (t || {}).command || {};
    if (cmd && Object.keys(cmd).length > 0) uniq.add(cmd.source || datasource.DEFAULT_SOURCE);
  }
  if (uniq.size > 1 && datasource.currentSession() === null) warnMultiSource(uniq);
  return uniq;
}

/** 多源写：无法原子 → 程序化声明 nonAtomic（允许顺序执行，禁止静默） */
function warnMultiSource(sources) {
  const listed = Array.from(sources).sort();
  _emitFeedback({
    type: 'non_atomic_write',
    code: 'nonAtomic',
    layer: 'crud',
    message: `本次写调用跨 ${listed.length} 个数据源（${listed.join(', ')}）：无法原子，按顺序执行（非原子）`,
    hint: '把写操作收敛到单源；或在 store.session() 内执行以便跨源写被拒（fail-closed）',
    sources: listed,
  });
}

/**
 * 顶层 API 调用的原子包络：无会话 + 单一源（SQL 或 Mongo）→ 包事务；否则原样执行
 *
 *   - 会话内：事务边界由会话统一管理，直接执行（不嵌套）；
 *   - 单一 SQL 源：包事务（原子）；
 *   - 多源：无法原子 → 程序化声明 `nonAtomic`（反馈通道），再按顺序原样执行；
 *   - 单一 Mongo 源：按探测结果包 session 事务或降级声明（见 `runInTransaction`）；
 *   - 未配置源：按原样执行；
 *   - sources 由调用方从「规划结果」中提取（`sourcesOf`），命令源与事务源一致。
 */
async function runAtomic(sources, fn) {
  if (datasource.currentSession() !== null) return fn();
  const uniq = new Set(Array.from(sources, (s) => s || datasource.DEFAULT_SOURCE));
  if (uniq.size === 1) {
    const [source] = uniq;
    if (
      datasource.hasConnection(source) &&
      (datasource.isSql(source) || datasource.isMongoSource(source))
    ) {
      return datasource.runInTransaction(source, fn);
    }
  } else if (uniq.size > 1) {
    warnMultiSource(uniq);
  }
  return fn();
}

/** 深度替换命令中的占位符（命中 resolver 返回非字符串时替换） */
function _substitute(value, resolver) {
  if (typeof value === 'string') return resolver(value);
  if (Array.isArray(value)) return value.map((v) => _substitute(v, resolver));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _substitute(v, resolver);
    return out;
  }
  return value;
}

/**
 * Host 契约：把命令中的占位符替换为执行结果
 *
 *   - `{{phase1.ids}}`     → 两阶段查询第一步取回的 id 数组（整值替换）
 *   - `{{step.<N>._id}}`   → mutation 第 N 步执行结果的 _id
 *
 * 未命中的占位符原样保留（便于定位 core 与 Host 的契约漂移）。
 * Python 侧 `py_store.crud.exec.resolve_placeholders` 为同语义实现，
 * 两侧共测 `rust-store/fixtures/host/placeholders.json`。
 */
function resolvePlaceholders(command, { ids = null, steps = [] } = {}) {
  return _substitute(command, (s) => {
    if (_PHASE1_IDS.test(s)) return ids ?? s;
    const m = s.match(_STEP_PH);
    if (m) {
      const idx = Number(m[1]);
      if (idx < steps.length) return steps[idx];
    }
    return s;
  });
}

module.exports = {
  setConnections,
  setDb,
  _nowFor,
  _ctx,
  _call,
  ProfileViolation,
  _PROFILE_HINT,
  _exec,
  _execOn,
  runAtomic,
  declareTriggerSources,
  warnMultiSource,
  sourcesOf,
  _substitute,
  resolvePlaceholders,
};
