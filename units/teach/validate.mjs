// web/units/teach/validate.mjs
//
// 模型输出的**机械校验**（设计稿 §3.6.3 的第二层防护）。
//
// **纯逻辑：零浏览器 API、零副作用**（只 import 同目录两个纯模块：`./difficulty.mjs`、`./session.mjs`）。
//
// 为什么这一层这么重要：这是把"提示词工程"在本项目里**第一次变成可验证工程**的地方。
// 提示词约束天然会被模型违反——模型会本能地"帮忙帮到底"、顺手把那个词说出来、
// 顺手评价一句"这句有点问题"。而这三样恰好都可以**机械检出**，因此可以写断言、可以回归。
// 没有这一层，"框架约束"就只是一句祈祷。
//
// 三条检查（对应契约 TECHNICAL_CONSTRAINTS 第一条）：
//   1. focus_leak        回复里出现了本次焦点（词族也算）——**按拍子 + 档位判**，见下
//   2. over_length       回复超过当前难度档的字符上限（上限从 `bandRules` 取，不另抄）
//   3. scoring_language  出现评分/等级/比较学习者的词汇（**与拍子、档位无关**，设计稿没给它们限定）
//
// ---------------------------------------------------------------------------
// 为什么焦点词检查要看**拍子**与**档位**（本模块与计划原文最大的一处分歧）
// ---------------------------------------------------------------------------
//
// 计划 Task 6 的原文签名是 `checkReply({text, focusRef, band})`，且"任何拍子、任何档位下
// 只要 text 含 focusRef 就报 focus_leak"。**这是错的，三层证据都是实读的**：
//
//   ① §3.6.2 负面约束 1 的原文是「不许说出焦点词本身（**逼产出拍**）」——括号里限定了拍子。
//   ② §2.2 第 4 拍「给够用的帮助」原文允许给「**一个词**、一个句型、一个提示」。
//   ③ §3.5.3 的档位表逐档给了**不同**规则：
//        1 档｜情境里留位置，**可给首字母提示**（首字母，不是词）
//        2 档｜**他卡住再给"hesitate 是动词，意思是犹豫"**（← 这就是说出焦点词）
//        3 档｜只给情境，要求用上过去时；反馈时点搭配
//        4 档｜**不告诉他要学什么词**，只说"这里有个更精确的说法"
//
// 而**上游 `prompt.mjs` 已经这么做了**：它的【禁止】行是拍子相关的措辞——「不要说出 hesitate
// 这个词（逼产出拍不许说出；他卡住进入给帮助拍后按【帮助尺度】办）」。校验层若不看拍子也不看
// 档位，就会把提示词按设计产出的**合法**回应判为违规 → 重生成 → 仍违规 → 降级为模板话术
// ⇒ **2 档的帮助永远到不了学习者面前**。提示词层与校验层必须同口径，这是那处失效的直接哨兵
// （`tests/teach-validate.test.mjs` 的「2 档给帮助拍真的放行」就是为它写的）。
//
// **逐格判定**（`focusLeakApplies` 就是这张表的唯一出处，`checkReply` 调它）：
//
//   拍子 \ 档位   1 入门              2 基础                 3 进阶              4 熟练
//   elicit        违规                违规                   违规                违规
//   assist        违规(只给首字母)    **允许**(给词+释义)    违规(点搭配)        违规(从不给词)
//
// ⚠️ 这张表是**从设计稿推导的，不是逐字明文**（设计稿没有一行写"只有 2 档允许说词"）。
//    推导链：§3.5.3 的 2 档是唯一一处把"说出焦点词"写成**教学动作**的档位；1 档写的是"首字母"
//    （≠ 词）；3 档的"点搭配"与 4 档的"不告诉"都不以说出词为前提。授权来源
//    `DEC-OPI-968b804d-…db.92`（重估条件已绑在该决策上）。
//
// **"许可"是按档位整格给的，不是按泄漏形态给的**：2 档给帮助拍下，说出这个词（`ref`）与
// 说出它的意思（`meaning`）都不报；因为那一档的教学动作就是「这个词 + 它的意思」，
// 把 `meaning` 单独判违规会让这个许可自相矛盾（释义本来就会连带说出词）。
//
// 拍子表外的那些拍子（`idle` / `intake` / `diagnose` / `stage` / `close`，共五个）
// **不在 §3.5.3 的档位表里**，即"此时根本没有该说不该说这个词的教学动作"。处置是
// **只认 `assist` 为许可窗口，其余一律照拦**：在这些拍子里说出焦点词没有任何设计依据，
// 按保守方向拦（宁可重生成一次）。
//
// ---------------------------------------------------------------------------
// 判定口径与代价（如实记）
// ---------------------------------------------------------------------------
//   ① 词族匹配用**子串**，会有假阳性（焦点词是另一个词的词干时）。宁可假阳性——
//      假阳性的代价是重生成一次，假阴性的代价是**把答案直接给了学习者**，后者更坏。
//   ② 由此有一条**已知的、方向与允许表相反**的假阳性：3 档"点搭配"（§3.5.3 第 170 行
//      「反馈时点搭配（hesitate to do / about doing）」）**必须说出这个词**，而点搭配文本里的
//      词串会被子串匹配命中 ⇒ 判违规。**没有为它开第三次许可**（那会把 3 档的许可窗口开得比
//      设计依据更宽），代价如实登记：3 档的"点搭配"会走一次重生成，两次后降级为模板话术。
//      判据钉在 `tests/teach-validate.test.mjs` 的哨兵用例里——**这不是实现 bug，已裁决**：
//      **接受这个假阳性 + 登记重估条件**（重估触发点 = 真正把 `assist` 拍接线进回合编排时；
//      当前该拍不可达，只有 `elicit` 会被传进来）。届时若 3 档要真的点搭配，须**先**改
//      `DEC-OPI-968b804d-…db.92` 的允许表，再改实现与护栏（改契约 → 改实现 → 改护栏，顺序不能倒）。
//   ③ 评分词表是**保守的黑名单**，抓不到"换个说法的贬低"。它能挡住的是最常见的那几类。
//   ④ 长度按**码点**数（`[...text].length`），与"学习者看到几个字符"一致；不是 UTF-16 码元数
//      （否则一串 emoji 会被算成两倍字符数）。取这个口径是因为它更贴"学习者看到多长"，
//      而不是因为它更精确——它只把"拦长篇大论"做到机械可判，不是排版尺。
//      顺带：本文件的注释里**不写档位上限的数字**——那会让源码级护栏（测试里那条
//      "不许出现长度上限字面量"）误报；上限只有 `bandRules` 一个出处。
//   ⑤ 本模块**不认识教学质量**：它保证不了"这句话教得好"，只保证三类机械违规被检出。
//      它也不知道 `scene` 里是否混进了焦点词（`prompt.mjs` 文件头代价 ② 已记同一条边界）。
//   ⑥ `focusMeaning` 是**可选**的：不传 = 中文释义不参与泄漏判定（**不是"视为无泄漏"**，
//      是"这一项没被检查"）。2 档的许可是整格的，而 1/3/4 档若调用方不传 `meaning`，
//      "只给中文释义不给英文词"这种泄漏就检不出来。Task 9 的 `loop` 应当把 `focus.meaning` 传进来。

