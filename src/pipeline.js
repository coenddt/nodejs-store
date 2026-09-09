'use strict';

/**
 * GQL 解析 + Aggregate Pipeline 构建器
 *
 * GQL 语法（极简，支持5个参数）:
 *   ModelName($condition:@c0,$sort:@s1,$skip:@sk,$limit:@l1,$pipeline:@p1) {
 *     field1, field2,
 *     RelationName($condition:@c2,$sort:@s3) {
 *       field3,
 *       NestedRelation { field4 }
 *     }
 *   }
 * 值用 @key 引用 params 对象
 */

const {
  getContext,
  getReadableComputes,
  getReadableFields,
} = require('./permission');
const { get } = require('./schema');

// ─── 递归保护 ──────────────────────────────────────────────
const MAX_DEPTH = 10;
const MAX_PAGINATED_DEPTH = 4;

// ─── Tokenizer ─────────────────────────────────────────────

function tokenize(gql) {
  const tokens = [];
  let i = 0;
  const n = gql.length;
  while (i < n) {
    const ch = gql[i];
    // 空白
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // 标点
    if ('(){},:'.includes(ch)) {
      tokens.push({ t: 'p', v: ch });
      i += 1;
      continue;
    }
    // 标识符（模型名/字段名/关系名，支持点号嵌套）
    if (/[A-Za-z]/.test(ch) || ch === '_' || ch === '$') {
      let v = '';
      while (i < n && /[A-Za-z0-9_$.]/.test(gql[i])) {
        v += gql[i];
        i += 1;
      }
      tokens.push({ t: 'id', v });
      continue;
    }
    // 参数引用 @xxx
    if (ch === '@') {
      let v = '@';
      i += 1;
      while (i < n && /[A-Za-z0-9_]/.test(gql[i])) {
        v += gql[i];
        i += 1;
      }
      tokens.push({ t: 'ref', v });
      continue;
    }
    i += 1; // 跳过未知字符
  }
  return tokens;
}

// ─── Parser ────────────────────────────────────────────────

function parse(tokens) {
  let pos = 0;

  const peek = () => (pos < tokens.length ? tokens[pos] : null);

  const consume = (t, v = undefined) => {
    const tk = peek();
    if (tk === null) {
      throw new Error(`期望 ${t}(${v}) 但已到达末尾`);
    }
    if (tk.t !== t || (v !== undefined && tk.v !== v)) {
      throw new Error(`期望 ${t}(${v}) 实际 ${tk.t}(${tk.v}) 位置 ${pos}`);
    }
    pos += 1;
    return tk;
  };

  const parseParams = () => {
    const p = {};
    let tk = peek();
    if (tk && tk.t === 'p' && tk.v === '(') {
      consume('p', '(');
      for (;;) {
        tk = peek();
        if (tk && tk.v === ')') break;
        const key = consume('id').v.replace(/^\$+/, '');
        consume('p', ':');
        const val = peek();
        if (val && (val.t === 'ref' || val.t === 'id')) {
          p[key] = val.v;
        }
        pos += 1;
        tk = peek();
        if (tk && tk.v === ',') consume('p', ',');
      }
      consume('p', ')');
    }
    return p;
  };

  const parseBody = () => {
    const fields = [];
    const relations = {};
    let tk = peek();
    if (!tk || tk.t !== 'p' || tk.v !== '{') {
      return { fields, relations };
    }
    consume('p', '{');
    for (;;) {
      tk = peek();
      if (!tk || tk.v === '}') break;
      if (tk.v === ',') {
        consume('p', ',');
        continue;
      }
      const name = consume('id').v;
      tk = peek();
      const hasParen = tk && tk.t === 'p' && tk.v === '(';
      const hasBrace = tk && tk.t === 'p' && tk.v === '{';
      if (hasParen || hasBrace) {
        const prm = hasParen ? parseParams() : {};
        const body = hasBrace ? parseBody() : { fields: [], relations: {} };
        relations[name] = { ...body, params: prm };
      } else {
        fields.push(name);
      }
      tk = peek();
      if (tk && tk.v === ',') consume('p', ',');
    }
    consume('p', '}');
    return { fields, relations };
  };

  const modelName = consume('id').v;
  const rootParams = parseParams();
  const body = parseBody();
  return { model: modelName, params: rootParams, ...body };
}

