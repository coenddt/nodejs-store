'use strict';

/**
 * 启动期索引保障（D4-4 零语义拆分自 index.js）：按 source 分派，Mongo 源幂等创建
 * `schema.indexes` 声明的索引；嵌入式载体声明即告警；SQL 后端不建索引。
 *
 * 索引创建是初始化的**辅助动作**（不参与命令路由）：失败不阻塞 init，但一律走统一
 * 反馈通道（禁静默）。与拆分前逐字同语义。
 */

const datasource = require('../datasource');
const feedback = require('../feedback');
const naming = require('../naming');
const schema = require('../schema');

/**
 * 索引名对齐 MongoDB 自动命名（k1_v1_k2_v2），用于幂等创建。
 *
 * 按 source 分派：Mongo 源执行 `_createIndexesIfNeeded`；SQL 后端**不建索引**
 * （`schema.indexes` 仅作元数据，见执行文档 Phase 3 动作 5）。
 */
/** 嵌入式载体（local / memory）v1 无索引：声明 indexes 即告警（禁静默忽略） */
function _warnLocalIndexes(name, s, conn) {
  if (!(s.indexes || []).length) return;
  feedback.emit({
    type: 'local_indexes_ignored',
    code: 'localIndexesIgnored',
    layer: conn.kind,
    message: `schema ${name} 声明了 indexes，但 ${conn.kind} 数据源 v1 不建索引（仅顺序扫描）`,
    hint: `${conn.kind} 源请勿声明 indexes；需要索引请改用 sqlite/mongo 等后端`,
    schema: name,
  });
}

/** 单个索引的幂等创建：合并 inline 选项与显式 options，同 key 模式已存在则跳过 */
async function _ensureIndex(coll, idx, existingIndexes, s) {
  try {
    const keys = idx.keys;
    if (!keys) return;

    // 合并 inline 选项（unique/sparse/expireAfterSeconds 等）与显式 options
    const explicitOptions = idx.options || {};
    const finalOptions = {};
    for (const [k, v] of Object.entries(idx)) {
      if (k !== 'keys' && k !== 'options') finalOptions[k] = v;
    }
    Object.assign(finalOptions, explicitOptions);

    // 检查是否已有同 key 模式的索引（忽略选项差异）；键按目标介质逐段翻译为
    // 物理名（点号路径保留层级结构，不得整串拼接）
    const physKeys = Object.entries(keys).map(([k, v]) => [naming.physicalPath(k), v]);
    const nameFromKeys = physKeys.map(([k, v]) => `${k}_${v}`).join('_');
    if (existingIndexes.some((ei) => ei.name === nameFromKeys)) return;

    await coll.createIndex(physKeys, finalOptions);
  } catch (e) {
    // 索引创建失败不阻塞 init（辅助动作），但必须走统一反馈通道：
    // 无 sink 时由 feedback 默认落 stderr（不双份打印），宿主可 setFeedbackSink 接管
    feedback.emit({
      type: 'index_create_failed',
      code: 'indexCreateFailed',
      layer: 'host',
      message: `创建索引失败 ${s.collection}: ${e && e.message ? e.message : e}`,
      hint: '检查该集合的索引定义与连接权限；索引缺失不影响读写，相关查询将退化为全表扫描',
    });
  }
}

/** 单个 schema 的索引保障：连接缺失软跳过；嵌入式告警跳过；SQL 源不建索引 */
async function _createIndexesForSchema(name, s) {
  // 索引创建是初始化的辅助动作（非命令路由）：schema 绑定的 source 暂未在
  // 当前连接映射中时软跳过，不阻塞 init；其余配置错误（database 形态不匹配等）
  // 按 fail-fast 由 dbOfSchema 上抛，不静默吞掉
  if (!datasource.hasConnection(datasource.sourceOfSchema(name))) return;
  // 嵌入式载体（local / memory）v1 无索引（仅顺序扫描）：声明 indexes 即告警（禁静默忽略），直接跳过建索引
  const conn = datasource.getConnection(datasource.sourceOfSchema(name));
  if (datasource.isEmbeddedConnection(conn)) {
    _warnLocalIndexes(name, s, conn);
    return;
  }
  const db = datasource.dbOfSchema(name); // Mongo 按 (datasource, database) 解析；SQL 源返回 null
  if (!db) return; // SQL 后端不建索引

  // 物理集合名：与命令执行路径同源（core::naming 的 camelCase 翻译，单点）
  const coll = db.collection(naming.physical(s.collection));

  let existingIndexes;
  try {
    existingIndexes = await coll.listIndexes().toArray();
  } catch (e) {
    // 只吞服务器错误（集合尚未存在 → NamespaceNotFound 属 MongoServerError）；
    // 连接/程序错误按 fail-fast 上抛，不再静默吞掉（对齐 py 侧 PyMongoError 收窄）
    if (e && e.name === 'MongoServerError') existingIndexes = [];
    else throw e;
  }

  for (const idx of s.indexes || []) {
    await _ensureIndex(coll, idx, existingIndexes, s);
  }
}

async function _createIndexesIfNeeded() {
  const names = schema.list();
  for (const name of names) {
    await _createIndexesForSchema(name, schema.get(name));
  }
}

module.exports = { createIndexesIfNeeded: _createIndexesIfNeeded };
