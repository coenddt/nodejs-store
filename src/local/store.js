'use strict';

/**
 * 本地磁盘数据源的文件 IO（唯一落盘边界）
 *
 * 布局：`<dir>/<物理集合名>.json`，内容为该集合的**文档数组**。
 *   - 读：整个目录快照 `{ "<集合名>": [文档…] }`（目录不存在 → `{}`）。
 *     非数组 / 非法 JSON 文件一律**抛错**（禁静默当空集合，见执行文档 §7）。
 *   - 写：只回写 `changed` 里的集合，先写 `.tmp` 再 `rename`（原子替换），
 *     避免中途崩溃留下半截 JSON。
 *   - 串行化：同一目录的写操作经 `withDirLock` 排队（**仅覆盖单进程**；
 *     跨进程并发不在 v1 保证范围，见执行文档 §8-1）。
 */

const fs = require('node:fs');
const path = require('node:path');

const _queues = new Map(); // dir -> Promise（写串行化：单进程内互斥）

/**
 * 读取整个目录快照。
 * @param {string} dir
 * @returns {Record<string, Array<object>>} 集合名 → 文档数组
 */
function readSnapshot(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  const out = {};
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (!name.endsWith('.json')) continue; // `.tmp` 中间文件天然被排除
    const full = path.join(dir, name);
    const raw = fs.readFileSync(full, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`本地集合文件非法 JSON: ${full}（${e.message}）`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `本地集合文件必须是文档数组: ${full}（实为 ${parsed === null ? 'null' : typeof parsed}）`,
      );
    }
    out[name.slice(0, -'.json'.length)] = parsed;
  }
  return out;
}

/**
 * 只回写 `changed` 里的集合（临时文件 + rename 原子替换）；目录不存在则创建。
 * @param {string} dir
 * @param {Iterable<string>} changed 需回写的集合名
 * @param {Record<string, Array<object>>} collections 最新快照
 */
function writeCollections(dir, changed, collections) {
  const names = Array.from(changed);
  if (names.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const tmp = path.join(dir, `.${name}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(collections[name] ?? [], null, 2));
    fs.renameSync(tmp, path.join(dir, `${name}.json`));
  }
}

/**
 * 同一目录的写操作串行化（避免同一进程内并发写互相覆盖）。
 * @template T
 * @param {string} dir
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function withDirLock(dir, fn) {
  const prev = _queues.get(dir) || Promise.resolve();
  const next = prev.then(fn, fn);
  _queues.set(dir, next.catch(() => {}));
  return next;
}

module.exports = { readSnapshot, writeCollections, withDirLock };