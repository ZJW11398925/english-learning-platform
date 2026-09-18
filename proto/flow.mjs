// web/proto/flow.mjs
//
// 一屏原型（Task 17）的**纯状态机 + 内容表**。这个文件里没有任何界面代码：
// 不碰 DOM、不碰存储、不发请求、不调模型。界面在 `flow.view.mjs`，这一层可以在
// Node 里被确定性地 `import` 并逐条测（`tests/proto-flow.test.mjs`）。
//
// ===========================================================================
// 这一屏要回答的四条指控（用户当场否掉前两版形态时说的）
// ===========================================================================
//   ① **答非所问**：情境是从写死的表里按焦点词挑的，与他说的话无关。
//      ⇒ 这里的硬规则是「相关性」：教点由 `pickTeachPoint(他的话)` 从他**这句话里**选，
//      返回值带着它来自哪个片段（`sourceSpan`），屏上把这个片段**标在他的原句里**。
//      反向控制由测试钉住：换一句不含该片段的话，教点**不得照旧返回**。
//   ② **没人味、看不出循序渐进**：每轮一次独立模型调用，程序不持有跨轮状态。
//      ⇒ 这里的流程**只由 `reduce(state, event)` 推进**，每一步的屏是状态的函数；
//      全程零模型调用（没有 Key 也能走完）。
//   ③ **让填空，界面却只有一个对话框**：⇒ 空位只能**点词块**补，`pickChunk` 带的是
//      词块 id（闭集），除第一步的 `say` 之外**没有任何事件携带自由文本**。
//   ④ **屏上的英文不能点词查义**：⇒ 屏上每个英文词都由 `segmentEnglish` 切成可点单元，
//      点开是词卡；`tests/proto-flow.test.mjs` 断言逐词覆盖率 100%。
//
// ===========================================================================
// 内容来源（口径）
// ===========================================================================
// **英文内容与演示输入逐字取自任务书，本文件一个字都没有改写。**
// 唯一两处**补**的东西（都在文件里指名标出，且写进了报告）：
//   · `WORD_CARDS` 末尾三张卡（`usual` / `like` / `have`）——原表里没有，而这三个词
//     出现在给定提示与给定词块池里（`like usual` / `…接名词性的 usual` / `I usually have classes…`），
//     不补就不可能满足"屏上每个英文词都有条目"这条硬规则。内容是我写的，**无人背书**。
//   · `usual` 那张卡同此。
// 反引号（`）在本文件里是**排版标记**：表示"这一段是英文，按英文衬线渲染、逐词可点"，
// 渲染时反引号字形不出现（`stripMarks` 与视图里的分段渲染是同一个口径）。
// 任务书给的提示与词卡单元格本身就带反引号，这里照抄，不在数据里改写。

/**
 * 演示输入（学习者说的那句中文）。任务书定死，屏上预填。
 * @type {string}
 */
export const DEMO_INPUT = '今天没什么特殊的，我正常上了半天课';

/** 空位标记（`BLANK_SENTENCE` 里唯一的那个）。 */
export const BLANK_MARK = '___';

/** S2 的空位句——**一个**空位，空位＝「照常」。逐字取自任务书。 */
export const BLANK_SENTENCE = 'Nothing special today. I had classes ___ for half a day.';

/** S3/S4 的「更自然的整句」。逐字取自任务书。 */
export const NATURAL_SENTENCE = 'Nothing special today. I had classes as usual for half a day.';

/** S4 的「为什么改」一句。逐字取自任务书。 */
export const S4_WHY = 'as usual 是固定短语，意思是「照常、像平常一样」。';

/** S5 的渐进痕迹（演示值）。逐字取自任务书。 */
export const PROGRESS_LINE = '今天 1 句 · 新用上：as usual（照常）';

/**
 * 把空位补上。
 * @param {string} chunk 词块文本（`CHUNKS[].text`）
 * @returns {string} 补好空位的整句；`fillBlank('as usual')` **逐字等于** `NATURAL_SENTENCE`
 *   （这句是单一出处：S3/S4 的"更自然的整句"不另抄一份，测试钉住这条等式）
 */
export function fillBlank(chunk) {
  return BLANK_SENTENCE.replace(BLANK_MARK, String(chunk));
}

/**
 * 词块池（4 个，可点）。顺序 = 任务书给的顺序。
 * `correct` 只有一个；`hint` 是点错时**逐字**给出的那条具体提示（不批评，只指出差别）。
 * @type {ReadonlyArray<{id: string, text: string, correct: boolean, hint: string|null}>}
 */
