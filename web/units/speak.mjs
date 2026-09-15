// web/units/speak.mjs
//
// 跟读判定（设计文档 §4.3）：**只判"有没有说出目标词"**，不做音素级音准评分——那是本切片
// 显式写下的妥协（§4.3 + Global Constraints）。所以本模块里不会出现相似度、置信度、
// 打分或"念得好不好"这类东西：判据只有一个布尔。
//
// 两条输入、两个输出，**零浏览器 API、零 import、零副作用**：转写由调用方（`web/app.mjs`）
// 从浏览器引擎拿到后传进来，本模块只做纯文本判定，于是它能在 Node 里直接测
// （`tests/speak.test.mjs`）。这也是"纯逻辑单元与外部依赖严格分离"这条架构纪律的落点：
// `SpeechRecognition` 的可用性判定（`isSpeechAvailable`）收的是**传进来的那个对象**，
// 本模块自己不读 `window`、不读 `globalThis`——测试注入一个假 window 就能驱动它。
//
// ── token 规则（判定的全部内容）────────────────────────────────────────────────
//
// 目标词与转写**用同一套切词规则**切成 token（小写 → 按非字母、非撇号的字符切 → 去掉空串），
// 再判"目标词的 token 序列是否在转写的 token 序列里**连续出现**"：
//   · `mug`     vs `I see a Mug.`      → 说出（大小写与标点无关）
//   · `mug`     vs `mugshot`           → 没说（词的一部分不算，避免与合成词混淆）
//   · `mug`     vs `two mugs`          → 没说（复数/派生形式是别的词，首版不猜词形）
//   · `mug`     vs `mug2` / `mug的`    → 说出（数字与非 ASCII 都当分隔符，于是它与 `mug 2` 同形）
//   · `notebook computer` vs `I have a notebook computer at home.` → 说出（连续出现）
//   · `notebook computer` vs `a notebook.` / `computer notebook` / `notebook and computer`
//                                      → 都没说（不完整 / 词序颠倒 / 中间插了别的词）
//   · `ice-cream` vs `ice cream`       → 说出（连字符与空格同形：两者都只是分隔符）
//
// 为什么**不是**"子串包含"：那会让 `mugshot` 命中 `mug`（计划自带的用例就是为这条写的），
// "有没有说出这个词"于是不再成其为判据。
//
// 多词目标词这条规则是一次**口径变更**（控制器裁定，理由与影响面见 task-9-report）：
// 更早的实现把目标词整体当一个 token 去比，任何含空格/连字符的目标词**永远判不出"说出"**；
// 而那是**可达**的（`web/app.mjs` 的 ACCEPTABLE_SETS 里就有
// `laptop: ['laptop', 'notebook computer']`），于是用户念对了也会被判"没说"、
// 重试永远过不去、界面还不告诉他这个词首版判不了——一处用户可见的静默失败。
// **单词目标词的行为在这次变更里一字未变**（原 brief 的 5 条用例逐字保留且全绿）。
//
// ── 转写原样保留 ──────────────────────────────────────────────────────────────
//
// 返回值里的 `transcript` **逐字**带回调用方给出的那个字符串（不 trim、不改写、不动大小写），
// 即使它是 `null`/`undefined`（归一成空串）。理由：它是"用户到底说了什么"的唯一证据，
// 是复核"引擎是不是听错了"以及将来做人工标注的唯一凭据；在这里顺手规整一下，
// 就等于把证据改掉了，而且改得没人看得见。

/** 切词：小写 → 按非字母、非撇号的字符切 → 去掉空串。目标词与转写**共用**这一条规则。 */
const tokenize = (s) => String(s ?? '').toLowerCase().split(/[^a-z']+/).filter(Boolean);

/**
 * `seq` 是否在 `tokens` 里**连续出现**。
 *
 * 逐位置比较，**不用 join 拼串再 includes**——拼串会让"子串包含"混回来（`mug` 命中 `mugshot`）。
 * 第一句是**唯一**处理"空序列"的地方（判定默认值必须是"没说"）：删掉它，空目标词就会命中
 * 任何非空转写——一条配置错误（词表里写了空串）会让所有人**自动**通过跟读。
 * 序列比转写还长时不必单独判断：下面的循环边界天然一次都不进，直接返回 false。
 */
function containsSequence(tokens, seq) {
  if (seq.length === 0) return false;
  for (let i = 0; i + seq.length <= tokens.length; i += 1) {
    let j = 0;
    while (j < seq.length && tokens[i + j] === seq[j]) j += 1;
    if (j === seq.length) return true;
  }
  return false;
}

/**
 * 只判"有没有说出目标词"。永不抛错（转写是外部引擎给的，什么形状都可能）。
 *
 * @param {unknown} targetWord 目标词（大小写无关；切完一个 token 都不剩时判"没说"）
 * @param {unknown} transcript 语音引擎给的转写文本（**原样带回来**，不规整）
 * @returns {{ said: boolean, transcript: string }} `transcript` 是原样的转写（空值归一成 `''`）
 */
export function checkSpeech(targetWord, transcript) {
  const raw = String(transcript ?? '');
  // 「目标词切完没有 token」与「转写切完没有 token」两种情形都由 `containsSequence` 收口
  // （前者是空 seq、后者是空 tokens），这里**不再另加一层早退**——同一件事只有一个起源，
  // 否则会出现"两处机制产出同一结果、删掉哪一处测试都不红"的那种没人验证的冗余。
  return { said: containsSequence(tokenize(raw), tokenize(targetWord)), transcript: raw };
}

/**
 * 这个环境能不能做转写。
 *
 * @param {unknown} win 浏览器里传 `globalThis`（或注入的替身）；判定只认**函数**，
 *   因为调用方会 `new` 它——同名字段是个对象/字符串时判"可用"，等于把一次
 *   "点击即崩"留给用户（`tests/speak.test.mjs` 有这一层用例）。
 * @returns {boolean}
 */
export function isSpeechAvailable(win) {
  return typeof win?.SpeechRecognition === 'function'
    || typeof win?.webkitSpeechRecognition === 'function';
}
