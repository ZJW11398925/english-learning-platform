// web/units/write/flow.mjs
//
// **流程层**：这条学习循环的推进器。它持有全部状态与全部状态转移，一眼看得见"现在在哪一步"。
//
//   他说一句中文 → 从零写英文（分段）→ 卡住 → 点「给点提示」（三级台阶）→ 提交
//   → 挑一个教点 → 只标出一处「不地道」（不说为什么）→ 他自己再改一版
//   → 改完才揭开系统版 + 每处一句为什么 + 降难度两档 → 延迟重写队列
//
// ── 架构纪律（契约原文）──────────────────────────────────────────────────────
// **程序管流程/状态/界面；模型只管「提教点」与「改他写的」。**
// 本模块**不碰网络、不碰 DOM、不做任何模型调用**——`read`/`revise` 的结果由外面（`./index.mjs`）
// 交进来（`noteRead` / `noteIssue`）。这条分离就是"把大模型当引擎、而不是当产品"的落点：
// 旧形态里"模型决定教什么、怎么教、下一步做什么，程序只负责把文本贴到屏幕上"，
// 于是它答非所问、且**没有任何一处程序可以负责**。这里每一个状态转移都由本模块说了算。
//
// ── 五条**产品纪律**，每条都有断言（不是界面礼貌）──────────────────────────────
//   1. **改完才揭开**：`reveal()` 在他没 `reviseDraft` 之前返回 `null`。
//   2. **只许暴露一处不地道**：`noteIssue` 之后 `state().issue` 里**只有 quote 与 kind**；
//      系统版/为什么/降难度**一个都不许进 state**（它们只活在闭包里，等 `reveal()`）。
//   3. **接不住就说不接**：`canHelp===false` 时**什么候选都不给**（`candidates: []`，
//      `canHelp` 保持 false）；绝不替他编一个教点（编出来的那个"教点"会变成他要挑的东西）。
//   4. **三级台阶只升不降**：同一次提问里 1→2→3 单调；`category===null` 只到 1 级。
//   5. **没有候选时跳过"挑教点"这一步**（`pickTeachPoint(null)`）：`pickedKey` 保持 `null`，
//      但 `pickDecided` 变 true ⇒ ② 以 `pickedTeachPoint = null` 跑，只做"标出最值得改的一处"。
//      ⚠️ 跳过**不等于**接不住：`canHelp` 仍是 true，提示那一栏照给（两者混起来界面就没法分开说）。
//
// ── `REWRITE_INTERVALS_MS` 的数字是**凭空发明**的（如实登记）────────────────────
// 共识只写了"自适应"，**没有给数**（`DEC-…db.192` 第四处冻结明确要求"写成单一常量表 +
// 注释写明未标定"）。所以：一张常量表、一处定义、注释里写死"未标定"，并在报告里再写一遍。
// 规则（有断言）：全靠自己写出来的（`scaffoldLevel===0`）走 `self` 档，用过提示的走 `hinted` 档；
// **`hinted` 必须比 `self` 短**（刚被扶过的人更该趁热再写一遍，理由与代价写在常量旁）。
//
// 纯逻辑模块：零 import、零浏览器 API、零副作用（时间经 `now` 注入）——可在 Node 中直接测。
import { createEngine } from './engine.mjs';

/**
 * 这条循环的七个状态。**顺序就是循环的顺序**——`idle` 是入口也是出口（`done` 之后回 `idle`）。
 * 冻结：界面（视图层）按这些名字切屏，改名就是改契约。
 */
export const STEPS = ['idle', 'drafting', 'choosing', 'marked', 'revising', 'revealed', 'done'];

/**
 * 「卡在哪一类」的三个类目（1 级提示问的就是它）。
 * 与 `./prompt.mjs` 的 `hint.{word,structure,content}` **同一组**：三级台阶按类给内容，
 * 类目名对不上就等于 2/3 级永远取不到东西（有测试钉住这两处不许漂移）。
 */
export const HINT_CATEGORIES = ['word', 'structure', 'content'];

