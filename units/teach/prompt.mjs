// web/units/teach/prompt.mjs
//
// 提示词组装：把六槽位与行为约束拼成这一次要给模型的东西（设计稿 §3.6）。
//
// **纯逻辑：零浏览器 API、零副作用**（只 import 同目录两个纯模块：`./difficulty.mjs`、`./method.mjs`）。
//
// 这是整个产品的**护城河所在**：产品不是"接了个模型"，而是"用一套框架约束模型"（§3.6）。
// 所以约束不是角色设定（"你是英语老师"保证不了任何事），而是**行为约束**：不许说出焦点词、
// 不许评价、单次回复长度上限、卡住先降档不先给答案（§3.6.2 的四类）。
//
// 为什么缺槽位要**响亮抛错**而不是补默认值：六槽任一缺失，模型就退化成通用闲聊——那是"裸聊"，
// 不是教学（§3.6.1 的"缺失后果"一列）。宁可当次不发请求，也不要发一次没有教学目标的调用。
//
// **焦点槽按档位填**（人裁决的改动；§3.5.3 的档位表逐档不同）：
//   1–3 档：把 `focus.ref` 与 `focus.meaning` **都**写进上下文。这不是泄漏——2 档的帮助就是
//     "他卡住再给『hesitate 是动词，意思是犹豫』"，模型不拿到这个词与释义，那一档的帮助路径
//     根本无从执行（这处的张力已在【禁止】行里写清：**逼产出拍**不许说出，进了给帮助拍才按
//     【帮助尺度】办）。
//   4 档（熟练）：**同时隐去 `focus.ref` 与 `focus.meaning`**，只留一句意译描述
//     （"这里有一个更精确的说法"），并把目标说明为候选词的**语域**比较（§3.5.3 第 171 行）。
//     ⚠️ 只隐英文词是不够的：§3.5.3 第 169 行把 2 档的帮助定义成"意思是**犹豫**"——
//     **中文释义本身就泄漏焦点**，而计划把 ref 与 meaning 写在**同一行**。
//     判据写在模块内（入参里本来就有 band），**不做成"调用方传个布尔开关"**：传开关等于把
//     静默失效的机会交给调用方（少传一次就悄悄退回"把词告诉模型"）。
//
// **逐档教法**（§3.5.3 那四行，其中三样在 `bandRules` 的四个开关里没有位置——见潜伏项 E）：
//   1 档｜句型里留空位（"I need to ___."）→ 落在【本档怎么教】+ 首字母提示
//   2 档｜给完整情境不给句型、卡住再给"这个词 + 中文释义" → 落在【焦点】槽 +【本档怎么教】
//   3 档｜只给情境、要求用上过去时、反馈时点搭配 → 落在【本档怎么教】
//   4 档｜不告诉他要学什么词、只说"这里有一个更精确的说法" → 落在【焦点】槽 +【本档怎么教】
//
// 为什么长度上限与帮助尺度一律走 `bandRules(band)`：档位参数的权威只有 `difficulty.mjs` 一处。
// 在这里再抄一份数字，就是给同一件事造第二个出处——两处一旦不一致，提示词说的长度与
// `validate.mjs` 按 RULES 判超长的长度会**静默分叉**，而模型只会照着提示词里那个数写。
//
// 代价（如实记）：
//   ① 本模块只**保证约束被写进提示词**，保证不了模型遵守（§3.6.3：提示词约束天然会被违反）。
//      遵守由 `validate.mjs` 的机械校验兜底——两层是分开的，缺一层都不成立。
//   ② 本模块**不管 `scene` / `learnerState` / `phase` 的内容**：它们只被要求"非空字符串"。
//      特别是 `scene`：4 档只隐去了焦点槽里的词，若调用方把焦点词写进 `scene`（学习者的原话里
//      本来就可能出现这个词，而焦点常常正是从他这段话里挑的），提示词里就会有它。**这一层不在
//      本模块**——抹掉学习者自己的话等于篡改教学素材，要挡就挡在调用方（loop）。
//   ③ `phase` 与 `learnerState` 的枚举权威分别在 `session.mjs` / `focus.mjs`，本模块**不重列**
//      它们（重列就是第二份枚举），只要求非空字符串。
//   ④ `focus.meaning` 允许是**空串**（`makeFocus` 的 `String(meaning ?? '')` 就是允许的：
//      结构类焦点可以没有中文释义），但不许是 undefined / 非字符串——那会让【焦点】行印出
//      "含义：undefined"，而 4 档又根本拿不到它。
//   ⑤ 本模块**不拒绝多余的键**：签名是一个解构对象，Task 9 要加的 `retryHint` 就追加在同一个
//      对象里——今天传进来会被忽略（不会被当成第七个槽位，也不抛错）。写死"只许这六个键"等于
//      把下一步锁死在签名外面。
//   ⑥ `focus.kind` 的中文名只是一张**显示映射**，不是枚举的第二权威：表里没有的 kind 原样退回，
//      绝不会因为标签表缺一项就炸（枚举权威在 `focus.mjs`）。
//   ⑦ `retryHint`（可选，Task 9 授权追加的跨任务改动，计划第 1628–1630 行自己写明）：
//      非空时在末尾追加一段「上次的问题」。**`null` / `undefined` / 空数组时输出与追加前逐字相同**
//      ——六槽位顺序与内容一个字都不许动（`SLOTS` 是既定契约，"六槽缺一不发调用"不许放宽）。
//      代价如实记：它回灌的是**违规码**（`focus_leak` / `over_length` / `scoring_language` /
//      `generate_failed`），模型并不知道这些标识符是什么意思——真正起作用的是那句中文引导
//      （"这次务必避开"）+ 模型自己上一轮的输出。**没有为它发明人话映射**（那会是提示词工程里的
//      又一次猜测，且没有实测依据）。类型守卫是**响亮抛错**而不是静默 `String()`：
//      `retryHint: 0` 走 truthiness 会**静默不追加**，让"回灌失败"看起来像"模型没照做"。