export const CHUNKS = Object.freeze([
  Object.freeze({ id: 'as-usual', text: 'as usual', correct: true, hint: null }),
  Object.freeze({
    id: 'as-usually',
    text: 'as usually',
    correct: false,
    hint: '`as usual` 是固定短语，`as` 后面接名词性的 `usual`，没有 `as usually` 这种说法',
  }),
  Object.freeze({
    id: 'like-usual',
    text: 'like usual',
    correct: false,
    hint: '口语里能听到，但标准写法是 `as usual`',
  }),
  Object.freeze({
    id: 'usually',
    text: 'usually',
    correct: false,
    hint: '`usually` 是副词，位置不同（`I usually have classes…`）',
  }),
]);

/**
 * 可教的点（规则表）。
 *
 * 现在只有一条规则——原型只示范一句。但**挑选是"扫他的话"而不是"取第 0 条"**：
 * `pickTeachPoint` 逐条在句子里找 `sourceSpan`，取**最靠左**的那条命中。
 * 这条区分不是洁癖：把 `pickTeachPoint` 改成无条件返回 `TEACH_RULES[0]`，
 * 反向控制的用例会当场 RED（见报告里的变异清单 M2）。
 *
 * @type {ReadonlyArray<{id: string, sourceSpan: string, chunk: string, gloss: string}>}
 */
export const TEACH_RULES = Object.freeze([
  Object.freeze({
    id: 'as-usual',
    /** 教点的来源片段：**必须逐字出现在学习者原句里**（这就是"相关性"的机械判据）。 */
    sourceSpan: '正常上了半天课',
    /** 从这个片段里挑出来的、要教的英文。 */
    chunk: 'as usual',
    /** 屏上「（照常）」那个短释义。 */
    gloss: '照常',
  }),
]);

/**
 * 从学习者那句话里挑一个可教的点。
 *
 * **返回 null 是一种正常结果**，不是错误：句子为空、或没有任何规则的来源片段出现在
 * 他的话里，就是"这一屏接不上"。界面据此**不假装接住**（不许回落到一条固定教点，
 * 那正是"答非所问"的成因）。反向控制见 `tests/proto-flow.test.mjs`。
 *
 * @param {unknown} sentence 学习者说的中文
 * @returns {{id: string, sourceSpan: string, chunk: string, gloss: string, at: number}|null}
 *   `at` 是片段在原句里的下标；`sourceSpan` 逐字等于 `sentence` 里那一段
 */
export function pickTeachPoint(sentence) {
  if (typeof sentence !== 'string') return null;
  const text = sentence.trim();
  if (text === '') return null;
  let best = null;
  for (const rule of TEACH_RULES) {
    const at = text.indexOf(rule.sourceSpan);
    if (at < 0) continue; // ← 他的话里没有这个片段 ⇒ 这条规则不成立
    if (best === null || at < best.at) best = { rule, at };
  }
  if (best === null) return null;
  return { ...best.rule, at: best.at };
}

/**
 * 词卡表（屏上出现的每个英文词都必须有条目）。
 *
 * 列 = 任务书的四列：词 / 词性 / 中文 / 搭配·例句（第 4 列原文里混着搭配与例句，
 * 这里照抄在同一格里，按原文渲染，**不替原文分类**）。
 * ⚠️ 任务书列了"音标"这个字段，本表**没有**——见报告「明知未验项」：
 *    给一份无人背书的注音，等于替无人背书的内容再加一层无人背书的内容。
 *
 * @type {ReadonlyArray<{word: string, pos: string, zh: string, use: string}>}
 */
