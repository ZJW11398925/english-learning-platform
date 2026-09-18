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
//   V3 `canHelp` / `canTeach === false` 时**原样透出 reason、程序绝不补内容**；
//      反过来 `canHelp === true` 时必须**真的给出东西**（提示那一栏非空）——
//      ⚠️ 唯一的例外：**草稿归一空白时允许 `teachPoints` 为空**（一个字都没写 ⇒ 无处可锚，
//      见 `validateRead` 里那条）。"他还没写"不是"接不住"，也不是"模型可以编一个教点"。
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

/**
 * 词元扫描：英文词（带撇号/连字符）与数字，附句首标记与"是否在引号里"。
 *
 * ⚠️ **缩写的后缀必须是词元的一部分**——旧写法（`[A-Za-z][A-Za-z'’-]*`）会把 `I've` 切成
 * `I` + `ve`（撇号不在字符类里），于是**报出来的是 `I've` 这个词，判的却是 `I` 在不在他原句里**。
 * 这是 TASK F 复跑实测到的**第二个误杀**（与 D3 同类）：
 *   learner 写 `…because I haven't been sleeping well.`，系统版写 `This week I've been feeling…`
 *   ⇒ 报 `I've` 是"句外词" ⇒ **整份 ② 作废**（那一版的 system 其实是一次正确的时态改进）。
 *   根因是 `I've` 与 `haven't` 里的 `n't` 一样，**撇号在 `TOKEN_RE` 的字符类里根本不存在**
 *   （`'-` 之间那个撇号是**弯撇号 U+2019**，ASCII 撇号漏了）⇒ `ve` 成了独立词元、`I` 也是。
 * 修法两条（缺一不可，两条都有断言）：
 *   ① `(?:['’][A-Za-z]+)?` 把缩写后缀并进同一个词元（两种撇号都认）；
 *   ② 词元里带撇号时，**前缀也在原句里**就一并放过——`I've` 的 `I` 他明明写过（见 `baseKnown`）。
 * 数字词元仍不带后缀（`3.5` 不会被 `3.5's` 吃掉）；撇号开头（引号里的 `'quoting'`）不误当词元开头。
 */
