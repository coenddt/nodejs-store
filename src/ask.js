'use strict';

/**
 * AI 问数（L1）—— `ask()` 唯一入口 + `describeForAi` schema 摘要生成器
 *
 * 《AI能力接入设计-L1问数档.md》§4 的宿主侧两个新组件（M2 nodejs-store parity，
 * 与 py_store/ask.py 逐函数同构），把既有能力接线：
 *
 *     用户问题 → ① describeForAi(ctx) 权限过滤摘要
 *              → ② LLM（注入式客户端）翻译为 {"gql","params"}
 *              → ③ text2query() 档内规划期校验（core 判决：语法/档位/权限/硬限）
 *              → ④ crud.query 执行（只读）
 *              → ⑤ 失败结构化回喂 LLM 重试（≤ maxRetries 次），耗尽抛 AskExhausted
 *
 * 护栏面（D5，服务端硬编码，LLM 零可触）：
 *   - 档位 = text2query：本模块硬编码 `text2query()` 包裹全部执行；
 *   - 用户上下文 = ctx：服务端注入参数，经 permission.scopedContext 进执行面，
 *     绝不进入任何 LLM 消息；core 档位门禁强制无 ctx 即拒（fail-secure，A4）；
 *   - routeOverride = null：硬编码（CWE-639；Host 兜底 _guardRouteOverride 双保险）；
 *   - 行数/深度/联邦硬限：core 常量（T2Q_MAX_ROWS=1000 / T2Q_MAX_DEPTH=3 / ...，A5）；
 *   - 只读：编排面仅 crud.query（mutation/remove 属 L2，禁入）。
 *
 * LLM 输出永远当不可信输入：唯一产出形状 `{"gql","params"}` 单 JSON 对象（D3），
 * 严格 JSON 解析、禁正则容错提取；幻觉最坏后果是「规划失败 + 结构化错误回喂」，
 * 不可能变成不受控命令。一切失败结构化显式暴露（no-error-masking：是错就是错，
 * 禁降级、禁返回空结果——「问数失败」就是失败，交上层裁决，D4）。
 *
 * 并发限制（如实声明）：text2query 档位（core 单例）与反馈 sink 为进程级全局，
 * 同一进程内并发调用 ask() 会互相串扰，宿主需串行化（或每任务独享进程/事件循环）。
 */

const fs = require('node:fs');
const path = require('node:path');

const crud = require('./crud');
const feedback = require('./feedback');
const permission = require('./permission');
const schema = require('./schema');
const { text2query } = require('./profile');
const { getLlm } = require('./llm');

// ─── 轨迹载体 ──────────────────────────────────────────────────

/** 问数成功结果：查询数据 + 全部尝试轨迹 + 反馈事件（对齐 py AskResult） */
class AskResult {
  /**
   * - `data`：查询结果数组（crud.query 原样返回）；
   * - `attempts`：每次尝试一条（`llmRaw` / `gql` / `params` / `rows`），
   *   最后一轮为成功轮——**不含任何 error 键**（成功态无错误字段，
   *   no-error-masking 正向断言）；
   * - `events`：执行期接管到的反馈事件（拦截/降级告警；无拦截时为空数组）。
   */
  constructor(data, attempts, events) {
    this.data = data;
    this.attempts = attempts;
    this.events = events;
  }
}

/**
 * 重试耗尽：maxRetries 次回喂重试后仍失败（D4：显式失败，不降级、不返回空结果）
 *
 * `attempts` / `events` 携带全部尝试轨迹；消息内嵌最后一轮结构化错误，
 * 上游不读属性也能看到失败原因。
 */
class AskExhausted extends Error {
  constructor(attempts, events) {
    const lastError = (attempts.length && attempts[attempts.length - 1].error)
      || { code: 'unknown' };
    super(`ask() 重试耗尽（共 ${attempts.length} 次尝试全部失败），不降级、不返回空结果；`
      + `最后一轮错误: ${JSON.stringify(lastError)}；完整轨迹见 .attempts / .events`);
    this.name = 'AskExhausted';
    this.attempts = attempts;
    this.events = events;
  }
}

