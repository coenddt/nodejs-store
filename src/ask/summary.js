'use strict';

/**
 * schema 摘要生成器（D4-4 零语义拆分自 ask.js 组件 A）
 *
 * 承载 `describeForAi`：按 core 角色判决产出 LLM 可读的紧凑 schema 摘要
 * （模型级 canRead / 字段与关系可读集 / 计算列判决），无 ctx 时仅暴露名称。
 * 编排器留在 ../ask.js。
 */

const feedback = require('../feedback-core');
const permission = require('../permission');
const schema = require('../schema');

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
/** 无 ctx 形态：仅模型名与字段名（防探针，不暴露类型细节） */
function _summaryNoCtx(name, mirror) {
  return { name, fields: Object.keys(mirror.fields).sort() };
}

/** 可读字段投影：镜像内取类型；core 补的时间戳字段（不在镜像）类型显式留白 */
function _readableFields(mirror, readable) {
  const fields = {};
  for (const [fname, fdef] of Object.entries(mirror.fields)) {
    if (readable.has(fname)) fields[fname] = _fieldType(fdef);
  }
  for (const fname of [...readable].filter((f) => !(f in mirror.fields)).sort()) {
    // core 自动补的时间戳字段（createdAt/updatedAt）不在 Host 镜像——类型显式留白
    fields[fname] = null;
  }
  return fields;
}

/** 可读关系投影 */
function _readableRelations(mirror, readableRels) {
  const relations = {};
  for (const [rname, rdef] of Object.entries(mirror.relations)) {
    if (readableRels.has(rname)) {
      relations[rname] = { model: rdef.model, type: rdef.type };
    }
  }
  return relations;
}

/** 计算列投影（core 角色判决；旧绑定降级收窄 + 告警）；entry 仅收非空 agg/type */
function _readableComputes(name, mirror, readableComputes) {
  const computes = {};
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
  return computes;
}

/** 单模型摘要：ctx 缺失 → 无 ctx 形态；模型不可读 → null（排除）；构造顺序 fields→relations→computes 与原版一致 */
function _modelSummary(name, mirror, ctx) {
  if (ctx == null) return _summaryNoCtx(name, mirror);
  if (!permission.canReadSchema(name, ctx)) return null;
  const readable = new Set(permission.getReadableFields(name, ctx));
  // 新绑定：core 角色判决；旧绑定（core-node 未导出 readableComputes，如 npm
  // rust-store-node 2.0.0）：能力探测降级为「配 read 一律收窄 + 告警」（对齐 py 现状）
  const readableComputes = typeof schema.getCore().readableComputes === 'function'
    ? new Set(permission.getReadableComputes(name, ctx))
    : null;
  return {
    name,
    fields: _readableFields(mirror, readable),
    relations: _readableRelations(mirror, new Set(permission.getReadableRelations(name, ctx))),
    computes: _readableComputes(name, mirror, readableComputes),
  };
}

function describeForAi(ctx = null) {
  const summaries = [];
  for (const name of schema.list()) {
    if (name.endsWith('Deleted')) continue;
    const summary = _modelSummary(name, schema.get(name), ctx);
    if (summary !== null) summaries.push(summary);
  }
  return summaries;
}

module.exports = { describeForAi, _computeSkipSigs };
