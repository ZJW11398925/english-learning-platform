// web/units/write/validate.mjs
//
// 机械护栏层：把"提示词里写死的行为约束"变成**会让测试变红**的判据。
// 这是本形态与旧形态最要紧的一处分别——旧形态的所有验收判据都是"`node --test` 不红"，
// 没有一条问过"它教到东西了吗"；而"提示词工程"在本项目第一次变成**可验证工程**，
// 靠的就是这一层：凡是模型说了算的地方，程序都不信。
//
// ── 五条判据（前三条判 ①「读这一版」，后两条判 ②「改这一版」）──────────────────
//   V1 每条教点的 `quote` **逐字可追溯**到他写的那一版（归一空白后是它的子串）
//   V2 输出里不得出现原句没有的**大写词/数字**（句外的人事词）
//   V3 `canHelp` / `canTeach === false` 时**原样透出 reason、程序绝不补内容**
//   V4 `issue` **恰好一处**
//   V5 `glosses` 的 `word` 必须**逐字出现在 `system` 里**
//
// ── 判据与提示词是**两份**，且都要在 ──────────────────────────────────────────
// 提示词里写一遍（劝模型），这里再写一遍（机械判）。只有前者时，模型不听话就没人知道；
// 只有后者时，模型会经常撞墙。两份都在的前提下，**这里的结论是权威**。
//
// ── `source` 的定义（这一层最容易被搞错的地方）────────────────────────────────
// `source` = **他写的那一版**（不是中文原话、不是素材、不是系统版）。
// 传错 source 会让 V1/V2 变成假绿：拿系统版当 source，系统版自然包含自己的每一个词。
// 调用点（`./engine.mjs`）传的是 `draft`，测试里对每条判据都有**反向控制**
// （故意传一个错的 source，断言它必须报违规）。
//
// ── 为什么 V2 要跳过"句首词"与"引号里的话" ────────────────────────────────────
// 句首词天然大写（`Today I went…`），那不是"句外的人事词"；模型引用学习者原句片段时
// 引号里的内容本来就属于他。两条豁免都写在 `findForeignEntities` 里，并且**都有测试钉住**
// （既钉"该报的报得出来"，也钉"不该报的不许报"——否则这条判据会被噪声淹没而失效）。
//
// 纯逻辑模块：零 import、零浏览器 API、零副作用——可在 Node 中直接测、直接变异。

/** 归一空白：所有空白序列（含换行）折成一个空格，并剪掉首尾。比较文本一律先过它。 */
export function collapseWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/**
 * V1：`quote` 是不是 `source` 里**逐字**出现的一段。
 *
 * 先按归一空白口径比（大小写敏感）——那是"逐字复制"的字面口径。
 * 再不敏感地比一次：模型把 `Yesterday` 抄成 `yesterday` 是**抄写噪声**，不是编造
 * （编造是"这句话里根本没有这几个词"，那两种必须分开：前者放过，后者必须报）。
 * 反过来，**长度不是判据**：一个词的 quote（`I go`）只要真的在，就是合法教点。
 *
 * @param {unknown} quote
 * @param {unknown} source 他写的那一版
 * @returns {boolean}
 */
export function quoteIsTraceable(quote, source) {
  if (typeof quote !== 'string' || typeof source !== 'string') return false;
  const q = collapseWhitespace(quote);
  const s = collapseWhitespace(source);
  if (q === '' || s === '') return false;
  if (s.includes(q)) return true;
  return s.toLowerCase().includes(q.toLowerCase());
}