// ─── 组件 A：schema 摘要生成器 ─────────────────────────────────

// 计算列收窄告警去重（同 (model, compute) 只告警一次，对齐 py _COMPUTE_SKIP_SIGS）
const _computeSkipSigs = new Set();

/** 字段类型字符串（str 形态原样；dict 形态取 type；其余显式 null，不伪造） */
function _fieldType(fdef) {
  if (typeof fdef === 'string') return fdef;
  if (fdef && typeof fdef === 'object') return fdef.type;
  return null;
}

function _emitComputeSkipped(model, compute) {
  const sig = `${model}\u0000${compute}`;
  if (_computeSkipSigs.has(sig)) return;
  _computeSkipSigs.add(sig);
  feedback.emit({
    type: 'ask_summary_compute_skipped',
    code: 'askSummaryComputeSkipped',
    layer: 'host',
    message: `AI 摘要收窄：模型 ${model} 的计算列 ${compute} 配置了 read 白名单，`
      + 'core-node 绑定未导出 readableComputes 判决，为不越权暴露已从摘要排除',
    hint: '去掉该计算列的 read 配置可进摘要；或在 core-node 导出 readableComputes '
      + '后接入 describeForAi（执行面权限判决始终在 core，此处仅摘要暴露面收窄）',
    model,
    compute,
  });
}

/**
 * 输出 LLM 可读的 schema 摘要（紧凑 JSON 数组，每模型一条；对齐 py describe_for_ai）。
 *
 * 过滤规则（顺序固定，设计文档 §4.1）：
 *   1. 排除归档表（名称以 `Deleted` 结尾，对齐 store-api 派生路由先例）；
 *   2. 模型级按 core `canRead`；字段/关系按 core 角色可读集（`readableFields` /
 *      `readableRelations`，列级白名单）；计算列按 core `readableComputes` 角色判决——
 *      该判决在 core-node 已导出（rust-store「导出 readableComputes」任务合入后），
 *      旧绑定未导出时按声明 read 白名单**保守收窄**并 emit 告警（宁缺勿泄，
 *      对齐 py 现状；执行面判决始终在 core，收窄只影响摘要暴露面）；
 *      无 ctx → 仅暴露模型名与字段名，不暴露类型细节（防探针）；
 *   3. 不输出 indexes / datasource / database / schema（运维细节不进 prompt）。
 */
function describeForAi(ctx = null) {
  const summaries = [];
  for (const name of schema.list()) {
    if (name.endsWith('Deleted')) continue;
    const mirror = schema.get(name);
    if (ctx == null) {
      summaries.push({ name, fields: Object.keys(mirror.fields).sort() });
      continue;
    }
    if (!permission.canReadSchema(name, ctx)) continue;
    const readable = new Set(permission.getReadableFields(name, ctx));
    const fields = {};
    for (const [fname, fdef] of Object.entries(mirror.fields)) {
      if (readable.has(fname)) fields[fname] = _fieldType(fdef);
    }
    for (const fname of [...readable]
      .filter((f) => !(f in mirror.fields))
      .sort()) {
      // core 自动补的时间戳字段（createdAt/updatedAt）不在 Host 镜像——类型显式留白
      fields[fname] = null;
    }
    const relations = {};
    const readableRels = new Set(permission.getReadableRelations(name, ctx));
    for (const [rname, rdef] of Object.entries(mirror.relations)) {
      if (readableRels.has(rname)) {
        relations[rname] = { model: rdef.model, type: rdef.type };
      }
    }
    const computes = {};
    // 新绑定：core 角色判决；旧绑定（core-node 未导出 readableComputes，如 npm
    // rust-store-node 2.0.0）：能力探测降级为「配 read 一律收窄 + 告警」（对齐 py 现状）
    const readableComputes = typeof schema.core.readableComputes === 'function'
      ? new Set(permission.getReadableComputes(name, ctx))
      : null;
    for (const [cname, cdef] of Object.entries(mirror.computes)) {
      if (readableComputes !== null) {
        if (!readableComputes.has(cname)) continue;
      } else if (cdef.read !== undefined && cdef.read !== null) {
        _emitComputeSkipped(name, cname);
        continue;
      }
      const entry = {};
      if (cdef.agg !== undefined && cdef.agg !== null) entry.agg = cdef.agg;
      if (cdef.type !== undefined && cdef.type !== null) entry.type = cdef.type;
      computes[cname] = entry;
    }
    summaries.push({ name, fields, relations, computes });
  }
  return summaries;
}

