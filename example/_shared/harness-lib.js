'use strict';

/**
 * 场景 harness 共享库 —— example 两场景（course-platform / manager-transaction）的
 * 同构骨架下沉（D4-2 去重提取）。
 *
 * 两场景 harness 的执行管线逐字同构：装载（cases/seed/schema/ddl）→ setupBackend 四分支
 * （sqlite 内存 / mysql / postgres / mongodb，不可达返回 {error} 绝不静默）→
 * reset / withCtx / seed / teardown → 归一（deepSortValue / stableKey / compareValues /
 * compareRow / normRows / deepEq）→ runStep（op 分派、统一捕获为「显式报错」证据）→
 * assertStep（error/feedback/unsupported/run/raw→CHECKS/count/exists/inserted/updated/
 * removed/rows+oracle）→ runBackend 主循环（Mongo 先行产 oracle，SQL 后端对拍）。
 *
 * 场景差异全部经 `config` 注入（薄壳只留差异，骨架零复制）：
 *   - root / tables {main, archive} / uris {mysql, pg, mongo}：目录、清库表集、连接串；
 *   - registerAll(helpers)：schema 注册（course 附 applyFns + PROBES + 豁免清单；
 *     mgrtx 仅 schemas）；
 *   - extraDdl(kind)：建表 DDL 追加语句（mgrtx 的内建 `__workflowRun` 表；course 无）；
 *   - postSetup(kind, driver, helpers)：init 前置（mgrtx 的 CREATE INDEX + Mongo 先清空；
 *     course 无）；
 *   - filterCase(c, kind)：用例过滤（mgrtx 的 backends 子集限定；course 无）；
 *   - onRaw(h, step)：裸 raw 步骤处理（mgrtx 调 CHECKS 协程自执行自断言）；
 *     缺省（未提供）走 assertStep 的 raw 断言分支（course：复用上一步 h.result/h.error）；
 *   - stepMeta(step)：stepsOut 追加字段（course 的 oracleOnly 标记）；
 *   - checks：raw 断言协程表（各场景 impl/checks.js 的 CHECKS）。
 *
 * 零语义说明（对拍两份原 harness 逐行核对）：
 *   - runStep 的 op 分派为两场景**并集**（course 独有 query_federated；mgrtx 独有
 *     set_ctx / register_workflow / run_workflow）——已枚举两场景全部用例，各自从不触发
 *     对方的独有 op，故「未知 op」报错边界不变；
 *   - assertStep 含 run 分支（course 用例无 expect.kind='run'，该分支走不到）；
 *   - compareRow 统一为嵌套键版（`k.split('.')` 逐段下钻）——对平键（无点号）与原
 *     course 平键版逐值等价（normRows 输入恒为对象，`a[k]` 与逐段下钻同值）；
 *   - h 统一带 `driver` 字段（course 的 checks 协程只读 backend/error/events/result/store，
 *     不读 driver，新增字段无观察点）；
 *   - `eventsAll` 缓冲按 createHarness **实例**隔离（原版两 harness 为独立模块实例、
 *     各有独立缓冲；共享库若用模块级数组，node --test 并发跑两场景会互串事件）。
 *
 * D4-4 零语义拆分：本文件保留门面（导出面键名 / 键序逐字不变：仅 `createHarness`）
 *   - ./harness-oracle.js   归一与深比较（deepSortValue/stableKey/compareRow/normRows/deepEq）
 *   - ./harness-assert.js   步骤 op 分派与全部断言（runStep/assertStep）
 *   - ./harness-backend.js  四分支建连 / 清库 / ctx 三态 / seed / 收尾（makeBackendKit）
 *   拆分只搬函数体、不改调用点语义：后端工厂仍逐字引用同一 config / loaders / store /
 *   permission；`runBackend` 主循环、`_runCase` 用例生命周期、`eventsAll` 实例隔离均未动。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  init, store, permission, feedback, schema: sc,
} = require('../../src');
const { normRows } = require('./harness-oracle');
const { runStep, assertStep } = require('./harness-assert');
const { makeBackendKit } = require('./harness-backend');

/** 场景后端清单（MongoDB 为语义基准，必须最先跑以产出 oracle） */
const BACKENDS = ['mongodb', 'postgres', 'mysql', 'sqlite'];

