'use strict';

/**
 * 数据源模块级状态与常量（D4-4 零语义拆分自 datasource.js）
 *
 * 本文件只承载跨子模块共享的可变状态与常量：连接映射、事务/会话的 AsyncLocalStorage、
 * Mongo 事务能力缓存、crud 模块注入口。拆分目的仅是控制单文件行数，加载次序与行为不变。
 */

const { AsyncLocalStorage } = require('node:async_hooks');

/** 数据源名缺省值 */
const DEFAULT_SOURCE = 'default';

/** 本地磁盘数据源类型标记（连接描述符与事务视图均携带该 `kind`） */
const LOCAL_KIND = 'local';

/** 进程内内存数据源类型标记（与 local 同族：同为嵌入式载体） */
const MEMORY_KIND = 'memory';

/** 写命令 kind（与 crud 侧 Command.kind 一致） */
const WRITE_KINDS = new Set([
  'insertOne',
  'insertMany',
  'updateMany',
  'findOneAndUpdate',
  'deleteMany',
]);

/** SQL 后端 kind 白名单（Mongo 驱动实例 / Mongo 事务视图一律非 SQL） */
const SQL_KINDS = new Set(['mysql', 'postgres', 'sqlite']);

/** 事务作用域的连接覆盖：source → 事务描述符（见 tx.js#runInTransaction） */
const _txStore = new AsyncLocalStorage();

/** 当前会话：优先于 _txStore（会话内部自持事务连接） */
const _sessionStore = new AsyncLocalStorage();

/** Mongo 事务能力缓存：client -> true/false（探测失败不写缓存，下次重探） */
const _mongoTxCap = new WeakMap();

// D4-1 解环：Session「会话 API」门面（query/insert/…，与 Store 同名同形）原本函数内
// require('./crud')，形成 crud→claim/exec→datasource→crud 加载环（madge 环 1）。
// 改为反向注入：crud/index.js 加载完成时把模块对象注入本表（crud→datasource 单向，
// 不回指），调用期再经 _crud() 取用——加载图上 datasource 不再指向 crud。
let _crudModule = null;

/** crud/index.js 加载完成时调用（包内注入口，非公共 API） */
function _bindCrudModule(m) { _crudModule = m; }

/** 取已注入的 crud 模块（未注入显式报错，禁静默回落） */
function _crud() {
  if (!_crudModule) throw new Error('ERR:INTERNAL crud 模块未注入（应经 nodejs-store 主入口加载）');
  return _crudModule;
}

/** 当前生效会话（无则 null） */
function currentSession() {
  return _sessionStore.getStore() || null;
}

/** 在会话上下文内执行 fn（供 store.session 使用） */
function runWithSession(session, fn) {
  return _sessionStore.run(session, fn);
}

/** 命令是否为写命令（跨源写 fail-closed 判定用） */
function isWriteCommand(cmd) {
  return !!cmd && WRITE_KINDS.has(cmd.kind);
}

module.exports = {
  DEFAULT_SOURCE,
  LOCAL_KIND,
  MEMORY_KIND,
  WRITE_KINDS,
  SQL_KINDS,
  _txStore,
  _sessionStore,
  _mongoTxCap,
  _bindCrudModule,
  _crud,
  currentSession,
  runWithSession,
  isWriteCommand,
};
