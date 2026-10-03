'use strict';

/**
 * 双端拒绝文案对拍（A6）—— 输出一行：坏 defn 的拒绝文案（异常消息原样）。
 * 与 `py-store/scripts/parity_deny.py` 输出逐字节比对；依据 core 原文，禁改文案对齐。
 */

const { workflow } = require('../src');

// 坏 defn：query 步骤引用未注册 model → 触发注册期可规划性校验（B1）
const BAD_DEFN = {
  name: 'parityBad',
  steps: [{ op: 'query', as: 'x', gql: 'NoSuchModel($condition:@c){ _id }', params: { c: {} } }],
};

try {
  workflow.register(BAD_DEFN);
  process.stdout.write('OK\n');           // 不应发生；出现即测试判失败
} catch (e) {
  process.stdout.write(String(e && e.message ? e.message : e) + '\n');
}