// ──────────────────────────────────────────────────────────── 装载 ──

/** 按场景根目录构造四件装载器（cases / seed / schema / ddl，两场景同构） */
function makeLoaders(root) {
  return {
    /** 按文件名排序装载全部用例 */
    loadCases() {
      const dir = path.join(root, 'cases');
      const cases = [];
      for (const f of fs.readdirSync(dir).sort()) {
        cases.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      }
      return cases;
    },
    loadSeed() {
      return JSON.parse(fs.readFileSync(path.join(root, 'seed', 'seed.json'), 'utf8'));
    },
    loadSchemas() {
      return JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8'));
    },
    /** DDL 文本 → 语句数组（剥整行 `--` 注释后按 `;` 切分） */
    loadDdl(kind) {
      const text = fs.readFileSync(path.join(root, 'ddl', `${kind}.sql`), 'utf8');
      return text
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
    },
  };
}

/** fn/asyncFn 占位 true → 场景 FNS 表的真函数（agg 计算列原样透传，无 Host 实现） */
function applyFns(defn, fnsTable) {
  for (const [key, val] of Object.entries(defn.computes || {})) {
    if (!val.fn && !val.asyncFn) continue;
    const ref = val.fnRef || key;
    const impl = fnsTable[ref];
    if (!impl) throw new Error(`计算列 ${defn.name}.${key} 缺少 FNS 实现 ${ref}`);
    if (val.fn) val.fn = impl;
    if (val.asyncFn) val.asyncFn = impl;
  }
}

// ──────────────────────────────────────────────────────────── 工厂 ──

/**
 * 构造一个场景 harness（装载器 / setup / 归一 / 断言 / runBackend 全套闭包）。
 * @param {object} config 见模块头注释「场景差异全部经 config 注入」
 * @returns {{BACKENDS, MYSQL_URI, PG_URI, MONGO_URI, loadCases, loadSeed, loadSchemas,
 *            loadDdl, applyFns, runBackend}}
 */
