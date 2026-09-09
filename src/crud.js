'use strict';

/**
 * CRUD 操作
 *
 * 核心原则：
 *   - 写入时不补默认值（DB 存最少数据）
 *   - 读取时自动补默认值 + 执行简单计算列（计算列引擎在 computes.js）
 *   - lookup 计算列嵌入 aggregate 的 $addFields
 *   - asyncFn 计算列需显式请求
 */

const { ReturnDocument } = require('mongodb');

const {
  _mergeDependsIntoAst,
  _runAsyncFns,
  _stripDepInjected,
  applyDefaultsAndComputes,
  processNode,
} = require('./computes');
const {
  PermissionError,
  canReadSchema,
  canWriteSchema,
  evaluate,
  filterWritableData,
  getContext,
  mergeOwnerCondition,
} = require('./permission');
const { buildPipeline, buildProjection, parseGql } = require('./pipeline');
const { get: _getSchema, has: _hasSchema } = require('./schema');

let _db = null;

function setDb(db) {
  _db = db;
}

function _getDb() {
  if (_db === null) throw new Error('MongoStore 未初始化，请先调用 init(db)');
  return _db;
}

/** 剔除对象中的 null/undefined 值（原地修改），避免空值写入 DB */
function _removeUndefined(obj) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === null || obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function _col(schemaName) {
  const s = _getSchema(schemaName);
  return _getDb().collection(s.collection);
}

