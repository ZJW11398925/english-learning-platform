// web/units/write/index.mjs
//
// **界面只消费这一个门面。** 七个模块里，视图层只 `import` 本文件——它不知道
// `client` / `prompt` / `parse` / `validate` / `engine` / `flow` / `store` 各自存在，
// 也就不可能绕过某一层（例如"绕过校验直接把模型的话贴到屏上"）。
//
// ── 门面替界面扛下的四件事 ────────────────────────────────────────────────────
//   1. **一个回合 ≤2 次调用**：`read`（①）与 `revise`（②）各**恰好一次**。
//      "求提示 → 提交"这条路上 ① 只发一次（求提示不调用，提交时才是 ①）；
//      "提交前又改了字"⇒ 作废缓存重发（否则模型读的不是他真正交上来的那一版）。
//   2. **挑教点插在提交与标出之间**：`submit()` 只到"拿到候选"为止；
//      `pickTeachPoint(key)` 才触发 ②，并把**他挑中的那个教点**作为输入发出去。
//      于是"挑"不是装饰性的——它真的改变了 ② 看到的东西（旧形态正是死在这里）。
//   3. **成本账**：`cost()` 的 `calls` 是**程序持有的计数**（引擎里数），不是界面的自觉。
//   4. **持久化**：每次状态推进后落盘一次，写失败不影响这一回合（代价见 `./store.mjs`）。
//
// ── 失败一律**原样上抛**，绝不补内容 ──────────────────────────────────────────
// `submit()` 在 `canHelp === false` 时返回 `reason: 'cannot_help'`，`detail` 就是模型给的
// `reason`（原样，不翻译、不润色、不补一个教点）。`pickTeachPoint()` 同理。
// 界面的责任是把它**显示成"接不住"**，而不是替它编一句——`./flow.mjs` 的
// `candidates: []` 已经把"没有东西可挑"这件事说清楚了。
//
// 纯逻辑模块：零 DOM、零浏览器 API（`callModel` / `storage` / `now` 全是注入点）。
import { createFlow } from './flow.mjs';
import { createEngine } from './engine.mjs';
import { loadState, saveState } from './store.mjs';
import { callModel as defaultCallModel } from './client.mjs';

/** 门面自己的失败档（与引擎/客户端的档**分开**：这三档是"流程层面没到那一步"）。 */
export const APP_FAIL_REASONS = Object.freeze({
  /** 他还没开始/这一版还没读（② 无处可谈）。 */
  NOT_READY: 'not_ready',
  /** 这一版是空的：一个字都没有就提交，没有东西可读。 */
  EMPTY_DRAFT: 'empty_draft',
  /** 没有这个教点 key（界面传了一个候选表里没有的）。 */
  NO_SUCH_TEACH_POINT: 'no_such_teach_point',
  /** 模型说接不住（`canHelp === false`）——程序**不补内容**，原样透出它的 reason。 */
  CANNOT_HELP: 'cannot_help',
});

/** 非空字符串才算"给了"。 */
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** 快照一次引擎的累计账（用它算增量：`cost()` 是"花了多少"，不是"引擎一共花了多少"）。 */
function snapshot(engine) {
  const st = engine.state();
  return {
    calls: st.callsTotal,
    latencyMs: st.latencyMsTotal,
  };
}

/**
 * 造这一条链路的总装。
 *
 * @param {object} input
 *   - `callModel`：模型出口（生产是 `./client.mjs` 的 `callModel`；测试注入桩）。
 *   - `storage`：本机存储（生产是 `globalThis.localStorage`；测试用假的）。可缺省（= 不持久化）。
 *   - `now`：时钟注入点（`Date.now` 形状）。
 * @returns {object} 见下面的返回对象（任务书第四节冻结的那一组，一个不少）
 */