import { bandRules } from './difficulty.mjs';
import { PHASES } from './session.mjs';

/**
 * 参与本模块判定的两个拍子（**不是第二份枚举**：两者都必须是 `session.mjs` 的 `PHASES` 成员，
 * 有护栏钉住）。其余拍子不在 §3.5.3 的档位表里——见文件头"拍子表外的四拍"。
 */
export const INPUT_PHASES = Object.freeze(['elicit', 'assist']);

/**
 * 哪几档在**给帮助拍**允许说出焦点词。只有 2 档（§3.5.3：「他卡住再给"hesitate 是动词，
 * 意思是犹豫"」）。给帮助拍以外的拍子一律不允许，故本表只描述"许可窗口"。
 */
const NAMING_BANDS_IN_ASSIST = Object.freeze([2]);

/**
 * 焦点词串短于这个长度时**不判泄漏**。
 *
 * 理由：本检查是**子串**匹配，一个 1 字符的 `focusRef`（`"a"` / `"I"` / `"字"`）会命中几乎
 * 任何回复——那不是"泄漏了答案"，那是尺子太粗。**真正的泄漏是"把要找的那个说法给出去"**，
 * 而 1 个字符连词都算不上，给出去不构成给答案。
 * 代价如实记：焦点词本身只有 1 个字符时（`"a"` / `"I"`），这一项**检不出来**（假阴性）——
 * 假阴性在这一层是贵的那一边，所以阈值取**能取的最小值**（2 而不是 3，见下）。
 *
 * ⚠️ 为什么是 2 而不是 3：**两种文字的字数密度不同**。英文里 2 个字母只是碎片（`be` / `to`），
 * 而中文里 2 个字**已经是一个完整的词**（`犹豫` / `休息`）。阈值取 3 会把 `focusMeaning: '犹豫'`
 * 这种**完全成立的中文释义**判成"太短、不检查"——而"释义本身就是泄漏"是 Task 5 的人裁决
 * 已经确认过的事（4 档必须连释义一起隐去），放过它等于把那条裁决在**只给释义**的那一格上撤销。
 * 取值处钉在测试里（`'a'` 放行 / `'be'` 照抓）。
 */