const TOKEN_RE = /[A-Za-z][A-Za-z'’-]*(?:['’][A-Za-z]+)?|\d+(?:[.,]\d+)?/g;
/** 句末标点（英文与中文句读）。只看**最后一个字符**——见 `hasSentenceEnd` 的说明。 */
const SENTENCE_END = /[.!?;:。！？；：]$/;
const ALL_CAPS = /^[A-Z][A-Z'’-]*$/;
/**
 * 两个词元之间的那段空隙里**是不是新起了一句**：句末标点 + 同一行内的空白。
 *
 * ⚠️ **这一条曾经是恒为 false 的死代码**（D3，实弹暴露、发布阻断级）——
 * 旧写法判的是 `SENTENCE_END.test(prevToken)`，而 `TOKEN_RE` 只匹配词与数字，
 * **标点从来不进 `prevToken`**，于是"句号后的第一个词"永远拿不到句首豁免：
 *   `…went. The mountains…`（句号后**空格**）⇒ 报 `["The"]` ⇒ 整个 ② 作废、屏幕全空；
 *   `…went.⏎The mountains…`（句号后**换行**）⇒ 放行（那一支走的是换行）。
 * 同一条口语规则在两种排版下判定相反 ⇒ 模型写多句英文是常态，这在真实使用里会反复发生。
 *
 * 所以句首的判据必须看**词元之间的原文**，不能只看上一个词元：标点在 `TOKEN_RE` 的眼里不存在，
 * 但在文本里真实存在。`[^\S\n]*` 只吃同一行内的空白（空格/制表），**换行由单独一支管**——
 * 两支分开才能让"空格"与"换行"给出同一个答案（正是这次修的东西）。
 */
const INLINE_SENTENCE_START = /[.!?;:。！？；：][^\S\n]*$/;

/**
 * **称谓/头衔**：这些词本身就是"我在说一个具体的人"的标记，所以它们**不享受句首豁免**。
 *
 * ⚠️ 这一条是 D3 修法**自己带出来的回归**（我实测发现的，任务书没预料到）：
 * 把"行内句号后的第一个词"纳入句首豁免之后，`…class. Mr Smith agreed.` 里的 `Mr`
 * 从"被抓"变成"被豁免"（`Smith` 仍被抓，因为它是句中词）——**判别力被削了一角**。
 * 而"不许靠削掉护栏来消除误杀"是本次的硬红线，所以不能就这么算了。
 *
 * 为什么是"称谓表"而不是"不许句首大写"：句首词天然大写（`Today I went…`），
 * 而"哪一个大写词是名字、哪一个是普通的句子开头"**不是机械可判的**
 * （这正是本条判据当初就要豁免句首词的原因）。称谓表是**有界且可枚举**的那一小块——
 * 它覆盖真实语料里最常见的那一类（"编造出一个人"），且不会误伤 `The` / `Today`。
 * **如实登记代价**：句首的**普通名字**（`Beijing is far.` / `Smith agreed.`）仍然抓不到，
 * 那是句首豁免本身的代价、不是这次修出来的（见测试里那条同义的既有断言）。
 */
const TITLES = /^(mr|mrs|ms|miss|dr|prof|sir|madam|madame|lord|lady|saint|st)\.?$/i;

/**
 * 一个词元扫出来时，它是不是"句首"（因而首字母大写不算异常）。
 *
 * ⚠️ **三条判据都要留着**（它们覆盖不同的写法，各自的变异体都改得红，见测试）：
 *   · `prevToken === null`  ⇒ **整个文本的第一个词**（行首），它前面没有任何空隙可看；
 *   · `hasSentenceEnd(prevToken)` ⇒ 句子**跨行**结束（`…went.\n  The mountains…`:
 *     换行与缩进一起吃掉了，`INLINE_SENTENCE_START` 的空隙锚点对不上，这里兜住）；
 *   · 行内句末标点那一支在 `INLINE_SENTENCE_START`——那是 D3 修的那一格。
 */
function isSentenceInitial(prevToken) {
  return prevToken === null || hasSentenceEnd(prevToken);
}

/** 这个词元自己就**以句末标点结尾**（跨行那一支的判据，见 `isSentenceInitial`）。 */
function hasSentenceEnd(token) {
  return SENTENCE_END.test(token);
}

/** 一词元里带撇号（ASCII 或弯撇号）时，它**主干那一段**是不是他写过的词。 */
const APOS_IN_TOKEN = /['’]/;
function baseKnown(token, srcTokens) {
  if (!APOS_IN_TOKEN.test(token)) return false;
  const base = token.split(APOS_IN_TOKEN)[0].toLowerCase();
  // 主干太短（一个字母）时也认——`I've` 的 `I`、`we're` 的 `we` 都是他写过的常见词。
  return base !== '' && srcTokens.has(base);
}

/**
 * 他那一版的**词元集合**（小写）。
 *
 * ⚠️ **必须是集合成员判定，不是子串判定**（TASK F 复跑实测的第三处误杀）：
 * 旧写法用 `srcLower.includes(token.toLowerCase())`，而 `I` 在 `little` / `is` / `in` 里
 * 都能"找到"——一个**单字母词元的子串判定几乎恒为真**，于是 `I` 这类词永远不会被报。
 * 实测的后果：`Me go school` 这种"他根本没写过 I"的草稿里，系统版的 `I` **不会**被报出来
 * （而该判据的注释正是拿这个例子说明它有意保守）。子串判定让"保守"变成了"看不见"。
 * 换成词元集合之后：`Smith's` 的 `Smith`、`I` 这样的词元都按**词**判（`small` 不再匹配 `s`）。
 * 同一把尺子也用在 `quoteIsTraceable` 之外的这一层，不另造第二个出处：词元由同一个 `TOKEN_RE` 切。
 */
function tokensOf(text) {
  const out = new Set();
  if (typeof text !== 'string' || text === '') return out;
  TOKEN_RE.lastIndex = 0;
  let m = TOKEN_RE.exec(text);
  while (m !== null) {
    out.add(m[0].toLowerCase());
    m = TOKEN_RE.exec(text);
  }
  return out;
}

/**
 * V2：找出**输出里有、原句里没有**的大写词与数字（= 句外的人事词）。
 *
 * 判据（三条，任一成立即算候选）：非句首且首字母大写 / 全大写 / 含数字。
 * 候选再与原句比：**这个"词"在他那一版里出现过**就放过（引号里的词、他本来就写过的人名地名）。
 * 两个豁免：句首词（天然大写）、双引号/中文引号里的内容（模型在引用他的话）。
 *
 * ⚠️ **口径的边界（如实登记）**：`I / I'm / My / The` 这类词若在他那一版里就放过；
 * 若他**根本没写过** `I`（比如写了 `Me go school`），系统版里的 `I` 会被报成"句外词"。
 * 这是**有意取的保守口径**：宁可多报一次让人看见，也不放过一次编造——
 * 编造正是真实用户否掉旧形态的原因之一（"房东与续租"出现在他只说了上课的时候）。
 *
 * ⚠️ **第二条边界（TASK F 复跑实测后登记的）**：缩写只按**主干**判。
 * `I've` 的 `I` 他写过 ⇒ 放过——**哪怕他把 `I have` 写成了 `I haven't`**（助动词/极性改了，
 * 那是"意思被改"而不是"编了个人事词"，本判据管不了，见报告）。反过来 `Smith's` 的 `Smith`
 * 他没写过 ⇒ 照报。**"句子的意思有没有被改"没有任何机械判据**，这是已知缺口。
 *
 * @param {unknown} text 输出（通常是 `revise.system`）
 * @param {unknown} source 他写的那一版
 * @returns {string[]} 去重后的问题词元，按出现顺序
 */
export function findForeignEntities(text, source) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const src = typeof source === 'string' ? source : '';
  /** 他那一版的**词元集合**（不是小写整串——子串判定的坑见 `tokensOf` 的说明）。 */
  const srcTokens = tokensOf(src);

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
    // 两个词元之间的**原文**——标点只活在这里（`TOKEN_RE` 只匹配词与数字）。
    const gap = prevEnd >= 0 ? text.slice(prevEnd, start) : '';
    // 换行是硬边界：换行之后的第一个词按句首处理（提示词与产物都是分行写的）。
    const lineBreakBefore = /\n/.test(gap);
    // 行内的句末标点同样是硬边界（D3）：`…went. The…` 与 `…went.⏎The…` 必须给同一个答案。
    const inlineSentenceBefore = INLINE_SENTENCE_START.test(gap);
    const sentenceInitial = prevToken === null || lineBreakBefore || inlineSentenceBefore
      || isSentenceInitial(prevToken);
    // 句首词天然大写（`Today I went…`），不是"句外的人事词"——但**句首的数字不算豁免**
    // （`2024 was hard`，而他从没说过 2024，那正是编造）。
    const entityCandidate = /\d/.test(token)
      || /^[A-Z]/.test(token)
      || ALL_CAPS.test(token);
    const exempt = sentenceInitial && !/\d/.test(token) && !TITLES.test(token);
    // ⚠️ 与原句比是**按词**的（大小写不敏感）：判据问的是"他写过这个词没有"，
    // 而 `Mr` / `mr` 是同一个词。旧写法用大小写敏感的 `src.includes(token)`，他写过 `mr` 时
    // 系统版里的 `Mr` 会被误报；而"整串子串判定"更坏（单字母词元几乎恒为真，见 `tokensOf`）。
    if (entityCandidate && !exempt && !insideQuote(start)
      && !srcTokens.has(token.toLowerCase()) && !baseKnown(token, srcTokens)) {
      if (!seen.has(token)) { seen.add(token); found.push(token); }
    }
    prevToken = token;
    prevEnd = start + token.length;
    m = TOKEN_RE.exec(text);
  }
  return found;
}

