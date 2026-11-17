'use strict';

/**
 * `Store` 方法组：结构同步 + 事务 / 会话 / 原生执行 + DDL + meta-store 定义控制面
 * + 反馈落库 + 缓存注记（D4-4 零语义拆分自 index.js）。
 *
 * 本组多数方法为薄转发；`session` / `aggregate` / `restoreDefs` 与 workflow 定义族
 * 带逻辑，方法体逐字搬迁（`this` 仍指向 Store 实例，与拆分前同）。`aggregate` 的
 * opt-in 开关经 ./runtime-state 现场读取（拆分前为 index.js 模块级 `let`）。
 *
 * 继承自 ./api-schema-crud：方法组沿原型链组装为 `Store` 的基类链，供 TS checkJs
 * 解析签名。
 */

const cache = require('../cache');
const datasource = require('../datasource');
const { Session } = require('../datasource');
const ddl = require('../ddl');
const feedback = require('../feedback');
const metadef = require('../metadef');
const migrate = require('../migrate');
const permission = require('../permission');
const schema = require('../schema');
const { syncSchema } = require('../sync');
const { allowNativeAggregate } = require('./runtime-state');
const SchemaCrudApi = require('./api-schema-crud');

class TxDefsApi extends SchemaCrudApi {
  // ── 结构同步（SQL 数据源：introspect → schemaFromRows → mergeSchema → register） ──
  async syncSchema(opts) {
    return syncSchema(opts);
  }

  // ── 事务 + 原生 SQL（复用 datasource.runInTransaction；见 README「事务边界」）──
  /**
   * 事务作用域：单 SQL 源「同连接 + 同事务」执行 fn（复用 runInTransaction）
   *
   * fn 内 executeRaw / CRUD 均落到该源的事务连接（commit/rollback 一体）；
   * Mongo 源或执行器未实现 withTransaction 时按原样执行（跨源无法原子），
   * 绝不静默假装已事务化。单源场景 source 传 'default'。
   *
   * 同源嵌套 transaction 会开保存点（内层失败只回滚本层）；句柄无保存点原语时
   * 降级并入外层并发 nested_savepoint_unsupported。
   */
  async transaction(source, fn) {
    return datasource.runInTransaction(source, fn);
  }

