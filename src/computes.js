'use strict';

/**
 * 计算列引擎（读取时后处理，纯 schema 驱动，禁 DB 访问）
 *
 * 职责：
 *   - 字段默认值解析与填充（含嵌套 object 递归）
 *   - fn/asyncFn 计算列执行与权限裁剪
 *   - asyncFn 依赖（depends）GQL 片段的 AST 注入与结果裁剪
 *   - processNode：GQL 查询结果的递归后处理（默认值→fn→关系下钻→字段裁剪→权限裁剪）
 *
 * 与 crud 分层：本模块只做「读出后加工」，不做任何 IO；
 * crud.query 负责 GQL 解析与取数，取数后调本模块完成加工。
 */

const {
  evaluate,
  getReadableComputes,
  getReadableFields,
  getReadableRelations,
} = require('./permission');
const { flattenObjectFields, parse, tokenize } = require('./pipeline');
const { get: _getSchema } = require('./schema');
const { getDefault } = require('./types');

// ─── 默认值 & 计算列（简单 CRUD 用，非递归） ──────────────

/** 解析字段默认值；可变容器必须返回「新实例」，不能返回共享引用 */
function _resolveDefault(defn) {
  if (typeof defn === 'function') return defn();
  if (Array.isArray(defn)) return defn.slice();
  if (defn && typeof defn === 'object') return { ...defn };
  return defn;
}

/** 取字段定义的默认值（无则 undefined），语义对齐 Python：null 视为未配置 */
function _fieldDefault(field) {
  if (typeof field === 'string') {
    const d = getDefault(field);
    return d === null ? undefined : d;
  }
  if (field && field.default !== undefined && field.default !== null) {
    return field.default;
  }
  const d = getDefault(field ? field.type : undefined);
  return d === null ? undefined : d;
}

function _isObjectField(field) {
  return !!field && typeof field === 'object' && field.type === 'object' && !!field.fields;
}

function _fillNestedDefaults(obj, fieldsDef) {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, field] of Object.entries(fieldsDef)) {
    if (!(key in obj) || obj[key] === null) {
      const defn = _fieldDefault(field);
      if (defn !== undefined) obj[key] = _resolveDefault(defn);
    }
    // 递归：object 内嵌 object
    if (_isObjectField(field) && obj[key] && typeof obj[key] === 'object') {
      _fillNestedDefaults(obj[key], field.fields);
    }
  }
}

/** 对单条记录应用字段默认值 + 简单计算列（仅根文档，不递归） */
function applyDefaultsAndComputes(doc, schema) {
  if (!doc) return doc;
  const result = { ...doc };

  for (const [key, field] of Object.entries(schema.fields)) {
    if (!(key in result) || result[key] === null) {
      const defn = _fieldDefault(field);
      if (defn !== undefined) result[key] = _resolveDefault(defn);
    }
    // 递归填充嵌套 object 子字段
    if (_isObjectField(field) && result[key] && typeof result[key] === 'object') {
      _fillNestedDefaults(result[key], field.fields);
    }
  }

  for (const [key, comp] of Object.entries(schema.computes || {})) {
    if (comp.fn) result[key] = comp.fn(result);
  }

  return result;
}

// ─── 默认值缓存 + 递归处理器（GQL 查询用） ────────────────

const _defaultsCache = new Map();

function _ensureCache(schema) {
  if (_defaultsCache.has(schema.name)) return _defaultsCache.get(schema.name);

  const fieldDefaults = {};
  for (const [key, field] of Object.entries(schema.fields)) {
    const defn = _fieldDefault(field);
    if (defn !== undefined) fieldDefaults[key] = defn;
  }

  const computeDefaults = {};
  const fnList = [];
  const asyncFnList = [];
  for (const [key, comp] of Object.entries(schema.computes || {})) {
    if (comp.type) computeDefaults[key] = getDefault(comp.type);
    if (comp.fn) fnList.push({ key, depends: comp.depends || [], fn: comp.fn });
    if (comp.asyncFn) {
      asyncFnList.push({ key, asyncFn: comp.asyncFn, depends: comp.depends || [] });
    }
  }

  const cache = { fieldDefaults, computeDefaults, fnList, asyncFnList };
  _defaultsCache.set(schema.name, cache);
  return cache;
}

/** 执行 asyncFn 计算列（批量），带权限裁剪 */
async function _runAsyncFns(items, schema, ctx) {
  if (!items || !items.length) return;
  const cache = _ensureCache(schema);
  if (!cache.asyncFnList.length) return;

  let readonlyAsyncFns = cache.asyncFnList;
  if (ctx) {
    readonlyAsyncFns = [];
    for (const entry of cache.asyncFnList) {
      const comp = (schema.computes || {})[entry.key];
      if (comp && comp.read) {
        if (evaluate(ctx, comp.read)) readonlyAsyncFns.push(entry);
      } else {
        readonlyAsyncFns.push(entry);
      }
    }
  }

  for (const entry of readonlyAsyncFns) {
    await entry.asyncFn(items, ctx);
  }
}