export const WORD_CARDS = Object.freeze([
  Object.freeze({ word: 'Nothing', pos: 'pron.', zh: '没有什么', use: '`nothing special` 没什么特别的' }),
  Object.freeze({ word: 'special', pos: 'adj.', zh: '特别的', use: '`nothing special`' }),
  Object.freeze({ word: 'today', pos: 'adv.', zh: '今天', use: '`Nothing special today.`' }),
  Object.freeze({ word: 'I', pos: 'pron.', zh: '我', use: '' }),
  Object.freeze({ word: 'had', pos: 'v.', zh: 'have 的过去式', use: '`have classes` 上课' }),
  Object.freeze({ word: 'classes', pos: 'n.', zh: 'class 的复数，泛指「课」', use: '`have / take classes`' }),
  Object.freeze({ word: 'as usual', pos: 'phr.', zh: '照常、像平常一样（固定短语）', use: '`I had classes as usual.`' }),
  Object.freeze({ word: 'for', pos: 'prep.', zh: '持续（一段时间）', use: '`for half a day` 持续半天' }),
  Object.freeze({ word: 'half', pos: 'n./adj.', zh: '一半', use: '`half a day` 半天' }),
  Object.freeze({ word: 'a', pos: 'art.', zh: '一个', use: '`half a day`' }),
  Object.freeze({ word: 'day', pos: 'n.', zh: '天', use: '`half a day`' }),
  Object.freeze({ word: 'as', pos: 'conj./prep.', zh: '作为；像', use: '见 `as usual`' }),
  Object.freeze({ word: 'usually', pos: 'adv.', zh: '通常', use: '`I usually have classes in the morning.`' }),
  // ── 以下三张是**补的卡**（原表没有这三个词，而它们出现在给定的提示与词块池里：
  //    `like usual` / `as` 后面接名词性的 `usual` / `I usually have classes…`）。
  //    没有它们，"屏上每个英文词都有条目"这条硬规则**不可能**成立。
  //    内容是我写的，**无人背书**——已登记在报告里。
  Object.freeze({ word: 'usual', pos: 'adj.', zh: '通常的、平常的', use: '`as usual` 照常' }),
  Object.freeze({ word: 'like', pos: 'prep.', zh: '像；像……一样', use: '`like usual`' }),
  Object.freeze({ word: 'have', pos: 'v.', zh: '有；上（课）', use: '`have classes` 上课' }),
]);

/** 词卡索引（键 = 小写词形；`as usual` 这类短语按整串建键）。 */
const CARD_BY_KEY = new Map(WORD_CARDS.map((c) => [c.word.toLowerCase(), c]));

/**
 * 查词卡（大小写不敏感）。
 * @param {unknown} token 词或短语（`as usual` 这种整串也能查）
 * @returns {{word: string, pos: string, zh: string, use: string}|null} 查不到返回 `null`
 *   ——视图对 `null` 的处理是**渲染成不可点的纯文本**，绝不假装有卡。
 */
export function lookupCard(token) {
  if (typeof token !== 'string') return null;
  return CARD_BY_KEY.get(token.trim().toLowerCase()) ?? null;
}

/** 一个英文"词"的形状（词内可以带撇号/连字符，如 `I'd`）。 */
const WORD_RUN = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

/**
 * 取出一段文本里的英文词（按下标顺序）。
 * @param {unknown} text
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function tokenizeEnglish(text) {
  const out = [];
  if (typeof text !== 'string' || text === '') return out;
  const re = new RegExp(WORD_RUN.source, 'g'); // 每次新建：不带 `lastIndex` 这种跨调用状态
  let m = re.exec(text);
  while (m !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    m = re.exec(text);
  }
  return out;
}

/**
 * 把一段文本切成**渲染单元**：中文等原样成段，英文词（或短语）成 `word` 段。
 *
 * **最长匹配**：相邻两个词之间正好是一个空格、且合起来是词卡里的短语时（`as usual`），
 * 合成**一个** `word` 段——否则 `as usual` 会被切成 `as` + `usual` 两张卡，
 * 点上去弹出的就不是"照常"那条短语卡了。
 * 判据落在**词边界**上（先切成词，再合并），所以 `as usually` **不会**被前缀骗到
 * （它不是 `as usual`，而是 `as` + `usually` 两个词，两张卡都在）。
 *
 * @param {unknown} text
 * @returns {Array<{kind: 'text'|'word', text: string, card: object|null}>}
 */
export function segmentEnglish(text) {
  if (typeof text !== 'string' || text === '') return [];
  const runs = tokenizeEnglish(text);
  const out = [];
  let cursor = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const next = runs[i + 1];
    let token = null;
    if (next !== undefined && text[run.end] === ' ' && next.start === run.end + 1) {
      const phrase = `${run.text} ${next.text}`;
      const card = lookupCard(phrase);
      if (card !== null) {
        token = { text: phrase, start: run.start, end: next.end, card };
        i += 1; // 两词并作一段
      }
    }
    if (token === null) {
      token = { text: run.text, start: run.start, end: run.end, card: lookupCard(run.text) };
    }
    if (token.start > cursor) out.push({ kind: 'text', text: text.slice(cursor, token.start), card: null });
    out.push({ kind: 'word', text: token.text, card: token.card });
    cursor = token.end;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor), card: null });
  return out;
}

