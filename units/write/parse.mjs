// web/units/write/parse.mjs
//
// 模型吐回来的那段文本 → **形状**。这一层只做三件事：把 JSON 找出来、把字段按契约归一、
// 把明显不成形的整份判死（返回 `null`）。它**不判语义**——"教点能不能在他的原句里逐字找到"
// 一类的问题全在 `./validate.mjs`。两层分开的理由：形状错与内容错是两种完全不同的处置
// （前者要改提示词/契约，后者要改教学内容），混在一层里就分不清该去改哪儿。
//
// ── 为什么容忍 ```json 围栏与前后噪声，却不容忍字段乱来 ─────────────────────────
// 围栏与"好的，这是 JSON："是**排版噪声**：`response_format: {type:'json_object'}` 挡不住
// 所有实现，剥掉它们不会让一份不合格的响应变得合格。而字段形状是**契约**：`canHelp` 不是
// 布尔、`teachPoints` 不是数组，就不是"模型多说了句话"，而是"这一份不能用"。
// 所以：**噪声容忍，形状从严**。找不到 JSON、或顶层不是对象 ⇒ 返回 `null`。
//
// ── null 与空值不是一回事（这一条贯穿三个归一函数）────────────────────────────
// `null` = "这一份形状不对，整份不可用"；字段级的 `null` = "模型没给这一项"。
// 两者的处置完全不同（V3：字段缺了要如实透出，整份坏了要如实失败），
// 所以本层**绝不**把"缺字段"悄悄补成 `[]` 或 `''`——补出来的内容会被下游当成模型说的。
//
// 纯逻辑模块：零 import、零浏览器 API、零副作用——可在 Node 中直接测、直接变异。

/** 教点的 `kind` 枚举（值域与 `./prompt.mjs` 的 `kind` 说明一致）。越界归 `'other'`，不丢这一条。 */
const KINDS = new Set(['word', 'grammar', 'collocation', 'structure', 'meaning']);

/** 三级台阶的三个类目（与 `./flow.mjs` 的 `HINT_CATEGORIES` 同一组）。 */
const HINT_KEYS = ['word', 'structure', 'content'];

/** 同一件事的几种写法都认（模型把 "1" 写成 step1 不该让整份作废——那是排版噪声，不是契约违背）。 */
const STEP_ALIASES = { 1: ['1', 'step1', 'step_1'], 2: ['2', 'step2', 'step_2'], 3: ['3', 'step3', 'step_3'] };

/** 教点候选上限：提示词要 2–3 个，多给的一律砍掉（V4 的"只有一处"同源纪律）。 */
const MAX_TEACH_POINTS = 3;
/** 释义条数上限：一份响应不该带一整本词典（省钱也省屏幕）。 */
const MAX_GLOSSES = 30;

/** 非空字符串才算"给了"，其余（含纯空白、数字、对象）一律归 null。 */
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** 已剪空白的字符串，或 null。 */
function trimmed(v) {
  const s = str(v);
  return s === null ? null : s.trim();
}

/**
 * 从一段文本里找出**严格 JSON 对象**。容忍 ```json 围栏与前后噪声。
 *
 * 三种尝试，按"最干净 → 最宽松"排列：
 *   1. 整段就是 JSON；
 *   2. 剥掉围栏（```json … ``` / ``` … ```）后再试；
 *   3. 从第一个 `{` 扫到**与之配对的** `}`（逐字符数括号深度，能正确跳过字符串里的
 *      `{`/`}` 与转义引号）。
 *
 * 全失败 ⇒ `null`。**绝不"从散文里抠字段"**：那是猜测，不是解析。
 * 顶层解出来不是对象（数组/数字/null）同样 `null` —— 这一层的契约对象，不是任意 JSON。
 *
 * @param {unknown} content 模型返回的 content 字符串
 * @returns {object|null}
 */