/** 收集所有 asyncFn 计算列 depends 中的关系字段需求 { relName → Set(fields) } */
function _collectRelDeps(schema) {
  const cache = _ensureCache(schema);
  const relDeps = {};
  for (const entry of cache.asyncFnList) {
    for (const dep of entry.depends || []) {
      const trimmed = (dep || '').trim();
      if (!trimmed || trimmed === '_id') continue;
      if (trimmed.includes('{')) {
        const parsed = parse(tokenize(trimmed));
        const relName = parsed.model;
        if (!(relName in schema.relations)) continue;
        if (!relDeps[relName]) relDeps[relName] = new Set();
        for (const f of parsed.fields) {
          if (f !== '_id') relDeps[relName].add(f);
        }
      } else {
        if (!(trimmed in schema.relations)) continue;
        if (!relDeps[trimmed]) relDeps[trimmed] = new Set();
      }
    }
  }
  return relDeps;
}

/** 把关系字段需求合并注入到 AST，返回注入信息 */
function _injectIntoAst(ast, relDeps) {
  if (!('relations' in ast)) ast.relations = {};
  const injectInfo = { relations: {} };

  for (const [relName, depFields] of Object.entries(relDeps)) {
    const existing = ast.relations[relName];
    if (existing) {
      const existingFields = new Set(existing.fields || []);
      const added = [];
      for (const f of depFields) {
        if (!existingFields.has(f)) {
          if (!existing.fields) existing.fields = [];
          existing.fields.push(f);
          added.push(f);
        }
      }
      if (added.length) injectInfo.relations[relName] = new Set(added);
    } else {
      ast.relations[relName] = { fields: [...depFields], relations: {}, params: {} };
      injectInfo.relations[relName] = '__all__';
    }
  }

  return injectInfo;
}

/** 收集所有 asyncFn 计算列的 depends GQL 片段，合并注入到查询 AST 中 */
function _mergeDependsIntoAst(ast, schema) {
  const cache = _ensureCache(schema);
  if (!cache.asyncFnList.length) return { relations: {} };

  const relDeps = _collectRelDeps(schema);
  if (!Object.keys(relDeps).length) return { relations: {} };

  return _injectIntoAst(ast, relDeps);
}

/** 从结果中裁剪依赖注入的字段（不返回客户端） */
function _stripDepInjected(items, injectInfo, schema) {
  if (!injectInfo || !injectInfo.relations || !Object.keys(injectInfo.relations).length) return;
  for (const item of items) {
    for (const [relName, injected] of Object.entries(injectInfo.relations)) {
      const relVal = item[relName];
      if (injected === '__all__') {
        delete item[relName];
      } else if (Array.isArray(relVal)) {
        for (const sub of relVal) {
          if (sub && typeof sub === 'object') {
            for (const f of injected) delete sub[f];
          }
        }
      } else if (relVal && typeof relVal === 'object') {
        for (const f of injected) delete relVal[f];
      }
    }
  }
}

/** GQL 请求字段 + fn 计算列依赖字段（去重） */
function _collectNeeded(astNode, cache) {
  const needed = [...astNode.fields];
  const seen = new Set(needed);
  for (const entry of cache.fnList) {
    for (const dep of entry.depends) {
      if (!seen.has(dep)) {
        seen.add(dep);
        needed.push(dep);
      }
    }
  }
  return needed;
}

/** 收集点号嵌套字段信息 { root → [subPath, ...] } */
function _collectDot(astNode) {
  const dotFields = {};
  for (const f of astNode.fields) {
    if (f.includes('.')) {
      const idx = f.indexOf('.');
      const root = f.slice(0, idx);
      const sub = f.slice(idx + 1);
      if (!dotFields[root]) dotFields[root] = [];
      dotFields[root].push(sub);
    }
  }
  return dotFields;
}

/** 补字段默认值（含点号字段的根字段） */
function _fillDefaults(doc, cache, needed, dotFields) {
  for (const key of needed) {
    if (!(key in doc) || doc[key] === null) {
      if (Object.prototype.hasOwnProperty.call(cache.fieldDefaults, key)) {
        doc[key] = _resolveDefault(cache.fieldDefaults[key]);
      }
    }
  }
  for (const root of Object.keys(dotFields)) {
    if (!(root in doc) || doc[root] === null) {
      if (Object.prototype.hasOwnProperty.call(cache.fieldDefaults, root)) {
        doc[root] = _resolveDefault(cache.fieldDefaults[root]);
      }
    }
  }
}