/**
 * 按反引号把文本切成「普通段 / 英文段」（反引号是排版标记，渲染时不出现在字形里）。
 * @param {unknown} text
 * @returns {Array<{code: boolean, text: string}>} 顺序拼回去（去掉反引号）等于原文
 */
export function stripMarks(text) {
  const s = typeof text === 'string' ? text : '';
  const out = [];
  let code = false;
  for (const piece of s.split('`')) {
    if (piece !== '') out.push({ code, text: piece });
    code = !code;
  }
  return out;
}

/**
 * 去掉排版标记后的纯文本（界面上真正看到的那些字）。
 * @param {unknown} text
 * @returns {string}
 */
export function plainText(text) {
  return stripMarks(text).map((p) => p.text).join('');
}

/**
 * 这段文本里有没有**独立成词**的 `word`（大小写不敏感，按词边界判，不走子串）。
 * 视图用它算词卡的「在你这句里」那一行；**子串匹配会骗人**（`as` 会在 `classes` 里命中）。
 * @param {unknown} text
 * @param {unknown} word
 * @returns {boolean}
 */
export function containsWord(text, word) {
  if (typeof text !== 'string' || typeof word !== 'string' || word === '') return false;
  const want = word.toLowerCase().split(' ');
  const runs = tokenizeEnglish(text).map((r) => r.text.toLowerCase());
  for (let i = 0; i + want.length <= runs.length; i += 1) {
    let hit = true;
    for (let k = 0; k < want.length; k += 1) {
      if (runs[i + k] !== want[k]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * 逐词覆盖率的**判据**（测试与视图读同一个口径）：一段文本里所有英文词里，
 * 词卡表里查不到的那些。
 * ⚠️ 测试**不只用它**：它另有一把独立的分词尺子（见 `tests/proto-flow.test.mjs`），
 * 否则"分词器把查不到的词整段丢掉"这种变异会让判据与产物一起瞎掉（红线 16）。
 * @param {unknown} text
 * @returns {string[]} 查不到词卡的那些词（空数组 = 覆盖率 100%）
 */
export function uncoveredTokens(text) {
  return tokenizeEnglish(text)
    .map((r) => r.text)
    .filter((w) => lookupCard(w) === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 状态机（流程全在这里；界面只是 `state` 的函数）
// ═══════════════════════════════════════════════════════════════════════════

/** 六个动作面板的 id。`S0` 输入 / `S1` 接住 / `S2` 组装 / `S3` 判定 / `S4` 对照 / `S5` 收录。 */
export const STEPS = Object.freeze(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);

/** 步骤轨上的中文标签（**刻意不用拉丁字母**：屏上任何拉丁字母都得能在词卡里查到）。 */
export const STEP_LABELS = Object.freeze({
  S0: '输入', S1: '接住', S2: '组装', S3: '判定', S4: '对照', S5: '收录',
});

/** 每一屏的标题。 */
export const STEP_TITLES = Object.freeze({
  S0: '说一句中文',
  S1: '接住你说的那句话',
  S2: '把空位补上',
  S3: '这一句对了',
  S4: '两句话摆在一起',
  S5: '收进我的句子',
});

/** 接不住那句话时说的话（**不许回落到固定教点**）。 */
export const NO_POINT_NOTICE =
  '这句我一时接不上——这一屏只做了一句示范，换「今天没什么特殊的，我正常上了半天课」试试。';

/** 学习者点错词块时界面上的小标题。 */
export const HINT_LABEL = '差在哪';

/**
 * 初始状态。`draft` 预填演示那句话，让演示一步可点（不是替学习者决定说什么：
 * 他照样可以改，改完点「接着说」就是他的话）。
 * @returns {{step: string, draft: string, said: string, point: object|null, notice: string|null,
 *   picked: object|null, tried: string[], hint: string|null, sentences: Array<object>}}
 */
export function initialState() {
  return {
    step: 'S0',
    draft: DEMO_INPUT,
    said: '',
    point: null,
    notice: null,
    picked: null,
    tried: [],
    hint: null,
    sentences: [],
  };
}

/**
 * 状态机的**唯一**入口：纯函数，不改 `state`，不创建副作用。
 *
 * 事件表（闭集）：
 *   · `{type:'say', text}`          —— **唯一**携带自由文本的事件，且只在 `S0` 收
 *   · `{type:'beginAssembly'}`      —— S1 → S2（「我自己拼」）
 *   · `{type:'pickChunk', chunkId}` —— S2 → S3（点对）/ 停在 S2（点错 + 一条提示）
 *   · `{type:'compare'}`            —— S3 → S4
 *   · `{type:'collect'}`            —— S4 → S5（进「我的句子」+ 渐进痕迹）
 *   · `{type:'again'}`              —— S5 → S0（保留「我的句子」）
 * 非法转移 / 未知事件一律**原对象返回**（`===` 可判），不悄悄改状态。
 *
 * @param {object} state
 * @param {{type?: string, [k: string]: unknown}} event
 * @returns {object} 新状态（或原状态本身）
 */
export function reduce(state, event) {
  if (state === null || typeof state !== 'object') return state;
  const e = (event !== null && typeof event === 'object') ? event : {};
  switch (e.type) {
    case 'say': {
      if (state.step !== 'S0') return state; // 只有第一步收他的话
      const said = typeof e.text === 'string' ? e.text.trim() : '';
      const point = pickTeachPoint(said);
      if (point === null) {
        // 空话 / 接不上：**停在这一屏**，说一句实情，不回落到固定教点。
        return { ...state, draft: said, said, point: null, notice: NO_POINT_NOTICE };
      }
      return { ...state, draft: said, said, point, notice: null, step: 'S1' };
    }
    case 'beginAssembly':
      if (state.step !== 'S1' || state.point === null) return state;
      return { ...state, step: 'S2' };
    case 'pickChunk': {
      if (state.step !== 'S2') return state; // 判定之后就锁了，避免反复改答案
      const chunk = CHUNKS.find((c) => c.id === e.chunkId);
      if (chunk === undefined) return state;
      if (chunk.correct) {
        return { ...state, step: 'S3', picked: chunk, hint: null, tried: [...state.tried, chunk.id] };
      }
      // 点错：**不推进**，不批评，给一条**具体**提示（提示逐字来自任务书），并记住这个块试过。
      return {
        ...state,
        hint: chunk.hint,
        tried: state.tried.includes(chunk.id) ? state.tried : [...state.tried, chunk.id],
      };
    }
    case 'compare':
      if (state.step !== 'S3' || state.picked === null) return state;
      return { ...state, step: 'S4' };
    case 'collect': {
      if (state.step !== 'S4' || state.picked === null || state.picked.correct !== true) return state;
      const item = {
        zh: state.said,
        en: fillBlank(state.picked.text), // 单一出处：不另抄一份"更自然的整句"
        chunk: state.picked.text,
        chunkZh: state.point === null ? '' : state.point.gloss,
      };
      return { ...state, step: 'S5', sentences: [...state.sentences, item] };
    }
    case 'again':
      if (state.step !== 'S5') return state;
      // 换一句：流程回到起点，「我的句子」留着（渐进痕迹就是它）。
      return { ...initialState(), sentences: state.sentences };
    default:
      return state;
  }
}

/**
 * 状态机的运行时外壳：`send` 收集事件（界面侧只从点击里发事件），供视图与测试共用。
 * **它也不碰任何浏览器全局**——`flow.view.mjs` 拿到它，再决定怎么画。
 * @param {object} [start] 初始状态（缺省 `initialState()`）
 * @returns {{state: object, events: Array<object>, send: (event: object) => object}}
 */
export function createRuntime(start = initialState()) {
  let state = start;
  const events = [];
  return {
    get state() { return state; },
    /** 这一路走过来发过的事件（测试用它断言"除第一步外没有事件带文本"）。 */
    get events() { return events.slice(); },
    send(event) {
      events.push(event);
      state = reduce(state, event);
      return state;
    },
  };
}

/**
 * S5 的渐进痕迹，**由状态算出来**（`今天几句` / `新用上的结构`），
 * 演示状态下**逐字等于**任务书给的 `PROGRESS_LINE`——测试钉住这条等式。
 * 为什么不直接在界面里印那个常量：句数是状态里的事实，印常量就是给同一件事造第二个出处。
 * @param {Array<{chunk: string, chunkZh: string}>} sentences 「我的句子」列表
 * @returns {string}
 */
export function progressLine(sentences) {
  const list = Array.isArray(sentences) ? sentences : [];
  const n = list.length;
  const last = n > 0 ? list[n - 1] : null;
  if (last === null || typeof last !== 'object') return `今天 ${n} 句`;
  return `今天 ${n} 句 · 新用上：${last.chunk}（${last.chunkZh}）`;
}

/** 这一屏要用到的、写死在界面上的英文（供测试做逐词覆盖率的正向控制）。 */
export const LESSON_ENGLISH = Object.freeze([BLANK_SENTENCE, NATURAL_SENTENCE]);
