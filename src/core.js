'use strict';

/**
 * Rust core 原生绑定加载器（唯一原生模块入口）
 *
 * mongo-store 采用「Rust 单核心 + 双绑定」架构：schema/GQL/权限/计算列/命令规划
 * 全部在 Rust core 实现，本目录 src/*.js 只是薄 Host 适配层（驱动 IO + 回调 + 占位符）。
 *
 * Rust core 与 Node/Python 绑定位于独立仓库 mongo-store-rust，本仓库通过其绑定产物引用。
 * 构建绑定产物（在 mongo-store-rust 仓库内，Windows）：
 *   cargo build --manifest-path core-node/Cargo.toml
 *   Copy-Item core-node/target/debug/mongo_store_node.dll core-node/dist/mongo-store-node.node -Force
 */

const path = require('path');

function _load() {
  const candidates = [
    // 1) 作为 npm 依赖安装（由 mongo-store-rust 发布的绑定包）
    'mongo-store-node',
    // 2) 开发期：相邻的 mongo-store-rust 仓库构建产物
    path.join(__dirname, '..', '..', 'mongo-store-rust', 'core-node', 'dist', 'mongo-store-node.node'),
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
    '无法加载 mongo-store 原生核心（mongo-store-node 绑定产物）。\n'
    + '请安装 npm 依赖 mongo-store-node，或在 mongo-store-rust 仓库构建：\n'
    + '  cargo build --manifest-path core-node/Cargo.toml\n'
    + errors.join('\n'),
  );
}

module.exports = _load();