/** 填充嵌套 object 的点号精确子字段默认值 */
function _fillDotNested(doc, schema, root, subPath) {
  const field = schema.fields[root];
  if (!_isObjectField(field) || !doc[root] || typeof doc[root] !== 'object') return;
  const subFieldDef = field.fields[subPath];
  if (subFieldDef && (!(subPath in doc[root]) || doc[root][subPath] === null)) {
    const defn = _fieldDefault(subFieldDef);
    if (defn !== undefined) doc[root][subPath] = _resolveDefault(defn);
  }
}

/** 递归填充嵌套 object 子字段默认值（含点号精确子字段） */
function _fillNestedObjects(doc, schema, needed) {
  for (const key of needed) {
    if (key.includes('.')) {
      const idx = key.indexOf('.');
      _fillDotNested(doc, schema, key.slice(0, idx), key.slice(idx + 1));
    } else {
      const field = schema.fields[key];
      if (_isObjectField(field) && doc[key] && typeof doc[key] === 'object') {
        _fillNestedDefaults(doc[key], field.fields);
      }
    }
  }
}

/** 跑 fn 计算列，再补计算列默认值 */
function _runComputes(doc, cache) {
  for (const entry of cache.fnList) {
    doc[entry.key] = entry.fn(doc);
  }
  for (const entry of cache.fnList) {
    const key = entry.key;
    if (!(key in doc) || doc[key] === null) {
      if (Object.prototype.hasOwnProperty.call(cache.computeDefaults, key)) {
        const defn = cache.computeDefaults[key];
        if (defn !== undefined && defn !== null) doc[key] = _resolveDefault(defn);
      }
    }
  }
}

/** 递归下钻嵌套关系文档（跳过不可读关系） */
function _descendRelations(doc, astNode, schema, ctx) {
  const relNames = Object.keys(astNode.relations || {});
  const readableRelations = ctx ? getReadableRelations(schema, ctx) : null;
  for (const relName of relNames) {
    if (readableRelations !== null && !readableRelations.has(relName)) continue;
    const relAst = astNode.relations[relName];
    const relDef = schema.relations[relName];
    if (!relDef) continue;
    const relSchema = _getSchema(relDef.model);
    const relVal = doc[relName];
    if (Array.isArray(relVal)) {
      for (const relDoc of relVal) processNode(relDoc, relAst, relSchema, ctx);
    } else if (relVal && typeof relVal === 'object') {
      processNode(relVal, relAst, relSchema, ctx);
    }
  }
}

/** 仅保留 GQL 字段 + 关系名 + 点号根字段（_id 始终保留） */
function _computeKeep(astNode, dotFields) {
  const keep = new Set(astNode.fields);
  for (const root of Object.keys(dotFields)) keep.add(root);
  for (const relName of Object.keys(astNode.relations || {})) keep.add(relName);
  keep.add('_id');
  return keep;
}

/** 从 keep 中移除不可读的关系 */
function _pruneUnreadableRelations(astNode, readableRelations, keep) {
  if (readableRelations === null) return;
  for (const relName of Object.keys(astNode.relations || {})) {
    if (!readableRelations.has(relName)) keep.delete(relName);
  }
}

/** 从 keep 中移除用户不可读的字段/计算列/关系（读权限，不含 Owner 级） */
function _applyReadablePrune(doc, astNode, schema, ctx, keep) {
  const readableFields = getReadableFields(schema, ctx);
  const readableComputes = getReadableComputes(schema, ctx);
  const readableRelations = getReadableRelations(schema, ctx);

  for (const key of astNode.fields) {
    if (key === '_id') continue;
    const unreadableField = key in schema.fields && readableFields !== null && !readableFields.has(key);
    const unreadableCompute =
      key in (schema.computes || {}) && readableComputes !== null && !readableComputes.has(key);
    if (unreadableField || unreadableCompute) keep.delete(key);
  }
  _pruneUnreadableRelations(astNode, readableRelations, keep);
}

/** 字段级 Owner read 校验（含计算列、关系） */
function _pruneOwnerFieldRead(doc, astNode, schema, ctx, keep) {
  for (const key of astNode.fields) {
    if (key === '_id' || !keep.has(key)) continue;
    const field = schema.fields[key];
    if (field && field.read && evaluate(ctx, field.read, doc) === false) keep.delete(key);
  }
}

