// web/units/write/prompt.mjs
//
// 这条链路**只有两次模型调用**，两次的提示词都在这里：
//   ① `buildReadMessages`   —— 「读他这一版」：接不接得住 + 三级台阶的提示 + 2–3 个教点候选；
//   ② `buildReviseMessages` —— 「改他这一版」：一处不地道的标记 + 系统版 + 每处一句为什么
//                              + 降难度两档 + 逐词释义。
//
// ── 为什么每条行为约束都单独成一个常量 ────────────────────────────────────────
// 与 `../compose.mjs` 的四条规则同一个理由，而且这里更狠：**"整段提示词里出现过某几个字"
// 这种断言拦不住"把其中一条删掉"**。拆成常量之后每条都能被单独断言、被变异探针单独钉住。
// 但**提示词永远是"劝"，不是"保证"**——真正的判定权在 `./validate.mjs`（机械可校验的三条）
// 与 `./parse.mjs`（形状）。本模块的一句纪律：**凡是能写成机械判据的约束，
// 提示词里写一遍、校验器里再写一遍**；只写在提示词里的那些，报告里必须如实标注"无机械护栏"。
//
// ── 两次调用各自看得见什么（这一节是产品口径，不是排版）────────────────────────
// ① 看得见：中文原话 / 素材 / 他写的这一版 / 三级台阶要按三类给（想不起词·不会搭结构·没想好怎么说）。
// ② 看得见：**他挑中的那个教点**（`pickedTeachPoint`）。这是本形态与旧形态的关键分野：
//    教点什么由程序交出去、他挑了哪一个由程序收回来、再作为 ② 的输入发出去——
//    若挑了不影响 ②，这个选择就是装饰性的（旧形态正是因为做了假选择被真实用户否掉）。
//
// ── 长度与语言口径 ────────────────────────────────────────────────────────────
// 学习者是中文母语的成人初学者：`why`（为什么）与 `glosses.zh`（词义）用中文；
// `system`（系统版）与 `simpler.half`/`simpler.easy`（降难度两档）是**英文**——
// 那是给他"照着说一遍"的示范句，翻成中文就没有示范作用了。
//
// 纯逻辑模块：零 import、零浏览器 API、零副作用——可在 Node 中直接测。
// `/v1/chat/completions` 的请求头、超时、失败分档都在 `./client.mjs`，本模块**不碰网络**。

/**
 * 提示词版本号（`w1` → `w2`：D4 收紧 1 级提示；`w2` → `w3`：2026-09-19 给"能帮（台阶锚中文）
 * 但草稿无可锚教点"的输入补**第三条道**——空 teachPoints + 一句中文 reason；改提示词就改它，
 * 成本账与效果账要能区分"哪一代提示词"）。
 */
export const PROMPT_VERSION = 'w3';

// ─────────────────────────── ① 「读这一版」───────────────────────────

/** 角色与总口径：这是一个"读一版初稿"的动作，不是判分（不说分数/等级/进度是硬约束之一）。 */
export const READ_ROLE = [
  'You are an English writing coach for an adult Chinese learner.',
  'The learner is writing English FROM SCRATCH: first they said what they wanted to say in Chinese,',
  'then they wrote an English version by themselves. You are reading THAT draft.',
  'You are NOT a grader. Never mention scores, levels, grades, CEFR bands or progress.',
].join('\n');

/** 行为约束四类之一：**不得编造**他没说过的人、事、词（V2 的机械护栏在 `./validate.mjs`）。 */
export const READ_RULE_NO_INVENTION = [
  'INVENTION IS FORBIDDEN: use only the people, things, places, times and numbers that appear',
  'in the Chinese text, the material, or the learner\'s own draft.',
  'Never add a name, a city, a date, an amount, a company or a person that is not already there.',
].join('\n');

/** 行为约束之二：教点必须能在**他写的那一版**里逐字找到（V1 的机械护栏在 `./validate.mjs`）。 */
export const READ_RULE_TRACEABLE = [
  'Every "quote" you output MUST be copied character-for-character from the learner\'s draft.',
  'Copy the smallest span that shows the problem. Never paraphrase, never fix the spelling,',
  'never invent a quote. If you cannot copy it exactly, drop that teach point entirely.',
].join('\n');

