'use strict';

/**
 * 框架统一入口：强制「init → 逐条 register → 挂协议皮」顺序，
 * 消除装配期快照陷阱（注册完才挂载，见 store-api/spec/01-routing.md:3）。
 * 本轮不含回调注入与反馈接线（分别在 02 / 03 以可选参数叠加）。
 *
 * 注意：`init` / `store` 用惰性 require——index.js 顶部 require 本模块，
 * 若此处顶层 require('./index') 会拿到尚未赋值的循环导出（空对象）。
 */

async function createApp(cfg) {
  const { init, store } = require('./index');
  const {
    datasource,          // 必填：传给 init 的数据源（Mongo db 实例或 {default: ...} 配置）
    schemas = [],        // 定义数组（纯 JSON；每项即 register 的入参）
    fns = {},            // 可选：回调实现 `{ fnRef: impl(item, ctx) }`
    ctx = null,          // 可选：定义层门禁上下文
    skins = null,        // 可选：store-gateway-node 的 opts（null 则不起协议面）
    reload = null,       // 可选：{ tenant, env }，透传给 gateway
  } = cfg || {};
  if (!datasource) throw new Error('ERR_BOOTSTRAP:缺 datasource');

  await init(datasource);
  for (const defn of schemas) store.register(defn, ctx);
  for (const [ref, impl] of Object.entries(fns)) store.setFn(ref, impl);
  store.assertFnsCovered(schemas);        // A3：缺实现即抛，进程不启动

  let gateway = null;
  if (skins) {
    // eslint-disable-next-line global-require
    const { serve } = require('store-gateway-node');
    gateway = await serve(store, { ...skins, reload });
  }
  return {
    store,
    gateway,
    close: async () => { if (gateway) await gateway.close(); },
  };
}

module.exports = { createApp };