  /**
   * 会话（工作单元）：回调式，退出统一提交 / 异常统一回滚
   *
   * 用法:
   *   await store.session(async (s) => {
   *     await s.insert('Order', { ... });
   *     await s.update('Account', cond, { ... });
   *   });
   *
   * 约束：同一会话内写命令只允许落在**单一数据源**；跨源写退出时抛
   * NonAtomicWriteError（先全部回滚，绝不提交半截）。
   *
   * 嵌套：内层会话作为嵌套作用域在已有事务上开保存点，内层失败只回滚本层
   * （生命周期仍交外层）。
   */
  async session(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('store.session(fn) 需要回调函数：await store.session(async (s) => { ... })');
    }
    const s = new Session();
    const parent = datasource.currentSession();
    if (parent !== null) {
      // 嵌套：生命周期交外层；本层作为嵌套作用域（保存点隔离，失败只回滚本层）
      s.bindOuter(parent);
      const scope = parent.pushScope();
      try {
        const out = await fn(s);
        await parent.popScope(scope, false);
        return out;
      } catch (err) {
        await parent.popScope(scope, true);
        throw err;
      }
    }
    return datasource.runWithSession(s, async () => {
      try {
        const out = await fn(s);
        await s.exit(null);
        return out;
      } catch (err) {
        await s.exit(err);
        throw err;
      }
    });
  }

  /**
   * 在指定 SQL 源执行原生 SQL（事务内可用；编译由 core rawStmtCompile 完成）
   *
   * 两档参数风格：位置档（params 为数组/null）→ SQL 原样透传，占位符为各后端
   * 原生风格（mysql/sqlite 用 `?`，postgres 用 `$1..$n`）；命名档（params 为对象）
   * → SQL 文本中的 `:name` 编译为方言占位符（同名复用、跳过 `::` cast / 引号 /
   * 注释边界；缺名 / 多余名显式报错）。isWrite 缺省时按 SQL 首词推断（读白名单外
   * 一律按写——安全方向）。仅支持 SQL 源（Mongo 源抛 RawSqlError）。
   * 对齐 py-store store.execute_raw。
   */
  async executeRaw(source, sql, params = null, isWrite = null) {
    return datasource.executeRaw(source, sql, params, isWrite);
  }

  /**
   * 在指定 Mongo 源执行原生聚合管道（事务内可用；对标 SQL 侧 executeRaw）
   *
   * pipeline 为原生聚合管道（数组），options 为驱动原生透传项（allowDiskUse /
   * batchSize / hint / maxTimeMS…，宿主不做白名单）。事务 / 会话作用域内自动透传
   * session（由事务强制接管，options.session 不可覆盖）；统一按读路径解析，
   * $merge / $out 写管道请自行开事务。仅支持 Mongo 源（SQL 源抛 NativeCommandError
   * 并指引 executeRaw）。返回 { rows }。对齐 py-store store.execute_native。
   */
  async executeNative(source, collection, pipeline = [], options = null) {
    return datasource.executeNative(source, collection, pipeline, options);
  }

  /**
   * 以 schema 名发起原生聚合管道（opt-in 逃生舱，默认关闭）
   *
   *   - init(connections, { allowNativeAggregate: true }) 显式开启后可用；
   *     未开启抛 `ERR_NATIVE_AGGREGATE_DISABLED`（含开启方式提示，默认关闭是产品边界）；
   *   - schemaName → (datasource, collection) 解析后转调 executeNative——session 注入、
   *     连接复用全部复用既有实现，不另起驱动连接；
   *   - 不注入权限过滤、不做 computes rehydration（逃生舱语义：调用方自担权限与后处理）；
   *     管道内容不校验不拦截（$match/$group/$lookup/$facet 均放行，$merge/$out 亦不拦，
   *     写管道请自行开事务）。
   */
  async aggregate(schemaName, pipeline = [], options = null) {
    if (!allowNativeAggregate()) {
      /** @type {Error & { code?: string }} */
      const err = new Error(
        'ERR_NATIVE_AGGREGATE_DISABLED:原生聚合别名未开启——默认关闭是产品边界，'
        + 'init(connections, { allowNativeAggregate: true }) 显式开启；'
        + '或改用 GQL $group / $having 归一聚合 / executeNative 直调',
      );
      err.code = 'ERR_NATIVE_AGGREGATE_DISABLED';
      throw err;
    }
    if (!schema.has(schemaName)) {
      /** @type {Error & { code?: string }} */
      const err = new Error(`ERR_AGGREGATE_SCHEMA:未知 schema ${schemaName}`);
      err.code = 'ERR_AGGREGATE_SCHEMA';
      throw err;
    }
    const m = schema.get(schemaName);
    return datasource.executeNative(m.datasource || 'default', m.collection, pipeline, options);
  }

  /** 从已注册 schema def 生成指定后端 DDL 文本（纯函数，不连库、不回写；铁律 6） */
  generateDdl(backend, names) {
    return ddl.generate(backend, names);
  }

  // ── meta-store 定义控制面（定义持久化与版本化；见 metadef.js）──
  /** 持久化定义（同名同形幂等，异形 version+1；A1/A2） */
  async persistDef(defn, opts) {
    return metadef.persistDef(this, defn, opts);
  }

  /** 列定义行（按 version desc；name 缺省列全部） */
  async listDefs(opts) {
    return metadef.listDefs(this, opts);
  }

  // 注：定义控制面的「各 name 最新 active 行」经导出的 `metadef` 模块调用
  // （`metadef.loadDefs`）；门面 `store.loadDefs` 归运行期目录装载器（见本类上文
  // `loadDefs(opts)` 与 `bootstrap.js`），二者不得同名遮蔽。

  /** 从持久化定义重建注册表：schema + workflow 两类（网关 reload 重装配前调用） */
  async restoreDefs(opts) {
    const s = await metadef.restoreDefs(this, { ...(opts || {}), kind: 'schema' });
    const w = await metadef.restoreDefs(this, { ...(opts || {}), kind: 'workflow' });
    return { total: s.total + w.total, applied: s.applied + w.applied };
  }

  /** 回滚到历史版本（重新 register 该版本 defn） */
  async rollbackTo(opts) {
    return metadef.rollbackTo(this, opts);
  }

  /** 迁移编排（A4）：diff → 方言 SQL → 事务执行 → `__schemaMigration` 版本行；白名单外拒绝并给分步建议 */
  async migrate(opts) {
    return migrate.migrate(opts);
  }

  // ── 定义控制面：workflow 定义（kind=workflow；见 metadef.js）──
  /** 持久化 workflow 定义（同名同形幂等，异形 version+1） */
  async persistWorkflowDef(defn, opts) {
    return metadef.persistDef(this, defn, { ...(opts || {}), kind: 'workflow' });
  }

  /** 列 workflow 定义行（按 version desc；name 缺省列全部） */
  async listWorkflowDefs(opts) {
    return metadef.listDefs(this, { ...(opts || {}), kind: 'workflow' });
  }

  /** 各 name 的最新 active workflow 定义行 */
  async loadWorkflowDefs(opts) {
    return metadef.loadDefs(this, { ...(opts || {}), kind: 'workflow' });
  }

  /** 回滚 workflow 定义到历史版本（追加式） */
  async rollbackWorkflowTo(opts) {
    return metadef.rollbackTo(this, { ...(opts || {}), kind: 'workflow' });
  }

  /** 自举内建定义表 __schemaDef/__workflowDef（幂等） */
  ensureBuiltins() {
    return metadef.ensureBuiltins();
  }

  // ── 反馈事件落库（A6；见 feedback.js）──
  /** 一键接线：注册内建 __feedback 并把 sink 指向落库；返回 disposer（恢复原 sink） */
  enableFeedbackTable() {
    return feedback.enableFeedbackTable(this);
  }

  /** 注入进程级 ns 标签（tenant/env），供落库事件附加（进程级隔离下天然单 ns） */
  setFeedbackMeta(meta) {
    return feedback.setMeta(meta);
  }

  /** 等待全部在途 __feedback 落库完成（graceful shutdown 前调用；对齐 py store.flushFeedback） */
  flushFeedback() {
    return feedback.flush();
  }

  // ── 缓存状态注记（B6；见 cache.js）──
  /** 注册缓存状态 provider：`x-cache` 注记位唯一取值来源；未注册恒 BYPASS（本轮不实现缓存） */
  setCacheStatus(fn) {
    return cache.setCacheStatus(fn);
  }

  /** 当前响应的缓存状态注记（恒为 HIT|MISS|BYPASS 之一） */
  cacheStatus(ctx) {
    return cache.cacheStatus(ctx ?? permission.getContext() ?? null);
  }
}

module.exports = TxDefsApi;
