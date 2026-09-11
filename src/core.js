'use strict';

/**
 * Rust core 原生绑定加载器（唯一原生模块入口）
 *
 * mongo-store 采用「Rust 单核心 + 双绑定」架构：schema/GQL/权限/计算列/命令规划
 * 全部在 Rust core 实现，本目录 src/*.js 只是薄 Host 适配层（驱动 IO + 回调 + 占位符）。
 *
 * Rust core 与 Node/Python 绑定位于独立仓库 rust-store，本仓库通过其绑定产物引用。
 * 构建绑定产物（在 rust-store 仓库内，Windows）：
 *   cargo build --manifest-path core-node/Cargo.toml
 *   Copy-Item core-node/target/debug/rust_store_node.dll core-node/dist/rust-store-node.node -Force
 */

const path = require('path');

function _load() {
  const candidates = [
    // 1) 作为 npm 依赖安装（由 rust-store 发布的绑定包）
    'rust-store-node',
    // 2) 开发期：相邻的 rust-store 仓库构建产物
    path.join(__dirname, '..', '..', 'rust-store', 'core-node', 'dist', 'rust-store-node.node'),
  ];
  const errors = [];
  for (const p of candidates) {
    try {
      return require(p);
    } catch (e) {
      errors.push(`${p}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error(
    '无法加载 rust-store 原生核心（rust-store-node 绑定产物）。\n'
    + '请安装 npm 依赖 rust-store-node，或在 rust-store 仓库构建：\n'
    + '  cargo build --manifest-path core-node/Cargo.toml\n'
    + errors.join('\n'),
  );
}

module.exports = _load();