/** 解析 GQL 字符串 → AST */
function parseGql(gql) {
  return parse(tokenize(gql));
}

/** 从 params 中按 @ref 取值，ref 为空返回 undefined */
function _param(params, ref) {
  if (!ref) return undefined;
  return params[ref.slice(1)];
}

function _findStageIdx(stages, key) {
  for (let i = 0; i < stages.length; i += 1) {
    if (key in stages[i]) return i;
  }
  return -1;
}

// ─── Pipeline 构建器 ───────────────────────────────────────

/** 按序追加 $sort/$skip/$limit 到 stages */
function _appendOrder(stages, sort, skipVal, limitVal) {
  if (sort != null) stages.push({ $sort: sort });
  if (skipVal != null) stages.push({ $skip: skipVal });
  if (limitVal != null) stages.push({ $limit: limitVal });
}

/** 构建所有嵌套关系 lookup 阶段（含 one 关系的 $unwind） */
function _nsLookupStages(relAst, relSchema, params, _depth, _nextPaginated) {
  const stages = [];
  for (const [nName, nAst] of Object.entries(relAst.relations || {})) {
    const nDef = relSchema.relations[nName];
    if (!nDef) {
      throw new Error(`关系 "${nName}" 未在 schema "${relSchema.name}" 中定义`);
    }
    const nSchema = get(nDef.model);
    stages.push(
      buildLookup(nName, nAst, params, nDef, nSchema, relSchema, _depth + 1, _nextPaginated)
    );
    if (nDef.type === 'one') {
      stages.push({ $unwind: { path: `$${nName}`, preserveNullAndEmptyArrays: true } });
    }
  }
  return stages;
}

/** 构建嵌套关系的 $project（请求字段 + fn 计算列 depends） */
function _buildRelProjection(relAst, relSchema) {
  if (!relAst.fields || !relAst.fields.length) return null;
  const proj = { _id: 1 };
  for (const f of relAst.fields) proj[f] = 1;
  // 补充 fn 计算列的 depends 字段
  for (const f of relAst.fields) {
    const comp = (relSchema.computes || {})[f];
    if (comp && comp.fn && comp.depends) {
      for (const dep of comp.depends) {
        if (!(dep in proj)) proj[dep] = 1;
      }
    }
  }
  return proj;
}

function buildLookup(relName, relAst, params, relDef, relSchema, sourceSchema, _depth = 0, _paginated = 0) {
  const localKey = relDef.localField;
  const foreignKey = relDef.foreignField;
  const letVar = `rel_${localKey}`;

  const condition = _param(params, relAst.params.condition);
  const sort = _param(params, relAst.params.sort);
  const skipVal = _param(params, relAst.params.skip);
  const limitVal = _param(params, relAst.params.limit);

  // ── 递归保护（分两套深度限制） ──
  const hasPaginated = skipVal != null || limitVal != null;
  const nextPaginated = hasPaginated ? _paginated + 1 : _paginated;
  if (_depth >= MAX_DEPTH || (hasPaginated && _paginated >= MAX_PAGINATED_DEPTH)) {
    // 返回空 $lookup（只做外键匹配，不继续嵌套），pipeline 不崩溃
    return buildEmptyLookup(relName, relDef, relSchema, sourceSchema);
  }

  const stages = [];

  // $match: 外键关联 + 附加条件
  // 当 localField 是 array 类型时，使用 $in 匹配数组中的任一元素
  const sourceField = ((sourceSchema || {}).fields || {})[localKey] || {};
  const isArrayField = sourceField.type === 'array';
  const matchExpr = _relMatchExpr(foreignKey, letVar, isArrayField);
  if (condition != null) {
    stages.push({ $match: { $and: [matchExpr, condition] } });
  } else {
    stages.push({ $match: matchExpr });
  }

  // sort / skip / limit（优先执行，避免全量数据流入后续嵌套 $lookup）
  // 当 sort 依赖嵌套关联字段时，嵌套 $lookup 必须优先于 sort
  const sortsByNested = !!sort && Object.keys(sort).some((k) => k.includes('.'));
  if (!sortsByNested) {
    _appendOrder(stages, sort, skipVal, limitVal);
  }

  // 嵌套 relations
  stages.push(..._nsLookupStages(relAst, relSchema, params, _depth, nextPaginated));

  // sort / skip / limit（兜底：仅在嵌套 $lookup 未提前执行时追加）
  if (sortsByNested) {
    _appendOrder(stages, sort, skipVal, limitVal);
  }

  // $project: 只返回请求的字段 + 计算列 fn 的 depends
  const relProj = _buildRelProjection(relAst, relSchema);
  if (relProj !== null) stages.push({ $project: relProj });

  return {
    $lookup: {
      from: relSchema.collection,
      // 防御：localField 为数组字段时，$in 第二参用 $isArray 守卫
      let: { [letVar]: _relLetExpr(localKey, isArrayField) },
      pipeline: stages,
      as: relName,
    },
  };
}