function createHarness(config) {
  const loaders = makeLoaders(config.root);
  // 后端装配下沉（harness-backend.js）：闭包取值面与原版逐字同源
  const {
    setupBackend, reset, withCtx, seed, teardown,
  } = makeBackendKit({
    config, loaders, store, permission,
  });
  // 事件缓冲按实例隔离：原版两 harness 为独立模块实例、各有独立缓冲；
  // node --test 并发跑两场景时（feedback.setSink 全局单点）必须互不串扰
  const _eventsAll = [];

  /** 场景 helpers：registerAll / postSetup 等钩子的取数与清库入口（reset 在工厂解构处绑定） */
  const Helpers = {
    ...loaders,
    applyFns,
    sc,
    store,
    reset,
  };

  /** 单步骤执行+断言：raw 走场景协程（缺省复用上一步结果）；其余 runStep→assertStep。
   * `oc`：oracle 采集环境 `{ at(c,si), collected[], kind }`（mongo 侧采集 / SQL 侧回取） */
  async function _execOneStep(h, step, si, c, oc) {
    let ok;
    let note;
    if (step.op === 'raw') {
      h.events = [];
      oc.collected.push(null);
      const handled = config.onRaw ? await config.onRaw(h, step) : undefined;
      if (handled) {
        ({ ok, note } = handled);
      } else {
        // raw 断言复用上一步的 h.result/h.error（自身不发命令、不产事件）；
        // SQL 后端从 mongo oracle 按步骤位取回（mongo 侧 raw 步骤恒为 null）
        ({ ok, note } = await assertStep(h, step, oc.at(c, si), config.checks));
      }
    } else {
      const { result, error, events } = await runStep(h, step);
      h.result = result;
      h.error = error;
      h.events = events;
      let oracleRows = null;
      if (oc.kind === 'mongodb') {
        if ((step.expect || {}).kind === 'rows') {
          oracleRows = normRows(h.result, (step.expect || {}).normalize);
        }
        oc.collected.push(oracleRows);
      } else {
        oracleRows = oc.at(c, si);
      }
      ({ ok, note } = await assertStep(h, step, oracleRows, config.checks));
    }
    return { ok, note };
  }

  /** withCtx 包裹的步骤循环（用例内 ctx 态生效范围）→ stepsOut */
  async function _runCaseSteps(h, c, oc) {
    const stepsOut = [];
    await withCtx(c.ctx, async () => {
      for (let si = 0; si < c.steps.length; si += 1) {
        const step = c.steps[si];
        const { ok, note } = await _execOneStep(h, step, si, c, oc);
        const out = {
          idx: si,
          ok,
          note,
          op: step.op,
          expectKind: (step.expect || {}).kind,
        };
        if (config.stepMeta) Object.assign(out, config.stepMeta(step));
        stepsOut.push(out);
      }
    });
    return stepsOut;
  }

  /** 单用例执行：reset→seed→profile/ctx 态切换（finally 复原）；被过滤返回 null */
  async function _runCase(h, driver, c, oc) {
    if (config.filterCase && !config.filterCase(c, oc.kind)) return null;
    if ((c.reset || 'seed') === 'seed') {
      await reset(oc.kind, driver);
      await seed();
    }
    const savedRequire = store.requireContext();
    // 档位按用例声明切换（缺省 standard），结束复原
    const savedProfile = sc.getProfile();
    sc.setProfile(c.profile || 'standard');
    h.casePolicy = c.sqlPolicy || null;
    const collected = [];
    let stepsOut;
    try {
      stepsOut = await _runCaseSteps(h, c, { ...oc, collected });
    } finally {
      store.setRequireContext(savedRequire);
      sc.setProfile(savedProfile);
    }
    return { stepsOut, caseOracleSteps: collected };
  }

  /**
   * 跑一个后端：`建表 → register → (postSetup) → init → 逐用例（reset→seed→ctx→steps→
   * 断言）→ teardown`。`oracle`：mongo 侧 `runBackend('mongodb').oracle`（SQL 后端对拍用）。
   */
  async function runBackend(kind, oracle) {
    _eventsAll.length = 0;
    feedback.setSink((e) => _eventsAll.push(e));

    const h = {
      backend: kind,
      driver: null, // setup 后填充（迁移类 checks 协程执行 DDL 用）
      store,
      eventsAll: _eventsAll,
      result: null,
      error: null,
      events: [],
      casePolicy: null,
    };

    const setup = await setupBackend(kind);
    if (setup.error) {
      return { backend: kind, available: false, skipReason: setup.error, results: [], oracle: null };
    }
    const { driver, conn, client } = setup;
    h.driver = driver;

    config.registerAll(Helpers);
    if (config.postSetup) await config.postSetup(kind, driver, Helpers);
    await init({ default: conn });

    const cases = loaders.loadCases();
    const caseOracle = oracle || {};
    /** SQL 后端从 mongo oracle 按步骤位取回（越位/缺失 → null） */
    const oracleAt = (c, si) => (caseOracle && Array.isArray(caseOracle[c.id]) && si < caseOracle[c.id].length
      ? caseOracle[c.id][si] : null);
    const results = [];
    const collectedOracle = {};

    try {
      for (const c of cases) {
        const done = await _runCase(h, driver, c, { at: oracleAt, kind });
        if (!done) continue;
        results.push({
          id: c.id,
          title: c.title || '',
          group: c.group,
          backend: kind,
          status: done.stepsOut.every((s) => s.ok) ? 'pass' : 'fail',
          steps: done.stepsOut,
        });
        if (kind === 'mongodb') collectedOracle[c.id] = done.caseOracleSteps;
      }
    } finally {
      await teardown(kind, driver, client);
    }

    return {
      backend: kind,
      available: true,
      skipReason: null,
      results,
      oracle: kind === 'mongodb' ? collectedOracle : null,
    };
  }

  return {
    BACKENDS,
    MYSQL_URI: config.uris.mysql,
    PG_URI: config.uris.pg,
    MONGO_URI: config.uris.mongo,
    loadCases: loaders.loadCases,
    loadSeed: loaders.loadSeed,
    loadSchemas: loaders.loadSchemas,
    loadDdl: loaders.loadDdl,
    applyFns,
    runBackend,
  };
}

module.exports = { createHarness };