// ────────────────────── 1 级提示不许漏答案（D4）──────────────────────
//
// 实弹里 5 个回合有 **1 个**的 1 级提示直接把答案词说了出来（topic-3 的 `word` 类目：
// 「…英文你想用哪个动词？**它和 surprise 是一家**」，而 3 级正是 `surprise（过去式 surprised）`）。
// 「1 级 = 最小提示」是本形态的核心承诺（提示词里也写着 `step 1 = the smallest nudge`），
// 所以它和 V1–V5 一样要有**机械判据**——不能只靠提示词自律。
//
// ── 口径怎么定的（**代理口径，不是"1 级里不许出现英文"**）────────────────────
// 机械判据只能代理，代理口径写在这里，说清它拦什么、放过什么：
//   · 比的是 **1 级 ∩（2/3 级）里的英文词**。1 级该给的是**问法与方向**，
//     不是答案里的那几个词 ⇒ 一旦共享，它就是在把答案往前挪。
//   · **扣掉他那一版里已经有的词**：他自己写过的词不可能是"泄漏"，
//     而且 1 级本来就**该**引用他写过的字（「你已经有了 boss、me…」是合格的 1 级提示）。
//   · **扣掉功能词/超高频词**（`HINT_STOP_WORDS`）：`the` / `me` / `a` / `day` 这类词
//     出现在任何句子里，共享它们不构成泄漏；不扣就会把这条判据淹没在噪声里而失效。
//     代价如实登记：**真的**把 `day` 这类词当答案教的 1 级提示，这条判据抓不到。
//
// ⚠️ 这条判据**只判"答非所问"那一种坏**（把答案说了）；判不了"1 级太笼统"。
// 反向控制（一条编的泄漏必须被拦）与既有真模型语料都被测试钉住，见
// `tests/write-prompt-parse-validate.test.mjs`。