import { bandRules, BAND_LABELS } from './difficulty.mjs';
import { METHOD_LABELS } from './method.mjs';

/** 六槽位（固定顺序，不可省；设计稿 §3.6.1）。 */
export const SLOTS = Object.freeze(['phase', 'method', 'band', 'focus', 'learnerState', 'scene']);

/** 焦点种类的显示名（见文件头代价 ⑥）。 */
const KIND_LABELS = Object.freeze({ word: '词', structure: '结构', expression: '表达' });

/** 评分禁令（§3.6.2 负面约束 2；与 NON_GOALS"不制造分数焦虑"一致）。 */
const SCORING_BAN = '不得打分、不得说"错了/不正确"、不得比较学习者与他人、不得给出等级或分数。';

/** 熟练档的档号：这一档**从上下文里彻底不给焦点**（§3.5.3 第 171 行）。判据写死在这里。 */
const WITHHOLD_FOCUS_BAND = 4;

/**
 * @throws {TypeError} 不是非空字符串（纯空白的字符串与空串同罪——留一个空白槽位等于没填）
 */
function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`assemblePrompt: ${name} 必须是非空字符串，收到 ${JSON.stringify(value) ?? String(value)}`);
  }
}

/**
 * 焦点槽的守卫。`focus` 由 `focus.mjs` 的 `makeFocus` 造出（`{kind, ref, meaning, source, status}`）。
 * 只查本模块真正消费的四个字段；`status` 不被提示词用到，故不要求（不给自己造无谓的失败面）。
 *
 * @throws {TypeError} 不是对象 / ref 空 / kind 空 / source 空 / meaning 不是字符串
 */
function assertFocus(focus) {
  if (focus === null || typeof focus !== 'object' || Array.isArray(focus)) {
    throw new TypeError(`assemblePrompt: focus 必须是 makeFocus 造出来的对象，收到 ${JSON.stringify(focus) ?? String(focus)}`);
  }
  assertNonEmptyString(focus.ref, 'focus.ref');
  assertNonEmptyString(focus.kind, 'focus.kind');
  assertNonEmptyString(focus.source, 'focus.source');
  if (typeof focus.meaning !== 'string') {
    throw new TypeError(`assemblePrompt: focus.meaning 必须是字符串（可以为空串），收到 ${JSON.stringify(focus.meaning) ?? String(focus.meaning)}`);
  }
}

/** 焦点种类的中文名（未知 kind 原样退回，见文件头代价 ⑥）。 */
function kindLabelOf(focus) {
  return KIND_LABELS[focus.kind] ?? focus.kind;
}

/**
 * 【焦点】槽：1–3 档给词与释义，4 档**两者都不给**（人裁决）。
 * @returns {string}
 */