const MIN_LEAK_LEN = 2;

/**
 * 评分 / 等级 / 比较类词汇（中英各一组）。命中即拒。
 *
 * ⚠️ 词表里**每一条都必须有一个能独立触发它的断言**（见测试的"六条逐条活着"护栏）：
 * 计划自带的 5 个样例只够触发其中 3 条，删掉第 4 条（CEFR 等级）或第 6 条（英文否定纠错）
 * 原先**不会有任何用例变红**。
 */
export const SCORING_PATTERNS = Object.freeze([
  /评分|得分|打分|分数|成绩|等级|级别|排名|第\s*\d+\s*名/,
  /\b\d+\s*\/\s*(?:10|100)\b/,
  /\b(?:score|grade|level|rank|points?)\b/i,
  /\bB\d\b|\bA[12]\b|\bC[12]\b/,          // CEFR 等级不该出现在给学习者的回复里
  // '错的' 是**补进去的**（计划原文只有 `错了|不对|不正确|错误|又错`）：实测计划那份词表对它
  // **自己写的样例** `'你这句话是错的。'` **一个模式都不命中**，对那条"三条一起报"的样例
  // `hesitate 是错的，…` 同样不命中 ⇒ 计划自带的参考实现过不了它自己写的那两条
  // （实测 pass 6 / fail 2，见 `.superpowers/sdd/task-6-report.md` 的"独立复核结论"一节）。
  // 根因不是"少写一个词"：`是错的` 里**没有连续的 `错了`**，而"你这句话是错的"正是
  // NON_GOALS「不制造分数焦虑」要挡的那种**直接给学习者下判断**的话。
  // 反向核对过：补上它不会误伤 `prompt.mjs` 要求"说出问题所在"的那类合法回应
  // （`You can say hesitate to do something.` / `Say that sentence again in the past tense.`
  // 实测仍然干净——探针 `tmp/probes/task-6-plan-scoring-check.mjs`）。
  /错了|错的|不对|不正确|错误|又错/,
  /\b(?:wrong|incorrect|mistake|error)\b/i,
]);

/** 拍子守卫：合法取值**只从 `session.mjs` 的 `PHASES` 取**（不另造枚举）。@throws {TypeError} */
function assertPhase(phase) {
  if (typeof phase !== 'string' || !PHASES.includes(phase)) {
    throw new TypeError(`checkReply: phase 必须是 ${PHASES.join(' / ')} 之一，收到 ${JSON.stringify(phase) ?? String(phase)}`);
  }
}

/** @throws {TypeError} 不是非空字符串（纯空白与空串同罪——留一个空白回复等于没说话） */
function assertNonEmptyString(v, name) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new TypeError(`checkReply: ${name} 必须是非空字符串，收到 ${JSON.stringify(v) ?? String(v)}`);
  }
}

