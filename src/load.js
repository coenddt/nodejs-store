'use strict';

/**
 * 目录语义装载（宿主薄 IO 层）—— 共享分层与多落点择优 06
 *
 * 职责切分（判据唯一在 core）：
 *   - IO 在本模块：读 store.config.json、递归 walk 定义目录、读 JSON 文件；
 *   - 纯判决在 core：`schema.core.planLoad`（db 归属 / 路径→落点 / 主从 / 查重）。
 * 本模块**不含**任何落点/主从判据（禁双端漂移；总纲 §5 + 06 §4.1）。
 */

const fs = require('fs');
const path = require('path');

const schema = require('./schema');

/** 读 store.config.json（路径字符串 或 已解析对象）；返回 `{ config, baseDir }` */
function readConfig(pathOrObj, baseDir) {
  if (pathOrObj && typeof pathOrObj === 'object') {
    return { config: pathOrObj, baseDir: baseDir || process.cwd() };
  }
  if (typeof pathOrObj !== 'string' || !pathOrObj) {
    throw new TypeError('ERR:LOAD config 须为 store.config.json 路径或对象');
  }
  const abs = path.resolve(pathOrObj);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`ERR:LOAD 读取 store.config.json 失败: ${abs}: ${e.message}`);
  }
  return { config: parsed, baseDir: baseDir || path.dirname(abs) };
}

/**
 * 递归收集定义文件（IO）：跳过 `_` 前缀文件/目录，仅 `.json`。
 * 返回 `[{ rel, defn }]`，`rel` = 相对该定义根的路径（POSIX 分隔符）。
 */
function collectFiles(roots) {
  const out = [];
  for (const root of roots || []) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) {
      throw new Error(`ERR:LOAD 定义根不存在: ${root}`);
    }
    _walk(abs, abs, out);
  }
  return out;
}

function _walk(dir, root, out) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith('_')) continue; // IO 层约定：忽略 `_` 前缀
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      _walk(full, root, out);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      let defn;
      try {
        defn = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (e) {
        throw new Error(`ERR:LOAD 解析定义失败: ${rel}: ${e.message}`);
      }
      out.push({ rel, defn });
    }
  }
}

/** 纯规划（转调 core；判决唯一在 core） */
function planLoad(config, files) {
  return schema.core.planLoad(config, files);
}

/**
 * 运行期装载入口：读配置 → 收集定义 → core 纯规划 → 带定位批量注册。
 *
 * @returns {Array<{defn:any, location:{source:string,database:string|null,schema:string|null}}>}
 *          装载项（主在前、其后从）
 */
async function loadDefs(opts = {}) {
  const { config, ctx = null, baseDir = null } = opts;
  if (!config) throw new Error('ERR:LOAD loadDefs 缺 config（store.config.json 路径或对象）');
  const { config: cfg, baseDir: base } = readConfig(config, baseDir);
  const roots = (cfg.defs || []).map((r) => path.resolve(base, r));
  const files = collectFiles(roots);
  const items = planLoad(cfg, files);
  schema.registerBatch(items, ctx);
  return items;
}

module.exports = {
  readConfig,
  collectFiles,
  planLoad,
  loadDefs,
};