/** 外键匹配表达式：数组字段用 $in，否则 $eq */
function _relMatchExpr(foreignKey, letVar, isArrayField) {
  if (isArrayField) {
    return { $expr: { $in: [`$${foreignKey}`, `$$${letVar}`] } };
  }
  return { $expr: { $eq: [`$${foreignKey}`, `$$${letVar}`] } };
}

/** let 变量守卫：数组字段用 $isArray，否则 $ifNull */
function _relLetExpr(localKey, isArrayField) {
  if (isArrayField) {
    return { $cond: [{ $isArray: `$${localKey}` }, `$${localKey}`, []] };
  }
  return { $ifNull: [`$${localKey}`, null] };
}

/** 构建空 $lookup（递归保护降级用） */
function buildEmptyLookup(relName, relDef, relSchema, sourceSchema) {
  const localKey = relDef.localField;
  const foreignKey = relDef.foreignField;
  const letVar = `rel_${localKey}`;
  const sourceField = ((sourceSchema || {}).fields || {})[localKey] || {};
  const isArrayField = sourceField.type === 'array';
  const matchExpr = isArrayField
    ? { $expr: { $in: [`$${foreignKey}`, `$$${letVar}`] } }
    : { $expr: { $eq: [`$${foreignKey}`, `$$${letVar}`] } };
  return {
    $lookup: {
      from: relSchema.collection,
      let: {
        [letVar]: isArrayField
          ? { $cond: [{ $isArray: `$${localKey}` }, `$${localKey}`, []] }
          : { $ifNull: [`$${localKey}`, null] },
      },
      pipeline: [{ $match: matchExpr }],
      as: relName,
    },
  };
}

/** 构建 compute 的独立 $lookup 阶段 */
function buildComputeLookupStages(schema) {
  const stages = [];
  for (const [key, comp] of Object.entries(schema.computes || {})) {
    const lookup = comp.lookup;
    if (lookup && lookup.from) {
      stages.push({
        $lookup: {
          from: lookup.from,
          let: lookup.let || {},
          pipeline: lookup.pipeline || [],
          as: lookup.as || `_${key}`,
        },
      });
    }
  }
  return stages;
}

/** 构建 $addFields 阶段（lookup 类型计算列） */
function buildAddFields(schema, ctx) {
  const readableComputes = ctx ? getReadableComputes(schema, ctx) : null;

  const addFields = {};
  for (const [key, comp] of Object.entries(schema.computes || {})) {
    // 权限裁剪：跳过不可读的计算列
    if (readableComputes !== null && !readableComputes.has(key)) continue;
    const lookup = comp.lookup;
    if (lookup) {
      if (lookup.from) {
        // 独立 $lookup 模式：使用 addFields 表达式提取结果
        if (lookup.addFields) addFields[key] = lookup.addFields;
      } else {
        // 简单表达式模式
        addFields[key] = lookup;
      }
    }
  }
  return Object.keys(addFields).length ? { $addFields: addFields } : null;
}

