// web/write.mjs
//
// 「今天的一句」的**装配层**：把界面（`./write.view.mjs`）与门面（`./units/write/index.mjs`）
// 接起来，并管住三件界面自己的事：Key 的进出、加载/失败态、真浏览器里那些副作用
// （`speechSynthesis` 发音、本机存储）。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 为什么是一个 `mountWrite(root, deps)` 工厂，而不是模块顶层自己跑起来
// ═══════════════════════════════════════════════════════════════════════════════
// 因为走查台（`web/gallery-write.html`）与 Node 里的 mount 测试都要用**同一份装配代码**，
// 只把依赖换掉（门面 / Key 环 / 存储 / 发音）。顶层自启动的话，走查台就只能另写一套装配
// ——那时"走查台上看到的界面"与"线上跑的界面"会各自漂移，走查台也就不叫走查台了。
// 于是：`write.html` 显式调 `mountWrite(document.getElementById('app'))`（生产缺省），
// 走查台调 `mountWrite(app, { facade, keyring, ... })`（注入假门面）。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 界面只消费一个门面（任务书第五节的形状，逐字对齐）
// ═══════════════════════════════════════════════════════════════════════════════
//   createWriteApp({ callModel, storage, now }) → {
//     state, startSentence, setDraft, askHint, submit, pickTeachPoint, reviseDraft,
//     reveal, addWord, wordCard, dueNow, cost, exportState, importState,
//   }
// 本文件**不重新实现**任何一条教学判断：门面说什么就是什么，它接不住就显示接不住。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 「下一步是哪一屏」由**门面刚刚真的回了什么**决定（不是界面的想象）
// ═══════════════════════════════════════════════════════════════════════════════
//   source   --startSentence()--------------------> draft
//   draft    --submit() ok:true-------------------> choose   （ok:false ⇒ 留在 draft + 接不住）
//   choose   --pickTeachPoint() ok:true-----------> marked   （ok:false ⇒ 留在 choose + 接不住）
//   marked   --「我自己再改一版」------------------> revise   （纯导航，没有门面调用）
//   revise   --reviseDraft() + reveal() 非 null --> reveal
//            --reveal() === null-----------------> **留在 revise**（系统版不许提前揭开）
//   reveal   --「过几天再写一遍」------------------> rewrite  （纯导航）
// 每一步的推进都**挂在一个真的返回值上**；没有返回值就原地不动。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 三条诚实纪律
// ═══════════════════════════════════════════════════════════════════════════════
// ① **引擎没落地时如实说「引擎还没接上」**，绝不用演示数据顶上（只有走查台才注入假门面，
//    而且走查台上那三个字是写在页面里的）。
// ② **门面接不住（ok:false）时如实显示 reason**，不编候选、不编教点、不编系统版。
// ③ **三条持久化清单**（我的句子 / 我的词 / 待重写）按一份**约定字段名**从 `state()` 认。
//    认不出来时**不猜**：`engineListsOk=false`，界面如实写「这一项还没从引擎拿到」，
//    而不是摆一句"还没有"（把不知道说成知道）。
//    ⚠️ 这是本文件与引擎之间**唯一**一处靠约定字段名对齐的地方（其余全部靠门面方法的
//    返回值，形状是任务书冻结的）。约定名见 `LIST_KEYS`；对不上就是集成缺口，报告里点名。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 零外部资源 / 零计费
// ═══════════════════════════════════════════════════════════════════════════════
// 本文件不发任何自己的请求（模型调用全在 `./units/write/client.mjs` 里，由门面驱动）；
// 发音用浏览器自带的 `speechSynthesis`（本地、免费、零内容风险）；不读 `.env`、不碰网络。

import {
  renderWrite, emptySnapshot, segmentsToText, textToSegments,
} from './write.view.mjs';
import { createKeyring } from './units/keyring.mjs';
import { APP_FAIL_REASONS } from './units/write/index.mjs';

/** 门面的落地位置（`createWriteApp`）。**任务书冻结**：界面只许消费这一个门面。 */
export const ENGINE_URL = './units/write/index.mjs';

/** 模型客户端的落地位置（门面要的 `callModel` 注入点）。 */
export const CLIENT_URL = './units/write/client.mjs';

/**
 * 三条持久化清单在 `state()` 里的**约定字段名**（按顺序认第一个命中的）。
 * 这一层之外没有任何地方依赖这些名字；认不出来时 `engineListsOk=false` 如实上报。
 *
 * ⚠️ **写死的这几个名字是照引擎实读对齐的，不是猜的**（`web/units/write/flow.mjs`
 * 的 `state()` 快照）：`sentences` / `words` / `rewriteQueue`。
 * 后面那几个别名留着是为了"形状微调时不至于当场瞎"；**不许把它扩成"凡数组皆可"**。
 */