function focusSlot(band, focus) {
  if (band === WITHHOLD_FOCUS_BAND) {
    // 连 kind 也一并撤掉："要学的是一个词"本身就是提示。只留意译描述 + 语域目标。
    return '【焦点】本轮**不告诉他要学什么**（也不要把是哪一个说破）：只说"这里有一个更精确的说法，'
      + `比他现在用的说法更贴他的意思"，让他自己去找；来源：${focus.source}。`
      + '目标是让他在几个候选说法之间辨别**语域**差别（正式 / 中性 / 口语、语气强弱），'
      + '而不是知道"哪个词更高级"。';
  }
  return `【焦点】${focus.ref}（${kindLabelOf(focus)}，含义：${focus.meaning}，来源：${focus.source}）`;
}

/**
 * 【禁止】行：焦点词禁令**按档位**措辞。
 *
 * §3.6.2 的禁令限定在**逼产出拍**，而 §3.5.3 的 2 档帮助就是"把这个词与它的释义给他"。
 * 写成一句无条件的"永不说出"会让同一份提示词自相矛盾，模型只能二选一（通常是照禁令办）
 * ——那一档的帮助路径就永久失效。故：禁令照写（逼产出拍），并指出例外在哪一拍、按哪条办。
 * @returns {string}
 */
function banLine(band, focus) {
  const naming = band === WITHHOLD_FOCUS_BAND
    ? '不许说出你要引导他找到的那个说法本身（也不要说破"要学的是哪一个"）'
    : `不要说出 ${focus.ref} 这个词（逼产出拍不许说出；他卡住进入给帮助拍后按【帮助尺度】办）`;
  return `【禁止】${naming}；不评价他的英语；一次只教这一个点；不连续追问超过 2 轮；不替他写成稿。${SCORING_BAN}`;
}

/**
 * 【本档怎么教】：§3.5.3 的逐档教法，与【焦点】槽的分工是
 * "焦点槽管给不给这个词，这里管这一档怎么用它"。
 * @returns {string}
 */
function bandTeaching(band, focus) {
  switch (band) {
    case 1:
      return '情境里直接给他留出位置（如 "Are you sure? — I need to ___."），让他把这个词填进去；'
        + '【帮助尺度】里允许的首字母提示就用在此时，别一次把整个词给出来。';
    case 2:
      // 措辞照 §3.5.3 的 2 档（"他卡住再给『hesitate 是动词，意思是犹豫』"），但**不许照抄
      // "是动词"**：`focus.kind` 是焦点种类（word / structure / expression），不是词性——
      // 把 kind 当词性念出来，等于让提示词教模型一件错事。
      return '给完整情境、**不给句型**；他卡住时（给帮助拍）可以直接把这个词连它的意思说给他听'
        + `——"${focus.ref}，意思是${focus.meaning}"。`;
    case 3:
      return '只给情境、**不给句型**；要求他同时用上过去时；他产出之后再点这个词的搭配（只说你能确定的搭配）。';
    default:
      return '**不告诉他要学什么词**：只说"这里有一个更精确的说法"；他给出候选之后，'
        + '帮他比较候选之间的语域（正式 / 口语 / 语气强弱）——不要用"更高级/更好"这类评价词，'
        + '也不许提出任何拼写或填空提示。**本档没有直手帮助**：逼一次不行就换方法（见【帮助尺度】）。';
  }
}

/**
 * `retryHint` 的规范化（可选参数，Task 9 追加）。
 *
 * 接受**非空字符串**或**非空字符串数组**（数组按 `' / '` 连接，与计划第 1629 行同口径）；
 * `null` / `undefined` / `''` / 空数组 = "没有要回灌的" ⇒ 返回 `null`（**输出一字节不变**）。
 *
 * `0` / `false` / `{}` 这类**不是"没有"、也不是合法内容**的输入一律响亮抛 TypeError：
 * `0` 走 truthiness 会静默不追加，于是"回灌根本没生效"看起来像"模型没照做同一个错"——
 * 那是本仓修过两次的同一族失效（静默给出一个看起来正常的结果）。
 *
 * @returns {string[] | null} 已就绪、可直接拼进提示词的行数组（调用方不再做类型判断）
 * @throws {TypeError} 不是字符串 / 字符串数组，或数组里混进非字符串
 */
function retryLines(retryHint) {
  if (retryHint === null || retryHint === undefined) return null;
  const parts = typeof retryHint === 'string'
    ? (retryHint === '' ? [] : [retryHint])
    : (Array.isArray(retryHint) ? retryHint : null);
  if (parts === null) {
    throw new TypeError(`assemblePrompt: retryHint 必须是字符串或字符串数组（null / 空数组表示没有），收到 ${JSON.stringify(retryHint) ?? String(retryHint)}`);
  }
  for (const p of parts) {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new TypeError(`assemblePrompt: retryHint 的每一项都必须是非空字符串，收到 ${JSON.stringify(p) ?? String(p)}`);
    }
  }
  // 纯空白与空串同罪（留一段空白提示等于没有回灌）——与 `assertNonEmptyString` 同口径。
  return parts.length > 0 ? parts : null;
}

