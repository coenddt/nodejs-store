'use strict';

/**
 * 跨平台测试启动器
 *
 * nodejs-store 的 Host 单测需要 Rust 原生核心（`rust-store-node`），一律从 npm 依赖加载
 * （与生产同路径，见 src/core.js）。如需从相邻 `rust-store/core-node/dist/` 的调试产物
 * 加载，请在外部显式设置 LOCAL_CORE=1（本启动器不再强制注入）。
 *
 * 生产运行不经过本文件，仍只从 npm 依赖加载原生模块（见 src/core.js）。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const env = { ...process.env }; // 透传外部环境；不再注入 LOCAL_CORE=1
const result = spawnSync(process.execPath, ['--test', 'tests/**/*.js'], {
  cwd: root,
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
