'use strict';

/**
 * 资源能力配置层（D4-4 零语义拆分自 resource/index.js）
 *
 * 承载：canonical 表名/字段映射常量与校验、provider 池构建（旧形状等价默认池 /
 * 新形状逐池）、`configure` 整体重赋值，以及池选取（`_requirePool`）。
 *
 * 配置状态（_cfg / _pool / _pools）随本模块迁出，对外只经 `getCfg` / `getPool`
 * 现场取值——每次调用读到的都是当前配置，与拆分前「模块级变量现场读」同语义。
 */

const providers = require('./providers');

const DEFAULT_SCHEMA = {
  resource: 'Resource',
  location: 'ResourceLocation',
  binding: 'ResourceBinding',
};

// 逻辑角色 → 物理字段名（canonical 缺省）。业务可经 configureResource({ fields }) 覆盖，
// 使资源三表的字段结构由业务 schema 自定义；缺省 = canonical（向后逐字节兼容）。
const DEFAULT_FIELDS = {
  resource: { sha1: 'sha1', fileName: 'fileName', mime: 'mime', size: 'size', kind: 'kind' },
  location: { resourceId: 'resourceId', backend: 'backend', key: 'key', status: 'status', priority: 'priority' },
  binding: { resourceId: 'resourceId', businessTable: 'businessTable', businessId: 'businessId', userId: 'userId' },
};

// 必填角色：值为 null / 非空字符串之外的任何值 → configure 抛错（该列缺失则引擎无法定位）
const REQUIRED_ROLES = {
  resource: ['sha1'],
  location: ['resourceId', 'backend', 'key'],
  binding: ['resourceId', 'businessTable', 'businessId'],
};

/**
 * 解析并校验 `cfg.fields`：未知表 / 未知角色 → 抛错；
 * 必填角色须为非空字符串；可选角色为「非空字符串」或 `null`（`null` = 跳过该列）。
 */

/** 单角色值校验：必填角色须非空字符串；可选角色非空字符串或 null（错误文案逐字不变） */
function _validateRoleValue(table, role, v) {
  const isStr = typeof v === 'string' && v !== '';
  if (REQUIRED_ROLES[table].includes(role)) {
    if (!isStr) throw new Error(`configureResource: fields.${table}.${role} 为必填角色，须为非空字符串`);
  } else if (v !== null && !isStr) {
    throw new Error(`configureResource: fields.${table}.${role} 须为非空字符串或 null`);
  }
}

/** 单表解析：形状/未知角色校验 + 映射合并 + 逐角色校验，返回 mapped */
function _parseTableFields(table, given) {
  if (given === null || typeof given !== 'object') {
    throw new Error(`configureResource: fields.${table} 须为对象`);
  }
  for (const role of Object.keys(given)) {
    if (!(role in DEFAULT_FIELDS[table])) {
      throw new Error(`configureResource: fields.${table} 未知角色: ${role}`);
    }
  }
  const mapped = { ...DEFAULT_FIELDS[table], ...given };
  for (const role of Object.keys(mapped)) {
    _validateRoleValue(table, role, mapped[role]);
  }
  return mapped;
}

function _parseFields(raw = {}) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('configureResource: fields 须为对象');
  }
  for (const table of Object.keys(raw)) {
    if (!(table in DEFAULT_FIELDS)) throw new Error(`configureResource: fields 未知表: ${table}`);
  }
  const out = {};
  for (const table of Object.keys(DEFAULT_FIELDS)) {
    out[table] = _parseTableFields(table, raw[table] === undefined ? {} : raw[table]);
  }
  return out;
}

// 装配期由 configureResource 整体重赋值（形状随配置而变：schema/fields/store/providers/url/sign
// 及池级覆盖），声明为开放记录以免把首版字面量的窄形状当成契约。
/** @type {Record<string, any>} */
let _cfg = {
  schema: { ...DEFAULT_SCHEMA },
  fields: _parseFields({}),
  store: null,
  providers: [],
  url: {},
  sign: null,
};
let _pool = new Map();
// 命名池注册表（C2）：池名 → Map(kind → provider)。默认池恒名 "default"；
// _pool 保留为默认池别名（兼容既有引用，禁删/禁改名）
let _pools = new Map();