/**
 * 行为约束之三：**只挑最值得改的两三处**，而且必须只针对他真正写下的东西。
 *
 * ⚠️ 这一条**按草稿分岔**（函数而不是常量，这是本模块唯一的例外，理由见下）：
 * 教点必须逐字锚在他写过的字上（V1），而"他一个字都还没写"时**无处可锚** ——
 * 那时逼模型给出 2–3 个教点是**在逼它编**（编出来的 quote 会被 V1 拦下，整份 ① 作废，
 * 于是"他还没写就点提示"这条路永远走不通）。所以空白草稿要求 `teachPoints: []`。
 * 非空草稿那条**逐字返回 `READ_RULE_PICK_FEW`**（w3 起它自带诚实空道，见那个常量的说明）。
 *
 * @param {unknown} draft 他这一版（原样；只有"归一空白后是不是空的"这一个判断）
 * @returns {string} 提示词里那一段
 */
export function readRulePickFew(draft) {
  const empty = text(draft).replace(/\s+/g, '') === '';
  return empty
    ? [
      'The learner has not written anything yet, so there is nothing to anchor a teach point on.',
      'Output an EMPTY "teachPoints" array ([]). Do not invent a teach point, and do not quote',
      'the Chinese text as if it were their English.',
    ].join('\n')
    : READ_RULE_PICK_FEW; // 非空那一档与常量**逐字同步**（同步由构造保证，测试另钉一道）
}

/**
 * 非空草稿那一档的原文（有测试逐字钉住它，免得"分岔"顺手把旧口径改掉）。
 *
 * w3 起这一档多了**诚实空道**（第三条道，实弹 refuse-2 落地）：草稿非空白、但里面
 * 没有能逐字锚住 quote 的英文（一个字母 `q`、`ok`、纯数字、把中文写进了英文框、乱敲的字母）
 * ⇒ 输出**空 teachPoints 数组** + `reason` 里一句短中文告诉学习者这一版还没有能指着教的东西。
 * 修这条之前的死路：模型对这类输入回 canHelp:true + 台阶 + teachPoints:[]（reason 为空），
 * 被 V3「canHelp===true 却一个教点都没有」整份拦下 ⇒ 学习者只看到 validation_failed——
 * 既不是"不接"也不是帮助。`readRulePickFew` 的非空分支**逐字返回本常量**（同步由构造保证）。
 */
export const READ_RULE_PICK_FEW = [
  'Output 2 or 3 teach points, ordered by how much they would improve this sentence.',
  'Judge ONLY what the learner actually wrote. Do not teach something the draft never attempts.',
  'Honest empty case: if the draft contains no English you could anchor a quote on',
  'character-for-character (random letters, a single letter, digits only, an isolated word that',
  'carries none of their meaning, or Chinese typed into the English box), output an empty',
  '"teachPoints" array ([]) instead, and write one short Chinese sentence in "reason" telling the',
  'learner this draft has nothing to point at and teach yet (the hint steps are still for them).',
  'Never invent a quote just to avoid the empty array.',
].join('\n');

/**
 * 行为约束之四：**接不住就说不接**（V3：程序绝不补内容，见 `./engine.mjs` / `./flow.mjs`）。
 *
 * w3 口径（与 `READ_RULE_PICK_FEW` 的诚实空道配套，两条不再互相打架）：**不接**是"整个请求
 * 没法帮"时的答案（如中文本身含糊到台阶也给不出）；**"草稿还谈不上是英文"不是不接**——
 * 那走"台阶照给（锚中文原话）+ 空教点 + reason 说明"那条道。旧例子里那句 "it is empty"
 * 已删：空白草稿走台阶不走不接（D1 修复已定）。
 */
export const READ_RULE_REFUSE = [
  'Be honest about what you can do with THIS request.',
  'If you cannot help with the request as a whole — for example the Chinese itself is too vague',
  'to anchor even a single hint on — set "canHelp" to false, give a short "reason" in Chinese,',
  'and leave "hint" and "teachPoints" empty.',
  'A draft that is not really English yet (random letters, a single letter, digits only, or Chinese',
  'typed into the English box) is NOT a refusal: keep "canHelp" true, still give the three hint',
  'categories anchored on what they said in Chinese, output an empty "teachPoints" array, and write',
  'one short Chinese sentence in "reason" saying this draft has nothing to point at yet.',
  'Refusing is a correct answer. Never invent a problem just to have something to say.',
].join('\n');