export const LIST_KEYS = Object.freeze({
  mine: ['sentences', 'mineSentences', 'mySentences', 'works'],
  words: ['words', 'myWords', 'mineWords', 'vocab'],
  due: ['rewriteQueue', 'due', 'dueQueue', 'queue'],
});

/** 从一个可能是 `undefined`/别名的对象里，按候选名字取第一个数组。 */
function pickArray(obj, names) {
  if (obj === null || typeof obj !== 'object') return null;
  for (const n of names) {
    if (Array.isArray(obj[n])) return obj[n];
  }
  return null;
}

/**
 * 「我的句子」的一条 → `{zh, en}`。
 * ⚠️ 引擎的字段名是 **`draft`**（`flow.mjs` 的 `sentences[].draft` 就是他写的那一版英文），
 * 不是 `en`。任务书冻结的门面形状**没有写 `state()` 里长什么样**，所以这一层是按引擎实读
 * 对齐的；其余别名只为容忍形状微调。
 */
function normMine(item) {
  if (typeof item === 'string') return { zh: '', en: item };
  if (item === null || typeof item !== 'object') return null;
  const en = item.draft ?? item.en ?? item.english ?? item.text ?? item.sentence;
  if (typeof en !== 'string' || en.trim() === '') return null;
  const zh = item.zh ?? item.chinese ?? item.source ?? '';
  return { zh: typeof zh === 'string' ? zh : '', en };
}

/** 「我的词」的一条：引擎给的是对象 `{word, zh, pos}`；也容忍纯字符串。 */
function normWord(item) {
  if (typeof item === 'string') return item.trim() === '' ? null : item.trim();
  if (item === null || typeof item !== 'object') return null;
  return typeof item.word === 'string' && item.word.trim() !== '' ? item.word : null;
}

/**
 * 「还没到期的那一条」的人话措辞。**"到没到期"由引擎的 `dueNow()` 说了算**，
 * 这里只在它说"还没到"的时候把那个时间说成人话（界面的本分是措辞，不是判定）。
 */
export function whenLabel(dueAt, nowMs) {
  if (!Number.isFinite(dueAt)) return '';
  const diff = dueAt - nowMs;
  if (diff <= 0) return '现在就可以重写';
  if (diff < 24 * 60 * 60 * 1000) return `再过 ${String(Math.max(1, Math.round(diff / 3600000)))} 小时`;
  return `再过 ${String(Math.ceil(diff / 86400000))} 天`;
}

/**
 * 「待重写」的一条 → `{en, zh, when}`。
 *
 * ⚠️ 引擎的队列项里**没有正文**（`{id, sessionId, dueAt, intervalMs, hinted, scaffoldLevel, status}`）——
 * 正文要按 `sessionId` 回到 `sentences` 里取。取不到就**如实留空**（界面写"这一句的正文没读回来"），
 * 不拿别的句子顶上。
 */
function normDue(item, sentencesRaw, dueIds, nowMs) {
  if (typeof item === 'string') return { en: item, zh: '', when: '' };
  if (item === null || typeof item !== 'object') return null;
  const sid = item.sessionId ?? null;
  const src = (Array.isArray(sentencesRaw) && sid !== null)
    ? (sentencesRaw.find((s) => s !== null && typeof s === 'object' && s.id === sid) ?? null)
    : null;
  const en = src !== null && typeof src.draft === 'string'
    ? src.draft
    : (typeof item.draft === 'string' ? item.draft : '');
  const zh = src !== null && typeof src.zh === 'string' ? src.zh : '';
  const when = dueIds.has(String(item.id ?? '')) ? '现在就可以重写' : whenLabel(Number(item.dueAt), nowMs);
  return { en, zh, when };
}

/**
 * 本机存储的**薄包装**：只在调用那一刻碰 `localStorage`，读写抛错都变成"这一次没成"。
 * 为什么不让引擎自己去摸全局：`localStorage` 在隐私模式下**访问属性**就可能抛，
 * 而"存不进去"必须变成一个能显示给人看的信号，不是静默。
 */
