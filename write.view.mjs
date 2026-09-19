// web/write.view.mjs
//
// 「今天的一句」的**渲染层**：把一份状态快照（纯数据）画成一条不断长的稿纸。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 职责边界（硬）
// ═══════════════════════════════════════════════════════════════════════════════
// 本文件**不做任何教学判断，也不做任何流程判断**：
//   · 教什么、标哪一处、为什么 —— 全部来自门面（`web/units/write/index.mjs`）的返回值；
//   · 什么时候能揭开系统版 —— 由门面 `reveal()` 的返回值决定，本文件只认
//     `snapshot.revealed === true` 这一个信号（见下面「三条不许提前」）；
//   · 下一步是哪一屏 —— 由装配层（`web/write.mjs`）按"门面刚刚真的回了什么"决定，
//     本文件只按 `snapshot.step` 画。
// 本文件唯一的局部职责是：**把快照画出来** + 把点击翻译成 `handlers.on(名字, 载荷)`。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 三条「不许提前」（产品纪律，每一条都有测试钉住）
// ═══════════════════════════════════════════════════════════════════════════════
// ① **`revealed !== true` 时，`system` / `why` / `simpler` 一个字都不许上屏。**
//    `reveal()` 在他没再改一版之前返回 `null` —— 界面必须拿它当信号。
//    实现上是**两个独立条件**（`revealed === true` **且** `system` 是非空字符串），
//    任何一个不成立就整段不建节点 —— 空断言（"不该出现的没出现"因为功能没跑而通过）
//    在这里被这一对条件挡住：测试有一条正向控制专门喂 revealed+system 断言它**出现**。
// ② **`snapshot.issueOpen !== true` 时不许出现"为什么"**，只许有一条波浪线。
//    「标出来、不说，点开才说」——点开之后也只说**类别**（`issue.kind`），
//    真正的"为什么"仍然锁在 ① 后面。
// ③ **`snapshot.fail` 存在时不许出现任何候选 / 教点 / 系统版**。
//    「这次接不住」就只是接不住 + `reason`，绝不编内容、绝不拿假数据顶上。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 快照的形状（本文件唯一的输入；装配层负责把门面的产物翻译成它）
// ═══════════════════════════════════════════════════════════════════════════════
//   step         'source'|'draft'|'choose'|'marked'|'revise'|'reveal'|'rewrite'
//   chinese      string   他说的那句中文（出处）
//   material     string   他贴的素材（可空）
//   sourceInput  string   「说一句」那一步输入框里的当前值
//   draftSegs    string[] 正在写的那一版，**一段一格**（手机打长句很痛）
//   reviseSegs   string[] 再改那一版，同样分段
//   version1     string|null 他提交的第一版（提交成功之后才有）
//   version2     string|null 他改完的那一版
//   hint         null|{level:1|2|3, category, text}
//   hintOpen     boolean  类别还没选（1 级只问「卡在哪类」）
//   hintCats     string[] 还能问哪几类（到顶了就空）
//   candidates   null|[{key,label,quote,kind}]
//   picked       null|{key,label,quote,kind}
//   issue        null|{quote,kind}
//   issueOpen    boolean
//   revealed     boolean  只有 reveal() 返回过非 null 才是 true
//   system       null|string
//   why          string[]
//   simpler      null|{half,easy}
//   glosses      [{word,pos,zh}]
//   card         null|{key,surface,pos,zh,hasGloss,block,lex}
//                `lex` = 词库那条规范词条（`web/units/lexicon.mjs` 的产物）或 `null`；
//                有 `lex` 时**以它为主源**，`pos`/`zh` 只在词库没有这一条时兜底。
//   mineSentences [{zh,en}]
//   myWords      string[]
//   due          [{en,when}]
//   cost         {calls,promptTokens,completionTokens,latencyMsTotal}
//   fail         null|{reason}
//   failHint     null|string  失败底下那句**"下一步怎么办"**（D2：本回合不再自动重读 ⇒
//                            要再读只能他主动点「给点提示」。这一句就是那个动作的可见化）
//   notice       null|string
//   busy         boolean
//   fold         null|'s'|'w'|'due'
//   keyMissing   boolean
//   engineMissing null|string
//
// ═══════════════════════════════════════════════════════════════════════════════
// 为什么只用 `createElement` / `append` / `replaceChildren` / `setAttribute`
// ═══════════════════════════════════════════════════════════════════════════════
// `tests/helpers/dom.mjs` 的假 DOM 只认这几个（**没有** `innerHTML` / `querySelector` /
// `dataset` / `classList` / `style`），而本仓的口径是 mount 测试**不引 jsdom**。
// 于是本文件全程只用那一小片 API —— 换来的好处是：这一层能在 Node 里被逐屏挂起来断言，
// 而"页面到底长什么样"由真浏览器探针（`tmp/probes/write-ui-check.mjs`）负责。

/** 七步。顺序即流程；`data-step` 写的就是这里面的一个值。 */
export const STEPS = Object.freeze(['source', 'draft', 'choose', 'marked', 'revise', 'reveal', 'rewrite']);

/** 每一步在屏上的小标签（人要看得见"现在在哪儿"）。 */
export const STEP_LABELS = Object.freeze({
  source: '说一句',
  draft: '从零写',
  choose: '挑教点',
  marked: '看标记',
  revise: '再改一版',
  reveal: '看系统版',
  rewrite: '过几天再写',
});

/**
 * 提示的三个类别 —— 与门面 `askHint(category)` 的取值**逐字对齐**。
 * 这三项就是「1 级只问『卡在哪类』」里的"类"。
 * （口径来自引擎侧 `units/write/parse.mjs` 的 `hint: {word, structure, content}` 三槽。）
 */
export const HINT_CATEGORIES = Object.freeze([
  { key: 'word', label: '词' },
  { key: 'structure', label: '结构' },
  { key: 'content', label: '内容' },
]);

/**
 * 「你靠了多大力」的**离散四档**（纪律 ④：不是进度条、不是分数）。
 * 文字在 CSS 里按 `[data-effort]` 挂（`.eff[data-effort='2']::after`），
 * 这里只导出**取值域**给测试与装配层用 —— 档位只有这四个，多一个都不许。
 */
export const EFFORT_LEVELS = Object.freeze(['0', '1', '2', '3']);

/** 靠了多大力 → `data-effort` 的值。**只由提示台阶决定**（`hint.level`），与点击数无关。 */
export function effortOf(snapshot) {
  const lv = snapshot?.hint?.level;
  return lv === 1 || lv === 2 || lv === 3 ? String(lv) : '0';
}

/** 分段拼回一整版。空段丢掉、每段剪空白、用**一个空格**连 —— 拼法只有这一处定义。 */
export function segmentsToText(segs) {
  if (!Array.isArray(segs)) return '';
  return segs.map((s) => String(s ?? '').trim()).filter((s) => s !== '').join(' ');
}

/**
 * 一整版拆回分段（刷新/导入之后要能接着分段编辑）。**按句末标点断**——
 * 这是他打字时的自然分段（"Nothing special today." / "I had class …"），
 * 不是语言学意义上的切分。切不出来就给一段（宁可一段长，不许把句子切坏）。
 */
