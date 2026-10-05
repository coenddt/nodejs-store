'use strict';

/** 计算列实现（core 经 FnRegistry 回调 Host）——coverUrl 走 core 纯拼接 */
const native = require('../../../src/core');

const BASE_URL = process.env.RESOURCE_BASE_URL || 'https://cdn.example.com';

function coverUrl(doc) {
  const id = doc && doc.coverId;
  if (!id) return null;
  // 内部 id：core 按 contentPath 模板拼；外部 URL：core 原样返回
  return native.resourceComposeUrl(id, { baseUrl: BASE_URL, pathTemplate: '/{contentPath}' });
}

const FNS = { cover_url: coverUrl };

module.exports = { FNS, coverUrl };