export function createWriteApp({ callModel = defaultCallModel, storage = null, now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const engine = createEngine({ callModel, now: clock });
  const flow = createFlow({ now: clock, engine });

  /** 本回合的累计账（`calls` 是**真的发出去的次数**，含校验失败那一次——钱是按次花的）。 */
  let cost = {
    calls: 0, promptTokens: 0, completionTokens: 0, latencyMsTotal: 0,
  };
  /** 上一次累计账的快照：`record()` 用两次快照相减，避免"往同一次调用上重复记账"。 */
  let last = snapshot(engine);
  /** 回合标记：新句子 / 揭开之后算新回合（`calls` 从头数）。 */
  let roundMark = null;

  /** 把增量记进成本账（含 token；usage 缺失时**不补 0**，如实留 0 表示"这次没量到"）。 */
  function record() {
    const cur = snapshot(engine);
    cost.calls += Math.max(0, cur.calls - last.calls);
    cost.latencyMsTotal += Math.max(0, cur.latencyMs - last.latencyMs);
    last = cur;
  }

  /** 一次调用的 usage → 成本账（缺字段就是 0 次 token，不编）。 */
  function recordUsage(usage) {
    if (usage === null || typeof usage !== 'object') return;
    cost.promptTokens += Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
    cost.completionTokens += Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  }

  /** 落盘（尽力而为；写不进去不影响这一回合）。 */
  function persist() {
    saveState(storage, flow.exportState());
  }

  // ─────────────────────────── Key（**不读存储**）───────────────────────────

  /**
   * 本模块**不读 Key**（Key 的存取在 `../keyring.mjs`，那是它唯一的家）。
   * 装配层（视图/壳）在造这个 app 时把 Key 交进来（`bindApiKey`）；没交就是 `null`，
   * `callModel` 会当场落 `no_key`——**不会发那个必然 401 的请求**（`./client.mjs` 的第一道闸）。
   */
  let boundKey = null;
  const apiKeyOf = () => boundKey;

  // ─────────────────────────── ① 的缓存（一个回合只发一次）───────────────────────────

  /** 本回合 ① 的结果缓存。`draftAtRead` 是"这份结果读的是哪一版"——对不上就作废重发。 */
  let cache = null;

  const clearCache = () => { cache = null; };

  /**
   * 回合边界：新句子（`sessionId` 变了）或揭开之后（`done`）⇒ 账与缓存都从头。
   * 为什么不挂在 `startSentence` 上：**失败路径也会开新句子**（例如 ① 落空后他改一版重来），
   * 挂在状态上就不依赖"调用方记得清理"。
   */
  function syncRound() {
    const st = flow.state();
    const mark = st.sessionId;
    if (roundMark !== mark) {
      roundMark = mark;
      if (mark !== null) { engine.state().resetRound(); clearCache(); }
      cost = {
        calls: 0, promptTokens: 0, completionTokens: 0, latencyMsTotal: 0,
      };
      last = snapshot(engine);
    }
    if (st.step === 'done') { engine.state().resetRound(); clearCache(); }
  }

  /**
   * 保证 ① 已经跑过（跑过就复用缓存）。
   * **恰好一次**的落点就在这里：缓存命中时不调用模型，只有草稿变了才重发。
   */
  async function ensureRead() {
    syncRound();
    if (cache !== null && cache.draft === flow.state().draft) {
      return { ok: true, read: cache.read, cached: true };
    }
    const before = snapshot(engine);
    const res = await engine.read({
      chinese: flow.state().chinese,
      material: flow.state().material,
      draft: flow.state().draft,
      apiKey: apiKeyOf(),
    });
    cost.calls += Math.max(0, snapshot(engine).calls - before.calls);
    last = snapshot(engine);
    if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail };
    recordUsage(res.usage);
    cache = { draft: flow.state().draft, read: res.read };
    return { ok: true, read: res.read, cached: false };
  }

  /** ② 的结果缓存：同一份草稿 + 同一个教点只发一次（读结果被重新交进来时不会重复扣钱）。 */
  let reviseCache = null;

  /** 保证 ② 已经跑过（**只在挑完教点之后**才可能跑）。 */
  async function ensureRevise() {
    const st = flow.state();
    if (st.pickedKey === null) {
      return { ok: false, reason: APP_FAIL_REASONS.NOT_READY, detail: '还没有挑教点：② 要吃他挑中的那个教点。' };
    }
    if (reviseCache !== null && reviseCache.draft === st.draft && reviseCache.key === st.pickedKey) {
      return { ok: true, revise: reviseCache.revise, cached: true };
    }
    const before = snapshot(engine);
    const res = await engine.revise({
      chinese: st.chinese,
      material: st.material,
      draft: st.draft,
      pickedTeachPoint: st.pickedTeachPoint,
      apiKey: apiKeyOf(),
    });
    cost.calls += Math.max(0, snapshot(engine).calls - before.calls);
    last = snapshot(engine);
    if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail };
    recordUsage(res.usage);
    reviseCache = { draft: st.draft, key: st.pickedKey, revise: res.revise };
    return { ok: true, revise: res.revise, cached: false };
  }

  // ─────────────────────────── 对外 ───────────────────────────

  return {
    // 读
    state: () => flow.state(),
    candidates: () => flow.candidates(),
    dueNow: () => flow.dueNow(),
    wordCard(word) {
      const w = str(word);
      if (w === null) return { word: '', zh: null, pos: null, hasGloss: false };
      const found = flow.state().words.find((x) => x.word.toLowerCase() === w.trim().toLowerCase()) ?? null;
      return found === null
        ? { word: w.trim(), zh: null, pos: null, hasGloss: false }
        : { word: found.word, zh: str(found.zh), pos: str(found.pos), hasGloss: str(found.zh) !== null };
    },
    cost: () => ({ ...cost }),

    // 写
    startSentence({ chinese, material = null } = {}) {
      const ok = flow.startSentence({ chinese, material });
      syncRound();
      persist();
      return ok;
    },
    setDraft(text) {
      return flow.setDraft(text);
    },
    askHint(category = null) {
      // **零模型调用**：1 级只是"问一句卡在哪类"，内容全在 ① 的产物里（`./flow.mjs` 的 askHint）。
      const hint = flow.askHint(category);
      return Promise.resolve(hint);
    },
    async submit() {
      syncRound();
      const draft = flow.state().draft;
      if (str(draft) === null) {
        return { ok: false, reason: APP_FAIL_REASONS.EMPTY_DRAFT, detail: '这一版还是空的：先写出你想说的那句话，再来提交。' };
      }
      const got = await ensureRead();
      if (!got.ok) return { ok: false, reason: got.reason, detail: got.detail };

      flow.noteRead(got.read);
      persist();
      // **接不住就说不接**：程序一个教点都不补，原样透出模型给的 reason。
      if (got.read.canHelp !== true) {
        return {
          ok: false,
          candidates: [],
          reason: APP_FAIL_REASONS.CANNOT_HELP,
          detail: str(got.read.reason) ?? '模型说这一版它接不住，但没给理由。',
        };
      }
      return { ok: true, candidates: flow.candidates(), reason: null };
    },
    async pickTeachPoint(key) {
      syncRound();
      if (!flow.pickTeachPoint(key)) {
        return { ok: false, reason: APP_FAIL_REASONS.NO_SUCH_TEACH_POINT, detail: `候选里没有这个教点：${String(key)}` };
      }
      const got = await ensureRevise();
      if (!got.ok) return { ok: false, reason: got.reason, detail: got.detail };

      const issue = flow.noteIssue(got.revise);
      persist();
      if (issue === null) {
        return {
          ok: false,
          reason: APP_FAIL_REASONS.CANNOT_HELP,
          detail: str(got.revise.reason) ?? '模型说这一版它不改，但没给理由。',
        };
      }
      return { ok: true, issue: { ...issue } };
    },
    reviseDraft(text) {
      const ok = flow.reviseDraft(text);
      if (ok) { engine.state().resetRound(); clearCache(); persist(); }
      return ok;
    },
    reveal() {
      const out = flow.reveal();
      if (out !== null) {
        // 揭开 = 这一轮学习循环走完了 ⇒ **此刻入延迟重写队列**（"→ 延迟重写队列"那一截）。
        // 入队的时机是产品语义决定的：只有他已经看过系统版、这一版才算定稿，
        // 提前入队会把"他还没改完的那一版"当成要复习的东西。
        flow.enqueueRewrite();
        engine.state().resetRound();
        clearCache();
        persist();
      }
      return out;
    },
    addWord(word) {
      const out = flow.addWord(word);
      if (out !== null && out.added) persist(); // 没新增就不必再写一次盘（幂等收录不产生写）
      return out;
    },
    noteRewriteDone(id) {
      const ok = flow.noteRewriteDone(id);
      if (ok) persist();
      return ok;
    },

    // 持久化
    exportState: () => flow.exportState(),
    importState(obj) {
      const ok = flow.importState(obj);
      if (ok) persist();
      return ok;
    },
    /** 从注入的存储里读回并装进流程（装配层在 mount 时调一次）。 */
    loadFromStorage() {
      const ok = flow.importState(loadState(storage));
      last = snapshot(engine);
      return ok;
    },
    /** 绑定访问者的 API Key（**只在这里过一手**，本模块不碰任何存储键）。 */
    bindApiKey(key) {
      boundKey = str(key);
      return boundKey;
    },
  };
}

/** 兼容别名：任务书要求 `createApp` 与 `createWriteApp` 都能用。 */
export const createApp = createWriteApp;