export function parseEnvelope(content) {
  if (typeof content !== 'string') return null;
  const raw = content.trim();
  if (raw === '') return null;

  const candidates = [raw];
  const unfenced = stripFence(raw);
  if (unfenced !== null && unfenced !== raw) candidates.push(unfenced);
  const braced = firstBalancedObject(raw);
  if (braced !== null) candidates.push(braced);

  for (const c of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue; // 这一种尝试失败不是错误，是"换下一种"
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

/** 剥掉 ```json … ``` / ``` … ``` 围栏（没有围栏时返回剥过空白的原文）。 */
function stripFence(raw) {
  const m = /^```[ \t]*[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(raw);
  return m === null ? raw : m[1].trim();
}

/**
 * 找出第一段**配对**的花括号对象子串。
 * 逐字符扫描（不用正则——正则数不了嵌套括号），维护深度与"是否在字符串里"两个状态，
 * 字符串里遇到 `\"` 要跳过一个字符，否则 `{"a":"}"}` 会被截断在错误的位置。
 */
function firstBalancedObject(raw) {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null; // 括号没闭合：这一份坏在半路
}

/**
 * 归一「读这一版」的响应。
 *
 * @param {unknown} obj `parseEnvelope` 的产物（或任何东西）
 * @returns {null | {
 *   canHelp: boolean, reason: string|null,
 *   hint: {word: object|null, structure: object|null, content: object|null},
 *   teachPoints: Array<{key: string, label: string, quote: string, kind: string}>,
 * }}
 *   `null` = 形状坏到不可用（不是对象 / `canHelp` 不是布尔）。
 *   `canHelp === false` 时**照样把 reason 透出来**，且 hint/teachPoints 保持空——
 *   本层绝不因为"它说接不住"就补一份内容（V3）。
 */
export function normalizeRead(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const canHelp = obj.canHelp;
  if (typeof canHelp !== 'boolean') return null; // 接不接得住是布尔，含糊不得
  return {
    canHelp,
    reason: trimmed(obj.reason),
    hint: {
      word: normalizeTier(obj?.hint?.word),
      structure: normalizeTier(obj?.hint?.structure),
      content: normalizeTier(obj?.hint?.content),
    },
    teachPoints: normalizeTeachPoints(obj.teachPoints),
  };
}

/**
 * 一个类目的三级台阶 → `{1,2,3}`，每级是字符串或 null。
 * **缺级不补齐**：`{1:'…'}` 的产物就是 `{1:'…',2:null,3:null}`——
 * "2/3 级没有"必须能被 `./flow.mjs` 看见（它据此决定台阶升不升得上去），补成空串就看不见了。
 */
function normalizeTier(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { 1: null, 2: null, 3: null };
  let any = false;
  for (const level of [1, 2, 3]) {
    for (const alias of STEP_ALIASES[level]) {
      const v = trimmed(raw[alias]);
      if (v !== null) { out[level] = v; any = true; break; }
    }
  }
  return any ? out : null;
}

/**
 * 教点候选：逐条归一到 `{key,label,quote,kind}`。
 * `key`/`label` 给不出来的条目**丢掉**（它在界面上根本没法被选），
 * 其余字段按缺省处理（`quote` 缺了会给 `''`，由 `./validate.mjs` 判 V1——**这里不预判**）。
 */
function normalizeTeachPoints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_TEACH_POINTS) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = trimmed(item.key);
    const label = trimmed(item.label);
    if (key === null || label === null) continue;
    const kind = trimmed(item.kind);
    out.push({
      key,
      label,
      quote: typeof item.quote === 'string' ? item.quote : '',
      kind: kind !== null && KINDS.has(kind) ? kind : 'other',
    });
  }
  return out;
}