/**
 * 三级台阶的三个类目 —— 与 `./flow.mjs` 的 `HINT_CATEGORIES`、`./parse.mjs` 的 `HINT_KEYS`
 * **同一组**（它们各自是纯逻辑模块、零 import，所以这一组名字在三个文件里各写了一遍；
 * 三处对不上就等于"某个类目的提示永远取不到"，`tests/write-prompt-parse-validate.test.mjs`
 * 有一条断言把这三份钉在一起）。
 */
const HINT_CATEGORIES = ['word', 'structure', 'content'];

/**
 * 1 级提示里那些**不算泄漏**的词：功能词与超高频词。
 * 这份表**只服务于这一条判据**，改它等于改判据的宽严——所以它就在这里、注释里写明代价。
 */
const HINT_STOP_WORDS = new Set([
  // 代词 / 限定词 / be / have / do / 情态
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'this', 'that', 'these', 'those',
  'a', 'an', 'the', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'not',
  // 连词 / 介词 / 疑问词 / 常用副词
  'and', 'or', 'but', 'so', 'if', 'when', 'while', 'because', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'with', 'about', 'from', 'into', 'out', 'up', 'down', 'off', 'over',
  'after', 'before', 'very', 'too', 'also', 'just', 'only', 'still', 'again', 'then',
  'than', 'more', 'most', 'much', 'many', 'some', 'any', 'all', 'other', 'another',
  'same', 'own', 'every', 'no', 'yes', 'here', 'there', 'what', 'which', 'who', 'whom',
  'whose', 'why', 'how', 'where',
  // 时间副词
  'today', 'yesterday', 'tomorrow', 'now', 'always', 'usually', 'often', 'sometimes', 'never',
  // 超高频实词（真有教它们的可能，但共享它们不足以判"漏答案"——代价见上面的登记）
  'go', 'goes', 'going', 'gone', 'went', 'get', 'gets', 'getting', 'got', 'gotten',
  'make', 'makes', 'making', 'made', 'say', 'says', 'said', 'take', 'takes', 'took', 'taken',
  'come', 'comes', 'came', 'see', 'sees', 'saw', 'seen', 'know', 'knows', 'knew', 'known',
  'think', 'thinks', 'thought', 'want', 'wants', 'wanted', 'like', 'likes', 'liked',
  'feel', 'feels', 'felt', 'need', 'needs', 'needed', 'help', 'helps', 'helped',
  'give', 'gives', 'gave', 'given', 'put', 'puts', 'use', 'uses', 'used',
  'day', 'days', 'time', 'times', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'half', 'hour', 'hours', 'minute', 'minutes', 'morning', 'afternoon', 'evening', 'night',
  'good', 'well', 'better', 'best', 'bad', 'worse', 'worst', 'nice', 'fine', 'ok', 'okay',
  'class', 'classes', 'school',
  'one', 'two', 'three', 'first', 'last', 'next',
]);

