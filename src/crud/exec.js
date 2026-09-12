'use strict';

/**
 * 命令执行（唯一 IO 边界） + 占位符替换 + core 调用包装
 *
 * 全部纯逻辑（GQL 解析、权限、命令规划、结果后处理）都在 Rust core；
 * 本模块只做 Host 三件事里最底层的一件：把 core 产出的 Command JSON
 * 路由到对应数据源连接并执行。不确定性输入由本层供给（now 时钟）。
 *
 * 路由规则见 `../datasource`：命令自带 `source` / `namespace` 三元组，按 `source`
 * 选连接、`namespace` 定位连接内的库（Mongo 双形态严格校验），
 * Mongo 走原生驱动，SQL 走 `translate → exec`。
 */

const { PermissionError, getContext } = require('../permission');
const datasource = require('../datasource');

const _PHASE1_IDS = /^\{\{phase1\.ids\}\}$/;
const _STEP_PH = /^\{\{step\.(\d+)\._id\}\}$/;

/** core 权限类错误消息 → PermissionError（消息与 core 常量保持一致） */
const _PERMISSION_MSGS = new Set(['无访问权限', '无写入权限', '无删除权限', '无批量写入权限']);

/** 设置数据源连接映射（对 `../datasource` 的路由入口做包内透出） */
const setConnections = datasource.setConnections;

/** 毫秒时间戳（Host 时钟源） */
function _now() {
  return Date.now();
}

function _ctx() {
  return getContext() ?? null;
}

/** 绑定层调用包装：权限类错误映射为 PermissionError */
function _call(fn) {
  try {
    return fn();
  } catch (e) {
    if (_PERMISSION_MSGS.has(e && e.message)) throw new PermissionError(e.message);
    throw e;
  }
}

// ─── 命令执行（唯一 IO 边界） ────────────────────────────────

/** Command JSON → MongoDB 原生驱动调用 */
async function _execMongo(db, cmd) {
  const coll = db.collection(cmd.collection);
  switch (cmd.kind) {
    case 'find': {
      const opts = cmd.projection ? { projection: cmd.projection } : undefined;
      return coll.find(cmd.filter, opts).toArray();
    }
    case 'aggregate':
      return coll.aggregate(cmd.pipeline).toArray();
    case 'countDocuments':
      return coll.countDocuments(cmd.filter);
    case 'findOne': {
      const opts = cmd.projection ? { projection: cmd.projection } : undefined;
      return coll.findOne(cmd.filter, opts);
    }
    case 'insertOne':
      await coll.insertOne(cmd.doc);
      return cmd.doc;
    case 'insertMany':
      await coll.insertMany(cmd.docs);
      return { insertedCount: cmd.docs.length };
    case 'findOneAndUpdate':
      return coll.findOneAndUpdate(cmd.filter, cmd.update, cmd.options);
    case 'updateMany':
      return coll.updateMany(cmd.filter, cmd.update);
    case 'deleteMany':
      return coll.deleteMany(cmd.filter);
    default:
      throw new Error(`未支持的命令: ${cmd.kind}`);
  }
}

/** 在指定数据源上执行命令（Mongo 走原生驱动，SQL 走 translate → exec） */
async function _execOn(source, cmd) {
  const connection = datasource.getConnection(source);
  const db = datasource.mongoDb(connection, source, cmd.namespace ?? null);
  if (db) {
    return _execMongo(db, cmd);
  }
  return datasource.execSql(source, connection, cmd);
}

/** Command JSON → 按命令自带的 `source` 路由（不按 collection 反查） */
async function _exec(cmd) {
  return _execOn(cmd.source || datasource.DEFAULT_SOURCE, cmd);
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
  _now,
  _ctx,
  _call,
  _exec,
  _execOn,
  _substitute,
  resolvePlaceholders,
};