/**
 * 延迟重写间隔（毫秒）——⚠️ **未标定：数字是凭空发明的**，共识只写"自适应"没给数。
 *
 * 为什么是这个**形状**而不是这个**数**（形状有断言，数没有）：
 *   · `self`   —— 全靠自己写出来的那一版。隔久一点：它已经是他自己的东西，重写是复习不是抢救。
 *   · `hinted` —— 用过提示的那一版。**更短**（刚被扶过，趁热再写一遍才记得住）。
 * 规则落点：`scaffoldLevel === 0` ⇒ `self`；`scaffoldLevel > 0` ⇒ `hinted`（`./flow.mjs` 的 `enqueueRewrite`）。
 * 唯一的机械约束是 `hinted < self`（有断言）——**数本身没有任何证据支持**，
 * 真值只能由后续实弹（真实使用者的复现率）标定，本轮零计费、零实弹，标不了。
 */
export const REWRITE_INTERVALS_MS = Object.freeze({
  /** 12 小时：自己写出来的那一版，隔一夜。**未标定。** */
  self: 12 * 60 * 60 * 1000,
  /** 4 小时：用过提示的那一版，当天之内趁热。**未标定。** */
  hinted: 4 * 60 * 60 * 1000,
});

/** 版本副本上限：他每一版都留着（"从零写、一层层说好"的过程就是这些版本），但别让它无限长。 */
const MAX_VERSIONS = 30;
/** 单句导出上限 / 词表导出上限（导出是给人看的，不是数据库备份）。 */
const MAX_EXPORTED_SENTENCES = 50;
const MAX_EXPORTED_WORDS = 200;
/** 逐词释义进 state 的条数上限（与 `./parse.mjs` 的 MAX_GLOSSES 同量级）。 */
const MAX_STATE_GLOSSES = 30;
const QUEUE_STATUSES = new Set(['pending', 'done']);

