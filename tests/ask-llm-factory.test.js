'use strict';

/**
 * llm.js OpenAI 兼容工厂行为矩阵（D4-4 零语义拆分）。
 *
 * 自 ask.test.js 原样迁出 `llm · OpenAI 兼容工厂（D6）` describe 与 `_llmCodeOf`
 * 断言器；用例名与断言逐字未改。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { LlmError, llm: llmReg, assertClientRejects } = require('../test-support/ask-support');

/** rejects 断言器：LlmError 且 detail.code 匹配（llm 工厂矩阵共用） */
function _llmCodeOf(code) {
  return (e) => {
    assert.ok(e instanceof LlmError);
    assert.equal(e.detail.code, code);
    return true;
  };
}

// ── llm.js 工厂行为矩阵（py 侧原型实测事实的 node 侧固化） ─────

describe('llm · OpenAI 兼容工厂（D6）', () => {
  const BASE = { baseUrl: 'https://llm.example/v1', model: 'deepseek-flash', apiKey: 'sk-test' };

  /** 临时替换全局 fetch（makeOpenaiCompat 的唯一 IO 面），用毕恢复 */
  function withFetch(fake, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = fake;
    return Promise.resolve()
      .then(fn)
      .finally(() => { globalThis.fetch = orig; });
  }

  it('json_mode 契约预检：prompt 缺 "json" 字样即抛 llmJsonPromptMissing（不发出请求）', async () => {
    let fetched = 0;
    await withFetch(async () => { fetched += 1; }, async () => {
      const client = llmReg.makeOpenaiCompat(BASE);
      await assert.rejects(
        client([{ role: 'user', content: '随便聊聊今天的天气' }]),
        _llmCodeOf('llmJsonPromptMissing'),
      );
      assert.equal(fetched, 0, '预检失败不得发出网络请求');
    });
  });

  it('HTTP 4xx/5xx → llmHttpError（携状态码与响应体片段）', async () => {
    await withFetch(async () => ({
      ok: false, status: 500, text: async () => 'boom-body',
    }), async () => {
      await assertClientRejects(llmReg, BASE, (e) => {
        assert.equal(e.detail.code, 'llmHttpError');
        assert.equal(e.detail.status, 500);
        assert.equal(e.detail.body, 'boom-body');
        return true;
      });
    });
  });

  it('网络层断连 → llmNetworkError', async () => {
    await withFetch(async () => { throw new Error('socket hang up'); }, async () => {
      await assertClientRejects(llmReg, BASE, (e) => {
        assert.equal(e.detail.code, 'llmNetworkError');
        assert.match(e.detail.detail, /socket hang up/);
        return true;
      });
    });
  });

  it('空 content → llmEmptyContent（携 finish_reason 与 reasoning_tokens，禁静默空串）', async () => {
    await withFetch(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { completion_tokens_details: { reasoning_tokens: 440 } },
      }),
    }), async () => {
      await assertClientRejects(llmReg, BASE, (e) => {
        assert.equal(e.detail.code, 'llmEmptyContent');
        assert.equal(e.detail.finish_reason, 'length');
        assert.equal(e.detail.reasoning_tokens, 440);
        return true;
      });
    });
  });

  it('正常路径返回 content；json_mode 与 effort 开关如实反映在请求体', async () => {
    const bodies = [];
    await withFetch(async (url, init) => {
      bodies.push({ url, body: JSON.parse(init.body), ua: init.headers['User-Agent'] });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"gql":"M{_id}","params":{}}' } }] }),
      };
    }, async () => {
      const client = llmReg.makeOpenaiCompat(BASE);
      const out = await client([{ role: 'user', content: '输出 json' }]);
      assert.equal(out, '{"gql":"M{_id}","params":{}}');
      assert.equal(bodies[0].url, 'https://llm.example/v1/chat/completions');
      assert.equal(bodies[0].body.model, 'deepseek-flash');
      assert.equal(bodies[0].body.response_format.type, 'json_object');
      assert.equal(bodies[0].body.reasoning_effort, 'low');
      assert.equal(bodies[0].body.max_tokens, 4096);
      // 默认 UA 被网关断连（py 侧实证），工厂显式覆盖
      assert.equal(bodies[0].ua, 'nodejs-store-ask/0.1');
    });
    // jsonMode=false：不传 response_format；effort=null：不传 reasoning_effort
    await withFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    }, async () => {
      const client = llmReg.makeOpenaiCompat({ ...BASE, jsonMode: false, effort: null });
      await client([{ role: 'user', content: '随意' }]);
      assert.ok(!('response_format' in bodies[1]));
      assert.ok(!('reasoning_effort' in bodies[1]));
    });
  });
});