/** 当前配置（现场取值；调用方不得长期持有以免读到过期配置） */
function getCfg() {
  return _cfg;
}

/** 默认池（`_pools` 的 "default" 别名；无默认池时为空 Map） */
function getPool() {
  return _pool;
}

function _buildPool(sub, { strict }) {
  if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) {
    throw new Error('configureResource: pools.<名> 须为对象');
  }
  if (strict) {
    // 命名池子形状仅接受 providers 键——schema/fields/store/url/sign 是全局配置，
    // 池级出现即抛错（禁静默丢弃让用户误以为已按池生效）
    for (const k of Object.keys(sub)) {
      if (k !== 'providers') {
        throw new Error(`configureResource: pools.<名>.${k} 不被接受（${k} 为全局配置不得按池分化；池级仅接受 providers）`);
      }
    }
  }
  const pool = new Map();
  (sub.providers || []).forEach((spec, i) => {
    const p = providers.createProvider(spec.kind, spec.options || {});
    p.priority = Number.isInteger(spec.priority) ? spec.priority : i;
    pool.set(spec.kind, p);
  });
  return pool;
}

/**
 * 配置资源能力。cfg 两种形状（互斥——同 cfg 同时出现 `providers` 与 `pools` 键抛错，禁静默合并）：
 *  ① 旧形状 `{providers, schema/fields/store/url/sign}` → 等价默认池 "default"（行为与 4.7.x 完全一致）；
 *  ② 新形状 `{pools: {"<池名>": {providers: [...]}, ...}, schema/...}` → 逐池独立构建
 *     （同 kind 双凭据 sys/biz 共存互不覆盖）；"default" 为保留池名，新形状中显式使用合法，但与旧形状互斥。
 *
 * 返回 `{"<池名>": <pool Map 拷贝>, ...}` 结构视图；模块级 _pool 仍指向默认池
 * （兼容既有引用；纯命名池未配 "default" 时为空 Map），`poolNames()` 枚举全池。
 */
/** 池初始化（副作用落 _pools/_pool）：新形状逐池 strict 构建 / 旧形状等价默认池 */
function _initPools(cfg) {
  _pools = new Map();
  if (cfg.pools != null) {
    if (typeof cfg.pools !== 'object' || Array.isArray(cfg.pools) || !Object.keys(cfg.pools).length) {
      throw new Error('configureResource: pools 须为非空对象');
    }
    for (const [name, sub] of Object.entries(cfg.pools)) {
      _pools.set(name, _buildPool(sub, { strict: true }));
    }
  } else {
    _pools.set('default', _buildPool(cfg, { strict: false }));
  }
  _pool = _pools.get('default') || new Map();
}

function configure(cfg = {}) {
  if (cfg.providers && cfg.pools) {
    throw new Error('configureResource: providers 与 pools 互斥（同一 cfg 只允许一种形状），禁静默合并');
  }
  _cfg = {
    schema: { ...DEFAULT_SCHEMA, ...(cfg.schema || {}) },
    fields: _parseFields(cfg.fields || {}),
    store: cfg.store || null,
    providers: Array.isArray(cfg.providers) ? cfg.providers.slice() : [],
    url: cfg.url || {},
    sign: typeof cfg.sign === 'function' ? cfg.sign : null,
  };
  _initPools(cfg);
  return Object.fromEntries([..._pools.entries()].map(([k, v]) => [k, new Map(v)]));
}

/** 已配置池名列表（旧形状配置 → 恒 ['default']；只读快照） */
function poolNames() {
  return Array.from(_pools.keys());
}

/** 取池：null = 默认池；未知池名抛错（禁静默回落默认池） */
function _requirePool(name) {
  const key = name || 'default';
  if (!_pools.has(key)) {
    throw new Error(`未知资源池: ${key}（已配置: ${Array.from(_pools.keys()).join(', ')}）`);
  }
  return _pools.get(key);
}

module.exports = {
  DEFAULT_SCHEMA,
  DEFAULT_FIELDS,
  getCfg,
  getPool,
  configure,
  poolNames,
  _requirePool,
};
