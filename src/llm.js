'use strict';

/**
 * 插拔式 LLM 注册表 —— 《AI能力接入设计-L1问数档.md》§4.2 决策 D6（M2 nodejs-store parity）
 *
 * 协议（唯一）：`async function llm(messages: Array<{role, content}>) => string`
 * nodejs-store 不引入任何 LLM SDK（依赖由宿主应用决定）；护栏在 core/Host 不在 LLM，
 * 能力开关只影响首次命中率，不影响正确性。
 *
 * 插拔三件套（对齐 py_store.llm 同名件）：
 *   - registerLlm()       注册；client 为符合协议的函数（测试注入假 LLM 同走此口）；
 *                         同名重复注册显式报错（禁静默覆盖）
 *   - getLlm()            按名取用；未注册显式报错（禁静默回落默认厂商）
 *   - makeOpenaiCompat()  OpenAI 兼容通用工厂（Node 18+ 全局 fetch，零依赖）：
 *                         一个实现覆盖 DeepSeek/OpenAI/Moonshot/SiliconFlow/Ollama 等
 *                         兼容端点；Anthropic 原生等特殊协议由应用侧自行 make 后注册，
 *                         数据层不内置 SDK。
 *
 * 能力差异收敛为工厂开关（同 py）：
 *   - jsonMode=false：不传 response_format，退化路径 = prompt 约定 + ask() 严格
 *     JSON 解析失败回喂（D3）；
 *   - effort=null：不传 reasoning_effort（非推理模型或不支持该参数的端点）。
 *
 * 实测接入事实（py 侧原型实证，直接继承；见设计文档 §4.2「三个接入事实」）：
 *   1. DeepSeek 网关对默认 UA 断连（curl 同参 200 实证）→ 显式覆盖 User-Agent
 *      （fetch 默认 UA 为 `node`，同理覆盖）；
 *   2. json_object 模式要求 prompt 含 "json" 字样，缺失时网关 400 → 工厂契约预检，
 *      缺失即抛 llmJsonPromptMissing（禁静默替调用方改写消息面，no-error-masking）；
 *   3. 网络层断连/超时 → llmNetworkError；HTTP 4xx/5xx → llmHttpError（携状态码
 *      与响应体片段）；空 content（多为推理 token 耗尽 max_tokens）→ llmEmptyContent
 *      （携 finish_reason 与推理 token 数，禁静默返回空串）。
 *      三者均以 LlmError（Error 子类，.detail 携结构化对象）抛出，ask() 原样穿透
 *      （不回喂、不降级）——对齐 py 侧 RuntimeError(dict) 的「异常本体携带结构化详情」。
 */

const _REGISTRY = new Map();

/**
 * LLM 客户端自身的结构化失败（网络 / HTTP / 契约预检 / 空 content）
 *
 * .detail 为结构化对象（code 稳定、其余字段如实），message 内嵌序列化详情——
 * 上游不读属性也能看到失败原因（对齐 AskExhausted 的消息形态）。
 */
class LlmError extends Error {
  constructor(detail) {
    super(`${(detail && detail.code) || 'llmError'}: ${JSON.stringify(detail)}`);
    this.name = 'LlmError';
    this.detail = detail;
  }
}

/** 注册一个 LLM 客户端；同名重复注册显式报错（禁静默覆盖） */
function registerLlm(name, client) {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('registerLlm(name, client) 需要非空字符串注册名');
  }
  if (typeof client !== 'function') {
    throw new TypeError('LLM 客户端必须是符合协议的函数：async (messages) => string');
  }
  if (_REGISTRY.has(name)) {
    throw new Error(`LLM 客户端重复注册: ${name}`);
  }
  _REGISTRY.set(name, client);
}

/** 按注册名取客户端；未注册显式报错（禁静默回落默认厂商） */
function getLlm(name) {
  if (!_REGISTRY.has(name)) {
    throw new Error(`LLM 客户端未注册: ${String(name)}（已注册: ${[..._REGISTRY.keys()].sort().join(', ') || '（无）'}）`);
  }
  return _REGISTRY.get(name);
}

/**
 * OpenAI 兼容端点通用工厂（返回符合协议的 async llm；Node 18+ 全局 fetch，零依赖）。
 *
 * 失败全部显式抛 LlmError（.detail 结构化），禁静默返回空串——
 * 空 content 的实证成因与防御见模块 docstring 与设计文档 W3。
 */
function makeOpenaiCompat({
  baseUrl,
  model,
  apiKey,
  jsonMode = true,
  effort = 'low',
  maxTokens = 4096,
  timeoutMs = 90000,
} = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new TypeError('makeOpenaiCompat 需要非空 baseUrl');
  }
  if (typeof model !== 'string' || !model) {
    throw new TypeError('makeOpenaiCompat 需要非空 model');
  }

  async function llm(messages) {
    const body = { model, messages, max_tokens: maxTokens };
    if (jsonMode) {
      // 契约预检：json_object 要求 prompt 含 "json" 字样（DeepSeek 实测 400 实证）。
      // 缺失显式报错交上游装配修复，禁静默改写调用方消息面（no-error-masking）
      const joined = messages.map((m) => String((m && m.content) ?? '')).join(' ').toLowerCase();
      if (!joined.includes('json')) {
        throw new LlmError({
          code: 'llmJsonPromptMissing',
          model,
          message: "json_mode=true 要求 messages（system/user）中包含 'json' 字样",
          hint: "ask() 的 system 输出契约模板已固定含 'JSON' 措辞；自定义 knowledge 时须保留",
        });
      }
      body.response_format = { type: 'json_object' };
    }
    if (effort !== null && effort !== undefined) {
      body.reasoning_effort = effort;
    }

    let resp;
    try {
      resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // 默认 UA「node」被 DeepSeek 网关断连（py 侧 urllib 同因实证），显式覆盖
          'User-Agent': 'nodejs-store-ask/0.1',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 网络层断连 / 超时 / 重置，结构化暴露（不吞错、不重试）
      throw new LlmError({ code: 'llmNetworkError', model, detail: String((e && e.message) || e) });
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new LlmError({ code: 'llmHttpError', status: resp.status, model, body: String(text).slice(0, 500) });
    }
    const data = await resp.json();
    const choice = (Array.isArray(data.choices) && data.choices[0]) || {};
    const content = choice.message ? choice.message.content : undefined;
    if (!content) {
      throw new LlmError({
        code: 'llmEmptyContent',
        model,
        finish_reason: choice.finish_reason ?? null,
        reasoning_tokens: (data.usage && data.usage.completion_tokens_details)
          ? (data.usage.completion_tokens_details.reasoning_tokens ?? null)
          : null,
        message: 'LLM 返回空 content（多为 max_tokens 被推理耗尽，调大 max_tokens 或降 effort）',
      });
    }
    return content;
  }

  return llm;
}

module.exports = { LlmError, registerLlm, getLlm, makeOpenaiCompat, _registry: _REGISTRY };
