'use strict';

/**
 * 公共错误类（零依赖）—— D4-1 解环提取
 *
 * 从 datasource.js 平移至此（零行为变化）：executors/mongo 与 crud/claim
 * 只需 `PushdownUnsupportedError` 一个错误类，却因此形成
 * mongo→datasource→executors/index→mongo / claim→…→datasource→crud→claim
 * 加载环（madge 环 1/6 的边）。错误类独立为零依赖模块后二者改指本文件；
 * datasource.js re-export 全部类名，对外导出面不变。
 */

/** 会话内跨数据源写入且无分布式事务时的显式报错（先全部回滚，绝不提交半截） */
class NonAtomicWriteError extends Error {
  constructor(sources) {
    const list = Array.from(sources).sort();
    super(
      `会话内写入了多个数据源（${list.join(', ')}）：跨源写无法原子（Phase 1 未提供分布式事务）；请拆分为多个会话，或改用单一数据源`,
    );
    this.name = 'NonAtomicWriteError';
    this.sources = list;
  }
}

/**
 * SQL 下推遇到无法安全翻译的组合（core 标记 unsupported）
 *
 * 显式报错而非静默执行「缺少该段」的 SQL（会返回错误结果）；
 * 自动反馈：触发原因见 message，修复指引见 feedback()。
 */
class PushdownUnsupportedError extends Error {
  constructor(source, kind, codes, warnings) {
    super(`SQL 下推不支持（${kind}）: ${codes.join(', ')}；${warnings.join(' / ')}`);
    this.name = 'PushdownUnsupportedError';
    this.source = source;
    this.kind = kind;
    this.codes = codes;
    this.warnings = warnings;
  }

  /** 转统一反馈事件（与 feedback.emit 的事件形状一致） */
  feedback() {
    return {
      type: 'sql_pushdown_unsupported',
      code: 'pushdownUnsupported',
      layer: 'dialect',
      message: this.message,
      hint: '改写查询避开该组合，或改用 Mongo 源执行该段取数',
      source: this.source,
      kind: this.kind,
    };
  }
}

/** 原生 SQL 执行边界错误（参数档校验 / 方言编译 / 执行器缺失） */
class RawSqlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RawSqlError';
  }
}

/** Mongo 原生命令执行边界错误 */
class NativeCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NativeCommandError';
  }
}

module.exports = { NonAtomicWriteError, PushdownUnsupportedError, RawSqlError, NativeCommandError };