/** 非空字符串才算"给了"。 */
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** 纯数组：不是数组时给空数组（导出/导入用，宁可少给也不编）。 */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** 非负有限数，否则 0（计数用；时钟坏掉不该让账变成 NaN）。 */
function num(v) {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 判 ① 的产物能不能用：形状对且 `canHelp` 是布尔。 */
function usableRead(read) {
  return read !== null && typeof read === 'object' && typeof read.canHelp === 'boolean';
}

/** 判 ② 的产物能不能用：形状对、`canTeach` 是布尔、且带得出系统版。 */
function usableRevise(revise) {
  return revise !== null && typeof revise === 'object'
    && typeof revise.canTeach === 'boolean'
    && typeof revise.system === 'string';
}

/**
 * 造这条循环的推进器。
 *
 * @param {object} [input]
 *   - `now`：时钟注入点（`Date.now` 形状）。本模块**只**用它——重写到期、会话 id、句子时间戳。
 *     不注入就在调用时取 `Date.now`（零浏览器 API 的写法与 `../recognize.mjs` 一致）。
 *   - `engine`：引擎注入点（测试可传一个"数了几次"的假引擎；缺省自己造一个）。
 *     本模块自己**不调用**它——`./index.mjs` 调，然后把结果交进来。留着它是为了让
 *     `resetRound()`（回合边界的计数清零）落在流程这一侧：**回合是流程的概念，不是引擎的**。
 * @returns {object} 见文件末尾的返回对象（`state`/`startSentence`/…/`importState`）
 */
export function createFlow({ now = null, engine = null } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const eng = engine ?? createEngine({ callModel: () => { throw new Error('createFlow: 未注入 engine'); } });

  let idSeq = 0;
  const nextId = () => {
    idSeq += 1;
    return `w-${clock()}-${idSeq}`;
  };

  /** 提交那一刻的计数基准（`./index.mjs` 用它算"这一回合花了多少"）。 */
  let roundStartCalls = eng.state().callsTotal;

  const blankRound = (extra = {}) => ({
    read: null,
    readReason: null,
    candidates: [],
    pickedKey: null,
    /**
     * 「挑教点这一步**走过了**」——`pickedKey === null` 有两种完全不同的意思，
     * 必须分开（这是本模块最容易错的一处判定）：
     *   · `pickDecided === false` ⇒ **还没挑**（② 不该跑，跑了就是拿一个没人提过的教点去改）；
     *   · `pickDecided === true && pickedKey === null` ⇒ **挑这一步被跳过了**，
     *     因为按可追溯过滤之后一个候选都没剩下（见 `./index.mjs` 的 `submit()`）。
     *     这时 ② 以 `pickedTeachPoint = null` 跑：它只做"标出最值得改的一处"。
     */
    pickDecided: false,
    issue: null,
    reviseReason: null,
    revisionDueAt: null,
    ...extra,
  });

  /** 全部状态都在这里。视图拿到的是它的**快照**（`state()`），不是它本身。 */
  let s = {
    sessionId: null,
    step: 'idle',
    chinese: '',
    material: null,
    draft: '',
    draftDirty: false,
    hintLevel: 0,
    hintCategory: null,
    categoriesUsed: [],
    categoryLevels: {},
    hintText: null,
    scaffoldLevel: 0,
    canHelp: null,
    versions: [],
    revealed: null,
    sentence: null,
    round: blankRound(),
    sentences: [],
    words: [],
    rewriteQueue: [],
    wordsAdded: 0,
  };

  /** 揭示那一刻才从闭包里放出来的东西（纪律 2：在此之前 `state()` 里一个字段都不许有）。 */
  let sealed = null;

  // ─────────────────────────── 读写状态 ───────────────────────────

  /** 对外快照：纯数据、深拷贝（视图改它不该影响流程）。 */
  const state = () => ({
    sessionId: s.sessionId,
    step: s.step,
    chinese: s.chinese,
    material: s.material,
    draft: s.draft,
    draftDirty: s.draftDirty,
    hintLevel: s.hintLevel,
    hintCategory: s.hintCategory,
    categoriesUsed: [...s.categoriesUsed],
    categoryLevels: { ...s.categoryLevels },
    hintText: s.hintText,
    scaffoldLevel: s.scaffoldLevel,
    canHelp: s.canHelp,
    readReason: s.round.readReason,
    reviseReason: s.round.reviseReason,
    candidates: s.round.candidates.map((tp) => ({ ...tp })),
    pickedKey: s.round.pickedKey,
    pickDecided: s.round.pickDecided,
    pickedTeachPoint: s.round.pickedKey === null
      ? null
      : { ...s.round.candidates.find((tp) => tp.key === s.round.pickedKey) },
    issue: s.round.issue === null ? null : { ...s.round.issue },
    versions: s.versions.map((v) => ({ ...v })),
    revealed: s.revealed === null
      ? null
      : {
        system: s.revealed.system,
        why: [...s.revealed.why],
        simpler: s.revealed.simpler === null
          ? null
          : { half: s.revealed.simpler.half, easy: s.revealed.simpler.easy },
        glosses: s.revealed.glosses.map((g) => ({ ...g })),
      },
    sentence: s.sentence === null ? null : { ...s.sentence },
    sentences: s.sentences.map((x) => ({ ...x })),
    words: s.words.map((w) => ({ ...w })),
    rewriteQueue: s.rewriteQueue.map((it) => ({ ...it })),
    wordsAdded: s.wordsAdded,
    callsThisRound: num(eng.state().callsThisRound),
  });

  // ─────────────────────────── 起一句 / 写草稿 ───────────────────────────

  /**
   * 起一句新的。（他给中文原话，或贴一段素材——两者都可以给，但至少要有一个非空。）
   * 上一句已经 `done` 时调用它是**正常路径**（循环的下一圈）；没 `done` 就调用会丢掉当前这一句，
   * 所以只有在 `idle` 或 `done` 时才真的重开，其余状态**原样不动地返回 `false`**。
   */
  function startSentence({ chinese, material = null } = {}) {
    if (s.step !== 'idle' && s.step !== 'done') return false;
    const zh = str(chinese);
    const mat = str(material);
    if (zh === null && mat === null) return false;

    eng.state().resetRound();
    roundStartCalls = eng.state().callsTotal;
    sealed = null;
    s = {
      ...s,
      sessionId: nextId(),
      step: 'drafting',
      chinese: zh === null ? '' : zh,
      material: mat,
      draft: '',
      draftDirty: false,
      hintLevel: 0,
      hintCategory: null,
      categoriesUsed: [],
      categoryLevels: {},
      hintText: null,
      scaffoldLevel: 0,
      canHelp: null,
      versions: [],
      revealed: null,
      sentence: null,
      round: blankRound(),
    };
    return true;
  }

  /**
   * 记录他当前这一版（分段写、边写边改都走它）。
   * `draftDirty` 标记"这一版与最后一次记版不同"——它决定提交时**要不要作废 ① 的缓存**
   * （提交前改了字还复用旧 ① 的话，模型读的就不是他真正交上来的那一版）。
   */
  function setDraft(text) {
    if (s.step !== 'drafting') return false;
    s.draft = typeof text === 'string' ? text : String(text ?? '');
    s.draftDirty = s.draft !== (s.versions.length === 0 ? '' : s.versions[s.versions.length - 1].text);
    return true;
  }

  // ─────────────────────────── 三级台阶 ───────────────────────────

  /** 提示是否可用：非空字符串才算"台阶上真的有东西"。 */
  const hasHint = (v) => typeof v === 'string' && v.trim() !== '';

  /** 某个类目某一级的内容；该类目没这一级时**回落到有内容的第一类**（有内容优先于类目精确）。 */
  function hintAt(level, category) {
    const hints = s.round.read?.hint;
    if (hints === null || hints === undefined) return null;
    const order = category !== null && HINT_CATEGORIES.includes(category)
      ? [category, ...HINT_CATEGORIES.filter((c) => c !== category)]
      : [...HINT_CATEGORIES];
    for (const c of order) {
      const v = hints[c]?.[level];
      if (hasHint(v)) return v;
    }
    return null;
  }

  /** 某个类目**最深**能到几级（0 = 一级都没有）。台阶能升多高由 ① 真的给了多少决定。 */
  function deepestTier(category) {
    const hints = s.round.read?.hint;
    if (hints === null || hints === undefined) return 0;
    const order = category !== null && HINT_CATEGORIES.includes(category)
      ? [category, ...HINT_CATEGORIES.filter((c) => c !== category)]
      : [...HINT_CATEGORIES];
    let best = 0;
    for (const c of order) {
      for (const level of [1, 2, 3]) if (hasHint(hints[c]?.[level]) && level > best) best = level;
    }
    return best;
  }

  /** 某个类目**自己**已经到过几级（0 = 这一类的台阶还没上过）。 */
  const levelOf = (cat) => num(s.categoryLevels[cat]);

  /**
   * 点「给点提示」。
   *
   * 台阶规则（**同一类目内只升不降**，1→2→3 单调）：
   *   · `category === null` ⇒ **只到 1 级**（他的意思正是"我还不知道卡在哪"，那就只问一句）；
   *   · 给类目 ⇒ 在这一类自己的台阶上往上走一级（没上过就是 1 级，问过 1 级就是 2 级…）；
   *   · 到 3 级封顶，**不换门再给一次答案**——换个类目重新从 1 级起是允许的（那是另一个角度
   *     的提示，不是同一个答案），但每个类目各只有三级，所以总共能拿到的帮助有上限。
   *
   * ⚠️ **台阶的内容来自 ①（"读这一版"）的产物，而 ① 是把草稿交进本模块的人负责发的**
   * （`./index.mjs` 的 `askHint` 会先 `ensureRead()` 再 `noteRead()`）。所以：
   *   · 本模块**自己不调模型**（零浏览器 API、零网络，见文件头）；
   *   · 本模块**也不判"要不要读"**——它只判"读了没有"（`s.round.read === null`）。
   *     把"要不要花这一次钱"放在流程层会多出一个判据来源，预算就说不清了。
   *
   * ⚠️ **1 级（`category === null`）零模型调用，而且不需要 ① 已经发生过**：
   * 它的全部内容就是"卡在哪一类？"这**一句问话**（界面上那三个类目按钮，`./write.view.mjs`
   * 的 `paintHintNotes`）——那不需要模型产一个字，所以它**不必**先有一次 ①。
   * 代价与口径一起写清楚：`askHint(null)` 回的 `text` **就是 `null`**（除问话外没有内容可给），
   * 界面照样只画那句问话。**2/3 级则必须有 ① 的产物**，而 ① 是把草稿交进本模块的人负责发的
   * （`./index.mjs` 的 `askHint` 会先 `ensureRead()` 再 `noteRead()`）——所以本模块里
   * "有类目、但还没读" ⇒ 如实回 `level 0`（那是接线错，不是"这个类目没提示"）。
   *
   * @returns {{level: 0|1|2|3, category: string|null, text: string|null}}
   *   `level: 0` = 这一步没给任何东西（还没起句 / 该类目还没有 ① 的产物 / 该类目到此为止），
   *   `text: null` 且**不是**编出来的内容——界面据此显示"这一类暂时没有更多提示"。
   */
  function askHint(category = null) {
    const cat = HINT_CATEGORIES.includes(category) ? category : null;
    if (s.step !== 'drafting') return { level: 0, category: cat, text: null };

    // 1 级：只问一句"卡在哪一类"，**零模型调用、零 ① 依赖**（内容就是那句问话本身）。
    if (cat === null) {
      s.hintLevel = 1;
      s.hintCategory = null;
      s.hintText = null;
      if (s.scaffoldLevel < 1) s.scaffoldLevel = 1;
      return { level: 1, category: null, text: null };
    }

    if (s.round.read === null || s.round.read.canHelp !== true) {
      return { level: 0, category: cat, text: null };
    }

    const next = Math.min(levelOf(cat) + 1, 3);
    if (next <= levelOf(cat)) {
      // 这一类已经到顶：如实回它现在在哪一级，**不再给新东西**（也不换门偷偷给）。
      return { level: levelOf(cat), category: cat, text: hintAt(levelOf(cat), cat) };
    }

    const text = hintAt(next, cat);
    if (!hasHint(text)) return { level: 0, category: cat, text: null };

    s.hintLevel = next;
    s.hintCategory = cat;
    s.hintText = text;
    s.categoryLevels[cat] = next;
    if (!s.categoriesUsed.includes(cat)) s.categoriesUsed.push(cat);
    // 脚手架深度 = 他得到过的**最高**一级（0..3）。它决定延迟重写走哪一档（REWRITE_INTERVALS_MS）。
    if (next > s.scaffoldLevel) s.scaffoldLevel = next;
    return { level: next, category: cat, text };
  }

  // ─────────────────────────── 交进 ① 的结果 ───────────────────────────

  /**
   * 交进 `engine.read` 的结果（含候选）。
   *
   * **接不住就说不接**：`canHelp === false` ⇒ 候选**一个都不留**（`candidates: []`），
   * `canHelp` 保持 false、`readReason` 原样留着。程序**绝不补一个教点**给他挑——
   * 那正是旧形态"做了假选择"的翻版：他以为自己在挑，其实挑的是程序编的。
   *
   * ⚠️ **`teachPoints: []` 与"接不住"是两件事**（本模块按 `canHelp` 分流，不看候选数）：
   * 草稿还是空的、**这一版里没有能逐字锚住的英文（w3 第三条道：`q`/纯数字/中文写进了
   * 英文框——模型会给一句中文 reason，`readReason` 原样留着给界面）**、或按可追溯过滤之后
   * 一个都没剩下时，`canHelp` 仍然是 `true`（提示那一栏照给），只是**没有可挑的教点**
   * ⇒ `pickTeachPoint(null)` 跳过挑这一步。
   * 把这两种情况混成一种，界面就没法把"它接不住"与"这一步跳过了"分开说。
   *
   * 同一份结果重复交进来是**幂等**的（缓存复用路径会这么走），但已经挑过教点之后
   * 再换一份读结果是拒绝的（那会让"他挑中的那个"指向不存在的候选）。
   *
   * @returns {boolean} 这份读结果被接受了吗
   */
  function noteRead(read) {
    if (!usableRead(read)) return false;
    if (s.step !== 'drafting') return false;
    if (s.round.pickDecided) return false;

    const canHelp = read.canHelp === true;
    const teachPoints = canHelp ? arr(read.teachPoints) : [];
    s.round = blankRound({
      read,
      readReason: str(read.reason),
      candidates: teachPoints,
    });
    s.canHelp = canHelp;
    return true;
  }

  // ─────────────────────────── 挑教点（插在提交与标出之间）───────────────────────────

  /** 教点候选（`noteRead` 之后才有；接不住时恒为空数组）。 */
  const candidates = () => s.round.candidates.map((tp) => ({ ...tp }));

  /**
   * 挑一个教点。挑中的 `key` **必须真的在候选里**——不在就拒绝（返回 `false`），
   * 不把界面传来的任意字符串当成一个教点（那样 ② 会拿一个没人提过的教点去改）。
   *
   * **`key === null` 是"跳过挑这一步"，不是"挑了空的"**：它只在**候选本来就空**时合法
   * （按可追溯过滤之后一个不剩，见 `./index.mjs` 的 `submit()`）。这时 `pickedKey` 保持
   * `null`，但 `pickDecided` 变成 `true` ⇒ ② 可以以 `pickedTeachPoint = null` 跑。
   * 候选非空时传 `null` 一律拒绝：那等于"没挑就开跑"，而他明明有东西可挑。
   *
   * @returns {boolean} 这一步走过了吗
   */
  function pickTeachPoint(key) {
    if (s.step !== 'drafting' || s.round.read === null) return false;
    if (s.round.pickDecided) return false; // 这一版只挑一次
    if (key === null) {
      if (s.round.candidates.length > 0) return false;
      s.round.pickDecided = true;
      s.step = 'choosing';
      return true;
    }
    if (typeof key !== 'string' || !s.round.candidates.some((tp) => tp.key === key)) return false;
    s.round.pickedKey = key;
    s.round.pickDecided = true;
    s.step = 'choosing';
    return true;
  }

  // ─────────────────────────── 交进 ② 的结果（只许暴露一处）───────────────────────────

  /**
   * 交进 `engine.revise` 的结果。
   *
   * **此时只许暴露 `issue`（一处 quote + kind）**：`system` / `why` / `simpler` / `glosses`
   * 一个都不进 state——它们被封在闭包的 `sealed` 里，等 `reveal()` 才放出来。
   * 这是产品纪律（"改完才给系统版 + 为什么"），不是界面礼貌，所以它落在这里而不是视图里。
   *
   * `canTeach === false` ⇒ `issue` 为 null、`reviseReason` 原样透出、**不补任何内容**。
   *
   * @returns {{quote: string, kind: string|null}|null} 标出来的那一处（标不出时 null）
   */
  function noteIssue(revise) {
    if (!usableRevise(revise)) return null;
    // 幂等**必须排在阶段判定之前**：第一份结果应用之后状态已经是 `marked`，
    // 若先判 `step !== 'choosing'`，同一份结果再交一次会被当成"阶段不对"而返回 null——
    // 那会让 `./index.mjs` 的缓存复用路径（同一份 ② 结果交两次）拿不到那一处标记。
    if (s.round.issue !== null) return { ...s.round.issue };
    // 闸门判的是 **`pickDecided`**（挑这一步走过了），不是 `pickedKey !== null`：
    // 挑教点被跳过的路径上 `pickedKey` 本来就是 null（没有候选可挑），
    // 若拿它当闸门，那条路径上的 ② 结果会被静默丢掉——界面上就是"标不出来"。
    if (s.step !== 'choosing' || !s.round.pickDecided) return null;

    if (revise.canTeach !== true) {
      sealed = null;
      s.round.reviseReason = str(revise.reason);
      s.step = 'marked';
      return null;
    }

    const issue = revise.issue !== null && typeof revise.issue === 'object'
      ? { quote: str(revise.issue.quote) ?? '', kind: str(revise.issue.kind) }
      : { quote: '', kind: null };
    sealed = {
      system: revise.system,
      why: arr(revise.why).filter((x) => hasHint(x)),
      simpler: revise.simpler === null || revise.simpler === undefined
        ? null
        : { half: str(revise.simpler.half), easy: str(revise.simpler.easy) },
      glosses: arr(revise.glosses)
        .filter((g) => g !== null && typeof g === 'object' && hasHint(g.word))
        .slice(0, MAX_STATE_GLOSSES)
        .map((g) => ({ word: g.word, pos: str(g.pos), zh: str(g.zh) ?? '' })),
    };
    s.round.issue = issue;
    s.step = 'marked';
    return { ...issue };
  }

  // ─────────────────────────── 他自己再改一版 → 改完才揭开 ───────────────────────────

  /** 记下他自己改的这一版。**记了才算"改过"**——`reveal()` 的闸门就是它。 */
  function reviseDraft(text) {
    if (s.step !== 'marked') return false;
    const next = typeof text === 'string' ? text : '';
    s.versions.push({ n: s.versions.length + 1, text: next, at: clock() });
    if (s.versions.length > MAX_VERSIONS) s.versions = s.versions.slice(-MAX_VERSIONS);
    s.draft = next;
    s.draftDirty = false; // 这一版就是"他改出来的那一版"，已经记进 versions
    s.step = 'revising';
    return true;
  }

  /**
   * 揭开系统版 —— **他没 `reviseDraft` 之前必须返回 `null`**。
   *
   * 这条闸门是产品纪律的落点（"改完才给答案"）：学习发生在检索，不在接收。
   * 提前揭开 = 把这份练习直接作废。所以它判的是**流程状态**（`revising` 这一步有没有走到），
   * 而不是"界面按钮是不是灰的"。
   *
   * @returns {{system: string, why: string[], simpler: object|null, glosses: object[]}|null}
   */
  function reveal() {
    // 幂等：已经揭开过就直接给同一份。**这一条必须排在阶段判定之前**——
    // `enqueueRewrite()` 会把阶段推到 `done`（一轮走完），若先判阶段，界面重绘时再揭一次
    // 就会拿到 null，答案在屏幕上凭空消失。
    if (s.revealed !== null) {
      return {
        system: s.revealed.system,
        why: [...s.revealed.why],
        simpler: s.revealed.simpler === null ? null : { ...s.revealed.simpler },
        glosses: s.revealed.glosses.map((g) => ({ ...g })),
      };
    }
    if (s.step !== 'revising') return null;
    if (sealed === null) return null;

    const out = {
      system: sealed.system,
      why: [...sealed.why],
      simpler: sealed.simpler === null ? null : { ...sealed.simpler },
      glosses: sealed.glosses.map((g) => ({ ...g })),
    };
    s.revealed = out;
    s.step = 'revealed';
    return {
      system: out.system,
      why: [...out.why],
      simpler: out.simpler === null ? null : { ...out.simpler },
      glosses: out.glosses.map((g) => ({ ...g })),
    };
  }

  // ─────────────────────────── 收录词卡 ───────────────────────────

  /** 词表里找一条（大小写不敏感；模型给的 `Yesterday` 与他点的 `yesterday` 是同一个词）。 */
  const findWord = (word) => s.words.find((w) => w.word.toLowerCase() === word.toLowerCase()) ?? null;

  /** 净化一条释义（进 state 前最后一道；导出/导入也复用）。 */
  const cleanGloss = (g) => ({
    word: str(g?.word) ?? '',
    pos: str(g?.pos),
    zh: str(g?.zh) ?? '',
  });

  /**
   * 收录一个词（屏上点词 → 词卡 → 收录）。
   * **有释义就带上，没有就如实留空**（`hasGloss:false`）——绝不为了"看起来完整"编一个中文意思。
   * 重复收录是幂等的（返回同一条），并如实报 `added:false`。
   *
   * @returns {{word: string, zh: string|null, pos: string|null, hasGloss: boolean, added: boolean}|null}
   */
  function addWord(word) {
    const w = str(word);
    if (w === null) return null;
    const key = w.trim();

    const existing = findWord(key);
    if (existing !== null) {
      return {
        word: existing.word,
        zh: str(existing.zh),
        pos: str(existing.pos),
        hasGloss: str(existing.zh) !== null,
        added: false,
      };
    }

    const gloss = sealed === null
      ? null
      : sealed.glosses.find((g) => g.word.toLowerCase() === key.toLowerCase()) ?? null;
    const record = { word: key, zh: gloss?.zh ?? null, pos: gloss?.pos ?? null };
    s.words.push(record);
    s.wordsAdded += 1;
    return {
      word: record.word,
      zh: record.zh,
      pos: record.pos,
      hasGloss: record.zh !== null,
      added: true,
    };
  }

  // ─────────────────────────── 延迟重写队列 ───────────────────────────

  /** 收尾一个回合：入队 + 落一句记录 + 回 idle（会话 id 清掉：下一次是新的一圈）。 */
  function enqueueRewrite() {
    const hinted = s.scaffoldLevel > 0;
    const interval = hinted ? REWRITE_INTERVALS_MS.hinted : REWRITE_INTERVALS_MS.self;
    const at = clock();
    const item = {
      id: `${s.sessionId}-rw`,
      sessionId: s.sessionId,
      dueAt: at + interval,
      intervalMs: interval,
      hinted,
      scaffoldLevel: s.scaffoldLevel,
      status: 'pending',
    };
    s.rewriteQueue.push(item);
    s.sentence = {
      id: s.sessionId,
      zh: s.chinese,
      material: s.material,
      draft: s.draft,
      scaffoldLevel: s.scaffoldLevel,
      hinted,
      revealed: s.revealed === null ? null : { system: s.revealed.system, why: [...s.revealed.why] },
      at,
    };
    s.sentences.push(s.sentence);
    s.step = 'done';
    s.sessionId = null;
    return item;
  }

  /** 到期的待重写项（`dueAt <= now` 且还没做）。**不改状态**——它只是把到期的东西报出来。 */
  function dueNow() {
    const t = clock();
    return s.rewriteQueue
      .filter((it) => it.status === 'pending' && it.dueAt <= t)
      .map((it) => ({ ...it }));
  }

  /** 记下他重写完了（队列项转 `done`，不再到期）。 */
  function noteRewriteDone(id) {
    const it = s.rewriteQueue.find((x) => x.id === id);
    if (it === undefined) return false;
    it.status = 'done';
    it.doneAt = clock();
    return true;
  }

  // ─────────────────────────── 两件事由外面推 ───────────────────────────

  /**
   * 交进 ② 的结果并把状态推到 `marked`——它是 `./index.mjs` 在 `engine.revise` 返回后走的**唯一**一步。
   * （单独一个名字是为了让"② 的结果怎么进流程"只有一个入口点，而不是让 facade 自己改 step。）
   */
  function markFromRevise(revise) {
    return noteIssue(revise);
  }

  /** 回合边界的计数基准（`./index.mjs` 用它算这一回合花了多少）。 */
  const roundCallsBaseline = () => roundStartCalls;

  // ─────────────────────────── 导出 / 导入 ───────────────────────────

  /** 导出（纯数据，可直接 `JSON.stringify`）。只带"值得留下的"：句子、词、重写队列。 */
  function exportState() {
    return {
      version: 1,
      sentences: s.sentences.slice(-MAX_EXPORTED_SENTENCES).map((x) => ({
        id: x.id,
        zh: x.zh,
        material: x.material,
        draft: x.draft,
        scaffoldLevel: x.scaffoldLevel,
        hinted: x.hinted,
        revealed: x.revealed === null ? null : { system: x.revealed.system, why: [...x.revealed.why] },
        at: x.at,
      })),
      words: s.words.slice(-MAX_EXPORTED_WORDS).map((w) => ({ ...w })),
      rewriteQueue: s.rewriteQueue.map((it) => ({ ...it })),
    };
  }

  /**
   * 导入。**宽进严出**：坏条目丢掉、坏整份返回 `false`，绝不因为一份坏数据把流程炸掉
   * （与 `./store.mjs` 的"读路径安全回退"同一条纪律）。
   */
  function importState(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (obj.version !== 1) return false;

    s.sentences = arr(obj.sentences)
      .filter((x) => x !== null && typeof x === 'object' && str(x.zh) !== null && typeof x.draft === 'string')
      .slice(-MAX_EXPORTED_SENTENCES)
      .map((x) => ({
        id: str(x.id) ?? nextId(),
        zh: str(x.zh),
        material: str(x.material),
        draft: x.draft,
        scaffoldLevel: num(x.scaffoldLevel),
        hinted: x.hinted === true,
        revealed: x.revealed !== null && typeof x.revealed === 'object' && typeof x.revealed.system === 'string'
          ? { system: x.revealed.system, why: arr(x.revealed.why).filter((w) => hasHint(w)) }
          : null,
        at: Number.isFinite(x.at) ? x.at : null,
      }));

    s.words = arr(obj.words)
      .filter((w) => w !== null && typeof w === 'object' && str(w.word) !== null)
      .slice(-MAX_EXPORTED_WORDS)
      .map((w) => {
        const g = cleanGloss(w);
        return { word: g.word, zh: g.zh === '' ? null : g.zh, pos: g.pos };
      });

    s.rewriteQueue = arr(obj.rewriteQueue)
      .filter((it) => it !== null && typeof it === 'object'
        && typeof it.id === 'string' && Number.isFinite(it.dueAt))
      .map((it) => ({
        ...it,
        status: QUEUE_STATUSES.has(it.status) ? it.status : 'pending',
      }));

    return true;
  }

  return {
    // 读
    state,
    candidates,
    dueNow,
    exportState,
    roundCallsBaseline,
    // 推
    startSentence,
    setDraft,
    askHint,
    noteRead,
    pickTeachPoint,
    noteIssue,
    reviseDraft,
    reveal,
    addWord,
    noteRewriteDone,
    markFromRevise,
    importState,
    // 内部（`./index.mjs` 用；不写进任务书的冻结签名里，只是流程自己的尾巴）
    enqueueRewrite,
  };
}
