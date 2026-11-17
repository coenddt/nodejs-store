'use strict';

/**
 * `Store` 方法组：Schema 管理 + CRUD + Mutation/Upsert + 并发原语（D4-4 零语义拆分
 * 自 index.js）。
 *
 * 本组方法全部是薄转发（参数原样透传、返回值原样返回），不含分支逻辑。方法组以 class
 * 表达并作为 `Store` 的原型链基类（见 index.js），保证 TS 的 checkJs 能沿链解析全部
 * 方法签名（动态挂载方式对类型系统不可见）。
 */

const crud = require('../crud');
const triggerExec = require('../crud/triggers');
const load = require('../load');
const schema = require('../schema');

class SchemaCrudApi {
  // ── Schema 管理 ──
  /** 注册 schema（可选 `ctx` 过定义层门禁，见 setMetaPolicy；默认 Open） */
  register(defn, ctx) {
    return schema.register(defn, ctx);
  }

  /**
   * 批量注册（插件 bootstrap 接入门面）：`items = [{defn, location?}]`。
   *
   * 原子语义由 core 定：任一失败零副作用。`location` 缺省时按 defn 内落点字段
   * 推导（`_locOf`），与 `register` 单条路径同构。
   */
  registerBatch(items, ctx) {
    return schema.registerBatch(items, ctx);
  }

  /** 注销 schema（补偿整份 attempted 清单；未知 schema 幂等成功） */
  unregister(name) {
    return schema.unregister(name);
  }

  get(name) {
    return schema.get(name);
  }

  has(name) {
    return schema.has(name);
  }

  list() {
    return schema.list();
  }

  /** 公开回调注入：`fnRef → impl(item, ctx)`（对齐 py-store store.set_fn） */
  setFn(fnRef, impl) {
    return schema.setFn(fnRef, impl);
  }

  /** 启动期校验：定义声明的 fnRef 必须都有实现，缺则抛 `ERR_FN_MISSING`（对齐 py-store store.assert_fns_covered） */
  assertFnsCovered(defns) {
    return schema.assertFnsCovered(defns);
  }

  /** 触发器回调注入：`fnRef → impl(args, ctx, { store })`（可为 async；见 crud/triggers.js） */
  setTriggerFn(fnRef, impl) {
    return triggerExec.setTriggerFn(fnRef, impl);
  }

  /** 启动期校验：schema triggers 声明的 fnRef 必须都有实现，缺则抛 `ERR_TRIGGER_FN_MISSING` */
  assertTriggerFnsCovered(defns) {
    return triggerExec.assertTriggerFnsCovered(defns);
  }

  /**
   * 运行期目录装载：读 `store.config.json` → 收集定义 → core 纯规划 → 带定位批量注册。
   * `opts` = `{ config, ctx?, baseDir? }`（见 `./load`）。返回装载项（主在前、其后从）。
   */
  async loadDefs(opts) {
    return load.loadDefs(opts);
  }

  // ── CRUD ──
  /**
   * GQL 查询。`routeOverride`（可选）：`{ source?, database?, schema? }` 多租户路由，
   * 覆盖命令定位（权限/计算列仍按结构 schema 判定）。下同。
   * 注意：`routeOverride` 为**受信服务端参数**，禁止透传用户输入（否则可被用于跨源路由，CWE-639）。
   */
  async query(gql, params, routeOverride) {
    return crud.query(gql, params, routeOverride);
  }

  async queryOne(gql, params, routeOverride) {
    return crud.queryOne(gql, params, routeOverride);
  }

  async queryWithCount(gql, params, routeOverride) {
    return crud.queryWithCount(gql, params, routeOverride);
  }

  /** 跨库联邦查询（一条 GQL 跨多数据源：各源取数 → 内存 join → 统一后处理） */
  async queryFederated(gql, params) {
    return crud.queryFederated(gql, params);
  }

  async insert(schemaName, data, routeOverride) {
    return crud.insert(schemaName, data, routeOverride);
  }

  async insertMany(schemaName, docs, routeOverride) {
    return crud.insertMany(schemaName, docs, routeOverride);
  }

  async update(schemaName, condition, data, options, routeOverride) {
    return crud.update(schemaName, condition, data, options, routeOverride);
  }

  /**
   * 写后仅叠同步 `fn` 计算列（入参须为 `returnDocument: AFTER` 落库文档；不补默认值）。
   * 与 py 宿主 `store.apply_write_computes` 同构。
   */
  applyWriteComputes(schemaName, doc) {
    return crud.applyWriteComputes(schemaName, doc);
  }

  async updateMany(schemaName, condition, data, routeOverride) {
    return crud.updateMany(schemaName, condition, data, routeOverride);
  }

  async remove(schemaName, condition, routeOverride, options) {
    return crud.remove(schemaName, condition, routeOverride, options);
  }

  async exists(schemaName, condition, routeOverride) {
    return crud.exists(schemaName, condition, routeOverride);
  }

  async count(schemaName, filter, routeOverride) {
    return crud.count(schemaName, filter, routeOverride);
  }

  // ── Mutation / Upsert ──
  async mutation(schemaName, data, routeOverride) {
    return crud.mutation(schemaName, data, routeOverride);
  }

  async upsert(schemaName, condition, data, options, routeOverride) {
    return crud.upsert(schemaName, condition, data, options, routeOverride);
  }

  // ── 并发原语（C1：仅 SQL 源；Mongo 显式拒绝；时间戳/身份字段由调用方写入） ──
  /**
   * 条件领取 N 行并原子置标；返回领到的行（含领取后最新值）
   *
   * MySQL/PG 走 `FOR UPDATE SKIP LOCKED` 两步同事务；SQLite 走单条
   * `UPDATE … RETURNING`；仅 SQL 源（Mongo 显式拒绝）。
   */
  async claim(schemaName, filter, update,
    { limit = 1, sort = null, routeOverride = null } = {}) {
    return crud.claim(schemaName, filter, update,
      { limit, sort, routeOverride });
  }

  /** 条件更新并返回 `{ matched, modified }`（matched = WHERE 命中行数，三后端一致） */
  async compareAndSet(schemaName, filter, update, { routeOverride = null } = {}) {
    return crud.compareAndSet(schemaName, filter, update, { routeOverride });
  }

  /** 租约续期：compareAndSet 组合门面（归属条件由 filter 携带，时间戳由调用方写入） */
  async renewLease(schemaName, filter, leaseFields, { routeOverride = null } = {}) {
    return crud.renewLease(schemaName, filter, leaseFields, { routeOverride });
  }
}

module.exports = SchemaCrudApi;