/**
 * 归一「改这一版」的响应。
 *
 * @param {unknown} obj
 * @returns {null | {
 *   canTeach: boolean, reason: string|null,
 *   issue: {quote: string|null, kind: string|null}|null,
 *   system: string, why: string[],
 *   simpler: {half: string|null, easy: string|null}|null,
 *   glosses: Array<{word: string, pos: string|null, zh: string}>,
 * }}
 *   `null` = 形状坏到不可用（不是对象 / `canTeach` 不是布尔 / **说 `canTeach:true` 却没有系统版**）。
 *   没有系统版就没有"改完才揭开"的那一半，这一份直接作废（宁可如实报错，也不给半份）。
 *   `canTeach:false` 时**可以没有系统版**（那本来就不改），但字段整个缺失与明确给 null 不同：
 *   前者判形状不对，后者收下（`system` 归空串，V3 才能看见"这里不该有内容"）。
 *   **`issue` 最多一个**（V4）：模型给数组/多份时只取第一份——落在 `system` 上的是
 *   "程序持有的产品规则"，而"到底改了没有"由 `./validate.mjs` 判。
 */
export function normalizeRevise(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const canTeach = obj.canTeach;
  if (typeof canTeach !== 'boolean') return null;
  // `system` 的验收分两种情形，**这是产品语义决定的**：
  //   · `canTeach === true`  ⇒ 必须有系统版（非空字符串）。没有它，"改完才揭开"就没有可揭的东西。
  //   · `canTeach === false` ⇒ 他本来就不改，**没有系统版是正确的**。但**不认 `undefined`**：
  //     字段整个缺失是"形状不对"（模型根本没按那张表来），与"明确说没有"必须分开——
  //     这条区分就是这两种情形唯一的可观测差别。
  const system = trimmed(obj.system);
  if (canTeach && system === null) return null;
  // `canTeach === false` 的两种情形必须分开：
  //   · **没有系统版**（字段缺失 / 明确 null / 空串）⇒ 收下，`system` 归空串。
  //     他本来就不改，"没有东西可揭"是正确的——判死它会让"接不住"这条路彻底不通。
  //   · **给了一段系统版** ⇒ 形状不对，整份判死。那时 `canTeach` 的真假已经自相矛盾了。
  if (!canTeach && system !== null) return null;
  if (!canTeach && obj.system !== undefined && obj.system !== null && typeof obj.system !== 'string') {
    return null;
  }

  return {
    canTeach,
    reason: trimmed(obj.reason),
    issue: normalizeIssue(obj.issue),
    system: system ?? '',
    why: (Array.isArray(obj.why) ? obj.why : [])
      .map((x) => trimmed(x))
      .filter((x) => x !== null),
    simpler: normalizeSimpler(obj.simpler),
    glosses: normalizeGlosses(obj.glosses),
  };
}

/**
 * `issue` → `{quote, kind}` | null。
 * 给的是一份对象（哪怕字段不全）就**照原样归一出它的缺口**——缺 `quote` 出去是 `null`，
 * 由 `./validate.mjs` 判它是"这一处标不出来"（**不在这里悄悄丢掉**：丢掉了下游会以为模型
 * 压根没标，而真相是它标了一份残的——那是两种不同的处置）。
 * 给的是数组时取**第一份**（V4：本版只有一处）。
 */
function normalizeIssue(raw) {
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (one === null || one === undefined || typeof one !== 'object' || Array.isArray(one)) return null;
  const kind = trimmed(one.kind);
  return {
    quote: typeof one.quote === 'string' ? one.quote : null,
    kind: kind !== null && KINDS.has(kind) ? kind : (kind === null ? null : 'other'),
  };
}

/** `simpler` → `{half, easy}` | null（两档都给不出来时为 null）。 */
function normalizeSimpler(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const half = trimmed(raw.half);
  const easy = trimmed(raw.easy);
  if (half === null && easy === null) return null;
  return { half, easy };
}

/** `glosses` → 逐条 `{word, pos, zh}`；`word`/`zh` 都给不出来的条目丢掉（它对界面没有用）。 */
function normalizeGlosses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_GLOSSES) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const word = trimmed(item.word);
    const zh = trimmed(item.zh);
    if (word === null || zh === null) continue;
    out.push({ word, pos: trimmed(item.pos), zh });
  }
  return out;
}