// ─── 组件 B：ask() 编排器 ──────────────────────────────────────

let _knowledgeCache = null;

/** 知识文本：传参优先（测试/自定义）；缺省读包内 ask_knowledge.md（text-to-query 裁剪版） */
function _loadKnowledge(knowledge) {
  if (knowledge !== undefined && knowledge !== null) return knowledge;
  if (_knowledgeCache === null) {
    _knowledgeCache = fs.readFileSync(path.join(__dirname, 'ask_knowledge.md'), 'utf8');
  }
  return _knowledgeCache;
}

/** system prompt = 翻译知识 + 摘要 + 输出契约（D3；含 "json" 字样满足 json_mode 预检） */
function _buildSystemPrompt(summary, knowledge) {
  return `${knowledge}\n\n`
    + '## 可用模型摘要（当前用户可见；字段/关系/计算列已按权限过滤）\n'
    + `${JSON.stringify(summary)}\n\n`
    + '## 输出契约（唯一产出形状）\n'
    + '只输出一个 json 对象：{"gql": "<GQL 查询串>", "params": {<参数对象>}}。\n'
    + '- 条件值一律参数化：GQL 内用 @key 引用，真实值放 params（键 = 去掉 @ 的引用名）；\n'
    + '  禁止内联值进 GQL 串。\n'
    + '- 禁止输出解释文字、markdown 代码围栏、或除 gql/params 外的任何键。\n';
}

/** LLM 输出未通过严格解析（携带结构化 detail 供回喂）——内部控制流，不外穿 */
class BadLlmOutput extends Error {
  constructor(detail) {
    super(detail.detail || 'badLlmOutput');
    this.name = 'BadLlmOutput';
    this.detail = detail;
  }
}

/** 严格 JSON 解析 + 形状校验（D3）；失败抛 BadLlmOutput（禁正则容错提取） */
function _parseLlmOutput(raw) {
  const fail = (detail) => new BadLlmOutput({
    code: 'badLlmOutput',
    message: 'LLM 输出不是合法的 {"gql","params"} 单 JSON 对象',
    detail,
    raw: String(raw ?? '').slice(0, 500),
  });

  if (typeof raw !== 'string') throw fail(`输出不是字符串: ${typeof raw}`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw fail(`JSON 解析失败: ${(e && e.message) || e}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail(`顶层不是 JSON 对象: ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'gql' || keys[1] !== 'params') {
    throw fail(`键集合必须恰为 gql/params，实际: ${keys}`);
  }
  const { gql, params } = parsed;
  if (typeof gql !== 'string' || !gql.trim()) throw fail('gql 必须为非空字符串');
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw fail('params 必须为 JSON 对象');
  }
  return { gql, params };
}

/**
 * 执行失败 → 回喂错误对象：core/Host 拦截事件**原样透传**（禁改写禁摘要）；
 * 无事件兜底构造时只给确证字段（feature/layer 留白不伪造）
 */
function _errorFromException(e, roundEvents) {
  for (const ev of roundEvents) {
    if (ev && ev.type === 'profile_blocked') return { ...ev };
  }
  if (e instanceof permission.PermissionError) {
    return { code: 'permissionDenied', message: String(e.message) };
  }
  if (e instanceof crud.ProfileViolation) {
    return { code: 'profileBlocked', message: String(e.message) };
  }
  return { code: 'planError', message: String((e && e.message) || e) };
}

