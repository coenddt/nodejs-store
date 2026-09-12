'use strict';

/**
 * rust-store 原生绑定加载器（唯一原生模块入口）
 *
 * mongo-store 采用「Rust 单核心 + 双绑定」架构：schema/GQL/权限/计算列/命令规划
 * 全部在 Rust core 实现，本目录 src/*.js 只是薄 Host 适配层（驱动 IO + 回调 + 占位符）。
 *
 * 生产环境**只**从 npm 依赖 `rust-store-node` 加载原生模块。
 * 开发期若需从相邻 rust-store 仓库的调试产物加载，必须显式设置：
 *   LOCAL_CORE=1 且 NODE_ENV !== 'production'
 */

const path = require('path');

function _requireDevFallback() {
  // 开发期兜底：仅 LOCAL_CORE=1 且非 production 时启用，
  // 避免生产环境从相邻目录加载任意原生模块。
  if (process.env.LOCAL_CORE !== '1' || process.env.NODE_ENV === 'production') return null;
  const devPath = path.join(
    __dirname,
    '..',
    '..',
    'rust-store',
    'core-node',
    'dist',
    'rust-store-node.node',
  );
  try {
    return require(devPath);
  } catch (e) {
    return { __error: `${devPath}: ${e.message.split('\n')[0]}` };
  }
}

function _load() {
  // LOCAL_CORE=1（且非 production）优先加载本地调试产物 —— 使「从相邻 rust-store
  // 仓库加载」的语义与文档一致；未设置或加载失败再走 npm 依赖。
  if (process.env.LOCAL_CORE === '1' && process.env.NODE_ENV !== 'production') {
    const local = _requireDevFallback();
    if (local && !local.__error) return local;
  }
  try {
    return require('rust-store-node');
  } catch (e) {
    const fallback = _requireDevFallback();
    if (fallback && !fallback.__error) return fallback;

    const hints = [`rust-store-node: ${e.message.split('\n')[0]}`];
    if (fallback && fallback.__error) hints.push(fallback.__error);
    throw new Error(
      '无法加载 rust-store 原生核心（rust-store-node 绑定产物）。\n'
      + '请安装 npm 依赖 rust-store-node；开发期如需从相邻 rust-store 仓库加载，\n'
      + '请设置 LOCAL_CORE=1（且 NODE_ENV !== \'production\'）并在 rust-store 仓库构建：\n'
      + '  cargo build --manifest-path core-node/Cargo.toml\n'
      + hints.join('\n'),
    );
  }
}

module.exports = _load();