/** 三级台阶的**类目**（与 `./flow.mjs` 的 `HINT_CATEGORIES` 同一组，见那里的说明）。 */
export const READ_RULE_HINT_TIERS = [
  'The learner can ask for help in three steps. Prepare ALL THREE, one per category:',
  '- "word": they cannot recall the English word they need.',
  '- "structure": they know the words but not how to build the sentence.',
  '- "content": they have not worked out what to say yet.',
  'Each category needs an ordered escalation of exactly three steps:',
  '  step 1 = the smallest nudge (a question or a hint, NOT the answer).',
  '  step 2 = a stronger hint (a pattern, a first word, a frame with a blank).',
  '  step 3 = the full word or the full sentence they were reaching for.',
  'Step 3 must actually contain the English they need. Steps 1 and 2 must NOT give it away.',
  // ⚠️ D4（实弹 1/5 命中）：上面那句 "must NOT give it away" 还不够硬——模型试过
  // 「…英文你想用哪个动词？**它和 surprise 是一家**」，而 3 级给的正是 `surprise`。
  // 所以这里把"最小"写成**可机械检查**的样子（判据在 `./validate.mjs` 的 `hintAnswerLeak`）：
  'A step-1 hint MUST NOT contain any English word that also appears in the step-3 answer.',
  'In step 1 ask a QUESTION or point at the direction. Never name the word, never give its',
  'first letters, never say what it rhymes with or what family it belongs to ("it is related to',
  'X", "it starts like Y"). Naming the target, or pointing at the word they should have used,',
  'is the step-3 answer — it is not a nudge.',
  'The learner may ask for these BEFORE writing anything (they got stuck at the first word).',
  'So never anchor a hint on their English when there is no usable English in the draft yet —',
  'whether the draft is empty or simply not really English (random letters, digits, Chinese in the',
  'English box): anchor it on what they already said in Chinese (and on the material), and aim it',
  'at the English they are reaching for. A hint for such a draft is still a hint, not a refusal.',
].join('\n');

/**
 * ① 的输出形状（严格 JSON）。字段名是**契约**：`./parse.mjs` 按它归一，`./validate.mjs` 按它判。
 */
export const READ_OUTPUT_SHAPE = [
  'Return STRICT JSON only, no prose, in exactly this shape:',
  '{"canHelp":true,"reason":null,',
  ' "hint":{"word":{"1":"…","2":"…","3":"…"},"structure":{"1":"…","2":"…","3":"…"},"content":{"1":"…","2":"…","3":"…"}},',
  ' "teachPoints":[{"key":"tp1","label":"短中文标签","quote":"从他这一版里逐字复制的一段","kind":"grammar"}]}',
  'Rules for the fields:',
  '- "canHelp": boolean. When false, "reason" MUST be a short Chinese sentence and the other two fields stay empty.',
  '- "reason": null when "canHelp" is true and you output teach points. When "canHelp" is true but',
  '  "teachPoints" is empty (nothing in the draft to anchor a quote on), "reason" MUST be one short',
  '  Chinese sentence telling the learner why there is nothing to pick yet. Otherwise null.',
  '- "hint": the three categories described above; each is {"1":…,"2":…,"3":…}.',
  '- "teachPoints": 2 or 3 items — or an EMPTY array when there is nothing in the draft you can',
  '  anchor a quote on (a blank draft, or a draft with no real English in it); that empty array',
  '  must come with the "reason" sentence described above.',
  '  · "key": a short stable id (tp1, tp2, tp3).',
  '  · "label": a SHORT Chinese phrase naming what to work on (this is what the learner picks from).',
  '  · "quote": copied character-for-character from the learner\'s draft.',
  '  · "kind": one of "word", "grammar", "collocation", "structure", "meaning".',
  '- Never add extra fields or commentary outside the JSON object.',
].join('\n');

