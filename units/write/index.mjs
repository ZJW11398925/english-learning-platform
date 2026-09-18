// web/units/write/index.mjs
//
// **界面只消费这一个门面。** 七个模块里，视图层只 `import` 本文件——它不知道
// `client` / `prompt` / `parse` / `validate` / `engine` / `flow` / `store` 各自存在，
// 也就不可能绕过某一层（例如"绕过校验直接把模型的话贴到屏上"）。
//
// ── 门面替界面扛下的四件事 ────────────────────────────────────────────────────
//   1. **一个回合 ≤2 次调用**：`read`（①）与 `revise`（②）各**最多一次**，且 ① **总共只发一次**。
//      "求提示"这条路第一次要给的 2/3 级内容**来自 ①**，所以它当场发一次（并发完就缓存）；
//      "提交时又改了字"**不重发** ① —— 那是本回合的第二次调用，超预算。
//      改了字之后怎么办：把缓存那份 `teachPoints` 按 V1 的**逐字可追溯**口径向新草稿过滤
//      （幸存 ≥1 ⇒ 照旧挑；幸存 0 ⇒ 跳过挑这一步，② 以 `pickedTeachPoint = null` 跑）。
//      ⚠️ **失败也占这一次的预算**（D2：实弹里 topic-1 因此被发了 3 次）——"尝试过"与
//      "成功过"分开记（`readAttempt` / `cache`），失败之后要再读只能由**他主动点一下**。
//   2. **挑教点插在提交与标出之间**：`submit()` 只到"拿到候选"为止；
//      `pickTeachPoint(key)` 才触发 ②，并把**他挑中的那个教点**作为输入发出去。
//      于是"挑"不是装饰性的——它真的改变了 ② 看到的东西（旧形态正是死在这里）。
//   3. **成本账**：`cost()` 的 `calls` 是**程序持有的计数**（引擎里数），不是界面的自觉。
//      ⚠️ 求提示那一次 ① **真的计费** ⇒ 它必须出现在 `cost().calls` 里（它是本回合两次之一）。
//   4. **持久化**：每次状态推进后落盘一次，写失败不影响这一回合（代价见 `./store.mjs`）。
//
// ── 失败一律**原样上抛**，绝不补内容 ──────────────────────────────────────────
// `submit()` 在 `canHelp === false` 时返回 `reason: 'cannot_help'`，`detail` 就是模型给的
// `reason`（原样，不翻译、不润色、不补一个教点）。`pickTeachPoint()` 同理。
// `askHint()` 的失败**不伪装成"这一类没有更多提示"**：它照样上抛 `{ok:false, reason, detail}`，
// 因为"模型没答上来"与"模型说了没有"是两件事（前者要重试/看 Key，后者是教学判断）。
// 界面的责任是把它**显示成"接不住"**，而不是替它编一句——`./flow.mjs` 的
// `candidates: []` 已经把"没有东西可挑"这件事说清楚了。
//
// 纯逻辑模块：零 DOM、零浏览器 API（`callModel` / `storage` / `now` 全是注入点）。
import { createFlow, HINT_CATEGORIES } from './flow.mjs';
import { createEngine } from './engine.mjs';
import { loadState, saveState } from './store.mjs';
import { callModel as defaultCallModel } from './client.mjs';
import { quoteIsTraceable } from './validate.mjs';

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
  /**
   * **一个候选都没剩下**：他先求了提示（那次 ① 读的是草稿 A），之后又改过（现在交的是草稿 B），
   * 而缓存里那几个教点的 `quote` **在 B 里一个都逐字找不到**。
   *
   * 为什么不是 `cannot_help`：模型**接得住**（`canHelp === true`，提示那一栏照给），
   * 只是"教点该锚在哪几个字上"这件事随着他改了字而失效了。这两件事在界面上要分开说。
   * 处置：跳过挑教点这一步（`pickTeachPoint(null)`），② 以 `pickedTeachPoint = null` 跑。
   */
  NO_TRACEABLE_TEACH_POINT: 'no_traceable_teach_point',
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

  /**
   * 本回合 ① 的**失败**记录：`{draft, reason, detail}`。
   *
   * ⚠️ **它与 `cache` 是两件事，必须分开记**（D2 修的那一格）：
   *   · `cache !== null`    ⇒ ① **成功过**，这一份读结果可以复用；
   *   · `readAttempt !== null` ⇒ ① **尝试过**（可能失败）。失败也算花过钱，
   *     所以它一样占掉本回合的"读"预算——不许因为"没缓存"就再发一次。
   * 判据：`ensureRead()` 只在**本回合没读过这一版**时才真的发请求。
   */
  let readAttempt = null;

  const clearCache = () => { cache = null; readAttempt = null; };

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
   * 保证 ① 已经跑过。
   *
   * **一个回合 ① 总共只发一次**——这是预算纪律的落点，也是本文件最容易写错的一处：
   *   · 缓存里有东西 ⇒ **直接复用，不再调用**，哪怕他现在手里的草稿已经不是缓存读的那一版；
   *     草稿变了怎么办由调用方决定（`submit()` 会按可追溯过滤候选，见那里），
   *     但**绝不能靠再发一次 ① 来解决**（那就是第 3 次调用，超预算）。
   *   · 本回合**试过但失败** ⇒ **如实回同一条失败，不再发第二次**（D2）。
   *     旧写法在这里漏了一格：失败不写缓存 ⇒ 下一次 `ensureRead()` 看见 `cache === null`
   *     就当成"还没读过"再发一次——于是"求提示失败 + 提交"这条路上一个回合发了 3 次
   *     （实弹 topic-1 实测），而学习者什么都没拿到。**失败也是花过钱的一次**，
   *     所以"尝试过"必须和"成功过"一样占预算。
   *   · 其余情况（本回合还没读过这一版）⇒ 发这一次 ①，把"它读的是哪一版"记下来。
   *
   * @param {object} [options]
   *   - `retryFailed`：**他主动点了一下**（界面上的「给点提示」）⇒ 允许把本回合那条失败作废、
   *     真的再读一次。**只有显式动作能重读**——`submit()` / `pickTeachPoint()` 一律不带它，
   *     所以那条路上永远不会出现静默的第 3 次调用。重读的代价（一次计费调用）在屏上看得见：
   *     界面把它表现为他点的那颗按钮。
   * @returns {Promise<{ok:true, read:object, cached:boolean, readDraft:string}
   *   | {ok:false, reason:string, detail:string, alreadyFailed?:boolean}>}
   */
  async function ensureRead({ retryFailed = false } = {}) {
    syncRound();
    const draft = flow.state().draft;
    if (cache !== null) {
      return { ok: true, read: cache.read, cached: true, readDraft: cache.draft };
    }
    if (readAttempt !== null && readAttempt.draft === draft) {
      if (retryFailed !== true) {
        // 本回合这一版已经读过一次、且没成功。原样把那次失败交回去（**不再发请求**）。
        return {
          ok: false,
          reason: readAttempt.reason,
          detail: readAttempt.detail,
          alreadyFailed: true,
        };
      }
      readAttempt = null; // 他主动点了：这次才允许真的重读
    }
    const before = snapshot(engine);
    const res = await engine.read({
      chinese: flow.state().chinese,
      material: flow.state().material,
      draft,
      apiKey: apiKeyOf(),
    });
    cost.calls += Math.max(0, snapshot(engine).calls - before.calls);
    last = snapshot(engine);
    if (!res.ok) {
      // **失败也记账**：他这一回合的"读"预算已经用掉了（见 `readAttempt` 的说明）。
      readAttempt = { draft, reason: res.reason, detail: res.detail };
      return { ok: false, reason: res.reason, detail: res.detail };
    }
    recordUsage(res.usage);
    cache = { draft, read: res.read };
    return {
      ok: true, read: res.read, cached: false, readDraft: cache.draft,
    };
  }

  /**
   * 把一份 ① 的产物向**当前这一版草稿**过滤：只留 `quote` 逐字可追溯的教点。
   *
   * 判据直接复用 V1 那一把尺子（`./validate.mjs` 的 `quoteIsTraceable`，归一空白、大小写不敏感）——
   * 自己再写一份"差不多"的比对就是给同一个问题造第二个出处，两边迟早会漂移。
   * 编造的 quote（模型自己造的）与"他后来把那段字改掉了"在这里是**同一种**处置：都不留。
   */
  function traceableTo(read, draft) {
    const points = Array.isArray(read?.teachPoints) ? read.teachPoints : [];
    return { ...read, teachPoints: points.filter((tp) => quoteIsTraceable(tp?.quote, draft)) };
  }

  /** ② 的结果缓存：同一份草稿 + 同一个教点只发一次（读结果被重新交进来时不会重复扣钱）。 */
  let reviseCache = null;

  /** 保证 ② 已经跑过（**挑教点这一步走过之后**才可能跑）。 */
  async function ensureRevise() {
    const st = flow.state();
    // 闸门是 `pickDecided`（这一步走过了），不是 `pickedKey !== null`：
    // "跳过挑教点"那条路径上 `pickedKey` 本来就是 null，那时 ② 照样要跑
    // （`pickedTeachPoint: null` ⇒ 它只做"标出最值得改的一处"）。
    if (st.pickDecided !== true) {
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
    /**
     * 点「给点提示」。
     *
     * ⚠️ **入口先分流，这一条是预算纪律的落点**（订正见报告：任务书第三节①把 1 级写成
     * "零模型调用"，第三节①又要求 2/3 级当场读一次 ① —— 两者只有在**1 级根本不需要读**
     * 时才同时成立）：
     *   · `category === null`（他刚点「给点提示」，界面只问"卡在哪一类？"）⇒ **一次调用都不发**，
     *     直接把 `./flow.mjs` 的 1 级答案交回去（内容就是那句问话，界面上是那三个类目按钮）。
     *   · 给了类目 ⇒ 2/3 级的内容来自 ①（"读这一版"），**这时才读**：读的是**他当前这一版草稿**
     *     （半句也行、一个字都没有也行，`./validate.mjs` 的 `validateRead` 对空白草稿有专门一条）。
     *     读到了就缓存：**一个回合 ① 只发这一次**，提交时复用，绝不再发第二次（超预算）。
     *
     * 失败**不伪装成"没有更多提示"**：读不回来（没 Key / 网络 / 校验不过）时返回
     * `{ok:false, reason, detail}`，原样透上传给界面——"模型没答上来"与"模型说了没有"
     * 是两件事，混成一句会让真正的原因看不见。
     *
     * @returns {Promise<{ok:true, level:number, category:string|null, text:string|null}
     *   | {ok:false, reason:string, detail:string}>}
     */
    async askHint(category = null) {
      syncRound();
      if (!HINT_CATEGORIES.includes(category)) {
        // 1 级：只问一句"卡在哪一类"，零调用、零 ① 依赖（详见 `./flow.mjs` 的 askHint）。
        return { ok: true, ...flow.askHint(null) };
      }
      // ⚠️ `retryFailed: true` = **他主动点了这一下**。这是本回合唯一允许"把上一条 ① 失败
      // 作废、真的再读一次"的入口（D2）：`submit()` / `pickTeachPoint()` 都走缺省（不许重读），
      // 所以在那些路上**永远不会**出现静默的第 3 次调用。代价（一次计费调用）就在他点的这一下上。
      const got = await ensureRead({ retryFailed: true });
      if (!got.ok) return { ok: false, reason: got.reason, detail: got.detail };
      flow.noteRead(got.read);
      persist();
      const hint = flow.askHint(category);
      return { ok: true, ...hint };
    },
    /**
     * 交这一版。
     *
     * ⚠️ **本回合 ① 已经失败过一次时，这里不再自动重读**（D2）：`ensureRead()` 会原样把
     * 那次失败交回来（`reason` 不变），于是"求提示失败 + 提交"这条路上**不会有静默的第 3 次调用**。
     * 要再读只有一个入口——**他主动点「给点提示」**（`askHint`，见那里的 `retryFailed`）。
     */
    async submit() {
      syncRound();
      const draft = flow.state().draft;
      if (str(draft) === null) {
        return { ok: false, reason: APP_FAIL_REASONS.EMPTY_DRAFT, detail: '这一版还是空的：先写出你想说的那句话，再来提交。' };
      }
      const got = await ensureRead();
      if (!got.ok) {
        return {
          ok: false,
          reason: got.reason,
          detail: got.detail,
          // 如实标出"这是本回合早先那次读的失败、没有重发请求"——界面据此说清"再试一次要你自己点"。
          readFailedEarlier: got.alreadyFailed === true,
        };
      }

      // 缓存那份 ① 读的是哪一版？**只有对不上才过滤**——同一版就原样交进去，
      // 免得把"他自己挑的教点"在一条本该完全无变化的路径上重新算一遍（口径只留一处）。
      const changed = got.readDraft !== draft;
      const read = changed ? traceableTo(got.read, draft) : got.read;
      flow.noteRead(read);
      persist();
      // **接不住就说不接**：程序一个教点都不补，原样透出模型给的 reason。
      if (read.canHelp !== true) {
        return {
          ok: false,
          candidates: [],
          reason: APP_FAIL_REASONS.CANNOT_HELP,
          detail: str(read.reason) ?? '模型说这一版它接不住，但没给理由。',
        };
      }
      // 候选是空的时候**如实报"这一步要跳过"**，不报 ok:true ——
      // 报成功的话界面会画一张空候选表，而他看到的是"没有东西可挑"却说不出为什么。
      // （空候选只有两种来源：草稿是空的、或过滤之后一个不剩，两者都不是"接得住"。）
      if (flow.candidates().length === 0) {
        return {
          ok: false,
          candidates: [],
          reason: APP_FAIL_REASONS.NO_TRACEABLE_TEACH_POINT,
          detail: changed
            ? '系统读的是你先前那一版，那一版里标出的几个教点在你现在这一版里一个都对不上了，'
              + '所以这一次没有东西可挑——本回合不会再读一遍（读一遍就是多花一次钱），'
              + '直接标出最值得改的一处。'
            : '这一次系统没有给出可以挑的教点，直接标出最值得改的一处。',
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