/** 计算列 Owner read 校验 */
function _pruneOwnerComputeRead(doc, schema, ctx, keep) {
  for (const [key, comp] of Object.entries(schema.computes || {})) {
    if (!keep.has(key)) continue;
    if (comp && comp.read && evaluate(ctx, comp.read, doc) === false) keep.delete(key);
  }
}

/** 关系 Owner read 校验 */
function _pruneOwnerRelationRead(doc, astNode, schema, ctx, keep) {
  for (const relName of Object.keys(astNode.relations || {})) {
    if (!keep.has(relName)) continue;
    const rel = schema.relations[relName];
    if (rel && rel.read && evaluate(ctx, rel.read, doc) === false) keep.delete(relName);
  }
}

/** Owner 级 read 校验：逐字段/计算列/关系传入 doc 做 creator 检查 */
function _applyOwnerReadPrune(doc, astNode, schema, ctx, keep) {
  _pruneOwnerFieldRead(doc, astNode, schema, ctx, keep);
  _pruneOwnerComputeRead(doc, schema, ctx, keep);
  _pruneOwnerRelationRead(doc, astNode, schema, ctx, keep);
}

/** 从 keep 中移除当前用户不可读的字段/计算列/关系（含 Owner 级 read 校验） */
function _applyPermissions(doc, astNode, schema, ctx, keep) {
  if (!ctx) return;
  _applyReadablePrune(doc, astNode, schema, ctx, keep);
  _applyOwnerReadPrune(doc, astNode, schema, ctx, keep);
}

/** 删除不保留的顶层字段 */
function _pruneDoc(doc, keep) {
  for (const key of Object.keys(doc)) {
    if (!keep.has(key)) delete doc[key];
  }
}

/** 裁剪点号字段父对象中未请求的子字段 */
function _pruneDotSubfields(doc, dotFields) {
  for (const [root, subs] of Object.entries(dotFields)) {
    const obj = doc[root];
    if (obj && typeof obj === 'object') {
      const subKeep = new Set(subs);
      for (const subKey of Object.keys(obj)) {
        if (!subKeep.has(subKey)) delete obj[subKey];
      }
    }
  }
}

/**
 * 递归处理单条文档：补默认值 → 跑 fn 计算列 → 补计算列默认值 → 递归下钻 → 裁剪
 *
 * 时序严格：
 *   1. 补字段默认值（计算列依赖的字段必须先有值）
 *   2. 跑 fn 计算列
 *   3. 补计算列默认值
 *   4. 递归处理嵌套关系文档
 *   5. 裁剪到 GQL 请求字段
 *   6. 权限裁剪
 */
function processNode(doc, astNode, schema, ctx) {
  if (!doc) return;

  const cache = _ensureCache(schema);

  // 展平 object 子字段花括号语法 → dot-notation
  flattenObjectFields(astNode, schema);

  // ① 收集 needed 字段（请求字段 + fn 依赖）与点号字段信息
  const neededArr = _collectNeeded(astNode, cache);
  const dotFields = _collectDot(astNode);

  // ② 补字段默认值 + 递归填充嵌套 object 子字段
  _fillDefaults(doc, cache, neededArr, dotFields);
  _fillNestedObjects(doc, schema, neededArr);

  // ③ 跑 fn 计算列 + 补计算列默认值
  _runComputes(doc, cache);

  // ④ 递归下钻（跳过不可读的关系）
  _descendRelations(doc, astNode, schema, ctx);

  // ⑤ 计算 keep（GQL 字段 + 关系名 + 点号根字段 + _id）
  const keep = _computeKeep(astNode, dotFields);

  // ⑥ 权限裁剪（读权限 + Owner 级 read 校验）
  _applyPermissions(doc, astNode, schema, ctx, keep);

  // ⑦ 裁剪字段 + 点号父对象中未请求的子字段
  _pruneDoc(doc, keep);
  _pruneDotSubfields(doc, dotFields);
}

module.exports = {
  _resolveDefault,
  _fieldDefault,
  _fillNestedDefaults,
  applyDefaultsAndComputes,
  _defaultsCache,
  _ensureCache,
  _runAsyncFns,
  _collectRelDeps,
  _injectIntoAst,
  _mergeDependsIntoAst,
  _stripDepInjected,
  _collectNeeded,
  _collectDot,
  _fillDefaults,
  _fillDotNested,
  _fillNestedObjects,
  _runComputes,
  _descendRelations,
  _computeKeep,
  _pruneUnreadableRelations,
  _applyReadablePrune,
  _pruneOwnerFieldRead,
  _pruneOwnerComputeRead,
  _pruneOwnerRelationRead,
  _applyOwnerReadPrune,
  _applyPermissions,
  _pruneDoc,
  _pruneDotSubfields,
  processNode,
};