/** 对齐 Python Number()：数值截断为整数，字符串优先整数解析，无法转换时返回 0 */
function _toNumber(val) {
  if (typeof val === 'number') {
    return Number.isNaN(val) ? 0 : Math.trunc(val);
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  if (typeof val === 'string') {
    const t = val.trim();
    if (t === '') return 0;
    // Python int() 语义：十进制整数字符串 → 整数；否则回退浮点
    if (/^[+-]?\d+$/.test(t)) {
      const n = parseInt(t, 10);
      return Number.isNaN(n) ? 0 : n;
    }
    const f = Number(t);
    return Number.isNaN(f) ? 0 : f;
  }
  const n = Number(val);
  return Number.isNaN(n) ? 0 : n;
}

// ─── GQL 查询 ──────────────────────────────────────────────

/**
 * GQL 查询（返回数组）
 *
 * 支持的 params 键（通过 GQL 的 @key 引用）:
 *   $condition / $sort / $skip / $limit / $pipeline
 * 使用 $pipeline 时，框架不追加 compute 层、不补默认值、不裁剪，完全由用户控制。
 */
async function query(gql, params = null) {
  params = params !== null && params !== undefined ? params : {};
  const ctx = getContext();
  const ast = parseGql(gql);
  const schema = _getSchema(ast.model);

  // Schema 级读权限检查
  if (ctx && !canReadSchema(schema, ctx)) {
    throw new PermissionError('无访问权限');
  }

  // 所有者条件注入（非 admin 用户只看自己的数据）
  const condRef = ast.params.condition;
  if (ctx && condRef) {
    const condKey = condRef.slice(1);
    params[condKey] = mergeOwnerCondition(schema, ctx, params[condKey]);
  }

  // $pipeline 模式 → 用户全权控制
  const pipelineRef = ast.params.pipeline;
  const hasPipeline = !!pipelineRef && params[pipelineRef.slice(1)] != null;

  // 注入 asyncFn 计算列的关系依赖
  const injectInfo = hasPipeline ? { relations: {} } : _mergeDependsIntoAst(ast, schema);
  const hasInject = Object.keys(injectInfo.relations).length > 0;

  const pipeline = buildPipeline(ast, params);

  // 由 GQL 根字段 + fn 计算列 depends 驱动的投影，避免拉取整文档
  const projection = hasPipeline ? null : buildProjection(ast, schema, ctx);

  const coll = _col(ast.model);

  return _executePipeline(coll, pipeline, hasPipeline, projection, ast, schema, ctx,
    hasInject, injectInfo);
}

/** 按 pipeline 形态选执行路径：纯 $match → find 快路径；$lookup+分页 → 两阶段；否则标准聚合 */
async function _executePipeline(coll, pipeline, hasPipeline, projection, ast, schema, ctx,
  hasInject, injectInfo) {
  // ── 纯 $match 无关联 → 用 find 性能更好 ──
  if (!hasPipeline && pipeline.length === 1 && '$match' in pipeline[0]) {
    const cursor = projection
      ? coll.find(pipeline[0].$match, { projection })
      : coll.find(pipeline[0].$match);
    const items = await cursor.toArray();
    return _postprocess(items, ast, schema, ctx, hasInject, injectInfo);
  }

  // ── 自动两阶段优化（根级别） ──
  // 当 pipeline 同时有 $lookup 和 $skip/$limit 时，先用轻量 pipeline 取分页 ID，
  // 再对少量 ID 做关联查询，避免全量 join 后被 $skip 丢弃。
  const firstLookupIdx = pipeline.findIndex((st) => '$lookup' in st);
  const hasSkipLimit = !hasPipeline && pipeline.some((st) => '$skip' in st || '$limit' in st);

  if (firstLookupIdx >= 0 && hasSkipLimit) {
    return _runTwoPhase(coll, pipeline, projection, ast, schema, ctx, hasInject, injectInfo);
  }

  // ── 标准单阶段聚合 ──
  if (!hasPipeline && projection) pipeline.push({ $project: projection });
  const items = await coll.aggregate(pipeline).toArray();

  // $pipeline 模式：直接返回原始结果
  if (hasPipeline) return items;

  // 标准 GQL 模式：递归处理每一条
  return _postprocess(items, ast, schema, ctx, hasInject, injectInfo);
}

/** GQL 查询（返回单条） */
async function queryOne(gql, params = null) {
  const items = await query(gql, params);
  return items.length ? items[0] : null;
}

/** 解析分页参数（page/pageSize 或传统 $skip/$limit），pageSize 已含 5000 上限 */
function _resolvePage(ast, params) {
  let page;
  let pageSize;
  if ('page' in params || 'pageSize' in params) {
    page = params.page != null ? Math.max(0, Math.floor(_toNumber(params.page))) : 0;
    pageSize = params.pageSize != null ? _toNumber(params.pageSize) : 50;
  } else {
    const skipRef = ast.params.skip;
    const limitRef = ast.params.limit;
    const skipVal = skipRef ? params[skipRef.slice(1)] : undefined;
    const limitVal = limitRef ? params[limitRef.slice(1)] : undefined;
    page = skipVal != null && limitVal ? Math.floor(_toNumber(skipVal) / _toNumber(limitVal)) : 0;
    pageSize = limitVal != null ? _toNumber(limitVal) : 50;
  }
  return [page, Math.min(pageSize, 5000)];
}

/**
 * GQL 查询（返回 items + total + 分页元数据）
 *
 * 支持两种分页参数方式：
 *   1. page/pageSize（推荐）— 自动计算 skip/limit，page 默认 0，pageSize 默认 50
 *   2. 传统 $skip/$limit — 从 GQL 参数推导 page/pageSize
 * pageSize 上限 5000，防止拖库。
 */
async function queryWithCount(gql, params = null) {
  params = params !== null && params !== undefined ? params : {};
  const ast = parseGql(gql);
  const schema = _getSchema(ast.model);
  const coll = _col(ast.model);

  const [page, pageSize] = _resolvePage(ast, params);

  // 确保 GQL 实际使用上述分页值
  if (ast.params.skip) params[ast.params.skip.slice(1)] = page * pageSize;
  if (ast.params.limit) params[ast.params.limit.slice(1)] = pageSize;

  const items = await query(gql, params);

  // ── 统计 total（忽略 skip/limit） ──
  let countFilter = {};
  const condRef = ast.params.condition;
  if (condRef) countFilter = params[condRef.slice(1)] || {};

  // 权限：total 也应反映所有者条件
  const ctx = getContext();
  if (ctx) countFilter = mergeOwnerCondition(schema, ctx, countFilter);

  const total = await coll.countDocuments(countFilter);
  const hasMore = (page + 1) * pageSize < total;

  return { items, total, hasMore, page, pageSize };
}

/** 标准 GQL 尾处理：递归裁剪 + asyncFn 计算列 + 移除注入的关系依赖 */
async function _postprocess(items, ast, schema, ctx, hasInject, injectInfo) {
  for (const item of items) {
    processNode(item, ast, schema, ctx);
  }
  await _runAsyncFns(items, schema, ctx);
  if (hasInject) {
    _stripDepInjected(items, injectInfo, schema);
  }
  return items;
}

/** 自动两阶段优化：先取分页 ID，再对少量 ID 关联查询 */
async function _runTwoPhase(coll, pipeline, projection, ast, schema, ctx, hasInject, injectInfo) {
  // 检查 sort 是否引用关联表字段（如 'bidders.amount'），是则退化为标准单阶段
  if (_sortsByRelation(pipeline)) {
    return _runStandard(coll, pipeline, projection, ast, schema, ctx, hasInject, injectInfo);
  }

  const firstLookupIdx = pipeline.findIndex((st) => '$lookup' in st);

  // 阶段一：仅取分页后的 ID（无 $lookup，利用索引）
  const idPipeline = _paginateIdPipeline(pipeline, firstLookupIdx);
  const plSort = pipeline.find((st) => '$sort' in st) || null;

  const idDocs = await coll.aggregate(idPipeline).toArray();
  if (!idDocs.length) return [];
  const ids = idDocs.map((d) => d._id);

  // 阶段二：仅对分页后的少量 ID 执行关联查询
  const fullPipeline = pipeline
    .slice(firstLookupIdx)
    .filter((st) => !('$sort' in st) && !('$skip' in st) && !('$limit' in st));
  fullPipeline.unshift({ $match: { _id: { $in: ids } } });

  if (projection) fullPipeline.push({ $project: projection });
  let items = await coll.aggregate(fullPipeline).toArray();

  // $in 查询不保证返回顺序，按阶段一 ids 的顺序重排，恢复正确排序
  items = _restoreSortOrder(items, ids, plSort);

  return _postprocess(items, ast, schema, ctx, hasInject, injectInfo);
}

/** 构建仅取分页 ID 的轻量 pipeline（保留 sort/skip/limit，投影仅 _id） */
function _paginateIdPipeline(pipeline, firstLookupIdx) {
  const idPipeline = pipeline.slice(0, firstLookupIdx);
  for (const key of ['$sort', '$skip', '$limit']) {
    const st = pipeline.find((s) => key in s);
    if (st) idPipeline.push(st);
  }
  idPipeline.push({ $project: { _id: 1 } });
  return idPipeline;
}

/** pipeline 的 $sort 是否引用关联表点号字段（如 'bidders.amount'） */
function _sortsByRelation(pipeline) {
  const sortStage = pipeline.find((st) => '$sort' in st);
  if (!sortStage || typeof sortStage !== 'object') return false;
  return Object.keys(sortStage.$sort || {}).some((k) => k.includes('.'));
}

/** 按阶段一 ids 顺序重排阶段二结果（有排序且多文档时） */
function _restoreSortOrder(items, ids, plSort) {
  if (!plSort || ids.length <= 1) return items;
  const idOrder = new Map(ids.map((id, i) => [String(id), i]));
  items.sort((a, b) => {
    const ai = idOrder.has(String(a._id)) ? idOrder.get(String(a._id)) : idOrder.size;
    const bi = idOrder.has(String(b._id)) ? idOrder.get(String(b._id)) : idOrder.size;
    return ai - bi;
  });
  return items;
}

/** 标准单阶段聚合（两阶段优化因 sort 引用关联字段而退化至此路径） */
async function _runStandard(coll, pipeline, projection, ast, schema, ctx, hasInject, injectInfo) {
  if (projection) pipeline.push({ $project: projection });
  const items = await coll.aggregate(pipeline).toArray();
  return _postprocess(items, ast, schema, ctx, hasInject, injectInfo);
}

// ─── 简单 CRUD ─────────────────────────────────────────────

const _ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function _randomUpper(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += _ID_CHARS[Math.floor(Math.random() * _ID_CHARS.length)];
  }
  return out.toUpperCase();
}