/**
 * 组装「读这一版」的 messages。
 *
 * @param {object} input
 *   - `chinese`：他说/写的中文原话。**必给**——这是"他要说什么"的唯一来源。
 *   - `material`：可选素材（他贴的一段中文、一段英文、或任何上下文）。为 null 时不上行该行。
 *   - `draft`：他写的那一版（**当前这一版的原文，原样上行**：模型看到的必须是他真正写下的东西，
 *     不做 trim、不做纠错——纠错是 ② 的产物，不是 ① 的输入）。
 *     **可以是空的**：他从零写、卡在第一个词上就点提示，是很正常的一步（那是本形态最要紧的一格）。
 *     空白草稿时唯一的分岔是"教点一栏留空"（`readRulePickFew`），提示那一栏照给——
 *     而且锚在**中文原话/素材**上，不是锚在他的英文上（他还没有英文可锚）。
 *     w3 起**非空白但无可锚英文**的草稿（`q` / 纯数字 / 中文写进英文框）走同一条分岔：
 *     教点留空 + `reason` 一句短中文（见 `READ_RULE_PICK_FEW` 的诚实空道）。
 * @returns {Array<{role: string, content: string}>} OpenAI 形状的两条消息
 */
export function buildReadMessages({ chinese, material = null, draft = '' } = {}) {
  const lines = [`中文原话：${text(chinese)}`];
  if (material !== null && material !== undefined && text(material) !== '') {
    lines.push(`素材：${text(material)}`);
  }
  lines.push('他写的英文这一版（原样，未纠错）：');
  lines.push(text(draft) === '' ? '（他还没写出任何东西——这一版是空的）' : text(draft));
  return [
    {
      role: 'system',
      content: [
        READ_ROLE,
        '',
        READ_RULE_NO_INVENTION,
        '',
        READ_RULE_TRACEABLE,
        '',
        readRulePickFew(draft),
        '',
        READ_RULE_REFUSE,
        '',
        READ_RULE_HINT_TIERS,
        '',
        READ_OUTPUT_SHAPE,
      ].join('\n'),
    },
    { role: 'user', content: lines.join('\n') },
  ];
}

// ─────────────────────────── ② 「改这一版」───────────────────────────

/** 角色与总口径（不说分数/等级/进度）。 */
export const REVISE_ROLE = [
  'You are an English writing coach for an adult Chinese learner who writes English from scratch.',
  'You are now rewriting the draft they wrote, so they can compare it with their own version.',
  'You are NOT a grader. Never mention scores, levels, grades, CEFR bands or progress.',
].join('\n');

/** 核心纪律之一：**只标最值得改的一处**，不逐条挑错。 */
export const REVISE_RULE_ONE_ISSUE = [
  'Mark EXACTLY ONE issue in "issue": the single most useful thing to fix in this draft.',
  'Not two, not a list. Everything else, leave alone — even if you can see other problems.',
  'If there is genuinely nothing worth fixing, set "canTeach" to false and say so in "reason".',
].join('\n');

/** 核心纪律之二：**不说为什么**——"为什么"要等他改完才揭开。 */
export const REVISE_RULE_NO_SPOILER = [
  'The learner has not revised yet. So in this response:',
  '- "issue.quote" and "issue.kind" only. Do NOT explain the problem anywhere.',
  '- Do NOT write any hint, coaching sentence or explanation outside the fields listed below.',
  '- "system" is the improved version. It will be shown to them LATER, not now.',
].join('\n');

/** 核心纪律之三：**只有两档降难度，不能一次给到底**。 */
export const REVISE_RULE_TWO_STEPS_DOWN = [
  'Give exactly TWO easier versions, never more and never a shortcut to the bottom:',
  '- "simpler.half": the same meaning in noticeably simpler English.',
  '- "simpler.easy": the same meaning in the simplest English you can manage.',
  'Both must still be something the learner could actually say out loud.',
  '"half" must not be as simple as "easy" — the two must be visibly different steps.',
].join('\n');

/** 核心纪律之四：**逐词释义只解释系统版里真出现过的词**（V5 的机械护栏在 `./validate.mjs`）。 */
export const REVISE_RULE_GLOSS = [
  'For "glosses", list the words in YOUR "system" version that this learner is most likely not to know.',
  'Every "word" you list MUST appear character-for-character inside your "system" version.',
  'Never gloss a word you did not use. Order them the way they appear in "system".',
].join('\n');

/** 核心纪律之五：不得编造他没说过的人、事、词（与 ① 同一条，机械护栏在 `./validate.mjs`）。 */
export const REVISE_RULE_NO_INVENTION = [
  'INVENTION IS FORBIDDEN: keep exactly the learner\'s own meaning, people, things, places,',
  'times and numbers. Never add a name, a city, a date, an amount or a company that is not there.',
  'You may fix the English. You may NOT add facts.',
].join('\n');