/** 归一化 AST：将 type=object 的花括号子字段展平为点号字段（原地修改） */
function flattenObjectFields(ast, schema) {
  if (!('relations' in ast)) return;
  for (const relName of Object.keys(ast.relations)) {
    const fieldDef = (schema.fields || {})[relName];
    if (fieldDef && typeof fieldDef === 'object' && fieldDef.type === 'object' && fieldDef.fields) {
      const relAst = ast.relations[relName];
      if (relAst.fields && relAst.fields.length) {
        for (const subField of relAst.fields) {
          ast.fields.push(`${relName}.${subField}`);
        }
      }
      delete ast.relations[relName];
    }
  }
}

/** 若 stages 已含该类 stage 则覆盖，否则追加（自定义 pipeline 模式） */
function _overrideOrAppend(stages, stageKey, value) {
  const idx = _findStageIdx(stages, stageKey);
  if (idx >= 0) {
    stages[idx] = { [stageKey]: value };
  } else {
    stages.push({ [stageKey]: value });
  }
}

/** 自定义 pipeline 模式：延展用户 pipeline 并用根参数覆盖/追加排序分页 */
function _customPipelineBranch(stages, rootPipeline, rootCondition, rootSort, rootSkip, rootLimit) {
  stages.push(...rootPipeline);
  if (rootCondition != null) _overrideOrAppend(stages, '$match', rootCondition);
  if (rootSort != null) _overrideOrAppend(stages, '$sort', rootSort);
  if (rootSkip != null) _overrideOrAppend(stages, '$skip', rootSkip);
  if (rootLimit != null) _overrideOrAppend(stages, '$limit', rootLimit);
  return stages;
}

/** 标准 GQL：逐层展开根 relations 为 $lookup（one 关系附加 $unwind） */
function _rootLookupStages(ast, schema, params, stages) {
  for (const [relName, relAst] of Object.entries(ast.relations || {})) {
    const relDef = schema.relations[relName];
    if (!relDef) {
      throw new Error(`关系 "${relName}" 未在 schema "${schema.name}" 中定义`);
    }
    const relSchema = get(relDef.model);
    stages.push(buildLookup(relName, relAst, params, relDef, relSchema, schema));
    if (relDef.type === 'one') {
      stages.push({ $unwind: { path: `$${relName}`, preserveNullAndEmptyArrays: true } });
    }
  }
  return stages;
}

/** 从 AST 构建 aggregate pipeline */
function buildPipeline(ast, params) {
  const schema = get(ast.model);
  const stages = [];

  const rootCondition = _param(params, ast.params.condition);
  const rootSort = _param(params, ast.params.sort);
  const rootSkip = _param(params, ast.params.skip);
  const rootLimit = _param(params, ast.params.limit);
  const rootPipeline = _param(params, ast.params.pipeline);

  if (rootPipeline != null && Array.isArray(rootPipeline)) {
    return _customPipelineBranch(
      stages,
      rootPipeline,
      rootCondition,
      rootSort,
      rootSkip,
      rootLimit
    );
  }

  // ── 标准 GQL 模式 ──
  // 展平 object 子字段花括号语法 → dot-notation
  flattenObjectFields(ast, schema);

  if (rootCondition != null) {
    stages.push({ $match: rootCondition });
  }

  // $lookup: 逐层展开 relations
  _rootLookupStages(ast, schema, params, stages);

  // sort / skip / limit（根级别）
  _appendOrder(stages, rootSort, rootSkip, rootLimit);

  // $lookup: compute 独立的 $lookup 阶段（在 $addFields 之前）
  stages.push(...buildComputeLookupStages(schema));

  // $addFields: lookup 计算列（放在最后，确保所有 $lookup 字段已就绪）
  const ctx = getContext();
  const addFields = buildAddFields(schema, ctx);
  if (addFields) stages.push(addFields);

  return stages;
}

/** 从投影中移除当前用户不可读的字段 */
function _applyPermissionPrune(proj, schema, ctx) {
  if (!ctx) return;
  const readableFields = getReadableFields(schema, ctx);
  if (readableFields === null) return;
  for (const key of Object.keys(proj)) {
    if (key === '_id') continue;
    if (key in schema.fields && !readableFields.has(key)) delete proj[key];
  }
}

