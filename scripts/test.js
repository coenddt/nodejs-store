'use strict';

/**
 * 跨平台测试启动器
 *
 * nodejs-store 的 Host 单测需要 Rust 原生核心（`rust-store-node`）。仓库内开发时
 * 该依赖尚未安装，故显式开启 `core.js` 的开发期兜底开关（LOCAL_CORE=1，产出自
 * 相邻 `rust-store/core-node/dist/`），再交给 node 内置测试运行器。
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
