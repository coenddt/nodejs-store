'use strict';

/**
 * 框架统一入口：强制「init → 逐条 register → 挂协议皮」顺序，
 * 消除装配期快照陷阱（注册完才挂载，见 store-api/spec/01-routing.md:3）。
 * 可选参数：02 回调注入（fns）、03 反馈默认接线（feedback/tenant/env）。
 *
 * D4-1 解环：`init` / `store` 由 index.js 加载完成时经 `_bindDeps` 注入
 * （原为函数内惰性 require('./index')，与 index.js 顶部 require 本模块互指成环）。
 * 本模块仅被 index.js 引用（包内唯一消费方），经主入口加载时依赖必已注入。
 */

// index.js 加载完成时注入（包内注入口，非公共 API）
let _deps = null;
function _bindDeps(d) { _deps = d; }

/** cfg 缺省值归一（解构默认值语义集中在此：键缺失或 undefined → 默认；datasource 必填校验） */
function _normalizeCfg(cfg) {
  const d = {
    schemas: [],        // 定义数组（纯 JSON；每项即 register 的入参）
    fns: {},            // 回调实现 `{ implName: impl(item, ctx) }`（L2 包 store-fns-node，扁平字典）
    ctx: null,          // 定义层门禁上下文
    config: null,       // store.config.json 路径或对象；给定时以 store.loadDefs 取代 schemas 逐条 register
    configBaseDir: null, // config 的相对基准目录（默认 = config 文件所在目录 / cwd）
    skins: null,        // store-gateway-node 的 opts（null 则不起协议面）
    reload: null,       // { tenant, env }，透传给 gateway
    feedback: true,     // 降级/拦截事件默认落 __feedback（A5）
    tenant: '',         // 反馈事件的 ns 标签
    env: '',            // 反馈事件的 ns 标签
  };
  const merged = { ...d, ...cfg };
  for (const k of Object.keys(d)) {
    if (merged[k] === undefined) merged[k] = d[k];
  }
  if (!merged.datasource) throw new Error('ERR_BOOTSTRAP:缺 datasource');
  return merged;
}

async function createApp(cfg) {
  if (!_deps) throw new Error('ERR_BOOTSTRAP:依赖未注入（应经 nodejs-store 主入口 require createApp）');
  const { init, store } = _deps;
  // datasource 必填：传给 init 的数据源（Mongo db 实例或 {default: ...} 配置）
  const {
    datasource, schemas, fns, ctx, config, configBaseDir,
    skins, reload, feedback, tenant, env,
  } = _normalizeCfg(cfg);

  // 装载/注册**先于** init —— 保证「注册先于建索引」（06 §8 待核实 3：init 内即建索引）
  let defns;
  if (config) {
    const items = await store.loadDefs({ config, ctx, baseDir: configBaseDir });
    defns = items.map((it) => it.defn);
  } else {
    defns = schemas;
    for (const defn of defns) store.register(defn, ctx);
  }
  for (const [ref, impl] of Object.entries(fns)) store.setFn(ref, impl);
  store.assertFnsCovered(defns);        // A3：缺实现即抛，进程不启动

  await init(datasource);

  if (feedback) {
    store.setFeedbackMeta({ tenant, env });  // node 侧签名：传对象
    store.enableFeedbackTable();             // 内建 __feedback + sink 落库（幂等）
  }

  let gateway = null;
  if (skins) {

    const { serve } = require('store-gateway-node');
    gateway = await serve(store, { ...skins, reload });
  }
  return {
    store,
    gateway,
    close: async () => {
      if (gateway) await gateway.close();
      if (feedback) await store.flushFeedback();   // 收口在途落库，消除 D8 丢事件窗口
    },
  };
}

module.exports = { createApp, _bindDeps };