/** 按计算列 depends 把依赖字段并入投影 */
function _appendComputeDeps(proj, schema, computeKeys, dotParentFields) {
  const appComputes = Object.values(schema.computes || {}).filter((c) => c.fn || c.asyncFn);
  if (!appComputes.length) return;
  const allHaveDepends = appComputes.every((c) => Array.isArray(c.depends));
  if (allHaveDepends) {
    // 最优投影：仅保留 GQL 字段 + 显式声明的依赖
    _mergeComputeDepends(proj, appComputes, dotParentFields);
  } else {
    // 安全兜底：包含所有 schema 定义字段
    _mergeAllSchemaFields(proj, schema, dotParentFields);
  }
}

function _mergeComputeDepends(proj, appComputes, dotParentFields) {
  for (const c of appComputes) {
    for (const dep of c.depends) {
      if (dotParentFields.has(dep)) continue;
      if (!(dep in proj)) proj[dep] = 1;
    }
  }
}

function _mergeAllSchemaFields(proj, schema, dotParentFields) {
  for (const key of Object.keys(schema.fields)) {
    if (dotParentFields.has(key)) continue;
    if (!(key in proj)) proj[key] = 1;
  }
}

/** 收集真实 schema 字段的投影条目（排除计算列/点号重复） */
function _collectRealFields(ast, schema, computeKeys) {
  const proj = {};
  const dotParentFields = new Set();
  const anyFieldRequested = new Set();
  let hasRealField = false;
  for (const f of ast.fields) {
    if (computeKeys.has(f)) continue;
    if (f.includes('.')) {
      const root = f.split('.', 1)[0];
      if (root in schema.fields) {
        dotParentFields.add(root);
        if (!anyFieldRequested.has(root)) proj[f] = 1;
        hasRealField = true;
      }
    } else if (f in schema.fields) {
      proj[f] = 1;
      anyFieldRequested.add(f);
      hasRealField = true;
    }
  }
  // 如果父字段被整个请求，移除其 dot-notation 子条目
  if (hasRealField) {
    for (const root of dotParentFields) {
      if (root in proj) {
        for (const key of Object.keys(proj)) {
          if (key.startsWith(`${root}.`)) delete proj[key];
        }
      }
    }
  }
  return [proj, dotParentFields, hasRealField];
}

/** 从 GQL 根字段列表 + schema computes 计算投影 */
function buildProjection(ast, schema, ctx = null) {
  if (!ast.fields || !ast.fields.length) return null;

  const computeKeys = new Set(Object.keys(schema.computes || {}));
  const proj = { _id: 1 };

  // 仅包含实际 schema 字段（排除计算列与点号重复）
  const [fieldsProj, dotParentFields, hasRealField] = _collectRealFields(ast, schema, computeKeys);
  Object.assign(proj, fieldsProj);

  if (!hasRealField) return null;

  // 收集需要在应用层执行的计算列（fn + asyncFn），其依赖字段不能被投影排除
  _appendComputeDeps(proj, schema, computeKeys, dotParentFields);

  // 关系名加入投影（否则 $project 阶段会丢弃 $lookup 的结果）
  for (const relName of Object.keys(ast.relations || {})) {
    if (!(relName in proj)) proj[relName] = 1;
  }

  // 权限裁剪：从投影中移除当前用户不可读的字段
  _applyPermissionPrune(proj, schema, ctx);

  return proj;
}

module.exports = {
  MAX_DEPTH,
  MAX_PAGINATED_DEPTH,
  tokenize,
  parse,
  parseGql,
  buildPipeline,
  buildLookup,
  buildEmptyLookup,
  buildComputeLookupStages,
  buildAddFields,
  flattenObjectFields,
  buildProjection,
  _param,
  _findStageIdx,
  _appendOrder,
  _nsLookupStages,
  _buildRelProjection,
  _relMatchExpr,
  _relLetExpr,
  _overrideOrAppend,
  _customPipelineBranch,
  _rootLookupStages,
  _applyPermissionPrune,
  _appendComputeDeps,
  _mergeComputeDepends,
  _mergeAllSchemaFields,
  _collectRealFields,
};
