'use strict';

/**
 * HTTP 拉取适配器（第三方接口 = 供数链路；对齐执行文档 03 §4.1）
 *
 * 契约：
 *   - 只有 **pull** 能力，不可被 GQL 直接查询（禁注册为 `datasource` kind）；
 *   - 只做「请求 → 规范化 → 返回 `object[]`」，**禁 filter / 排序 / 聚合**
 *     （无下推能力，整量取回，求值只在 core）；
 *   - 失败一律**显式抛错**（禁静默成空数组）：非 2xx / 响应体非 JSON / `pick` 结果非数组
 *     均抛 `HttpAdapterError`；成功且 0 条 ⇒ 返回 `[]`（合法结果，与失败可区分）；
 *   - 不做重试、不做分页循环（分页由调用方按 `params` 多次调用）。
 */

/** HTTP 适配器错误（携 `status` / `url`；`name = 'HttpAdapterError'`） */
class HttpAdapterError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'HttpAdapterError';
    this.status = status;
    this.url = url;
  }
}

/**
 * HTTP 拉取适配器。
 * @param {object} spec
 * @param {string} spec.baseUrl                    接口基址
 * @param {'GET'|'POST'} [spec.method='GET']
 * @param {object} [spec.headers]                  额外请求头
 * @param {(params: object) => string} [spec.path] 由参数拼路径（缺省用 `baseUrl` 原样）
 * @param {(json: any) => object[]} [spec.pick]    从响应 JSON 取文档数组（缺省：响应本身须为数组）
 * @param {(row: object) => object} [spec.map]     逐文档字段映射（缺省：原样）
 * @param {Function} [spec.fetchImpl]              注入 fetch（测试用）
 * @param {number} [spec.timeoutMs]                超时毫秒（缺省不设）
 * @returns {{ fetch: (params?: object) => Promise<object[]> }}
 */
function createHttpAdapter(spec) {
  if (!spec || typeof spec.baseUrl !== 'string' || !spec.baseUrl) {
    throw new TypeError('createHttpAdapter 需要 spec.baseUrl');
  }
  const {
    baseUrl,
    method = 'GET',
    headers = null,
    path: pathFn = null,
    pick = null,
    map = null,
    fetchImpl = null,
    timeoutMs = 0,
  } = spec;

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    throw new Error("createHttpAdapter 需要 fetch（Node >= 18 内置）或注入 spec.fetchImpl");
  }

  async function fetchDocs(params = {}) {
    const url = pathFn ? pathFn(params) : baseUrl;
    const init = { method, headers: headers || undefined };
    if (method === 'POST') {
      init.headers = { 'content-type': 'application/json', ...(headers || {}) };
      init.body = JSON.stringify(params ?? {});
    }
    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);

    let res;
    try {
      res = await doFetch(url, init);
    } catch (e) {
      throw new HttpAdapterError(
        `HTTP 请求失败 ${url}: ${e && e.message ? e.message : e}`,
        { url },
      );
    }

    if (!res || !(res.status >= 200 && res.status < 300)) {
      const status = res ? res.status : null;
      throw new HttpAdapterError(`HTTP ${status} ${url}`, { status, url });
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new HttpAdapterError(
        `HTTP 响应非 JSON ${url}: ${String(text).slice(0, 200)}`,
        { status: res.status, url },
      );
    }

    const rows = pick ? pick(json) : json;
    if (!Array.isArray(rows)) {
      throw new HttpAdapterError(
        `HTTP 响应结构非数组 ${url}: pick 返回 ${Array.isArray(rows) ? 'array' : typeof rows}`,
        { status: res.status, url },
      );
    }
    return map ? rows.map((r) => map(r)) : rows;
  }

  return { fetch: fetchDocs };
}

module.exports = { createHttpAdapter, HttpAdapterError };