export function textToSegments(text) {
  const t = String(text ?? '').trim();
  if (t === '') return [];
  const parts = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s !== '');
  return parts.length > 0 ? parts : [t];
}

/**
 * 一个词的**查词键**：小写、只留字母与撇号。
 * 屏上显示的是原样（`Classes` 就显示 `Classes`），送去查的是键。
 * ⚠️ 这条归一只有这一处定义：装配层调用 `wordCard(key)` / `addWord(key)` 用的就是它。
 */
export function wordKey(surface) {
  return String(surface ?? '').toLowerCase().replace(/[^a-z']/g, '');
}

/** 空白快照：所有字段都在，且都是"还没有"的诚实取值。 */
export function emptySnapshot(over = {}) {
  return {
    step: 'source',
    chinese: '',
    material: '',
    sourceInput: '',
    materialInput: '',
    keyInput: '',
    keyError: '',
    draftSegs: [''],
    reviseSegs: [''],
    version1: null,
    version2: null,
    hint: null,
    hintOpen: false,
    hintCats: HINT_CATEGORIES.map((c) => c.key),
    candidates: null,
    picked: null,
    issue: null,
    issueOpen: false,
    revealed: false,
    system: null,
    why: [],
    simpler: null,
    glosses: [],
    card: null,
    mineSentences: [],
    myWords: [],
    due: [],
    cost: { calls: 0, promptTokens: 0, completionTokens: 0, latencyMsTotal: 0 },
    fail: null,
    failHint: null,
    notice: null,
    busy: false,
    fold: null,
    keyMissing: false,
    engineMissing: null,
    /**
     * 三条持久化清单（我的句子 / 我的词 / 待重写）有没有真的从引擎拿到。
     * ⚠️ 这一位是**为了不许把"没拿到"画成"还没有"**：`state()` 的形状由引擎定，
     * 装配层按一份**约定字段名**去认；认不出时这里是 `false`，三个折叠体如实说
     * 「这一项还没从引擎拿到」，而不是摆一句"还没有"（那是把不知道说成知道）。
     *
     * **缺省是 `false`**（"还没读过"）。这一位由装配层在**真的读过 `state()` 之后**改写。
     * 缺省 `true` 会造出下面这种假绿（本项目实测踩过一次）：装配层漏读了清单，
     * 而屏上照样写「还没有」——画面对、数字对、**事实错**。
     */
    engineListsOk: false,
    ...over,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   造节点的小工具（只用假 DOM 认识的那几个方法）
   ───────────────────────────────────────────────────────────────────────────── */

function assertRoot(root) {
  if (root === null || root === undefined || typeof root.replaceChildren !== 'function') {
    throw new TypeError('renderWrite: 需要传入一个容器元素（web/write.html 里的 #app）');
  }
}

/**
 * 造一个元素。
 * ⚠️ `className` 只在它是**非空字符串**时才写：`node.className = null` 在真浏览器里
 * 会变成字面量 `"null"` 这个类名（假 DOM 看不出来，真浏览器里一眼就坏）。
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (typeof className === 'string' && className !== '') node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * 造一个按钮。`act` 是给探针/测试用的机械钩子（`data-act`），
 * 但**判据不用它**：本仓的 mount 测试按**按钮文案**精确匹配（全仓 `querySelector` 0 次）。
 */
function button(doc, label, className, onClick, act) {
  const b = el(doc, 'button', className, label);
  b.setAttribute('type', 'button');
  if (act !== undefined) b.setAttribute('data-act', act);
  b.addEventListener('click', onClick);
  return b;
}

/** 调用事件出口。`on` 缺省是空函数 —— 于是"只画不接"也是合法用法（走查台/测试）。 */
const caller = (on) => (typeof on === 'function' ? on : () => {});

/* ─────────────────────────────────────────────────────────────────────────────
   逐词可点：屏上**每一段英文的每一个词**都是一个按钮
   ─────────────────────────────────────────────────────────────────────────────
   纪律 ⑤「屏上英文全部可点」。这里的"全部"是**字面意思**：句子、候选引文、被标出的
   那一处、系统版、两个降档版、逐词释义、队列里的句子、我的句子 —— 一个不漏。
   查不到释义**不是**不可点的理由：点开之后如实显示「没查到」（`.wc-miss`）。
   释义的来源已从"模型临时吐的那几条"换成**词库**（ECDICT）：点开先查词库，
   查到就以它为主源（音标/词性/柯林斯/牛津/考纲/词频/变形），查不到才退回引擎那条释义、
   两边都没有就如实说「词典里没查到」。**点词不新增任何模型调用**（成本纪律：一个回合 ≤2 次）。
   （上一版原型把无卡词降级成不可点的纯文本并打了 `data-uncarded` 标记；那一手在
   `flow.html` 里成立是因为它的判据是"面板区 `data-uncarded` 必须为 0"，而本任务书的
   纪律 ⑤ 要的是**没有例外**，所以这里改成"全都可点、没查到就说没查到"。）

   引文标记：`flag` 给了就把它在 `text` 里的**那一段**包进 `span.flag`（一条波浪线）。
   按**字符区间**做，不按"第几个词"——引文里可能有标点、可能是多词短语。
   ───────────────────────────────────────────────────────────────────────────── */
function appendEnglish(doc, host, text, opts) {
  const { onWord, block, flag = null, cardKey = null } = opts;
  const src = String(text ?? '');
  const start = flag === null ? -1 : src.indexOf(flag);
  const end = start < 0 ? -1 : start + flag.length;

  let wrap = null;
  let at = 0;
  for (const chunk of src.split(/(\s+)/)) {
    const from = at;
    const to = at + chunk.length;
    at = to;
    if (chunk === '') continue;

    const inside = start >= 0 && from >= start && to <= end;
    if (inside && wrap === null) {
      wrap = el(doc, 'span', 'flag');
      host.append(wrap);
    }
    if (!inside && wrap !== null) {
      wrap = null;
    }
    const target = wrap ?? host;

    const key = wordKey(chunk);
    if (key === '') {
      target.append(el(doc, 'span', '', chunk)); // 纯标点 / 空白：不是词
      continue;
    }
    const b = el(doc, 'button', 'w', chunk);
    b.setAttribute('type', 'button');
    b.setAttribute('data-w', key);
    if (cardKey !== null && cardKey === key) b.setAttribute('aria-expanded', 'true');
    b.addEventListener('click', () => onWord(key, chunk, block));
    target.append(b);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   若干个可复用的段落
   ───────────────────────────────────────────────────────────────────────────── */

/** 页眉：品牌标记 + 字标。 */
function mast(doc) {
  const h = el(doc, 'header', 'mast');
  const mark = el(doc, 'span', 'bmk');
  mark.setAttribute('aria-hidden', 'true');
  h.append(mark, el(doc, 'span', 'wordmark', '今天的一句'));
  return h;
}

const hair = (doc) => el(doc, 'hr', 'hair');
const tab = (doc, text) => el(doc, 'span', 'tab', text);

/**
 * 一段英文（衬线大字）。
 *
 * `opts.state` 只给**同一句的两个版本**用：`'old'`（被取代的那一版，划掉淡出）与
 * `'new'`（新那一版）。**系统版 / 降档版 / 队列里的句子都不是"版本"**，一律不传 ——
 * 否则 `is-new` 会挂在三四个地方，"哪一版是被改写出来的"这件事在 DOM 上就分辨不出来了。
 * `opts.anim` 只在**改写发生的那一次重画**为真（`snapshot.anim`）。
 */
function enBlock(doc, text, opts) {
  const base = opts.enClass ?? 'en';
  const state = opts.state === 'old' || opts.state === 'new' ? ` is-${opts.state}` : '';
  const anim = opts.anim === true && state !== '' ? ' rw-anim' : '';
  const p = el(doc, 'p', `${base}${state}${anim}`);
  appendEnglish(doc, p, text, opts);
  return p;
}

/**
 * 元信息那一行：音标 · 词性 · 柯林斯星级 · 牛津3000 · 考纲 · 词频档。
 *
 * ⚠️ **整条是「一个元素 + 文本分隔符」，不是七个子元素。**
 *   这一条看着像排版偏好，实际是被门量出来的：G3 的「≤13px 的小字 ≤7 处」是
 *   **逐文本元素**数的，与折不折行无关。把每一项做成 `<span>` 子元素时实测
 *   小字 15 处（门红）；改成"一个元素 + 文本 `·` 分隔"之后 8 处。
 *   每个字段**仍带一小段自己的标记类**（如 `pos` / `牛津3000` / `词频 极高`），
 *   探针与门照样能逐项读，不靠子元素。
 */
function metaLine(doc, lex) {
  const bits = [];
  if (typeof lex.phonetic === 'string' && lex.phonetic !== '') bits.push(`/${lex.phonetic}/`);
  if (typeof lex.pos === 'string' && lex.pos !== '') bits.push(lex.pos);
  if (lex.collinsStars !== null) bits.push(lex.collinsStars);
  if (lex.oxford === true) bits.push('· 牛津3000');
  for (const t of lex.tagLabels ?? []) bits.push(`· ${t}`);
  if (lex.frequency !== null) bits.push(`· 词频 ${lex.frequency.label}`);
  return bits.length === 0 ? null : el(doc, 'span', 'wc-meta', bits.join(' '));
}

/**
 * 词卡：一个脚注（零容器）。**主源是词库**（ECDICT，见 `web/units/lexicon.mjs`）。
 *
 * 卡上有三行（`card.lex` 有值时才画）：
 *   ① 词头 + **一行元信息**（音标 · 词性 · 柯林斯星级 · 牛津3000 · 考纲 · 词频档）
 *   ② 中文释义（主角，`--t-2`）
 *   ③ 一行注：**变形**（有就写）+ **例句与搭配：暂缺**（恒定，见下）
 *
 * **英文释义不上卡**（词库里仍然带着它，见 `lex.en`）：ECDICT 的 `en` 是 Wiktionary 抄来的
 * 整段，实测大量条目只有词性标记（`n.`）或混着词源；把它挤进一张手机上读的脚注，
 * 收益小于它占掉的那一行。要读英文释义的场合是查词工具，不是"屏上点一下"。
 *
 * 卡上**没有**什么，以及为什么：
 *   · **例句与搭配：源数据里就没有**（ECDICT 的 `detail` 列是空的）⇒ 如实写「暂缺」，
 *     **不许编**。这一栏**恒定存在**（不是"查到了才有"），为的是让人一眼看见
 *     "这两样现在没有"，而不是以为产品把它们藏起来了。
 *   · **发音**不由词库提供（源 `audio` 列也是空的）⇒ 继续用浏览器自带的 `speechSynthesis`
 *     （那颗「听一下」的按钮，本地、免费、零外部资源）。
 * 查不到的两种情形**分开说**（把"不知道"说成"知道"是本项目最怕的错）：
 *   · 词库里有这一条 ⇒ 按上面四行画；
 *   · 词库里**根本没这一条** ⇒ 如实说「词典里没查到」；
 *   · **取片失败** ⇒ 也说「没查到」，但下面那句是「这次没能取到词库：…」——
 *     "取不到"与"没有这个词"是两件事。
 */
function wordCard(doc, card, handlers) {
  const wrap = el(doc, 'div', 'cardwrap');
  wrap.setAttribute('data-layer', 'card');
  wrap.setAttribute('data-card-for', card.key);

  const box = el(doc, 'span', 'wc');
  box.append(el(doc, 'b', 'wc-w', card.surface));

  const lex = card.lex ?? null;
  if (lex !== null) {
    wrap.setAttribute('data-card-source', 'lexicon');
    const meta = metaLine(doc, lex);
    if (meta !== null) box.append(meta);

    // 中文释义是这张卡的**主角**（跟词头同一档字号）。
    if (typeof lex.zh === 'string' && lex.zh !== '') box.append(el(doc, 'span', 'wc-zh', lex.zh));

    // 最后一行：**变形**（有就写）**+ 「例句与搭配：暂缺」**（恒定，源数据就没有）。
    // ⚠️ 这两件合成**一个文本元素**，不是排版偏好，是配额算出来的：G3 的
    //    「≤13px 的小字 ≤7」逐元素数，这一屏底子 4 处 + 卡片 3 处 = 7 刚好；
    //    拆成两个元素就是 8（实测门红）。所以是"变形：… ｜ 例句与搭配：暂缺"一行。
    const notes = [];
    if (typeof lex.lemmaForm === 'string' && lex.lemmaForm !== '') {
      notes.push(`${lex.lemmaForm} 是 ${lex.word} 的变形`);
    }
    if (Array.isArray(lex.exchange) && lex.exchange.length > 0) {
      notes.push(`变形：${lex.exchange.map((x) => `${x.label} ${x.form}`).join(' · ')}`);
    }
    notes.push('例句与搭配：暂缺');
    box.append(el(doc, 'span', 'wc-none', notes.join(' ｜ ')));
  } else if (card.hasGloss === true) {
    // 词库里没有这一条，但引擎这条释义还在 ⇒ 画引擎那份，并**如实标出来源**。
    wrap.setAttribute('data-card-source', 'engine');
    if (typeof card.pos === 'string' && card.pos !== '') box.append(el(doc, 'i', 'wc-pos', card.pos));
    if (typeof card.zh === 'string' && card.zh !== '') box.append(el(doc, 'span', 'wc-zh', card.zh));
    box.append(el(doc, 'span', 'wc-none', '例句与搭配：暂缺'));
  } else {
    // 查不到就说查不到。`.wc-miss` 与「没查到」这两个字**来自上一版、已被测试钉住**，
    // 是"如实说查不到"的落点；这里在它后面补两件事：**更准确的出处**，以及
    // **例句与搭配这一栏照样在**（"没有"也要摆出来，不能因为没查到就整栏消失 ——
    //  那样读起来像"这卡上本来就没有这一栏"，而事实是"这一栏现在没有内容"）。
    wrap.setAttribute('data-card-source', 'none');
    box.append(el(doc, 'span', 'wc-miss', '没查到'));
    // 「取片失败」与「词典里没这一条」是两件事 —— 分开说，别把真因藏起来。
    box.append(el(doc, 'span', 'wc-none', typeof card.lexError === 'string' && card.lexError !== ''
      ? `这次没能取到词库：${card.lexError}`
      : '词典里没查到这一条'));
    box.append(el(doc, 'span', 'wc-none', '例句与搭配：暂缺'));
  }
  wrap.append(box);

  const acts = el(doc, 'div', 'wc-acts');
  acts.append(button(doc, '听一下', 'wc-do', () => handlers.on('speak', card.surface), 'speak'));
  acts.append(button(doc, '加进我要学的', 'wc-do', () => handlers.on('addWord', card.key), 'add-word'));
  wrap.append(acts);
  return wrap;
}

/** 把词卡挂到它所属的那一段后面（`card.block` 决定挂哪儿）。 */
function attachCard(doc, host, blockId, snapshot, handlers) {
  const card = snapshot.card;
  if (card === null || card === undefined) return;
  if (card.block !== blockId) return;
  host.append(wordCard(doc, card, handlers));
}

/* ─────────────────────────────────────────────────────────────────────────────
   主渲染
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * 把 `snapshot` 画进 `root`（整棵替换）。
 *
 * @param {object} root 容器（`replaceChildren` 必须存在）
 * @param {object} snapshot 见文件头「快照的形状」
 * @param {{doc?: object, on?: Function}} [handlers] `doc` 是注入的 document 工厂
 *   （缺省 `root.ownerDocument ?? globalThis.document`）；`on(名字, 载荷)` 是事件出口。
 */
export function renderWrite(root, snapshot, handlers = {}) {
  assertRoot(root);
  const doc = handlers.doc ?? root.ownerDocument ?? globalThis.document;
  if (doc === undefined || doc === null || typeof doc.createElement !== 'function') {
    throw new TypeError('renderWrite: 找不到可用的 document（Node 里请注入 handlers.doc）');
  }
  const on = caller(handlers.on);
  const h = { doc, on };

  // 「门面还没接上」——**诚实的空状态**，不是白屏、不是假数据。
  if (typeof snapshot.engineMissing === 'string' && snapshot.engineMissing !== '') {
    root.replaceChildren(engineMissingScreen(doc, snapshot));
    return root;
  }
  // 「没配 Key」——同样当场给完整引导，不撞墙。成本告知照样在（此时恒为 0 次）。
  if (snapshot.keyMissing === true) {
    const wrap = el(doc, 'div');
    wrap.append(keyScreen(doc, snapshot, h), footSeg(doc, snapshot));
    root.replaceChildren(wrap);
    return root;
  }

  const sheet = el(doc, 'div', 'sheet');
  sheet.setAttribute('data-sheet', '');
  sheet.setAttribute('data-step', snapshot.step);
  // 给探针的机械信号：三条持久化清单**有没有真的从引擎拿到**（不是"看起来有没有"）。
  sheet.setAttribute('data-lists', snapshot.engineListsOk === false ? 'partial' : 'full');

  sheet.append(mast(doc), hair(doc));
  sheet.append(sourceSeg(doc, snapshot, h));

  const body = el(doc, 'section', 'seg-block');
  body.setAttribute('data-step-body', '');
  paintStep(doc, body, snapshot, h);
  sheet.append(body);

  sheet.append(hair(doc));
  sheet.append(foldsSeg(doc, snapshot, h));

  const foot = footSeg(doc, snapshot);
  root.replaceChildren(sheet, foot);
  return root;
}

/* ── 出处：他说的那句中文（+ 他贴的素材）───────────────────────────────────── */
function sourceSeg(doc, snapshot, handlers) {
  const sec = el(doc, 'section', 'seg-src');
  sec.setAttribute('data-block', 'src');

  if (snapshot.step === 'source') {
    // 入口屏的**排版姿态**：一句大引导 + 一整块书写面。
    // 它不是一个"标签 + 灰占位符 + 一颗按钮"的表单 —— 那一版被产品负责人判为
    // "像设置页"。这里的书写面就是这一屏的主角（≥22px 的那块版面）。
    sec.append(el(doc, 'p', 'lede lede-lead', '用中文说一句，今天你过得怎么样。'));

    const box = el(doc, 'textarea', 'seg seg-lead');
    box.setAttribute('data-in', 'source');
    box.setAttribute('rows', '2');
    box.setAttribute('placeholder', '例如：今天没什么特殊的，我正常上了半天课');
    box.value = String(snapshot.sourceInput ?? '');
    box.addEventListener('input', () => { handlers.on('sourceInput', box.value); });
    sec.append(box);

    // 贴素材是**可选**的第二格。为什么分成两格而不是一格：门面收的就是
    // `startSentence({chinese, material})` 两个字段 —— 让它们各有一个来源，
    // 比在装配层猜"这一坨算中文还是算素材"诚实。
    // ⚠️ 它的说明收在 `placeholder` 里（占位符不是元素、不占版面）：
    //    "一格标签 + 一格占位符"正是这一版要治的形态（标签是配角，配角要少）。
    const mat = el(doc, 'textarea', 'seg seg-material');
    mat.setAttribute('data-in', 'material');
    mat.setAttribute('rows', '1');
    mat.setAttribute('placeholder', '也可以贴一段素材（可选）：一段英文或中文的原文都行');
    mat.value = String(snapshot.materialInput ?? '');
    mat.addEventListener('input', () => { handlers.on('materialInput', mat.value); });
    sec.append(mat);

    const acts = el(doc, 'div', 'acts');
    acts.append(button(doc, '就用这句', 'do do-main', () => handlers.on('start'), 'start'));
    sec.append(acts);
    return sec;
  }

  // 纸已经写起来了：出处只剩一行极小的灰字（它是配角，不再带标签）。
  sec.append(el(doc, 'p', 'src', snapshot.chinese));
  if (typeof snapshot.material === 'string' && snapshot.material !== '') {
    sec.append(el(doc, 'p', 'material', snapshot.material));
  }
  attachCard(doc, sec, 'src', snapshot, handlers);
  return sec;
}

/* ── 七步各自往纸上接什么 ──────────────────────────────────────────────────── */
function paintStep(doc, body, snapshot, handlers) {
  const step = snapshot.step;

  if (step === 'draft') {
    // 「从零写」：分段输入。**没有提示、没有答案、没有一个示范词。**
    // 引导语是 16px 的一句话（不是 11px 的小标签）—— 这一屏的主角是下面那块书写面。
    body.append(el(doc, 'p', 'lede', '一段一段写，不用一口气打完；写完再挑一处说好它。'));
    appendSegInputs(doc, body, snapshot.draftSegs, 'draft', handlers);
  }

  if (step === 'source') return;

  if (step !== 'draft') {
    // 第一版已经交出去了：留在纸上（被取代之后划掉淡出）——
    // 这就是纪律 ①「一条不断长的纸」：旧版不消失，新内容往下接。
    if (typeof snapshot.version1 === 'string' && snapshot.version1 !== '') {
      if (step === 'choose') body.append(el(doc, 'p', 'tab', '你写的这一版'));
      const host = el(doc, 'div');
      host.setAttribute('data-block', 'v1');
      host.append(enBlock(doc, snapshot.version1, {
        onWord: onWordHandler(handlers),
        block: 'v1',
        flag: snapshot.issue === null ? null : snapshot.issue.quote,
        cardKey: cardKeyIn(snapshot, 'v1'),
        // 版本史的三块**不许同款同重**（眼睛要有落点）：
        //   他写的第一版 = 22px 划掉淡出（旧）／他改的 = 22px 墨黑（新）／系统版 = 32px 主角。
        // 所以 v1 只在**没有 v2 作对照**的那几屏（choose/marked/revise）留在 32px，
        // 一旦揭示屏把它俩并排放在一起，两版一起降到 22px，把 32px 让给系统版。
        enClass: step === 'reveal' || step === 'rewrite' ? 'en en-v' : 'en',
        state: step === 'reveal' ? 'old' : undefined,
        // ⚠️ 动效类**只在改写发生的那一次重画**上加（`snapshot.anim`）——
        // 若按 `step === 'reveal'` 加，之后每次重画（展开折叠块、点词卡）都会重播一遍。
        anim: snapshot.anim === true,
      }));
      body.append(host);
      attachCard(doc, host, 'v1', snapshot, handlers);
    }
  }

  if (step === 'draft') {
    // 提示与动作在草稿段的最后（先写、卡住了再问）。提示的按钮与「写好了」同一行。
    paintHintNotes(doc, body, snapshot, handlers);
    if (snapshot.busy !== true) {
      const acts = el(doc, 'div', 'acts');
      for (const b of hintButtons(doc, snapshot, handlers)) acts.append(b);
      acts.append(button(doc, '再加一段', 'do do-alt', () => handlers.on('addSeg'), 'add-seg'));
      acts.append(button(doc, '写好了', 'do do-main', () => handlers.on('draftDone'), 'draft-done'));
      body.append(acts);
    }
    return;
  }

  if (step === 'choose') {
    paintChoose(doc, body, snapshot, handlers);
    // ⚠️ 提示的三级台阶**也挂在这一屏**，而且这一屏才是它真正能用的时候。
    // 实读引擎：`askHint` 要求 `s.round.read !== null`，而那次读只在 `submit()` 里发生
    // （`flow.mjs` 的 `noteRead` 只有 `index.mjs` 的 `submit()` 一处调用点）；
    // 提交之前求提示，引擎只能回 `level 0 / text null`。所以"卡住了点提示"这个动作
    // 在**写草稿那一屏**与**挑教点这一屏**都摆着，但只有后者拿得到内容。
    paintHintNotes(doc, body, snapshot, handlers);
    if (snapshot.busy !== true) {
      const hintActs = hintButtons(doc, snapshot, handlers);
      if (hintActs.length > 0) {
        const acts = el(doc, 'div', 'acts');
        for (const b of hintActs) acts.append(b);
        body.append(acts);
      }
    }
    return;
  }

  if (step === 'marked') {
    paintIssue(doc, body, snapshot, handlers);
    const acts = el(doc, 'div', 'acts');
    acts.append(button(doc, '我自己再改一版', 'do do-main', () => handlers.on('goRevise'), 'go-revise'));
    if (snapshot.busy !== true) body.append(acts);
    return;
  }

  if (step === 'revise') {
    paintIssue(doc, body, snapshot, handlers);
    body.append(tab(doc, '你改的这一版'));
    appendSegInputs(doc, body, snapshot.reviseSegs, 'revise', handlers);
    const acts = el(doc, 'div', 'acts');
    acts.append(button(doc, '再加一段', 'do do-alt', () => handlers.on('addReviseSeg'), 'add-revise-seg'));
    acts.append(button(doc, '改好了', 'do do-main', () => handlers.on('reviseDone'), 'revise-done'));
    if (snapshot.busy !== true) body.append(acts);
    return;
  }

  if (step === 'reveal') {
    paintIssue(doc, body, snapshot, handlers);
    paintReveal(doc, body, snapshot, handlers);
    const acts = el(doc, 'div', 'acts');
    acts.append(button(doc, '过几天再写一遍', 'do do-main', () => handlers.on('gotoQueue'), 'goto-queue'));
    body.append(acts);
    return;
  }

  if (step === 'rewrite') {
    paintReveal(doc, body, snapshot, handlers);
    const acts = el(doc, 'div', 'acts');
    acts.append(button(doc, '回到这一句', 'do do-alt', () => handlers.on('gotoReveal'), 'goto-reveal'));
    body.append(acts);
  }
}

/** 逐词可点的回调（把"点哪个词"翻译成事件出口）。 */
/**
 * 点词的出口。
 *
 * ⚠️ **必须把 `handlers.on(...)` 的返回值原样返回**（这里以前漏了 `return`，代价真实）：
 * 装配层的 `word` 动作是 **async**（它要去查词库 —— 一次同源取片），而假 DOM 的
 * `click()` 返回的是监听器的返回值。不返回的话 `await b.click()` 拿到 `undefined`，
 * 于是"点词 → 查词库 → 画卡"这条链在测试里**永远等不到落定**：卡还没画出来，
 * 断言先跑了。这与 `web/write.mjs` 的 `handle()` 里那条注释是同一件事
 * （那里专门 `return out` 就是为了让测试能 await 到异步链真的结束）。
 */
const onWordHandler = (handlers) => (key, surface, block) => (
  handlers.on('word', { key, surface, block })
);

/** 当前打开的词卡属于哪一段 → 只有那一段里的那个词带 `aria-expanded`。 */
const cardKeyIn = (snapshot, block) => (
  snapshot.card !== null && snapshot.card !== undefined && snapshot.card.block === block
    ? snapshot.card.key
    : null
);

/* ── 分段输入（纪律 ②）────────────────────────────────────────────────────────
   一行一段。**没有"1 / 2 / 3"的序号槽**：那是标签，而这一屏的主角是这几行本身。
   序号由 placeholder 的措辞承担（第一格说"第一段，用英文写"，后面的说"接着写下一段"）。
   ⚠️ placeholder **只许说"这里该写什么"，一个字英文都不许有**（2026-09-19 修）：
   他上一屏看到的中文例子是"今天没什么特殊的，我正常上了半天课"，而第一格原先的灰字是
   `Nothing special today.` —— 那**恰好就是那句中文的现成英文答案**：他一个字还没打，
   答案已经摆在光标的位置上。这与本文件 `paintStep` 里「从零写：没有提示、没有答案、
   没有一个示范词」这条纪律**直接冲突**（原先两处注释互相矛盾，是这次一起改掉的那条）。
   现在这条纪律有机械判据：`scripts/ui-gates.mjs` 的 **G5**（draft 档、他还没打字时，
   屏上不得出现任何 ASCII 英文字母；带"故意注入一句英文"的反向控制）。 */
function appendSegInputs(doc, host, segs, kind, handlers) {
  const list = Array.isArray(segs) && segs.length > 0 ? segs : [''];
  list.forEach((value, i) => {
    const box = el(doc, 'textarea', 'seg seg-part');
    box.setAttribute('data-in', `${kind}-${String(i)}`);
    box.setAttribute('rows', '1');
    // ⚠️ 中性提示，**不含任何英文**：这一屏是他从零写，给一句示范英文 = 给答案（见上面那段）。
    box.setAttribute('placeholder', i === 0 ? '第一段，用英文写' : '接着写下一段…');
    box.value = String(value ?? '');
    box.addEventListener('input', () => { handlers.on(`${kind}Input`, { index: i, value: box.value }); });
    host.append(box);
  });
}

/* ── 提示：三级台阶（1 级只问「卡在哪类」）────────────────────────────────────
   屏上只有三样，一样都不许多：
     ① 已经问到的那一级台阶的**原文**（门面说没给文字就一个字都不画）；
     ② 「卡在哪一类？」+ 三个类（只在类别还没选的时候出现）—— 这就是"1 级只问哪类"；
     ③ 一颗"往上要一级"的按钮（与「写好了」同一行动作里，见 `hintButtons`）。
   ⚠️ 台阶的级数**由门面返回的 `level` 决定**，本文件不自己数点击次数：
   "第几级"是教学判断，不是界面判断。到第 3 级就不再给按钮（不给一个点了没用的东西）。
   ───────────────────────────────────────────────────────────────────────────── */

/** ① + ②：提示的**文字部分**（挂在稿纸上）。 */
function paintHintNotes(doc, host, snapshot, handlers) {
  const hint = snapshot.hint;
  if (hint !== null && hint !== undefined && typeof hint.text === 'string' && hint.text !== '') {
    const note = el(doc, 'p', 'note note-hint');
    note.setAttribute('data-layer', 'hint');
    note.setAttribute('data-hint-level', String(hint.level));
    note.textContent = hint.text;
    host.append(note);
  }
  if (snapshot.hintOpen === true) {
    const ask = el(doc, 'p', 'note note-hint');
    ask.setAttribute('data-layer', 'hint-ask');
    ask.append(el(doc, 'span', null, '卡在哪一类？'));
    const cats = el(doc, 'div', 'cats');
    for (const c of HINT_CATEGORIES) {
      if (Array.isArray(snapshot.hintCats) && !snapshot.hintCats.includes(c.key)) continue;
      cats.append(button(doc, c.label, 'cat', () => handlers.on('hintCategory', c.key), `hint-${c.key}`));
    }
    ask.append(cats);
    host.append(ask);
  }
}

/** ③：往上要一级的那颗按钮（没有可要的就不返回按钮，不摆一个点了没用的东西）。 */
function hintButtons(doc, snapshot, handlers) {
  const hint = snapshot.hint;
  if (hint === null || hint === undefined) {
    return snapshot.hintOpen === true
      ? []
      : [button(doc, '给点提示', 'do do-alt', () => handlers.on('openHint'), 'open-hint')];
  }
  return hint.level === 3
    ? []
    : [button(doc, '再给一点', 'do do-alt', () => handlers.on('hintAgain'), 'hint-again')];
}

/* ── 教点 2–3 选一（选在**内容层**）────────────────────────────────────────────
   形态 = **铅笔注**（与 `.note` 同一套语言），**不是带边框的行列表**。
   上一版把三个候选做成三条带下划线的整行按钮，还在每条下面重复渲染一遍草稿片段 ——
   那是"盒子 + 重复内容"，正是产品负责人说的"套了个壳子"。现在：
     · 一行 16px 的引导（"挑一个你最想弄明白的"）；
     · 三条铅笔注，每条 = 一句"教什么"（16px，自己可点）+ 一处引文（22px 衬线，逐词可点）。
   候选按钮的**文字仍然恰好是 label 本身**（引文是它的兄弟节点）：本仓 mount 测试按按钮
   文案精确匹配 —— 引文塞进按钮里，真 DOM 与假 DOM 下的"按钮文案"就会不一样。 */
function paintChoose(doc, host, snapshot, handlers) {
  if (Array.isArray(snapshot.candidates) && snapshot.candidates.length > 0) {
    host.append(el(doc, 'p', 'lede', '这一段里，挑一个你最想弄明白的。'));
    const box = el(doc, 'div', 'pick');
    box.setAttribute('data-layer', 'candidates');
    for (const c of snapshot.candidates) {
      const row = el(doc, 'div', 'pick-item');
      row.append(button(doc, c.label, 'pick-do', () => handlers.on('pick', c.key), `pick-${c.key}`));
      const q = el(doc, 'span', 'pick-quote');
      q.setAttribute('data-block', 'pick');
      appendEnglish(doc, q, c.quote, {
        onWord: onWordHandler(handlers), block: 'pick', cardKey: cardKeyIn(snapshot, 'pick'),
      });
      row.append(q);
      box.append(row);
    }
    host.append(box);
    attachCard(doc, box, 'pick', snapshot, handlers);
    return;
  }
  // 候选还没来：如实说"在想"，不摆假选项。
  if (snapshot.busy === true) host.append(el(doc, 'p', 'busy', '在想这一版里该教你什么…'));
}

/* ── 标出一处：标出来、不说，点开才说 ──────────────────────────────────────── */
function paintIssue(doc, host, snapshot, handlers) {
  const issue = snapshot.issue;
  if (issue === null || issue === undefined) return;
  const note = el(doc, 'div', 'note note-issue');
  note.setAttribute('data-layer', 'issue');
  if (snapshot.issueOpen === true) {
    // 点开之后也只说**类别**；"为什么"锁在 reveal 后面。
    note.append(el(doc, 'span', null, '这一处不地道：'));
    const kind = el(doc, 'span', 'issue-kind', String(issue.kind ?? '说不清哪一类'));
    kind.setAttribute('data-issue-kind', String(issue.kind ?? ''));
    note.append(kind);
  } else {
    const b = button(doc, '这一处不地道 · 点开看看', 'issue-open', () => handlers.on('openIssue'), 'open-issue');
    note.append(b);
  }
  host.append(note);
}

/* ── 揭开系统版：改完才有（三条不许提前的第 ① 条）────────────────────────────
   版本史的**三种重量**（这一屏的落点就在这里，上一版三块一模一样大 ⇒ 眼睛没有落点）：
     他改的（v2）  = 22px 墨黑（`.is-new`）
     系统版        = 32px 主角（这一屏唯一的大字）
     他写的第一版  = 22px 划掉淡出（`.is-old`，在 `paintStep` 里画，排在更上面）
   为什么系统版才是主角：他爬到这一屏就是为了看"更好的那一版长什么样"。 */
function paintReveal(doc, host, snapshot, handlers) {
  const revealed = snapshot.revealed === true
    && typeof snapshot.system === 'string' && snapshot.system !== '';
  if (!revealed) return;

  // 他改完的那一版（新版浮现；动效只发生在这一处）
  if (typeof snapshot.version2 === 'string' && snapshot.version2 !== '') {
    host.append(el(doc, 'p', 'tab', '你改的'));
    const hostV2 = el(doc, 'div');
    hostV2.setAttribute('data-block', 'v2');
    hostV2.append(enBlock(doc, snapshot.version2, {
      onWord: onWordHandler(handlers), block: 'v2', cardKey: cardKeyIn(snapshot, 'v2'),
      enClass: 'en en-v', state: 'new', anim: snapshot.anim === true,
    }));
    host.append(hostV2);
    attachCard(doc, hostV2, 'v2', snapshot, handlers);
  }

  host.append(el(doc, 'p', 'tab', '系统版'));
  const hostSys = el(doc, 'div');
  hostSys.setAttribute('data-block', 'system');
  hostSys.append(enBlock(doc, snapshot.system, {
    onWord: onWordHandler(handlers), block: 'system', cardKey: cardKeyIn(snapshot, 'system'),
  }));
  host.append(hostSys);
  attachCard(doc, hostSys, 'system', snapshot, handlers);

  // 每处一句为什么：写在**铅笔边注**里（16px 的正文，不是 11px 的小灰条）。
  // 上一版把它做成 `ul.why` 里两条 11px 的 li —— 一屏能数出 25 处小字，其中一大半是它。
  if (Array.isArray(snapshot.why) && snapshot.why.length > 0) {
    const ul = el(doc, 'ul', 'why');
    ul.setAttribute('data-layer', 'why');
    for (const w of snapshot.why) ul.append(el(doc, 'li', null, w));
    host.append(ul);
  }

  // 降难度两档：两条更省力的说法（标签 16px + 英文 22px）。
  // 两条共用**同一道铅笔竖线**（`.simpler-wrap`）—— 上一版两条各带一条竖线，
  // 于是"带边框/填充的盒子"多出一个（wordcard 那一屏实测 6 个，配额是 4）。
  const simpler = snapshot.simpler;
  if (simpler !== null && simpler !== undefined && (simpler.half || simpler.easy)) {
    const wrap = el(doc, 'div', 'simpler-wrap');
    for (const [k, label] of [['half', '再简单一点'], ['easy', '最简单']]) {
      const text = simpler[k];
      if (typeof text !== 'string' || text === '') continue;
      const row = el(doc, 'div', 'simpler');
      row.setAttribute('data-simpler', k);
      row.append(el(doc, 'span', 'simpler-lab', label));
      const p = el(doc, 'p', 'en en-sm');
      p.setAttribute('data-block', `simpler-${k}`);
      appendEnglish(doc, p, text, {
        onWord: onWordHandler(handlers), block: `simpler-${k}`, cardKey: cardKeyIn(snapshot, `simpler-${k}`),
      });
      row.append(p);
      wrap.append(row);
      attachCard(doc, row, `simpler-${k}`, snapshot, handlers);
    }
    host.append(wrap);
  }

  // 逐词释义（来自 reveal().glosses）：这句里值得记的词。
  // ⚠️ 它**不再自带一行小标签**（"这句里值得记的"是外壳，不是内容）——
  //   词的本身用铅笔衬线起头，一行一个。
  if (Array.isArray(snapshot.glosses) && snapshot.glosses.length > 0) {
    const box = el(doc, 'div');
    box.setAttribute('data-layer', 'glosses');
    for (const g of snapshot.glosses) {
      const row = el(doc, 'p', 'gloss');
      row.append(el(doc, 'b', 'gloss-w', g.word));
      if (typeof g.pos === 'string' && g.pos !== '') row.append(el(doc, 'i', 'gloss-pos', g.pos));
      if (typeof g.zh === 'string' && g.zh !== '') row.append(el(doc, 'span', 'gloss-zh', g.zh));
      box.append(row);
    }
    host.append(box);
  }
}

/* ── 靠了多大力（离散标记，纪律 ④）+ 「接不住」+ 折叠块 + 页脚 ─────────────── */

/** 这枚标记在**每一步**都在（它是"你靠了多大力"，不是某一步的局部状态）。 */
function effortLine(doc, snapshot) {
  const p = el(doc, 'p', 'eff');
  p.setAttribute('data-effort', effortOf(snapshot));
  return p;
}

function foldsSeg(doc, snapshot, handlers) {
  const sec = el(doc, 'section', 'folds');
  sec.setAttribute('data-layer', 'folds');
  sec.append(effortLine(doc, snapshot));

  // 「这次接不住」：如实说 + reason。**绝不编内容。**
  if (snapshot.fail !== null && snapshot.fail !== undefined) {
    const note = el(doc, 'p', 'note note-fail');
    note.setAttribute('data-layer', 'fail');
    note.textContent = `这次接不住：${String(snapshot.fail.reason ?? '它没给理由')}`;
    sec.append(note);
    // 「下一步怎么办」——**只在门面明说"这是本回合早先那次读的失败、没有重发请求"时才画**。
    // 它把 D2 那条成本不变式变成屏上看得见的东西：钱不会再自己花一次，要再读**得他点一下**。
    if (typeof snapshot.failHint === 'string' && snapshot.failHint !== '') {
      const how = el(doc, 'p', 'note note-fail-hint');
      how.setAttribute('data-layer', 'fail-hint');
      how.textContent = snapshot.failHint;
      sec.append(how);
    }
  }
  if (typeof snapshot.notice === 'string' && snapshot.notice !== '') {
    const note = el(doc, 'p', 'note note-hint');
    note.setAttribute('data-layer', 'notice');
    note.textContent = snapshot.notice;
    sec.append(note);
  }
  if (snapshot.busy === true) sec.append(el(doc, 'p', 'busy', '在想…'));

  const mine = Array.isArray(snapshot.mineSentences) ? snapshot.mineSentences : [];
  const words = Array.isArray(snapshot.myWords) ? snapshot.myWords : [];
  const due = Array.isArray(snapshot.due) ? snapshot.due : [];
  // 「还没拿到」与「还没有」是两件事（见 emptySnapshot 里 engineListsOk 的说明）。
  const notReported = (what) => el(doc, 'p', 'empty', `这一项还没从引擎拿到（${what}）。`);
  const unknown = snapshot.engineListsOk === false;

  sec.append(fold(doc, 's', `我的句子（${String(mine.length)}）`, snapshot, handlers, (body) => {
    if (unknown) { body.append(notReported('我的句子')); return; }
    if (mine.length === 0) { body.append(el(doc, 'p', 'empty', '还没有。写完一句就会长在这里。')); return; }
    for (const s of mine) {
      const p = el(doc, 'p', 'mine-s');
      p.setAttribute('data-block', 'mine');
      if (typeof s.zh === 'string' && s.zh !== '') p.append(el(doc, 'span', 'mine-zh', s.zh));
      appendEnglish(doc, p, String(s.en ?? ''), {
        onWord: onWordHandler(handlers), block: 'mine', cardKey: cardKeyIn(snapshot, 'mine'),
      });
      body.append(p);
    }
    attachCard(doc, body, 'mine', snapshot, handlers);
  }));

  sec.append(fold(doc, 'w', `我的词（${String(words.length)}）`, snapshot, handlers, (body) => {
    if (unknown) { body.append(notReported('我的词')); return; }
    if (words.length === 0) { body.append(el(doc, 'p', 'empty', '还没有。查词时点「加进我要学的」就会收在这里。')); return; }
    const chips = el(doc, 'div', 'chips');
    for (const w of words) {
      const key = wordKey(w);
      const b = el(doc, 'button', 'w chip', w);
      b.setAttribute('type', 'button');
      b.setAttribute('data-w', key);
      if (cardKeyIn(snapshot, 'mine-words') === key) b.setAttribute('aria-expanded', 'true');
      b.addEventListener('click', () => handlers.on('word', { key, surface: String(w), block: 'mine-words' }));
      chips.append(b);
    }
    body.append(chips);
    attachCard(doc, body, 'mine-words', snapshot, handlers);
  }));

  sec.append(fold(doc, 'due', `过几天再写一遍（${String(due.length)}）`, snapshot, handlers, (body) => {
    if (unknown) { body.append(notReported('待重写队列')); return; }
    if (due.length === 0) { body.append(el(doc, 'p', 'empty', '还没有要重写的句子。')); return; }
    for (const d of due) {
      const row = el(doc, 'div', 'due-item');
      row.setAttribute('data-due', '');
      if (typeof d.when === 'string' && d.when !== '') row.append(el(doc, 'span', 'due-when', d.when));
      if (typeof d.zh === 'string' && d.zh !== '') row.append(el(doc, 'span', 'mine-zh', d.zh));
      if (typeof d.en !== 'string' || d.en === '') {
        // 正文取不回来（引擎的队列项里没有正文，要按 sessionId 回 sentences 里取）
        // ⇒ **如实说**，不拿别的句子顶上。
        row.append(el(doc, 'p', 'empty', '这一句的正文没读回来。'));
      } else {
        const p = el(doc, 'p', 'en en-sm');
        p.setAttribute('data-block', 'due');
        appendEnglish(doc, p, d.en, {
          onWord: onWordHandler(handlers), block: 'due', cardKey: cardKeyIn(snapshot, 'due'),
        });
        row.append(p);
      }
      body.append(row);
    }
    attachCard(doc, body, 'due', snapshot, handlers);
  }));

  return sec;
}

/**
 * 一个折叠块：**关着的时候折叠体不存在**（不是 `display:none` 藏着）。
 * 返回值是一个 `.foldblock` 小容器（`.fold` 与 `.fold-body` 是它的两个孩子）——
 * 这样"这一块的边距"落在容器上，而"▸/▾ + 标题"仍是那个按钮，语义没被容器吞掉。
 */
function fold(doc, kind, label, snapshot, handlers, paintBody) {
  const open = snapshot.fold === kind;
  const block = el(doc, 'div', 'foldblock');
  const b = button(doc, label, 'fold', () => handlers.on('fold', kind), `fold-${kind}`);
  b.setAttribute('aria-expanded', open ? 'true' : 'false');
  block.append(b);
  if (open) {
    const body = el(doc, 'div', 'fold-body');
    body.setAttribute('data-fold-body', kind);
    paintBody(body);
    block.append(body);
  }
  return block;
}

/** 页脚：**成本告知**（纪律 ⑪）。它在纸外 —— 稿纸主区里不许出现 token 数。 */
function footSeg(doc, snapshot) {
  const foot = el(doc, 'footer', 'page-foot');
  foot.setAttribute('data-layer', 'cost');
  const c = snapshot.cost ?? {};
  const calls = Number(c.calls ?? 0);
  const pt = Number(c.promptTokens ?? 0);
  const ct = Number(c.completionTokens ?? 0);
  const ms = Number(c.latencyMsTotal ?? 0);
  foot.textContent = calls === 0
    ? '这一次还没调用过模型（0 次）。'
    : `这一次：模型 ${String(calls)} 次 · 输入 ${String(pt)} tokens · 输出 ${String(ct)} tokens · 一共等了 ${(ms / 1000).toFixed(1)} 秒。`
      + 'Key 只在你自己的浏览器里，费用按你的用量记在你自己账上。';
  return foot;
}

/* ── 「没配 Key」那一屏（纪律 ⑩：四件事缺一件人就会卡住）───────────────────── */
function keyScreen(doc, snapshot, handlers) {
  const gate = el(doc, 'div', 'gate');
  gate.setAttribute('data-gate', 'key');
  const h1 = el(doc, 'h1', null, '先说一件事');
  gate.append(h1);
  gate.append(el(doc, 'p', 'gate-why',
    '还没配置 API Key：模型调用要从你的手机浏览器里直接发给 DeepSeek（按用量计费），'
    + '所以需要你自己的一把 Key。'));
  gate.append(el(doc, 'p', null,
    '到 platform.deepseek.com 注册后，在 API Keys 页面创建一串以 sk- 开头的密钥，粘贴到下面保存。'));
  gate.append(el(doc, 'p', null,
    '这把 Key 只保存在这台手机的浏览器里（本机存储），不会上传给任何人；它只随你的请求发给模型服务。'
    + '清掉浏览器数据会连同 Key 一起删掉。'));
  const box = el(doc, 'input', 'key-in');
  box.setAttribute('data-in', 'key');
  box.setAttribute('type', 'password');
  box.setAttribute('placeholder', '粘贴以 sk- 开头的 API Key');
  box.value = String(snapshot.keyInput ?? '');
  box.addEventListener('input', () => { handlers.on('keyInput', box.value); });
  gate.append(box);
  if (typeof snapshot.keyError === 'string' && snapshot.keyError !== '') {
    gate.append(el(doc, 'p', 'gate-err', `没存上：${snapshot.keyError}`));
  }
  const acts = el(doc, 'div', 'acts');
  acts.append(button(doc, '存到本机', 'do do-main', () => handlers.on('saveKey'), 'save-key'));
  gate.append(acts);
  gate.append(el(doc, 'p', 'note',
    '保存之后这一页会直接变成「今天的一句」——你的句子、你的词、待重写的队列都还在。'));
  return gate;
}

/* ── 「引擎还没接上」那一屏（不许静默用假数据顶上）───────────────────────── */
function engineMissingScreen(doc, snapshot) {
  const gate = el(doc, 'div', 'gate');
  gate.setAttribute('data-gate', 'engine');
  gate.append(el(doc, 'h1', null, '今天的一句'));
  gate.append(el(doc, 'p', 'gate-why', '引擎还没接上。'));
  gate.append(el(doc, 'p', null,
    `这一页要用 web/units/write/index.mjs 那个门面（createWriteApp）。现在没能把它接上：${String(snapshot.engineMissing)}`));
  gate.append(el(doc, 'p', null,
    '在它落地之前，这一页不会用演示数据顶上——屏上出现假的教学内容比什么都不显示更坏。'
    + '要看看这一页长什么样，请开走查台 gallery-write.html（那里注入的是明确标注的假门面）。'));
  const foot = footSeg(doc, snapshot);
  const wrap = el(doc, 'div');
  wrap.append(gate, foot);
  return wrap;
}