/**
 * AI 问数唯一入口（L1 只读）：自然语言 → LLM 翻译 → 受控沙箱执行 → 结构化回喂。
 *
 * 参数（options 对象，对齐 py keyword-only 形参）：
 *   question   : 自然语言问题（非空字符串）。
 *   llm        : 注册名（string，经 llm.getLlm）或现成客户端
 *                （协议 `async (messages) => string`，D2/D6 注入式，零 SDK）。
 *   ctx        : 服务端构造的用户上下文（`{userId: ..., roles: [...]}`）；
 *                null/undefined 直接拒绝（fail-secure）；LLM 永远碰不到本参数（D5）。
 *   maxRetries : 失败后的最大**重试**次数（总尝试 ≤ 1 + maxRetries）；耗尽抛 AskExhausted。
 *   knowledge  : 覆盖 system prompt 知识文本（缺省用包内 ask_knowledge.md）。
 *
 * 返回 AskResult(data, attempts, events)；LLM 客户端自身的异常（网络/HTTP/空 content，
 * LlmError 结构化）**原样穿透**——回喂循环只裁决「翻译质量/查询合法性」，
 * 链路故障显式失败不重试。
 *
 * 轨迹契约：成功轮 attempt 不含 error 键；每次失败以 user 消息追加
 * `{"error": {...}}`（core/Host 结构化错误原样透传，§4.3）。
 */
async function ask(question, { llm, ctx, maxRetries = 3, knowledge = null } = {}) {
  if (typeof question !== 'string' || !question.trim()) {
    throw new TypeError('ask(question) 需要非空自然语言问题字符串');
  }
  if (ctx == null) {
    // fail-secure：core text2query 档强制 ctx（ensure_profile_ctx）——入口先拒，
    // 免一次注定失败的 LLM 调用；空对象等其余边界交 core/权限层如实判决
    throw new TypeError(
      'ask() 需要服务端构造的用户上下文 ctx（如 { userId: ..., roles: [...] }）；'
      + 'ctx 属受信参数，LLM 永远碰不到（D5）');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError(`maxRetries 必须为非负整数，实际: ${JSON.stringify(maxRetries)}`);
  }
  if (llm === undefined) {
    throw new TypeError('ask() 需要 LLM 客户端 llm（注册名或符合协议的 async (messages) => string 函数）');
  }
  const client = typeof llm === 'function' ? llm : getLlm(llm);
  const system = _buildSystemPrompt(describeForAi(ctx), _loadKnowledge(knowledge));

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ];
  const attempts = [];
  const events = [];
  const roundEvents = [];

  const collect = (event) => {
    events.push(event);
    roundEvents.push(event);
  };

  const prevSink = feedback.getSink();
  feedback.setSink(collect);
  let result;
  try {
    // 成功轮在内层闭包 return AskResult；循环走完（耗尽）内层返回 undefined
    result = await text2query(() => permission.scopedContext(ctx, async () => {
      for (let i = 0; i < 1 + maxRetries; i++) {
        roundEvents.length = 0;
        // LLM 客户端异常（llmNetworkError/llmHttpError/llmEmptyContent）原样穿透
        const raw = await client(messages);
        const attempt = { llmRaw: raw };
        let parsed;
        try {
          parsed = _parseLlmOutput(raw);
        } catch (e) {
          if (!(e instanceof BadLlmOutput)) throw e;
          attempt.error = e.detail;
          attempts.push(attempt);
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: JSON.stringify({ error: e.detail }) });
          continue;
        }
        attempt.gql = parsed.gql;
        attempt.params = parsed.params;
        try {
          // routeOverride 硬编码 null（受信参数，禁 AI 侧指定，D5/CWE-639）
          const data = await crud.query(parsed.gql, parsed.params, null);
          attempt.rows = data.length;
          attempts.push(attempt);
          return new AskResult(data, attempts, events);
        } catch (e) {
          attempt.error = _errorFromException(e, roundEvents);
          attempts.push(attempt);
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: JSON.stringify({ error: attempt.error }) });
        }
      }
    }));
  } finally {
    feedback.setSink(prevSink);
  }
  if (result !== undefined) return result;
  throw new AskExhausted(attempts, events);
}

module.exports = {
  AskResult,
  AskExhausted,
  ask,
  describeForAi,
  // 内部件（测试取证用；下划线惯例对齐 crud/_ctx 等先例）
  _computeSkipSigs,
  _parseLlmOutput,
};
