'use strict';

const cache = require('../../src/cache');
const feedback = require('../../src/feedback');

/** 收集期间 emit 的事件（用后恢复原 sink，并复位 provider 防跨用例污染；cache.test / cache-link.test 共用） */
function collect(body) {
  const prev = feedback.getSink();
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    body();
  } finally {
    feedback.setSink(prev);
    cache.setCacheStatus(null);
  }
  return events;
}

module.exports = { collect };
