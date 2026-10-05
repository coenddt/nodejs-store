'use strict';

const local = require('./local');
const s3 = require('./s3');

const _REG = new Map([
  ['local', local],
  ['s3', s3],
]);

/** 注册 provider 类型：`mod` 须含 `create(options) -> provider` */
function registerProvider(kind, mod) {
  if (!mod || typeof mod.create !== 'function') {
    throw new Error(`provider "${kind}" 须提供 create(options) 工厂`);
  }
  _REG.set(kind, mod);
}

/** 实例化 provider（未知 kind 显式报错，列出已注册项） */
function createProvider(kind, options) {
  const mod = _REG.get(kind);
  if (!mod) {
    throw new Error(`未知资源 provider: ${kind}（已注册: ${Array.from(_REG.keys()).join(', ')}）`);
  }
  return mod.create(options || {});
}

module.exports = { registerProvider, createProvider, _REG };
