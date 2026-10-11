'use strict';

/**
 * Redis 作为「整量求值载体」的 io 实现（04 §4.2）—— 不立 `redis` 独立 kind，
 * 与内存载体同构（经 `memory/index.js` 的 io 注入点接入即可，查询能力与内存相同）。
 *
 * 键空间（必须与内存载体一致，§8-3）：
 *   key = `<prefix>/<database>/<collection>`；`database` 为空 ⇒ `<prefix>/<collection>`。
 * Redis 只负责**整量取回 / 回写**，**不实现任何查询语义**（filter / 聚合 / 排序）——
 * 求值仍走 `core.localEval`（与 memory / local 同路径）。
 *
 * client 契约（由调用方注入，禁新增 Redis 客户端依赖；同步 / 异步均可，内部 `await` 兼容）：
 *   scan(pattern: string) => string[]        匹配 pattern 的全部键（游标由调用方内部处理）
 *   get(key: string) => string | null        取单键（值为 JSON 字符串）
 *   set(key: string, value: string) => any   写单键
 *
 * 边界（继承内存载体，`README.md:216-220`）：不实现失效策略 / TTL（属业务侧）；
 * 并发写不做分布式锁（单进程 / 悲观假设）。
 */

/** Redis 载体 IO 显式错误（携 `database` / `op`；A9：禁静默当空快照） */
class RedisIoError extends Error {
  constructor(message, { database = null, op = null, cause = null } = {}) {
    super(message);
    this.name = 'RedisIoError';
    this.database = database;
    this.op = op;
    if (cause !== null && cause !== undefined) this.cause = cause;
  }
}

function _msg(e) {
  return e && e.message ? e.message : String(e);
}

/** `<prefix>/<database>/<collection>`（`database` 空 ⇒ `<prefix>/<collection>`） */
function _key(base, database, collection) {
  return database ? `${base}/${database}/${collection}` : `${base}/${collection}`;
}

/**
 * 创建「Redis 作载体」的整量 io。
 * @param {{client: {scan: Function, get: Function, set: Function}, prefix?: string}} spec
 *        `client` 由调用方注入（禁新增依赖）；`prefix` 为键空间根前缀，默认 `'store'`
 * @returns {{load: (database: string|null) => Promise<object>,
 *            save: (database: string|null, changed: string[], collections: object) => Promise<void>}}
 */
function createRedisIo({ client, prefix = 'store' } = {}) {
  if (!client
    || typeof client.scan !== 'function'
    || typeof client.get !== 'function'
    || typeof client.set !== 'function') {
    throw new RedisIoError('createRedisIo 需要注入 client（须实现 scan/get/set）', { op: 'init' });
  }
  const base = prefix === '' ? '' : String(prefix);
  const basePrefix = base ? `${base}/` : '';

  return {
    /** 整量取回：`{ 集合名: 文档数组 }`；单键解析失败 ⇒ Err（含键名），禁跳过 */
    async load(database) {
      const db = database ?? null;
      const pattern = db ? `${base}/${db}/*` : `${base}/*`;
      let keys;
      try {
        keys = await client.scan(pattern);
      } catch (e) {
        throw new RedisIoError(`Redis SCAN 失败（pattern=${pattern}）: ${_msg(e)}`, { database: db, op: 'scan', cause: e });
      }
      if (!Array.isArray(keys)) {
        throw new RedisIoError(`Redis SCAN 返回值非数组（pattern=${pattern}）`, { database: db, op: 'scan' });
      }
      const out = {};
      for (const fullKey of keys) {
        if (typeof fullKey !== 'string') continue;
        if (basePrefix && !fullKey.startsWith(basePrefix)) continue; // 防 client 越界返回
        let rel = basePrefix ? fullKey.slice(basePrefix.length) : fullKey;
        if (db) {
          const dbPrefix = `${db}/`;
          if (!rel.startsWith(dbPrefix)) continue; // 同前缀但不属本库分区
          rel = rel.slice(dbPrefix.length);
          if (rel.includes('/')) continue;         // 如 db='a' 不命中 'a/b/c'
        }
        if (rel === '') continue;
        let raw;
        try {
          raw = await client.get(fullKey);
        } catch (e) {
          throw new RedisIoError(`Redis GET 失败（key=${fullKey}）: ${_msg(e)}`, { database: db, op: 'get', cause: e });
        }
        if (raw === null || raw === undefined) continue; // 键已失效：跳过（非解析失败）
        try {
          out[rel] = JSON.parse(raw);
        } catch (e) {
          throw new RedisIoError(`Redis 值非法 JSON（key=${fullKey}）: ${_msg(e)}`, { database: db, op: 'parse', cause: e });
        }
      }
      return out;
    },

    /** 只回写 `changed` 中的集合（与 local 「只回写变更」同规） */
    async save(database, changed, collections) {
      const db = database ?? null;
      for (const name of Array.from(changed)) {
        const key = _key(base, db, name);
        let value;
        try {
          value = JSON.stringify(collections[name] ?? []);
        } catch (e) {
          throw new RedisIoError(`序列化失败（key=${key}）: ${_msg(e)}`, { database: db, op: 'stringify', cause: e });
        }
        try {
          await client.set(key, value);
        } catch (e) {
          throw new RedisIoError(`Redis SET 失败（key=${key}）: ${_msg(e)}`, { database: db, op: 'set', cause: e });
        }
      }
    },
  };
}

module.exports = { createRedisIo, RedisIoError };