/** 按 schema.idPrefix 生成唯一 ID（时间戳36进制 + 随机4位） */
function _generateId(schema) {
  const ts = _toBase36(Date.now()).toUpperCase();
  const rnd = _randomUpper(4);
  return schema.idPrefix + ts + rnd;
}

function _toBase36(n) {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  if (n === 0) return '0';
  let out = '';
  while (n) {
    out = digits[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out;
}

function _hasCreatorPermission(s) {
  return (s.read || []).includes('creator') || (s.write || []).includes('creator');
}

/** Schema 级写权限检查：guest 直接拒绝；非写授权时仅 creator 命中才放行 */
async function _checkWritePerm(s, ctx, coll, condition = null, denyMsg = '无写入权限') {
  if ((ctx.roles || []).includes('guest')) {
    throw new PermissionError(denyMsg);
  }
  if (canWriteSchema(s, ctx)) return;
  if (s.write && s.write.includes('creator') && condition) {
    const existing = await coll.findOne(condition, { projection: { _id: 1, createdBy: 1 } });
    if (!existing || evaluate(ctx, s.write, existing) === false) {
      throw new PermissionError(denyMsg);
    }
  } else {
    throw new PermissionError(denyMsg);
  }
}

/** 插入一条 */
async function insert(schemaName, data) {
  const ctx = getContext();
  const s = _getSchema(schemaName);

  // Schema 级写权限检查
  if (!canWriteSchema(s, ctx)) {
    throw new PermissionError('无写入权限');
  }

  // 字段级写权限过滤
  const filtered = ctx ? filterWritableData(s, ctx, data) : data;

  const coll = _col(schemaName);
  const doc = _removeUndefined({ ...filtered });

  // 自动生成 ID
  if (!doc._id && s.idPrefix) {
    doc._id = _generateId(s);
  }

  // 自动设置 createdBy（creator 权限场景）
  if (_hasCreatorPermission(s) && !doc.createdBy && ctx && ctx.userId) {
    doc.createdBy = ctx.userId;
  }

  // 自动时间戳
  if (s.timestamps) {
    const now = Date.now();
    if (!doc.createdAt) doc.createdAt = now;
    doc.updatedAt = now;
  }

  await coll.insertOne(doc);
  return applyDefaultsAndComputes(doc, s);
}

/** 批量插入（带权限检查，自动生成 _id 和时间戳） */
async function insertMany(schemaName, docs) {
  if (!Array.isArray(docs) || !docs.length) return [];

  const ctx = getContext();
  const s = _getSchema(schemaName);
  const coll = _col(schemaName);

  if (!canWriteSchema(s, ctx)) {
    throw new PermissionError('无写入权限');
  }

  const processedDocs = [];
  for (const data of docs) {
    const filtered = ctx ? filterWritableData(s, ctx, data) : data;
    const doc = _removeUndefined({ ...filtered });

    if (!doc._id && s.idPrefix) {
      doc._id = _generateId(s);
    }

    if (_hasCreatorPermission(s) && !doc.createdBy && ctx && ctx.userId) {
      doc.createdBy = ctx.userId;
    }

    if (s.timestamps) {
      const now = Date.now();
      if (!doc.createdAt) doc.createdAt = now;
      doc.updatedAt = now;
    }

    processedDocs.push(doc);
  }

  await coll.insertMany(processedDocs);
  return processedDocs.map((doc) => applyDefaultsAndComputes(doc, s));
}

/**
 * 更新一条（支持原生操作符，不触发默认值）
 *
 * data 的 key 以 '$' 开头 → 原生 MongoDB 操作符（$set/$inc/$unset 等）直接透传。
 * 否则自动包装为 $set 模式。
 */
async function update(schemaName, condition, data, options = null) {
  options = options || {};
  const ctx = getContext();
  const s = _getSchema(schemaName);
  const coll = _col(schemaName);

  // Schema 级写权限检查
  if (ctx) {
    await _checkWritePerm(s, ctx, coll, condition);
  }

  const hasRawOperators = !!data && Object.keys(data).some((k) => k.startsWith('$'));

  if (hasRawOperators) {
    // 原生操作符模式（透传 $inc/$unset/$addToSet 等）
    if (ctx && data.$set != null) {
      data.$set = _removeUndefined(filterWritableData(s, ctx, data.$set));
    }
    if (s.timestamps) {
      const setPart = data.$set || {};
      data.$set = { ...setPart, updatedAt: Date.now() };
    }
    const result = await coll.findOneAndUpdate(
      condition,
      data,
      { returnDocument: ReturnDocument.AFTER, ...options },
    );
    return result ? applyDefaultsAndComputes(result, s) : null;
  }

  // $set 模式
  const setData = _removeUndefined(ctx ? filterWritableData(s, ctx, data) : { ...data });
  delete setData._id;

  if (!Object.keys(setData).length) {
    throw new Error('没有提供要更新的字段');
  }

  if (s.timestamps) {
    setData.updatedAt = Date.now();
  }

  const result = await coll.findOneAndUpdate(
    condition,
    { $set: setData },
    { returnDocument: ReturnDocument.AFTER, ...options },
  );
  return result ? applyDefaultsAndComputes(result, s) : null;
}

/** 批量更新（支持原生操作符） */
async function updateMany(schemaName, condition, data) {
  const ctx = getContext();
  const s = _getSchema(schemaName);
  const coll = _col(schemaName);

  // Schema 级写权限检查
  if (ctx) {
    if ((ctx.roles || []).includes('guest')) {
      throw new PermissionError('无批量写入权限');
    }
    if (!canWriteSchema(s, ctx)) {
      throw new PermissionError('无批量写入权限');
    }
  }

  const hasRawOperators = !!data && Object.keys(data).some((k) => k.startsWith('$'));

  let updateDoc;
  if (hasRawOperators) {
    if (ctx && data.$set != null) {
      data.$set = _removeUndefined(filterWritableData(s, ctx, data.$set));
    }
    if (s.timestamps) {
      const setPart = data.$set || {};
      data.$set = { ...setPart, updatedAt: Date.now() };
    }
    updateDoc = data;
  } else {
    const setData = _removeUndefined(ctx ? filterWritableData(s, ctx, data) : { ...data });
    delete setData._id;
    if (s.timestamps) {
      setData.updatedAt = Date.now();
    }
    updateDoc = { $set: setData };
  }

  const result = await coll.updateMany(condition, updateDoc);
  return { modifiedCount: result.modifiedCount };
}

/** 删除 —— 原表数据先归档到对应 `_deleted` 附表（附 deletedAt），再物理删除原表数据 */
async function remove(schemaName, condition) {
  const ctx = getContext();
  const s = _getSchema(schemaName);
  const coll = _col(schemaName);

  if (ctx) {
    await _checkWritePerm(s, ctx, coll, condition, '无删除权限');
  }

  // 归档：完整拷贝到删除附表（保留原字段与时间戳，附 deletedAt）
  let archivedCount = 0;
  const archiveName = `${schemaName}Deleted`;
  if (_hasSchema(archiveName)) {
    const archiveColl = _col(archiveName);
    const docs = await coll.find(condition).toArray();
    if (docs.length) {
      const now = Date.now();
      for (const d of docs) {
        d.deletedAt = now;
      }
      await archiveColl.insertMany(docs);
      archivedCount = docs.length;
    }
  }

  const result = await coll.deleteMany(condition);
  return { deletedCount: result.deletedCount, archivedCount };
}

/** 判断是否存在 */
async function exists(schemaName, condition) {
  const coll = _col(schemaName);
  const doc = await coll.findOne(condition, { projection: { _id: 1 } });
  return doc !== null && doc !== undefined;
}

/** 统计符合条件的文档数量 */
async function count(schemaName, filter = null) {
  const coll = _col(schemaName);
  return coll.countDocuments(filter || {});
}

// ─── Mutation ──────────────────────────────────────────────

/**
 * 构建 upsert 条件组（$or 数组）
 *
 * 规则：
 *   1. data._id 非空 → 加入 { _id: data._id }
 *   2. unique 索引的 keys 在 data 中均非空 → 整组作为一条条件加入 $or
 */
function _buildUpsertConditions(schema, data) {
  const conditions = [];

  if (data._id && String(data._id).trim()) {
    conditions.push({ _id: data._id });
  }

  for (const idx of schema.indexes || []) {
    const options = idx.options;
    if (!options || !options.unique) continue;
    const keys = Object.keys(idx.keys);
    const allPresent = keys.every((k) => {
      const v = data[k];
      return v !== null && v !== undefined && !(typeof v === 'string' && !v.trim());
    });
    if (allPresent) {
      const cond = {};
      for (const k of keys) cond[k] = data[k];
      conditions.push(cond);
    }
  }

  return conditions;
}

/** type: 'one' 子文档强制按 foreignKey upsert */
async function _upsertOne(schema, data, foreignField) {
  const db = _getDb();
  const coll = db.collection(schema.collection);

  const setData = _removeUndefined({ ...data });
  const setOnInsert = {};

  // _id：有则 $setOnInsert（不 $set，避免修改已有文档的 _id）
  if (setData._id && String(setData._id).trim()) {
    setOnInsert._id = setData._id;
  } else if (schema.idPrefix) {
    setOnInsert._id = _generateId(schema);
  }
  delete setData._id;

  // 时间戳
  if (schema.timestamps) {
    const now = Date.now();
    setData.updatedAt = now;
    setOnInsert.createdAt = data.createdAt !== undefined ? data.createdAt : now;
  }
  delete setData.createdAt;

  const updateDoc = { $set: setData };
  if (Object.keys(setOnInsert).length) {
    updateDoc.$setOnInsert = setOnInsert;
  }

  const result = await coll.findOneAndUpdate(
    { [foreignField]: data[foreignField] },
    updateDoc,
    { upsert: true, returnDocument: ReturnDocument.AFTER },
  );
  return result;
}

/** 单条 mutation 核心逻辑 */
async function _mutationOne(schema, data) {
  const ctx = getContext();

  if (!canWriteSchema(schema, ctx)) {
    throw new PermissionError('无写入权限');
  }

  // ── 1. 按 schema.relations 拆分 fieldData + relationData ──
  const fieldData = {};
  const relationData = {};
  const relKeys = new Set(Object.keys(schema.relations));

  for (const [key, val] of Object.entries(data)) {
    if (relKeys.has(key)) {
      if (ctx) {
        const relDef = schema.relations[key];
        if (relDef.read && !evaluate(ctx, relDef.read)) continue;
      }
      relationData[key] = val;
    } else {
      fieldData[key] = val;
    }
  }

  const filteredFieldData = ctx ? filterWritableData(schema, ctx, fieldData) : fieldData;

  const db = _getDb();
  const coll = db.collection(schema.collection);

  // ── 2. 构建 upsert 条件 ──
  const orConditions = _buildUpsertConditions(schema, filteredFieldData);

  // ── 3. 写入 parent ──
  let parentDoc;
  if (orConditions.length) {
    // ── Upsert 路径 ──
    parentDoc = await coll.findOneAndUpdate(
      { $or: orConditions },
      _buildUpsertUpdate(schema, filteredFieldData),
      { upsert: true, returnDocument: ReturnDocument.AFTER },
    );
  } else {
    // ── Insert 路径（复用现有 insert 逻辑） ──
    parentDoc = await insert(schema.name, filteredFieldData);
  }

  // ── 4. 处理 relation 子文档 ──
  await _applyRelations(schema, relationData, parentDoc);

  // ── 5. 补默认值后返回 ──
  return applyDefaultsAndComputes(parentDoc, schema);
}

/** 由 fieldData 生成 upsert 的 updateDoc（$set + $setOnInsert） */
function _buildUpsertUpdate(schema, fieldData) {
  const setData = _removeUndefined({ ...fieldData });
  const setOnInsert = {};

  if (setData._id && String(setData._id).trim()) {
    setOnInsert._id = setData._id;
  } else if (schema.idPrefix) {
    setOnInsert._id = _generateId(schema);
  }
  delete setData._id;

  if (schema.timestamps) {
    const now = Date.now();
    setData.updatedAt = now;
    setOnInsert.createdAt = fieldData.createdAt !== undefined ? fieldData.createdAt : now;
  }
  delete setData.createdAt;

  // 自动设置 createdBy（upsert 新文档时）
  if (_hasCreatorPermission(schema) && !setOnInsert.createdBy) {
    setOnInsert.createdBy = setOnInsert._id;
  }

  const updateDoc = { $set: setData };
  if (Object.keys(setOnInsert).length) {
    updateDoc.$setOnInsert = setOnInsert;
  }
  return updateDoc;
}

/** 将 relation 子文档写入（one→外键 upsert / many→递归 mutation） */
async function _applyRelations(schema, relationData, parentDoc) {
  for (const [relName, relVal] of Object.entries(relationData)) {
    if (relVal === null || relVal === undefined) continue;
    const relDef = (schema.relations || {})[relName];
    if (!relDef) continue;

    const parentId = parentDoc._id;
    const relSchema = _getSchema(relDef.model);

    if (relDef.type === 'one') {
      const childData = { ...relVal };
      childData[relDef.foreignField] = parentId;
      await _upsertOne(relSchema, childData, relDef.foreignField);
    } else if (relDef.type === 'many') {
      const arr = Array.isArray(relVal) ? relVal : [relVal];
      for (const childItem of arr) {
        if (childItem === null || childItem === undefined) continue;
        childItem[relDef.foreignField] = parentId;
        await _mutationOne(relSchema, childItem);
      }
    }
  }
}

/**
 * mutation — 智能持久化
 *
 * 自动判断 upsert/insert，支持父子文档关联填充。
 */
async function mutation(schemaName, data) {
  const s = _getSchema(schemaName);
  const isArray = Array.isArray(data);
  const items = isArray ? data : [data];

  if (!items.length) return isArray ? [] : null;

  const results = [];
  for (const item of items) {
    results.push(await _mutationOne(s, item));
  }

  return isArray ? results : results[0];
}

/**
 * upsert — 显式条件 upsert
 *
 * 与 mutation 不同，upsert 需要调用方显式提供 match 条件，不处理父子关系。
 */
async function upsert(schemaName, condition, data, options = null) {
  options = options || {};
  const ctx = getContext();
  const s = _getSchema(schemaName);
  const coll = _col(schemaName);

  if (!canWriteSchema(s, ctx)) {
    throw new PermissionError('无写入权限');
  }

  const filteredData = ctx ? filterWritableData(s, ctx, data) : data;

  const returnNew = options.returnNew !== undefined ? options.returnNew : true;
  const setData = _removeUndefined({ ...filteredData });
  const setOnInsert = {};

  // _id：从 data 移到 $setOnInsert（不 $set，避免修改已有文档的 _id）
  if (setData._id && String(setData._id).trim()) {
    setOnInsert._id = setData._id;
  } else if (s.idPrefix && !condition._id) {
    setOnInsert._id = _generateId(s);
  }
  delete setData._id;

  // 时间戳
  if (s.timestamps) {
    const now = Date.now();
    setData.updatedAt = now;
    setOnInsert.createdAt = filteredData.createdAt !== undefined ? filteredData.createdAt : now;
  }
  delete setData.createdAt;

  // 自动设置 createdBy
  if (_hasCreatorPermission(s) && !setOnInsert.createdBy) {
    setOnInsert.createdBy = setOnInsert._id || condition._id;
  }

  const updateDoc = { $set: setData };
  if (Object.keys(setOnInsert).length) {
    updateDoc.$setOnInsert = setOnInsert;
  }

  const result = await coll.findOneAndUpdate(
    condition,
    updateDoc,
    {
      upsert: true,
      returnDocument: returnNew ? ReturnDocument.AFTER : ReturnDocument.BEFORE,
    },
  );

  return result ? applyDefaultsAndComputes(result, s) : null;
}

/** 对指定 schema 执行 MongoDB 原生聚合查询 */
async function aggregate(schemaName, pipeline) {
  const s = _getSchema(schemaName);
  const coll = _getDb().collection(s.collection);
  return coll.aggregate(pipeline).toArray();
}

module.exports = {
  setDb,
  _getDb,
  _removeUndefined,
  _col,
  query,
  _executePipeline,
  queryOne,
  _resolvePage,
  queryWithCount,
  _postprocess,
  _runTwoPhase,
  _paginateIdPipeline,
  _sortsByRelation,
  _restoreSortOrder,
  _runStandard,
  _toNumber,
  _generateId,
  _toBase36,
  _hasCreatorPermission,
  _checkWritePerm,
  insert,
  insertMany,
  update,
  updateMany,
  remove,
  exists,
  count,
  _buildUpsertConditions,
  _upsertOne,
  _mutationOne,
  _buildUpsertUpdate,
  _applyRelations,
  mutation,
  upsert,
  aggregate,
};
