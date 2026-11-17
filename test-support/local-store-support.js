'use strict';

/**
 * 本地磁盘数据源（local）Host 单测的共用支撑（D4-4 零语义拆分）。
 *
 * 自 tests/local-store.test.js 原样下沉：临时目录工厂与清理钩子、驱动手柄用的内存 io；
 * 并集中转发各段共用的 src 入口。用例文件只保留用例块，用例名与断言逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSnapshot, writeCollections, withDirLock } = require('../src/local/store');
const { createDb } = require('../src/local/handle');
const { connect, LOCAL_KIND } = require('../src/local');
const datasource = require('../src/datasource');
const feedback = require('../src/feedback');
const { init, store, schema: _sc } = require('../src');

const _dirs = [];

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nodejs-store-local-${tag}-`));
  _dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 内存 io（驱动 handle，不经 store/落盘） */
function memIo(initial = {}) {
  const box = { snap: initial };
  return {
    box,
    io: {
      load: () => box.snap,
      save: (_changed, collections) => { box.snap = collections; },
    },
  };
}

module.exports = {
  tmpDir,
  memIo,
  readSnapshot,
  writeCollections,
  withDirLock,
  createDb,
  connect,
  LOCAL_KIND,
  datasource,
  feedback,
  init,
  store,
  _sc,
};