/**
 * **判定**：这一拍 + 这一档下，"说出焦点词"算不算违规。
 *
 * 这是本模块最重要的一处判定，所以它被**导出**：`checkReply` 调它（唯一出处，不复制一份判定），
 * 测试也直接钉它（八格逐格），从而不会出现"实现改了、测试还按旧表绿着"。
 *
 * @param {string} phase session.mjs 的 PHASES 之一
 * @param {number} band  1–4（非法档位由 bandRules 抛 TypeError）
 * @returns {boolean} true = 说出焦点词要报 focus_leak
 * @throws {TypeError} 非法 phase / 非法 band
 */
export function focusLeakApplies(phase, band) {
  assertPhase(phase);
  bandRules(band);   // 非法档位在这里抛 TypeError（与 difficulty 同一个权威）
  // **只认 assist 为许可窗口**：其余任何拍子（含 elicit 与表外的 idle/intake/diagnose/stage/close）
  // 都没有"说出焦点词"的设计依据，一律照拦。
  if (phase !== 'assist') return true;
  return !NAMING_BANDS_IN_ASSIST.includes(band);
}

/**
 * 校验一次模型回复。
 *
 * @param {{
 *   text: string,
 *   focusRef: string,
 *   band: number,
 *   phase: string,
 *   focusMeaning?: string,
 * }} input
 *   - `phase`：**必填**，取当前拍子**原样**（`session.mjs` 的 `PHASES` 之一）。
 *     传错会改变判定，且两个方向都是真的坏事（见测试的"传错拍子会改变判定"）：
 *     该传 `assist` 却传 `elicit` → 静默**变紧**（2 档的帮助被判违规 ⇒ 降级模板话术）；
 *     该传 `elicit` 却传 `assist` → 静默**变松**（逼产出拍把答案说出来也不拦）。
 *   - `focusMeaning`：可选，中文释义。不传 = 释义不参与判定（见文件头代价 ⑥）。
 * @returns {{ ok: boolean, violations: string[] }} violations 按**固定顺序**（focus_leak → over_length
 *   → scoring_language）、可含多条；`ok` 就是"一条都没有"（不是第二个口径）
 * @throws {TypeError} text / focusRef 空或非字符串、band 非法、phase 缺失或非法
 */
export function checkReply({ text, focusRef, band, phase, focusMeaning = '' } = {}) {
  assertNonEmptyString(text, 'text');
  assertNonEmptyString(focusRef, 'focusRef');
  const rules = bandRules(band);   // 非法档位在这里抛 TypeError
  assertPhase(phase);
  if (typeof focusMeaning !== 'string') {
    throw new TypeError(`checkReply: focusMeaning 必须是字符串（可以不传或给空串），收到 ${JSON.stringify(focusMeaning) ?? String(focusMeaning)}`);
  }

  const violations = [];
  const lower = text.toLowerCase();

  // 1. 焦点泄漏（子串匹配 = 词族也算，见文件头"代价"）——**先问拍子 + 档位允不允许**。
  //    `focusLeakApplies` 是判定的唯一出处；这里只负责"命中没命中"。
  if (focusLeakApplies(phase, band)) {
    const needle = focusRef.toLowerCase();
    const meaning = focusMeaning.toLowerCase();
    // 两条走**同一把尺子**（`MIN_LEAK_LEN`）：焦点词与释义都可能极短（`"a"` / `"词"`），
    // 而短串会命中几乎任何文本——那不是泄漏，那是尺子太粗。只给其中一条加护栏等于看运气。
    if (
      (needle.length >= MIN_LEAK_LEN && lower.includes(needle))
      || (meaning.length >= MIN_LEAK_LEN && lower.includes(meaning))
    ) {
      violations.push('focus_leak');
    }
  }

  // 2. 长度（上限从 bandRules 取，见文件头"为什么长度上限走 bandRules"）
  if ([...text].length > rules.maxChars) violations.push('over_length');

  // 3. 评分语言（与拍子、档位无关）
  if (SCORING_PATTERNS.some((re) => re.test(text))) violations.push('scoring_language');

  return { ok: violations.length === 0, violations };
}