/** 一段文本里的英文词（小写、去重、按出现顺序）——判据用词元**不用子串**（子串会把 `plan` 匹配进 `plane`）。 */
export function englishWords(text) {
  if (typeof text !== 'string' || text === '') return [];
  const out = [];
  const seen = new Set();
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  let m = re.exec(text);
  while (m !== null) {
    const w = m[0].toLowerCase();
    if (!seen.has(w)) { seen.add(w); out.push(w); }
    m = re.exec(text);
  }
  return out;
}

/**
 * 屈折变体的**同词干**判据：`surprised` 与 `surprise` 是同一个词（要教的正是它）。
 *
 * ⚠️ **有界、且只在长词干上生效**（`HINT_STEM_MIN = 5`）：
 *   · `surprise`→`surpris` / `surprised`→`surpris` ⇒ 同干 ⇒ 判为泄漏（实测需要的正是这一格）；
 *   · `usual`→`usual` / `usually`→`usuall`（**不是** `usual`）⇒ 不同干 ⇒ 不误判
 *     —— 实弹里 topic-1 的 1 级正当地说了 `usually`（他那一版就写错了这个词），不能被当成泄漏。
 * 判据只用于**这一步**（1 级 vs 2/3 级），不去动任何既有的比对口径。
 */
const HINT_STEM_MIN = 5;

/** 粗糙词干（只用来判"是不是同一个词的不同形式"）：去掉常见的屈折后缀，太短的词原样返回。 */
function stemOf(word) {
  const w = String(word).toLowerCase();
  if (w.length < HINT_STEM_MIN) return w;
  // ⚠️ 后缀**从长到短**试：`surprised` 以 `ed` 结尾，而 `surprise` 以 `se` 结尾——
  // 若先试短的，两边的词干就永远对不上（这一条是实测踩到的：判据当时静默失效）。
  for (const suf of ['ing', 'ied', 'ies', 'ed', 'es', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, w.length - suf.length);
  }
  return w;
}

/**
 * 一个词的**词干族**：词干，以及"词干末尾的 e 被吃掉"的那一变体。
 *
 * 为什么需要它：英语屈折会让词干看起来不一样——`surprise` 的词干是 `surprise`
 * （它以 `se` 结尾，没有后缀可去），而 `surprised` 的词干是 `surpris`（`e` 在加 `-ed` 时掉了）。
 * 只比单个词干字符串，这两者**永远匹配不上**，判据在最需要它的那一格上静默失效。
 * 把 `e` 变体一起算进家族，`surprise`/`surprised`、`plan`/`planning` 这类才连得上。
 * 代价如实登记：这是**粗糙的**词干匹配（不是词形还原），它可能把 `use`/`using` 这类
 * 不同词性但同源的词也算成同一个词——在"1 级提示不许说答案"这条判据上，宁可严一点。
 */