/** 词元扫描：英文词（带撇号/连字符）与数字，附句首标记与"是否在引号里"。 */
const TOKEN_RE = /[A-Za-z][A-Za-z'’-]*|\d+(?:[.,]\d+)?/g;
const SENTENCE_END = /[.!?;:。！？；：]$/;
const ALL_CAPS = /^[A-Z][A-Z'’-]*$/;

/**
 * 一个词元扫出来时，它是不是"句首"（因而首字母大写不算异常）。
 * 行首与紧跟句末标点的位置都算——提示词与模型输出都用换行分行，换行后的首词同样是大写。
 */
function isSentenceInitial(prevToken) {
  return prevToken === null || SENTENCE_END.test(prevToken);
}

/**
 * V2：找出**输出里有、原句里没有**的大写词与数字（= 句外的人事词）。
 *
 * 判据（三条，任一成立即算候选）：非句首且首字母大写 / 全大写 / 含数字。
 * 候选再与原句比：**逐字出现**（大小写敏感）就放过（引号里的词、以及他本来就写过的人名地名）。
 * 两个豁免：句首词（天然大写）、双引号/中文引号里的内容（模型在引用他的话）。
 *
 * ⚠️ **口径的边界（如实登记）**：`I / I'm / My / The` 这类词若在他那一版里，
 * 逐字比得上就放过；若他**根本没写过** `I`（比如写了 `Me go school`），系统版里的 `I`
 * 会被报成"句外词"。这是**有意取的保守口径**：宁可多报一次让人看见，也不放过一次编造——
 * 编造正是真实用户否掉旧形态的原因之一（"房东与续租"出现在他只说了上课的时候）。
 *
 * @param {unknown} text 输出（通常是 `revise.system`）
 * @param {unknown} source 他写的那一版
 * @returns {string[]} 去重后的问题词元，按出现顺序
 */
export function findForeignEntities(text, source) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const src = typeof source === 'string' ? source : '';

  // 引号里的片段：模型引用学习者原话时，里面的词不该被当成"它带进来的"。
  // ⚠️ 引号字符里**不含 ASCII 单引号**：`don't` / `learner's` 里的撇号会被它错当成配对引号，
  // 于是从第一个撇号到下一个撇号之间的一切都被豁免——那会把这条判据悄悄变成空判据。
  // 只认无歧义的成对引号（弯引号与中文书名号/引号）。
  const quoted = [];
  const quoteRe = /[""「」『』"]([^""「」『』"]*)[""「」『』"]/g;
  let qm = quoteRe.exec(text);
  while (qm !== null) {
    quoted.push(qm.index);
    quoted.push(qm.index + qm[0].length);
    qm = quoteRe.exec(text);
  }
  const insideQuote = (i) => {
    for (let k = 0; k < quoted.length; k += 2) if (i > quoted[k] && i < quoted[k + 1]) return true;
    return false;
  };

  const found = [];
  const seen = new Set();
  TOKEN_RE.lastIndex = 0;
  let m = TOKEN_RE.exec(text);
  let prevToken = null;
  let prevEnd = -1;
  while (m !== null) {
    const token = m[0];
    const start = m.index;
    // 换行是硬边界：换行之后的第一个词按句首处理（提示词与产物都是分行写的）。
    const lineBreakBefore = prevEnd >= 0 && /\n/.test(text.slice(prevEnd, start));
    const sentenceInitial = lineBreakBefore || isSentenceInitial(prevToken);
    // 句首词天然大写（`Today I went…`），不是"句外的人事词"——但**句首的数字不算豁免**
    // （`2024 was hard`，而他从没说过 2024，那正是编造）。
    const entityCandidate = /\d/.test(token)
      || /^[A-Z]/.test(token)
      || ALL_CAPS.test(token);
    const exempt = sentenceInitial && !/\d/.test(token);
    if (entityCandidate && !exempt && !insideQuote(start) && !src.includes(token)) {
      if (!seen.has(token)) { seen.add(token); found.push(token); }
    }
    prevToken = token;
    prevEnd = start + token.length;
    m = TOKEN_RE.exec(text);
  }
  return found;
}

/** V3（读）：`canHelp===false` 时**只许**有一句 reason，不许有任何内容。 */
function checkRefusalRead(read, violations) {
  const hasContent = Object.values(read.hint ?? {}).some((tier) => tier !== null)
    || read.teachPoints.length > 0;
  if (hasContent) {
    violations.push('V3: canHelp===false 时不许给出任何提示或教点（程序绝不补内容，模型也不许补）');
  }
  if (read.reason === null) {
    violations.push('V3: canHelp===false 必须给出 reason（"不接"要有一句为什么，否则界面上是空白）');
  }
}

/**
 * V1–V3：判「读这一版」。
 *
 * @param {unknown} read `normalizeRead` 的产物
 * @param {unknown} source 他写的那一版
 * @returns {{ok: boolean, violations: string[]}} 每条违规都点名判据与位置（能直接进日志）
 */
export function validateRead(read, source) {
  const violations = [];
  if (read === null || typeof read !== 'object') {
    return { ok: false, violations: ['形状: read 不是对象（parse 阶段就该判死）'] };
  }
  if (read.canHelp === false) {
    checkRefusalRead(read, violations);
    return { ok: violations.length === 0, violations };
  }
  if (read.canHelp !== true) {
    return { ok: false, violations: ['形状: canHelp 不是布尔'] };
  }

  // V3 的反面：说"接得住"就得真的给出东西——否则界面上是三个空台阶 + 一个空候选表。
  const tiers = Object.values(read.hint ?? {}).filter((tier) => tier !== null);
  if (tiers.length === 0) {
    violations.push('V3: canHelp===true 却一个类目的提示都没有（"接得住"必须体现在内容上）');
  }
  if (read.teachPoints.length === 0) {
    violations.push('V3: canHelp===true 却一个教点都没有（他无从挑起）');
  }

  read.teachPoints.forEach((tp, i) => {
    // V1：教点的每一个片段字段都必须逐字可追溯——`quote` 是"教点锚在他哪几个字上"的证据。
    if (tp.quote.trim() === '') {
      violations.push(`V1: 教点 #${i + 1}（${tp.key}）没有 quote——教点必须锚在他写过的字上`);
    } else if (!quoteIsTraceable(tp.quote, source)) {
      violations.push(`V1: 教点 #${i + 1}（${tp.key}）的 quote 无法逐字追溯：${JSON.stringify(tp.quote)}`);
    }
    // V2：教点标签里不许出现句外的大写词/数字（`label` 是中文，但模型可能塞了英文专名）。
    const foreign = findForeignEntities(`${tp.label} ${tp.quote}`, source);
    if (foreign.length > 0) {
      violations.push(`V2: 教点 #${i + 1} 出现原句没有的词：${foreign.join(', ')}`);
    }
  });

  return { ok: violations.length === 0, violations };
}

/**
 * V2/V4/V5：判「改这一版」。
 *
 * @param {unknown} revise `normalizeRevise` 的产物
 * @param {unknown} source 他写的那一版
 * @returns {{ok: boolean, violations: string[]}}
 */
export function validateRevise(revise, source) {
  const violations = [];
  if (revise === null || typeof revise !== 'object') {
    return { ok: false, violations: ['形状: revise 不是对象（parse 阶段就该判死）'] };
  }
  if (revise.canTeach === false) {
    // V3：不教就不许有内容。系统版/为什么/降难度/释义有一项在，就是程序或模型偷偷补了内容。
    const leaked = revise.system !== ''
      || revise.why.length > 0
      || revise.issue !== null
      || revise.simpler !== null
      || revise.glosses.length > 0;
    if (leaked) {
      violations.push('V3: canTeach===false 时不许给出系统版/为什么/标记/降难度/释义');
    }
    if (revise.reason === null) {
      violations.push('V3: canTeach===false 必须给出 reason');
    }
    return { ok: violations.length === 0, violations };
  }
  if (revise.canTeach !== true) {
    return { ok: false, violations: ['形状: canTeach 不是布尔'] };
  }

  // V4：恰好一处。`null`（一处都没标）与形状不对都是违规——本版就是"只标最值得改的一处"。
  if (revise.issue === null) {
    violations.push('V4: 说 canTeach===true 却一处都没标（本版必须标出恰好一处不地道）');
  } else {
    if (revise.issue.quote === null || revise.issue.quote.trim() === '') {
      violations.push('V4: issue 缺少 quote——"标出一处"必须指出是哪几个字');
    } else if (!quoteIsTraceable(revise.issue.quote, source)) {
      violations.push(`V4/V1: issue.quote 无法逐字追溯：${JSON.stringify(revise.issue.quote)}`);
    }
    if (revise.issue.kind === null) {
      violations.push('V4: issue 缺少 kind——不说为什么，但要说清是哪一类');
    }
  }

  // V2：系统版与原句标记里不许出现句外的大写词/数字。
  const foreign = findForeignEntities(revise.system, source);
  if (foreign.length > 0) {
    violations.push(`V2: system 出现原句没有的词/数字：${foreign.join(', ')}`);
  }
  if (revise.issue !== null && revise.issue.quote !== null) {
    const foreignQuote = findForeignEntities(revise.issue.quote, source);
    if (foreignQuote.length > 0) {
      violations.push(`V2: issue.quote 出现原句没有的词：${foreignQuote.join(', ')}`);
    }
  }

  // V5：每一条释义的词必须**逐字**出现在系统版里（模型最容易在这里编词：解释一个它没用的词）。
  const system = revise.system.toLowerCase();
  revise.glosses.forEach((g, i) => {
    if (!system.includes(g.word.toLowerCase())) {
      violations.push(`V5: 释义 #${i + 1} 的 word（${JSON.stringify(g.word)}）没有逐字出现在 system 里`);
    }
  });

  return { ok: violations.length === 0, violations };
}