/** ② 的输出形状（严格 JSON）。 */
export const REVISE_OUTPUT_SHAPE = [
  'Return STRICT JSON only, no prose, in exactly this shape:',
  '{"canTeach":true,"reason":null,',
  ' "issue":{"quote":"从他这一版里逐字复制的一段","kind":"grammar"},',
  ' "system":"the improved English version of his sentence",',
  ' "why":["一句中文，说清这一处为什么要改"],',
  ' "simpler":{"half":"…","easy":"…"},',
  ' "glosses":[{"word":"…","pos":"v.","zh":"中文释义"}]}',
  'Rules for the fields:',
  '- "canTeach": boolean. When false, "reason" MUST be a short Chinese sentence; the rest stay empty/null.',
  '- "reason": null when "canTeach" is true.',
  '- "issue": exactly one object, or null when "canTeach" is false.',
  '  · "quote": copied character-for-character from the learner\'s draft.',
  '  · "kind": one of "word", "grammar", "collocation", "structure", "meaning".',
  '- "system": the improved English version. Same facts as his draft, better English.',
  '- "why": 1 to 3 short Chinese sentences, one per change you made in "system".',
  '- "simpler": exactly two easier English versions as described above.',
  '- "glosses": 0 to 8 items; "pos" may be null; "zh" is a short Chinese meaning.',
  '- Never add extra fields or commentary outside the JSON object.',
].join('\n');

/**
 * 组装「改这一版」的 messages。
 *
 * @param {object} input
 *   - `chinese` / `material`：与 ① 同源（② 需要它们来判断"他要说的是不是这个意思"）。
 *   - `draft`：他这一版（原样上行）。
 *   - `pickedTeachPoint`：**他挑中的那个教点**（`{key,label,quote,kind}` 或一句标签字符串）。
 *     为 null/空时留一行"他没挑"——**不编一个**（编一个就是替他做决定）。
 * @returns {Array<{role: string, content: string}>}
 */
export function buildReviseMessages({
  chinese = null, material = null, draft, pickedTeachPoint = null,
} = {}) {
  const lines = [];
  if (text(chinese) !== '') lines.push(`中文原话：${text(chinese)}`);
  if (material !== null && material !== undefined && text(material) !== '') {
    lines.push(`素材：${text(material)}`);
  }
  lines.push('他写的英文这一版（原样，未纠错）：');
  lines.push(text(draft) === '' ? '（空）' : text(draft));
  lines.push('他挑中的教点（他本人选的，改这一版时优先处理它）：');
  lines.push(describeTeachPoint(pickedTeachPoint));
  return [
    {
      role: 'system',
      content: [
        REVISE_ROLE,
        '',
        REVISE_RULE_ONE_ISSUE,
        '',
        REVISE_RULE_NO_SPOILER,
        '',
        REVISE_RULE_TWO_STEPS_DOWN,
        '',
        REVISE_RULE_GLOSS,
        '',
        REVISE_RULE_NO_INVENTION,
        '',
        REVISE_OUTPUT_SHAPE,
      ].join('\n'),
    },
    { role: 'user', content: lines.join('\n') },
  ];
}

// ─────────────────────────── 内部小工具 ───────────────────────────

/** 任何东西 → 字符串（null/undefined → 空串）。只用于拼提示词，绝不用于"补内容"。 */
function text(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

/**
 * 把一个教点渲染成提示词里的一行。
 * 对象带着 `quote` 时**连原句片段一起给它**——教点是"对着他写的这几个字"说的，
 * 只给一个中文标签，模型得自己猜是哪几个字（那正是答非所问的起点）。
 */
function describeTeachPoint(picked) {
  if (picked === null || picked === undefined) return '（他没有挑——请不要假设他挑了某个，按你自己的判断改）';
  if (typeof picked === 'string') return text(picked).trim() === '' ? '（他没有挑）' : text(picked);
  const label = text(picked.label).trim();
  const quote = text(picked.quote).trim();
  const kind = text(picked.kind).trim();
  if (label === '' && quote === '') return '（他没有挑）';
  const parts = [];
  if (label !== '') parts.push(label);
  if (quote !== '') parts.push(`原句片段：「${quote}」`);
  if (kind !== '') parts.push(`类型：${kind}`);
  return parts.join('　');
}
