'use strict';

/**
 * 向量能力探测（宿主只负责探测环境，判定唯一在 core `capability::vector_capability`）。
 */

const { list, get } = require('./schema');
const native = require('./core');
const datasource = require('./datasource');
const { emit } = require('./feedback');

function _backendOf(connection) {
  const kind = datasource.kindOf(connection);
  return kind === 'mongo' ? 'mongodb' : kind;
}

/** 该 source 下是否有 schema 的索引项声明了 `options.indexName`（Atlas 唯一可判据） */
function _atlasDeclared(source) {
  for (const name of list()) {
    let meta;
    try {
      meta = get(name);
    } catch (e) {
      continue; // 未注册（理论不可达）：不参与判定，不静默改判
    }
    if ((meta.datasource || 'default') !== source) continue;
    for (const ix of meta.indexes || []) {
      const indexName = ix && ix.options && ix.options.indexName;
      if (typeof indexName === 'string' && indexName) return true;
    }
  }
  return false;
}

/** PG 扩展探测：失败即 emit，返回 false（禁把探测失败当成「已安装」） */
async function _pgvectorReady(source) {
  try {
    const out = await datasource.executeRaw(
      source,
      "SELECT 1 AS present FROM pg_extension WHERE extname = 'vector'",
      null,
      false,
    );
    return Array.isArray(out.rows) && out.rows.length > 0;
  } catch (e) {
    emit({
      type: 'capability_probe_failed',
      code: 'capabilityProbeFailed',
      layer: 'host',
      backend: 'postgres',
      source,
      message: `探测 pgvector 扩展失败：${(e && e.message) || e}`,
      hint: '检查该数据源的连接权限；探测失败按「未安装」处理（不猜、不放行）',
    });
    return false;
  }
}

/**
 * 按 source 返回向量能力。
 * @param {{source?: string}} [opts] source 缺省 `default`
 * @returns {Promise<{source: string, vector: {supported:boolean,native:boolean,backend:string,metrics:string[],maxDim:number}}>}
 */
async function capabilities(opts = {}) {
  const source = opts.source || datasource.DEFAULT_SOURCE;
  if (!datasource.hasConnection(source)) {
    emit({
      type: 'capability_unknown_source',
      code: 'capabilityUnknownSource',
      layer: 'host',
      source,
      message: `能力探测请求的数据源 ${source} 未配置`,
      hint: '先经 init(connections) 注入该数据源，或改用已配置的 source',
    });
    return {
      source,
      vector: { supported: false, native: false, backend: 'unknown', metrics: [], maxDim: 0 },
    };
  }

  const backend = _backendOf(datasource.getConnection(source));
  const nativeReady = backend === 'postgres' ? await _pgvectorReady(source) : false;
  const atlasIndex = backend === 'mongodb' ? _atlasDeclared(source) : false;

  return {
    source,
    vector: native.vectorCapability(backend, nativeReady, atlasIndex),
  };
}

module.exports = { capabilities };
