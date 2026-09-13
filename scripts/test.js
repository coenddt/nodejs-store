'use strict';

/**
 * 跨平台测试启动器
 *
 * nodejs-store 的 Host 单测需要 Rust 原生核心（`rust-store-node`）。本地开发时优先用
 * 相邻 `rust-store/core-node/dist/` 的调试产物，故显式开启 `core.js` 的开发期兜底
 * 开关（LOCAL_CORE=1）；该产物不存在时 `core.js` 自动回落到 npm 依赖
 * （CI 即走此路径），不影响测试。
 *
 * 生产运行不经过本文件，仍只从 npm 依赖加载原生模块（见 src/core.js）。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const env = { ...process.env, LOCAL_CORE: '1' };
const result = spawnSync(process.execPath, ['--test', 'tests/**/*.js'], {
  cwd: root,
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