/**
 * 组装这一次的提示词。
 *
 * @param {{
 *   phase: string, method: string, band: number, focus: object, learnerState: string, scene: string,
 *   retryHint?: string | string[] | null,
 * }} input
 *   - `retryHint`：可选（Task 9 的回灌，见文件头代价 ⑦）。为 `null` / 空时**输出与不传时逐字相同**。
 * @returns {string}
 * @throws {TypeError} 任一槽位缺失 / 空串 / 类型不对，方法名不认识，档位非法，`retryHint` 类型不对
 *   （契约违约一律响亮失败）
 */
export function assemblePrompt({ phase, method, band, focus, learnerState, scene, retryHint = null } = {}) {
  const given = { phase, method, band, focus, learnerState, scene };
  for (const slot of SLOTS) {
    const value = given[slot];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`assemblePrompt: 缺少槽位 ${slot}——六槽缺一不发调用（缺了就退化成通用闲聊）`);
    }
  }
  assertNonEmptyString(phase, 'phase');
  assertNonEmptyString(learnerState, 'learnerState');
  assertNonEmptyString(scene, 'scene');
  assertFocus(focus);

  // 查表只认**自有属性**：`METHOD_LABELS['toString']` 会顺着原型链取到 `Object.prototype.toString`
  // （一个函数）——truthiness 检查放行，提示词里就印出函数的源码。同族缺陷在本仓已修过两次
  // （`teach/method.mjs` 的 `narrowOnStuck`、`teach/session.mjs` 的 `send`）。
  //
  // **先查类型再查表**：`Object.hasOwn` 会把键做 ToPropertyKey 归一——`['roleplay']` 这种单元素
  // 数组会被当成 `'roleplay'` 通过，拼出一份**看起来完全正常**的提示词（实测：本模块的第一版
  // 就是这样被自己的护栏抓住的）。签名声明的是 `method: string`，非字符串一律不认。
  const methodLabel = typeof method === 'string' && Object.hasOwn(METHOD_LABELS, method)
    ? METHOD_LABELS[method]
    : undefined;
  if (typeof methodLabel !== 'string') {
    throw new TypeError(`assemblePrompt: 不认识的方法 ${JSON.stringify(method) ?? String(method)}；已知：${Object.keys(METHOD_LABELS).join(' / ')}`);
  }

  const rules = bandRules(band);        // 非法档位在这里抛 TypeError（与 difficulty 同一个权威）
  const bandLabel = BAND_LABELS[band];  // 档位中文名同样只有 difficulty.mjs 一个出处

  const helpScale = rules.allowFirstLetterHint
    ? '他卡住时可以给首字母提示'
    : '不许给拼写提示——他自己能想出来';
  const allowSample = rules.allowSampleSentence
    ? '必要时可以给一句示例（但只限一句，且不许替他写出他这段内容的成稿）'
    : '不许给示例句';
  const stepBudget = `最多 ${rules.minHelpSteps} 步帮助，之后必须换方法`;
  // 回灌放在**最后**：六槽位与四类行为约束的相对顺序一个字都不许动（见文件头代价 ⑦）。
  const retry = retryLines(retryHint);

  return [
    '【角色】你是这个应用里的英语学习引导者。你的职责不是讲解，是**让他自己说出来**。',
    `【拍子】${phase}（诊断 → 搭台 → 逼产出 → 给够用的帮助 → 收尾）`,
    `【方法】${methodLabel}（${method}）`,
    `【难度档】${band}（${bandLabel}）—— 你这一次的回复**不得长于 ${rules.maxChars} 字符**（${rules.maxChars} 字符上限）`,
    focusSlot(band, focus),
    `【学习者状态】${learnerState}（untouched 未接触 / recognized 认得 / usable 能用）`,
    `【情境】${scene}`,
    '',
    '【必须】为焦点留出使用位置；把决定权留给他（给选项，不替他决定下一步）。',
    banLine(band, focus),
    `【帮助尺度】${helpScale}；${allowSample}；${stepBudget}。`,
    '【卡住时】先降一档难度，仍不行再换方法——**不要直接把答案给他**。',
    `【本档怎么教】${bandTeaching(band, focus)}`,
    ...(retry === null ? [] : ['', `【上次的问题】${retry.join(' / ')}——这次务必避开。`]),
  ].join('\n');
}