function stemFamily(word) {
  const s = stemOf(word);
  const out = [s];
  // ⚠️ `>= HINT_STEM_MIN` 不是笔误：**短词干不许再吃掉自己的 e**。
  // 实测踩到：旧写法（`HINT_STEM_MIN - 1` = 4）让 `w1`→词干 `w`→再产出 `w`，
  // 而 `w` 会撞上 `w2`/`w3` 的词干 `w` ⇒ 判据在一个**字母占位符**的合成响应上报了泄漏。
  // 词干本身够长时才做 e-变体（`surprise`→`surpris`），短词干一律不加。
  if (s.length >= HINT_STEM_MIN && s.endsWith('e')) out.push(s.slice(0, -1));
  return out;
}

/**
 * 1 级提示与后面的台阶**共享了哪些"答案词"**（空数组 = 没漏）。判据口径见上面那一段注释。
 *
 * 两种匹配都算共享：**同一个词**（`surprise`）与**同一个词的不同形式**（`surprised`）。
 *
 * @param {object|null} tier 一个类目的三级台阶 `{1,2,3}`（`./parse.mjs` 的 `normalizeTier` 产物）
 * @param {unknown} source 他写的那一版（**他写过的词一律不算泄漏**，含其屈折形式）
 * @returns {string[]} 泄漏词，按它在 1 级里的出现顺序
 */
export function hintAnswerLeak(tier, source) {
  if (tier === null || typeof tier !== 'object') return [];
  const step1 = typeof tier[1] === 'string' ? tier[1] : '';
  if (step1.trim() === '') return []; // 1 级没有内容不是"漏答案"（那是"这一格没给东西"，另一件事）
  const laterWords = [...englishWords(tier[2]), ...englishWords(tier[3])];
  const later = new Set(laterWords);
  const laterStems = new Set(laterWords.flatMap(stemFamily));
  const draftWords = englishWords(source);
  const inDraft = new Set(draftWords);
  const inDraftStems = new Set(draftWords.flatMap(stemFamily));
  const out = [];
  for (const w of englishWords(step1)) {
    if (HINT_STOP_WORDS.has(w)) continue;
    const family = stemFamily(w);
    if (inDraft.has(w) || family.some((s) => inDraftStems.has(s))) continue;
    if (later.has(w) || family.some((s) => laterStems.has(s))) out.push(w);
  }
  return out;
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
  // ⚠️ **教点这一条对"一个字都没写"的草稿要放宽**（这是 ① 可以被"求提示"提前调用的前提）：
  // 教点必须锚在他写过的字上（V1）——草稿归一空白时**无处可锚**，逼模型给出教点只会得到
  // 编造的 quote（然后被 V1 拦下），于是"他还没写就点提示"这条路永远走不通。
  // 空白草稿的 `hint` 锚在**他的中文原话/素材**上（提示词里写死了，见 `./prompt.mjs`），
  // 那一栏仍然必须非空（上面那条管着）。草稿非空时**旧规则一字不变**：给了 canHelp:true
  // 就必须给出教点。
  const draftEmpty = collapseWhitespace(source) === '';
  if (read.teachPoints.length === 0 && !draftEmpty) {
    violations.push('V3: canHelp===true 却一个教点都没有（他无从挑起）');
  }

  // HINT_LEAK（D4）：1 级是最小提示，**不许把答案里的词说出来**。
  // 三个类目各自判——某一路漏了不该让另外两路连坐（违规文案里点名是哪个类目）。
  for (const cat of HINT_CATEGORIES) {
    const leak = hintAnswerLeak(read.hint?.[cat] ?? null, source);
    if (leak.length > 0) {
      violations.push(
        `HINT_LEAK: 「${cat}」的 1 级提示说出了答案里的词（${leak.join(', ')}）——1 级只许给问法与方向`,
      );
    }
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