export function safeStorage(onFail = () => {}) {
  const ls = () => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  return {
    getItem(k) {
      const s = ls();
      if (s === null) return null;
      try { return s.getItem(k); } catch { return null; }
    },
    setItem(k, v) {
      const s = ls();
      if (s === null) { onFail(); return; }
      try { s.setItem(k, String(v)); } catch { onFail(); }
    },
    removeItem(k) {
      const s = ls();
      if (s === null) return;
      try { s.removeItem(k); } catch { /* 删不掉不影响读回：下一次读到的还是旧值 */ }
    },
  };
}

/** 浏览器自带的朗读出口（`speechSynthesis`）。零外部资源、零内容风险。 */
function browserSpeak(surface) {
  const synth = globalThis.speechSynthesis;
  const Utter = globalThis.SpeechSynthesisUtterance;
  if (synth === undefined || typeof Utter !== 'function') {
    return { ok: false, error: '这个浏览器没有自带的朗读功能。' };
  }
  const u = new Utter(String(surface ?? ''));
  u.lang = 'en-US';
  try {
    synth.cancel();
    synth.speak(u);
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: `朗读没能出声：${String(err?.message ?? err)}` };
  }
}

/**
 * 把「今天的一句」挂到 `root` 上。
 *
 * @param {object} root 容器元素（`replaceChildren` 必须存在）
 * @param {object} [deps] 注入点（生产一个都不传，全走缺省）
 *   - `doc`        document（缺省 `globalThis.document`）
 *   - `facade`     **直接给一个门面**（走查台注入假门面用）；给了就不再动态 import
 *   - `engineUrl`  门面位置（缺省 `ENGINE_URL`）
 *   - `callModel`  客户端的注入点（给了就不动态 import `client.mjs`）
 *   - `keyring`    Key 环（缺省 `createKeyring()`）
 *   - `storage`    门面要的本机存储（缺省 `safeStorage()`）
 *   - `speak`      发音出口（缺省浏览器自带的 `speechSynthesis`）
 * @returns {Promise<{getSnapshot: () => object}>} 一个只读把手（给走查台/探针看现场用）
 */
