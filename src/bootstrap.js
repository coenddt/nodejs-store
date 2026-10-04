'use strict';

/**
 * 框架统一入口：强制「init → 逐条 register → 挂协议皮」顺序，
 * 消除装配期快照陷阱（注册完才挂载，见 store-api/spec/01-routing.md:3）。
 * 可选参数：02 回调注入（fns）、03 反馈默认接线（feedback/tenant/env）。
 *
 * 注意：`init` / `store` 用惰性 require——index.js 顶部 require 本模块，
 * 若此处顶层 require('./index') 会拿到尚未赋值的循环导出（空对象）。
 */

async function createApp(cfg) {
  const { init, store } = require('./index');
  const {
    datasource,          // 必填：传给 init 的数据源（Mongo db 实例或 {default: ...} 配置）
    schemas = [],        // 定义数组（纯 JSON；每项即 register 的入参）
    fns = {},            // 可选：回调实现 `{ implName: impl(item, ctx) }`，来自 L2 包 store-fns-node（扁平字典）
    ctx = null,          // 可选：定义层门禁上下文
    skins = null,        // 可选：store-gateway-node 的 opts（null 则不起协议面）
    reload = null,       // 可选：{ tenant, env }，透传给 gateway
    feedback = true,     // 可选：降级/拦截事件默认落 __feedback（A5）
    tenant = '',         // 可选：反馈事件的 ns 标签
    env = '',            // 可选：反馈事件的 ns 标签
  } = cfg || {};
  if (!datasource) throw new Error('ERR_BOOTSTRAP:缺 datasource');

  await init(datasource);
  for (const defn of schemas) store.register(defn, ctx);
  for (const [ref, impl] of Object.entries(fns)) store.setFn(ref, impl);
  store.assertFnsCovered(schemas);        // A3：缺实现即抛，进程不启动

  if (feedback) {
    store.setFeedbackMeta({ tenant, env });  // node 侧签名：传对象
    store.enableFeedbackTable();             // 内建 __feedback + sink 落库（幂等）
  }

  let gateway = null;
  if (skins) {
    // eslint-disable-next-line global-require
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

module.exports = { createApp };