export async function mountWrite(root, deps = {}) {
  if (root === null || root === undefined || typeof root.replaceChildren !== 'function') {
    throw new TypeError('mountWrite: 需要传入一个容器元素（web/write.html 里的 #app）');
  }
  const doc = deps.doc ?? globalThis.document;
  if (doc === undefined || doc === null || typeof doc.createElement !== 'function') {
    throw new TypeError('mountWrite: 找不到可用的 document（Node 里请注入 deps.doc）');
  }
  const keyring = deps.keyring ?? createKeyring();
  const speak = typeof deps.speak === 'function' ? deps.speak : browserSpeak;

  /** 视图快照。**唯一**的一份界面状态；每次改完都整棵重画（本页零组件状态）。 */
  let snap = emptySnapshot();

  /** 引擎侧的门面。`null` = 还没接上。注入的假门面直接落这里。 */
  let facade = deps.facade ?? null;

  /** 界面的几个"这一步正在做什么"的标记（不是教学状态，是按钮的禁用与文案）。 */
  const ui = {
    busy: false,
    /** 提示已经选定的类别（`hintAgain` 用它继续问同一类）。 */
    hintCategory: null,
    /** 「这次接不住」的话（下一次成功的调用会清掉它）。 */
    failReason: null,
    /** 一句短暂的回执（「加进我的词了」之类）。 */
    notice: null,
    /** 本机存储写不进去时的如实提示。 */
    storageWarn: null,
  };

  const paint = () => {
    renderWrite(root, {
      ...snap,
      busy: ui.busy,
      fail: ui.failReason === null ? null : { reason: ui.failReason },
      notice: ui.storageWarn ?? ui.notice,
    }, { doc, on: handle });
    snap.anim = false;   // 动效类只在那一次重画里存在
  };

  /**
   * 一次门面调用前后的公共壳：置忙 → 跑 → **无论成败都刷一遍引擎、重画**。
   * `finally` 里重画是必须的：否则一次成功的调用之后界面还停在加载态
   * （"看不见的推进"等于什么都没发生）。异常也走同一条路 —— 界面绝不留在卡死的样子上。
   */
  async function run(fn) {
    ui.busy = true;
    paint();
    try {
      await fn();
    } finally {
      ui.busy = false;
      syncFromEngine();
      paint();
    }
  }

  /**
   * 把引擎里的三条清单与成本读进快照。认不出字段名**不猜**（见文件头第 ③ 条）。
   *
   * ⚠️ **待重写队列读的是 `state().rewriteQueue`，不是 `dueNow()`** —— 这两个不是一回事：
   * `dueNow()` 只回**此刻已到期**的条目，而刚揭开的那一句 `dueAt = now + 4~12 小时`，
   * 于是它当场必然是空的。屏上那一栏叫「过几天再写一遍」，把"还没到期"说成"还没有"
   * 就是**把不知道说成知道**（本项目最怕的那种错：画面对、数字对、事实错）。
   * `dueNow()` 仍然被用上：它决定哪几条的措辞是「现在就可以重写」——**到期是引擎判的**。
   */
  function syncFromEngine() {
    if (facade === null) return;
    let state = null;
    try {
      state = facade.state();
    } catch {
      state = null;
    }
    const mineRaw = pickArray(state, LIST_KEYS.mine);
    const wordsRaw = pickArray(state, LIST_KEYS.words);
    const dueRaw = pickArray(state, LIST_KEYS.due);

    snap.mineSentences = mineRaw === null ? [] : mineRaw.map(normMine).filter((x) => x !== null);
    snap.myWords = wordsRaw === null ? [] : wordsRaw.map(normWord).filter((w) => w !== null);

    let dueIds = new Set();
    try {
      const now = facade.dueNow();
      if (Array.isArray(now)) {
        dueIds = new Set(now.map((x) => (x !== null && typeof x === 'object' ? String(x.id ?? '') : '')));
      }
    } catch { /* 到期集合拿不到就只按时间措辞（措辞错了也只是措辞，不假装它到期了）*/ }

    const nowMs = Date.now();
    snap.due = dueRaw === null ? [] : dueRaw
      // 队列里已经写完的不算"待重写"（那是引擎自己的 `status`，不是界面猜的）
      .filter((it) => it !== null && typeof it === 'object' && it.status !== 'done')
      .map((it) => normDue(it, mineRaw, dueIds, nowMs))
      .filter((x) => x !== null);

    snap.engineListsOk = mineRaw !== null && wordsRaw !== null && dueRaw !== null;

    try {
      const c = facade.cost();
      if (c !== null && typeof c === 'object') {
        snap.cost = {
          calls: Number(c.calls ?? 0),
          promptTokens: Number(c.promptTokens ?? 0),
          completionTokens: Number(c.completionTokens ?? 0),
          latencyMsTotal: Number(c.latencyMsTotal ?? 0),
        };
      }
    } catch { /* 成本读不到就保持上一次的读数——**不把 0 写进去**（0 会盖住真凶）*/ }
  }

  /* ── 引擎接线（动态 import + 诚实失败）───────────────────────────────────── */
  async function connectEngine() {
    if (facade !== null) return true;      // 走查台/测试注入的门面：不再 import

    const url = deps.engineUrl ?? ENGINE_URL;
    let mod;
    try {
      mod = await import(url);
    } catch (err) {
      snap.engineMissing = `载入 ${url} 失败：${String(err?.message ?? err)}`;
      return false;
    }
    if (typeof mod?.createWriteApp !== 'function') {
      snap.engineMissing = `${url} 里没有导出 createWriteApp（导出的名字：`
        + `${Object.keys(mod ?? {}).join('、') || '一个都没有'}）`;
      return false;
    }

    // `callModel` 是门面要的**注入点**：它自己不去读 Key —— "谁是网络出口"只有一个决定点。
    // 这里在**每次调用那一刻**读 Key（中途换了 Key，下一次调用就用新的那把）。
    let client = typeof deps.callModel === 'function' ? deps.callModel : null;
    if (client === null) {
      try {
        const m = await import(CLIENT_URL);
        if (typeof m?.callModel === 'function') client = m.callModel;
      } catch { /* 客户端模块没落地：下面按"接不上"如实报 */ }
    }
    if (client === null) {
      snap.engineMissing = '门面要的 ./units/write/client.mjs（callModel）没接上';
      return false;
    }
    const callModel = (args) => client({ ...args, apiKey: keyring.loadKey() ?? '' });

    try {
      facade = mod.createWriteApp({
        callModel,
        storage: deps.storage ?? safeStorage(() => {
          ui.storageWarn = '本机存储写不进去（可能是隐私模式）：刷新之后可能留不住。';
        }),
        now: Date.now,
      });
    } catch (err) {
      facade = null;
      snap.engineMissing = `createWriteApp 没建成：${String(err?.message ?? err)}`;
      return false;
    }
    if (facade === null || typeof facade !== 'object') {
      facade = null;
      snap.engineMissing = 'createWriteApp 没有返回门面';
      return false;
    }
    snap.engineMissing = null;
    return true;
  }

  /**
   * 事件出口：视图只发名字 + 载荷，流程判断全在这里。
   *
   * 返回值约定（**只为了不把整页重画搞错**）：
   *   · 返回 `false` ⇒ **不重画**。只有"边打字边存值"那几个动作返回它 ——
   *     每敲一个字就整棵替换 DOM 的话，光标会当场丢掉（真浏览器里一试就知道）。
   *   · 返回 Promise ⇒ 异步动作，收尾重画由 `run()` 的 `finally` 负责；
   *     这里只兜住"连 run 都炸了"的意外。
   *   · 其余（含 `undefined`）⇒ 同步动作，这里统一重画。
   */
  function handle(name, payload) {
    const fn = ACTIONS[name];
    if (typeof fn !== 'function') return;
    ui.notice = null;             // 上一句回执只在它那一次动作之后短暂存在
    const out = fn(payload);
    if (out === false) return;    // 打字：只存值，不重画
    if (out !== undefined && typeof out.then === 'function') {
      // ⚠️ **把这个 Promise 返回出去**（而不是吞掉它）：
      //   · 真浏览器里点击事件的返回值没人看，没坏处；
      //   · 假 DOM（`tests/helpers/dom.mjs`）的 `click()` 会**返回**监听器的返回值 ——
      //     于是 mount 测试能 `await btn.click()` 等到这条异步链真的落定。
      //     不返回的话测试只能靠 sleep 猜，而"猜时长"正是本仓反复踩过的那类假绿。
      return out.catch((err) => {
        ui.failReason = `这一步没能完成：${String(err?.message ?? err)}`;
        ui.busy = false;
        paint();
      });
    }
    paint();
  }

  /**
   * 门面调用失败时的统一处置：**如实说不接**，一个字的假内容都不补。
   *
   * ⚠️ 优先用 **`detail`**：引擎的 `reason` 是一个**封闭枚举**（`no_key` / `timeout` /
   * `cannot_help` / `empty_draft` …），`detail` 才是给人看的那句话。
   * 任务书冻结的形状只写了 `reason` —— 照字面把它印到屏上，学习者会看到
   * `cannot_help` 这种东西。这一条是**实测出来的形状缺口**，不是猜的。
   */
  function refuse(err) {
    ui.failReason = String(err?.message ?? err ?? '它没给理由');
    ui.notice = null;
  }

  /** 从一次 `{ok:false, reason, detail}` 里取**给人看的那一句**。 */
  function whyOf(res, fallback) {
    const detail = res?.detail;
    if (typeof detail === 'string' && detail.trim() !== '') return detail;
    const reason = res?.reason;
    if (typeof reason === 'string' && reason.trim() !== '') return reason;
    return fallback;
  }

  /** 把当前草稿交给门面（提示与提交都要先让它看见这一版）。 */
  async function pushDraft() {
    const text = segmentsToText(snap.draftSegs);
    const ok = await facade.setDraft(text);
    return { text, ok };
  }

  /**
   * 提示拿不到内容时的那一句人话。
   *
   * ⚠️ **订正（这一版修掉了 D1）**：这里原先写着「提示要等系统读过你这一版才有：先按「写好了」
   * 交一次，再回来点提示」—— 那是把引擎当时的接线顺序（① 只在 `submit()` 里发生）
   * **当成了产品行为写进界面**，而形态的全部价值就在"卡住时给最小帮助"这一格。
   * 现在引擎在**求 2/3 级提示时当场读 ①**（读的是他当前这一版，一个字都没写也合法），
   * 所以这句话**已经变成假话**，必须删掉。
   *
   * 剩下的两种"没有内容"必须分开说（本项目的铁律：不把两件事说成一件）：
   *   · `canHelp === false` ⇒ 模型说了**它接不住这一版**（那是教学判断，照实转述）；
   *   · `canHelp === true` ⇒ 模型接得住、但这个类目**没有更深的一级了**（台阶到顶/只有一级）。
   */
  function noHintNotice() {
    let canHelp = null;
    try {
      const st = facade === null ? null : facade.state();
      if (st !== null && typeof st === 'object' && typeof st.canHelp === 'boolean') canHelp = st.canHelp;
    } catch { canHelp = null; }
    if (canHelp === false) return '系统说这一版它接不住，所以也给不出提示。';
    if (canHelp === null) return '这一类暂时没有更多提示了。';
    return '这一类暂时没有更多提示了（系统没给更深的一级，不是提示坏了）。';
  }

  const ACTIONS = {
    /* ── 没配 Key 那一屏 ─────────────────────────────────────────────────── */
    keyInput(v) { snap.keyInput = String(v ?? ''); return false; },
    async saveKey() {
      const r = keyring.saveKey(snap.keyInput);
      if (r.ok !== true) {
        snap.keyError = String(r.error ?? '没存上');
        return;
      }
      snap.keyError = '';
      snap.keyInput = '';
      snap.keyMissing = false;
      await boot();
    },

    /* ── 第 1 步：说一句中文 / 贴一段素材 ────────────────────────────────── */
    sourceInput(v) { snap.sourceInput = String(v ?? ''); return false; },
    materialInput(v) { snap.materialInput = String(v ?? ''); return false; },
    async start() {
      const chinese = String(snap.sourceInput ?? '').trim();
      if (chinese === '') {
        ui.failReason = '先写一句中文，再往下走。';
        return;
      }
      const material = String(snap.materialInput ?? '').trim();
      await run(async () => {
        let ok = true;
        try {
          ok = await facade.startSentence({ chinese, material: material === '' ? null : material });
        } catch (err) { refuse(err); return; }
        // ⚠️ 引擎的 `startSentence` 会**返回 false**（上一句还没走完时不重开）。
        // 不认这个返回值就是"界面自己往前走"—— 那正是本项目最恨的假推进。
        if (ok === false) {
          ui.failReason = '这一句还没走完，引擎不肯起新的一句——先把这一句收掉。';
          return;
        }
        snap.chinese = chinese;
        snap.material = material;
        snap.step = 'draft';
        ui.failReason = null;
      });
    },

    /* ── 第 2 步：从零写（分段）+ 三级台阶的提示 ─────────────────────────── */
    draftInput({ index, value }) { snap.draftSegs[index] = String(value ?? ''); return false; },
    addSeg() { snap.draftSegs = [...snap.draftSegs, '']; },
    openHint() { snap.hintOpen = true; ui.failReason = null; },

    async hintCategory(cat) {
      await run(async () => {
        try {
          await pushDraft();
          const r = await facade.askHint(cat);
          if (r === null || typeof r !== 'object') { refuse('门面没给出提示'); return; }
          // ⚠️ 门面会**如实报失败**（没 Key / 网络 / 校验不过）——那与"模型说了没有"是两件事，
          // 拿同一句话糊过去就会把真正的原因藏起来（所以先认 ok，再看 content）。
          if (r.ok !== true) {
            snap.hint = null;
            snap.hintOpen = false;
            ui.hintCategory = null;
            refuse(new Error(whyOf(r, '提示没拿到')));
            return;
          }
          // ⚠️ 引擎**明确会**回 `{level: 0, category, text: null}` —— 它的注释写着
          // "`text: null` 且**不是**编出来的内容——界面据此显示'这一类暂时没有更多提示'"。
          // 所以这里**不把它当成错误**，也不编一句提示：如实说这一句。
          if (typeof r.text !== 'string' || r.text.trim() === '') {
            snap.hint = null;
            snap.hintOpen = false;
            ui.hintCategory = null;
            ui.failReason = null;
            ui.notice = noHintNotice();
            return;
          }
          ui.hintCategory = cat;
          snap.hint = { level: r.level, category: r.category, text: r.text };
          snap.hintOpen = false;
          // 到第 3 级就不再让往上要（第 3 级是台阶的顶）。
          snap.hintCats = r.level === 3 ? [] : [cat];
          ui.failReason = null;
        } catch (err) { refuse(err); }
      });
    },

    async hintAgain() {
      if (ui.hintCategory === null) { snap.hintOpen = true; return; }
      await ACTIONS.hintCategory(ui.hintCategory);
    },

    /* ── 第 3 步：提交 → 挑教点 ─────────────────────────────────────────── */
    async draftDone() {
      await run(async () => {
        try {
          const { text, ok } = await pushDraft();
          if (text === '') { refuse('先写一句英文再交。'); return; }
          // 引擎的 `setDraft` 在**阶段不对**时返回 false（`s.step !== 'drafting'`）。
          // 不认它就是拿引擎里的**旧草稿**去提交 —— 那会是一次静默的错。
          if (ok === false) { refuse('这一版没能交进引擎（它说现在不是写草稿的阶段）'); return; }
          const r = await facade.submit();
          if (r === null || typeof r !== 'object') { refuse('门面没有回话'); return; }
          if (r.ok !== true) {
            // ⚠️ **"这一步跳过了"不是"接不住"**（门面把两者分开报，界面必须分开说）：
            // 他先求过提示（那次 ① 读的是草稿 A）、之后又改了字（现在交的是草稿 B），
            // 缓存里那几个教点在他这一版里一个都逐字找不到 ⇒ 跳过挑教点，直接标出一处。
            // 拿 "这次接不住" 糊过去就是**把两件事说成一件**，而那件事根本不是失败。
            if (r.reason === APP_FAIL_REASONS.NO_TRACEABLE_TEACH_POINT) {
              snap.version1 = text;
              await ACTIONS.pickSkip(whyOf(r, '这一次没有东西可挑'));
              return;
            }
            refuse(whyOf(r, '它没给理由'));
            return;
          }
          const cands = Array.isArray(r.candidates) ? r.candidates : [];
          if (cands.length === 0) { refuse('它没有给出可以挑的教点'); return; }
          snap.version1 = text;
          snap.candidates = cands;
          snap.step = 'choose';
          ui.failReason = null;
          ui.notice = null;
        } catch (err) { refuse(err); }
      });
    },

    async pick(key) {
      await run(async () => {
        try {
          const r = await facade.pickTeachPoint(key);
          if (r === null || typeof r !== 'object') { refuse('门面没有回话'); return; }
          if (r.ok !== true) { refuse(whyOf(r, '它没给理由')); return; }
          const issue = r.issue;
          if (issue === null || issue === undefined || typeof issue.quote !== 'string' || issue.quote === '') {
            refuse('它没有说清要标哪一处');
            return;
          }
          snap.picked = (snap.candidates ?? []).find((c) => c.key === key) ?? null;
          snap.issue = { quote: issue.quote, kind: issue.kind };
          snap.issueOpen = false;
          snap.step = 'marked';
          ui.failReason = null;
        } catch (err) { refuse(err); }
      });
    },

    /**
     * **跳过挑教点**：一个候选都没有剩下时，② 以 `pickedTeachPoint = null` 跑
     * （引擎的 `pickTeachPoint(null)`，只在候选真的是空的时候合法），② 只做
     * "标出最值得改的一处"。
     *
     * 为什么不做成"没候选就自动往下走"：那会让"他挑了哪一个"这件事凭空消失。
     * 他把这一步**看见**（屏上如实写着为什么没有东西可挑），比悄悄替他决定要好。
     * 它**不自己开一个 `run()`**：调用方（`draftDone`）已经在 `run()` 里了，
     * 再套一层会让同一次动作重画两遍。
     */
    async pickSkip(why = '') {
      try {
        const r = await facade.pickTeachPoint(null);
        if (r === null || typeof r !== 'object') { refuse('门面没有回话'); return; }
        if (r.ok !== true) { refuse(whyOf(r, '它没给理由')); return; }
        const issue = r.issue;
        if (issue === null || issue === undefined || typeof issue.quote !== 'string' || issue.quote === '') {
          refuse('它没有说清要标哪一处');
          return;
        }
        snap.picked = null;
        snap.issue = { quote: issue.quote, kind: issue.kind };
        snap.issueOpen = false;
        snap.step = 'marked';
        ui.failReason = null;
        ui.notice = why === '' ? null : why;
      } catch (err) { refuse(err); }
    },

    /* ── 第 4 步：标出来、不说；点开才说 ────────────────────────────────── */
    openIssue() { snap.issueOpen = true; },

    /* ── 第 5 步：他自己再改一版 ────────────────────────────────────────── */
    goRevise() {
      snap.reviseSegs = textToSegments(snap.version1 ?? '');
      if (snap.reviseSegs.length === 0) snap.reviseSegs = [''];
      snap.step = 'revise';
      ui.failReason = null;
    },
    reviseInput({ index, value }) { snap.reviseSegs[index] = String(value ?? ''); return false; },
    addReviseSeg() { snap.reviseSegs = [...snap.reviseSegs, '']; },

    /* ── 第 6 步：改完才揭开系统版 ──────────────────────────────────────── */
    async reviseDone() {
      await run(async () => {
        const text = segmentsToText(snap.reviseSegs);
        if (text === '') { refuse('先改出一版再揭开。'); return; }
        try {
          const ok = await facade.reviseDraft(text);
          // 引擎的 `reviseDraft` 在**阶段不对**时返回 false（`s.step !== 'marked'`）；
          // 认了它，下面那句"揭不开"的话才说得准。
          if (ok === false) {
            ui.failReason = null;
            ui.notice = '这一版没能交进引擎（它说现在不是再改一版的阶段）——系统版因此没揭开。';
            return;
          }
          // ⚠️ **揭开与否只有一个判据**：`reveal()` 的返回值。
          // 他没再改一版之前它是 `null` —— 那时界面**一个字**都不许画。
          const rev = facade.reveal();
          if (rev === null || rev === undefined) {
            ui.failReason = null;
            ui.notice = '系统版还没揭开——引擎说还没到揭开的时候。';
            return;
          }
          if (typeof rev.system !== 'string' || rev.system === '') {
            refuse('门面没给出系统版');
            return;
          }
          snap.version2 = text;
          snap.revealed = true;
          snap.system = rev.system;
          snap.why = Array.isArray(rev.why) ? rev.why.filter((x) => typeof x === 'string' && x !== '') : [];
          // 引擎的 `simpler` 可以是 `null`（模型没给两档）——`null` 就不画，不补空档。
          snap.simpler = rev.simpler ?? null;
          snap.glosses = Array.isArray(rev.glosses) ? rev.glosses : [];
          snap.step = 'reveal';
          snap.anim = true;            // 动效只在改写这一处
          ui.failReason = null;
          ui.notice = null;
        } catch (err) { refuse(err); }
      });
    },

    /* ── 第 7 步：延迟重写 ──────────────────────────────────────────────── */
    gotoQueue() {
      snap.step = 'rewrite';
      // 这一屏的全部内容就是这个队列 ⇒ 进来就把它摊开（不然人得再点一下才看得见东西）
      snap.fold = 'due';
      syncFromEngine();
    },
    gotoReveal() { snap.step = 'reveal'; },

    /* ── 词卡：发音 / 加进我要学的 ──────────────────────────────────────── */
    async word({ key, surface, block }) {
      const same = snap.card !== null && snap.card.key === key && snap.card.block === block;
      if (same) { snap.card = null; return; }        // 再点一次收起
      await run(async () => {
        try {
          const c = facade.wordCard(key);
          const obj = (c !== null && typeof c === 'object') ? c : {};
          snap.card = {
            key,
            surface: String(surface ?? key),
            pos: typeof obj.pos === 'string' ? obj.pos : null,
            zh: typeof obj.zh === 'string' ? obj.zh : null,
            hasGloss: obj.hasGloss === true,
            block,
          };
          ui.failReason = null;
        } catch (err) { refuse(err); }
      });
    },

    async addWord(key) {
      await run(async () => {
        try {
          const r = await facade.addWord(key);
          // 引擎会回 `{added:false}`（重复收录是幂等的）——**照实说**，
          // 说成"加进去了"就是一句小谎（它本来就在里面）。
          const added = r === null || r === undefined || r.added !== false;
          ui.notice = added
            ? `「${String(key)}」加进「我的词」了。`
            : `「${String(key)}」已经在「我的词」里了。`;
        } catch (err) { refuse(err); }
      });
    },

    /** 发音：浏览器自带的语音合成。本地、免费、零内容风险（不引任何外部资源）。 */
    speak(surface) {
      const r = speak(surface);
      if (r !== null && r !== undefined && r.ok === false) ui.notice = String(r.error ?? '朗读没能出声');
    },

    /* ── 折叠块 ─────────────────────────────────────────────────────────── */
    fold(kind) { snap.fold = snap.fold === kind ? null : kind; },
  };

  /* ── 装载 ───────────────────────────────────────────────────────────────── */
  async function boot() {
    // 纪律 ⑩：没配 Key **不撞墙** —— 当场给出完整引导（为什么需要 / 去哪拿 / sk- 形状 / 只存本机）。
    if (!keyring.hasKey()) {
      snap.keyMissing = true;
      snap.engineMissing = null;
      paint();
      return;
    }
    snap.keyMissing = false;
    const ok = await connectEngine();
    if (!ok) {
      paint();
      return;
    }
    // ⚠️ 读三条清单**必须在这里、而不是在 `connectEngine` 里**。
    // 踩过：`connectEngine` 对**注入的门面**（走查台 / 测试 / 以后可能的预置门面）
    // 是提前 return 的，于是"读 state()"这一步被整个跳过 —— 三条清单恒为空，
    // 而 `engineListsOk` 还是 `true`（默认值），屏上就出现了一个**假的"还没有"**。
    // 这一条正是本项目最怕的那类假绿：画面对、数字对、事实错。
    syncFromEngine();
    paint();
  }

  try {
    await boot();
  } catch (err) {
    // 连装载都炸了：**不白屏** —— 落一句人话在屏上（这是最后一道出口）。
    snap.engineMissing = String(err?.message ?? err);
    try { paint(); } catch { /* 连画都画不出来时不再套娃 */ }
  }

  return { getSnapshot: () => ({ ...snap, busy: ui.busy, fail: ui.failReason === null ? null : { reason: ui.failReason } }) };
}
