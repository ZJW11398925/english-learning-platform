// web/units/teach/loop.mjs
//
// 一个回合的编排：组装提示词 → 调模型 → 机械校验 → 重生成 → 降级为模板话术。
//
// **纯逻辑**：零浏览器 API、零副作用、**自己不发请求**——`generate` 由调用方注入
// （浏览器路径注入真 DeepSeek 调用，测试注入假实现）。这样这一层能在 Node 里确定性地测，
// 也是"提示词约束到底有没有生效"这件事**唯一能被自动化钉住**的地方（设计稿 §3.6.3 的第三层）。
//
// ---------------------------------------------------------------------------
// 为什么必须有"降级"这一档（设计稿 §3.6.3 第三层）
// ---------------------------------------------------------------------------
// 提示词约束一定会被违反。如果只是"重试一次然后放弃"，那么在最坏情况下我们**要么把违规内容
// 给学习者**（泄漏了焦点词 = 把答案给了），要么给一片空白。两者都不行。所以最后一档是
// **模板话术**——它不含任何教学判断，因此不可能违规，保证了下限。
// 它仍然完成"留出使用位置"这件事：给学习者一个说话的机会（§3.6.2 正面约束 1）。
//
// 为什么重试时**降一档**而不是原样重试：设计稿 §3.4.2 的行为约束 3 写着"卡住时先降档，
// 不先给答案"。模型第一次没能在不泄漏的前提下把台子搭起来，通常意味着台子对这个学习者偏难
// ——降档比重复同一个请求更可能成功（`difficulty.mjs` 的"挫败的代价远大于无聊"同理）。
//
// ---------------------------------------------------------------------------
// 与计划 Task 9 原文的四处偏离（每一处都有仓库外实测支撑，见 `.superpowers/sdd/task-9-report.md`）
// ---------------------------------------------------------------------------
// ① **`checkReply` 的实参补 `phase` 与 `focusMeaning`**。计划第 1615 行写的是
//    `checkReply({ text, focusRef: focus.ref, band: currentBand })`，漏了 `phase`；
//    而 `validate.mjs` 的 `checkReply({ text, focusRef, band, phase, focusMeaning = '' })`
//    把 `phase` 定为**必填**，`assertPhase(undefined)` 响亮抛 TypeError。那句调用在 `try`
//    **之外**（`try` 只包 `generate`），所以异常不会被吞——`runTurn` **整体 reject**。
//    **实测**：计划原样实现跑它自己的 8 条 = `pass 2 / fail 6`，6 条全是这条 TypeError。
//    `phase` 必须**原样**透传：`validate.mjs` 第 184–187 行写明传错拍子两个方向都是静默的坏事
//    （该传 `assist` 传成 `elicit` → 静默变紧，2 档的帮助永远到不了学习者面前；
//    该传 `elicit` 传成 `assist` → 静默变松，逼产出拍把答案说出来也不拦）。
//    `focusMeaning` 传 `focus.meaning`：不传 = 中文释义**完全不参与**泄漏判定
//    （不是"视为无泄漏"，是"这一项没被检查"），而"4 档连释义一起隐去"是 Task 5 的人裁决
//    ——不传等于把那条裁决的守卫砍掉一半。**实测**：不传 `focusMeaning` 时计划自己的 8 条
//    仍然 8/8 全绿，一条都挡不住这个回退。
//
// ② **坏返回值（`null` / `undefined` / 空串 / 非字符串）按失败尝试处理**，不再 `String(...)`。
//    计划是 `text = String(await generate({ prompt, attempt }))`：`String(null)` = `'null'`、
//    `String(undefined)` = `'undefined'`——这两个串**不含焦点词、不过长、不含评分词**
//    ⇒ `checkReply` 判 ok ⇒ `degraded: false` ⇒ 学习者在对话里看到一条写着 `null` 的
//    「教学回复」。这不是假想：`web/units/deepseek.mjs` 第 50–52 行的 `extractContent`
//    在响应形状异常时就返回 `null`（旧链路 `compose.mjs:316` 会落 `response_invalid` 挡住，
//    **而计划的新链路没有这一步**）。所以"无回复"与"模型抛错"走**同一条路**：
//    记下原因、降档、进入下一次尝试或最终降级。
//
// ③ **`retryHint` 回灌**（计划第 1628–1630 行自己写明的"本计划里唯一的跨任务修改"）：
//    `prompt.mjs` 的 `assemblePrompt` 加可选参数 `retryHint`，第二次起把上一次的违规原因带过去。
//    见本文件下方的 `violationHint`。**实测**：去掉这段回灌，计划自己的 8 条仍然 8/8 全绿
//    ——第 6 条在 2 档起手上跑，而 `stepDown(2) === 2` ⇒ 两次提示词**逐字相同**，
//    只是它没断言这一点；本任务的护栏把 2 档那一格钉住了。
//
// ④ **不接 `narrowOnStuck`**（计划第 1459 行把它列为 Consumes，Step 3 的实现里零调用）。
//    **没有为它发明调用点或阈值**：§3.6.2 的"两次沉默 → 降档 → 仍沉默 → 换方法"需要一个
//    "何时算沉默"的判据，而 MVP 里视图**从不发 `stuck`**（`DEC-OPI-968b804d-…db.96` 已裁决登记），
//    "何时算卡住"是教学判断、本轮无真实数据支撑，强行补 = 凭空发明阈值。
//    ⇒ 声明与实现取**实现**这一侧：本模块不 import 它，并有护栏钉住这一点
//    （将来真要接，必须同时改护栏与这段理由，不许静默补上）。
//
// ⑤ **发请求之前多一道判定式守卫**（`assertPhaseAndBand`）：坏 `phase` 的权威守卫在
//    `validate.mjs`（`assertPhase`），而 `prompt.mjs` 只要求"非空字符串"。若不做这一步，
//    一个非法拍子会**先白发一次请求**、再由 `checkReply` reject——"六槽缺一不发调用"
//    是**行为**断言，不只是"最终会抛错"。代价：每回合多一次 `focusLeakApplies` 调用
//    （纯函数、无副作用、无 I/O），以及本模块多 import 一个符号（判据钉在源码级护栏里）。
//
// ---------------------------------------------------------------------------
// 代价（如实记）
// ---------------------------------------------------------------------------
//   ① `MAX_ATTEMPTS = 2` 意味着**最坏情况一次回合发 2 次请求**，这直接进成本
//      （契约 `COST_CONSTRAINTS` 那条"单次会话调用上限"）。调大它会**线性抬高花费**。
//   ② 降档是**本回合内一次性**的：返回的 `band` 是本次实际生效的档位，但**不写回**
//      学习者画象（`profile.setBand` 由调用方决定要不要落）。也就是说"模型这次没搭好台子"
//      与"这个学习者该降档"在本模块里**不是同一件事**——后者需要真实信号，
//      本模块只有"一条回复违不违规"这一个信号。
//   ③ 降级话术的**上限被压到 40 字符**（`FALLBACK_CAP`），比任何档位的 `maxChars` 都紧。
//      理由是它是"保底的一句邀请"，不是教学内容。代价：1 档起手时它被裁到 40 字符以内，
//      若将来模板句写长了，`[...text].slice(0, cap)` 会**静默截断**（截断点在句尾标点之前）。
//      护栏钉的是"四档下都不超档、非空、不含焦点词与释义"，**不是**"截断后读起来通顺"。
//   ④ `retryHint` 回灌的是**违规码**（`focus_leak` / `over_length` / `scoring_language` /
//      `generate_failed`）：模型并不知道 `focus_leak` 是什么意思，实际起作用的是
//      `prompt.mjs` 里那句中文引导（"这次务必避开"）+ 它自己上一轮的输出。
//      **没有为它发明人话映射**——那会是提示词工程里的第三次猜测。代价如实登记：
//      这一层的回灌**可能无效**（模型照旧犯规），效果只能靠真实使用观察，纯函数测不了。
//   ⑤ 一个**已实测的交互事实**（本轮**不改行为**）：允许表是「assist×1 违规 / **assist×2 允许** /
//      assist×3 违规 / assist×4 违规」而重试会**降一档** ⇒ 在 `assist` 拍、3 档起手时，
//      第二次尝试落在 2 档 ⇒ **允许**模型说出焦点词。这可能是**有意的帮助尺度**
//      （§3.5.3 的 2 档帮助本来就是"这个词 + 它的意思"），也可能是允许表的边角。
//      判据钉在测试里（`[已实测的交互事实]` 那条），**要改它必须先改 `DEC-…db.92` 的允许表**。
//   ⑥ 本模块**不认识教学质量**：它能保证"违规内容不外泄、长度不超档、卡住会降档"，
//      保证不了"这一回合教得好"。降级话术在真实对话里是否**过于频繁**（模型多常违规），
//      只能靠真实使用回答——纯函数测不了。

import { assemblePrompt } from './prompt.mjs';
import { checkReply, focusLeakApplies } from './validate.mjs';
import { bandRules, stepDown } from './difficulty.mjs';

/** 每个回合最多尝试几次（含第一次）。再失败就走模板话术。**它直接进成本**，见文件头代价 ①。 */
export const MAX_ATTEMPTS = 2;

/**
 * 降级话术的字符上限（比任何档位的 `maxChars` 都紧，见文件头代价 ③）。
 *
 * ⚠️ **它是冗余的，本模块不声称它被测试覆盖**：当前五个模板最长 14 个字符，
 * 这道裁剪在今天的表上**从不生效**（变异实测：整道裁剪删掉，全部用例仍然全绿）。
 * 它留着是防御"将来给表里加一句长话术"——那时裁剪会**静默改写**它（读起来像被截断的句子）。
 * 测试钉的是**表本身**的不变式（每一句都 ≤ 这个上限、且自己能过机械校验），
 * 不是"裁剪跑过了"。口径同 `difficulty.mjs` 里那条 `!Number.isInteger`。
 */
export const FALLBACK_CAP = 40;

/** 按方法的保底邀请。**不含任何教学判断**，因此不可能违规。键都在这里，查不到就退回通用句。 */
export const FALLBACK_BY_METHOD = Object.freeze({
  roleplay: '你先说，我听着。',
  recall: '说说看，今天有什么想讲的？',
  guess: '你先猜一个，不着急。',
  upgrade: '换个说法再讲一遍？',
});

/** 未知方法（或非 MVP 方法名）的通用保底句。**导出**是为了让测试断言的是"这一句"，
 *  而不是在测试里再抄一份字面量——照抄一份就等于给同一件事造第二个出处。 */
export const FALLBACK_GENERIC = '你先说说看。';

/**
 * 降级用的模板话术。
 *
 * 长度按**当前（已降过的）档位**裁：降级也要守约束，否则"保底"会变成"超长"。
 *
 * `Object.hasOwn` 是**防御性**的（`FALLBACK_BY_METHOD['toString']` 会顺着原型链取到函数，
 * 拼进话术里就是函数源码——同族缺陷本仓已修过两次）。⚠️ **但它在当前代码下不可达**：
 * `assemblePrompt` 只认九种合法方法名，`method` 走到这里必然合法；而本模块的 `runTurn`
 * 只可能用九种之一调它（`focusLeakApplies` 的预检拦掉了非法值）。所以**没有测试能覆盖它**，
 * 这里不声称覆盖（口径同 `difficulty.mjs` 的 `!Number.isInteger`）——变异实测：
 * 把它换成原型链直查，全部用例仍然全绿。
 */
function fallbackText({ method, band }) {
  const cap = Math.min(bandRules(band).maxChars, FALLBACK_CAP);
  const text = Object.hasOwn(FALLBACK_BY_METHOD, method) ? FALLBACK_BY_METHOD[method] : FALLBACK_GENERIC;
  return [...text].slice(0, cap).join('');
}

/**
 * 一次尝试的**有效性判定**：只有非空字符串才算模型给出了回复。
 *
 * 这条守卫就是文件头偏离 ② 的落点。**为什么不能 `String(v)`**：`String(null)` 是 `'null'`、
 * `String(undefined)` 是 `'undefined'`，两者都能通过机械校验（无焦点词 / 不过长 / 无评分词），
 * 于是学习者会看到一条写着 `null` 的"教学回复"且 `degraded: false`。
 *
 * 判据是 `trim() !== ''` 而不是 `length > 0`：一串纯空白同样是"没说任何话"，
 * 而它在屏幕上与空串一样是坏的（`validate.mjs` 的 `assertNonEmptyString` 对纯空白同罪）。
 *
 * @returns {string | null} 有效就返回原样的字符串（不 trim——不许改模型的输出），否则 null
 */
function usableText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * 把上一次尝试的失败原因转成 `assemblePrompt` 的 `retryHint`。
 *
 * 两种原因合流（见文件头偏离 ②）：机械校验的违规码（`focus_leak` / `over_length` /
 * `scoring_language`）与调用失败（`generate_failed`）。**空数组 → null**：
 * `retryHint` 非空时 `prompt.mjs` 才会追加那一段，空数组是 truthy 的，
 * 直接传会印出一段空的「上次的问题」——那既没用又会让提示词变脏。
 *
 * @returns {string[] | null}
 */
function violationHint(reasons) {
  return reasons.length > 0 ? [...reasons] : null;
}

/**
 * 发请求**之前**的判定式守卫：`phase` / `band` 的合法性。
 *
 * 为什么这一步必须存在（"缺一不发调用"是**行为**断言，不只是"最终会抛错"）：
 * 坏 `phase` / 坏 `band` 的**权威守卫在 `validate.mjs`**（`assertPhase` / `bandRules`），
 * 而 `prompt.mjs` 只要求 `phase` 是"非空字符串"。所以若把 `checkReply` 留在模型调用**之后**，
 * 一个非法拍子会先**白发一次请求**、再 reject——调用方看到的是异常，账单上是真实调用，
 * 且坏槽位被悄悄送进了模型。判据钉在测试里（"非法拍子 / 非法档位时一个请求都不许发"）。
 *
 * 只借用 `focusLeakApplies` 的**两个 `assert*`**（`validate.mjs` 里 `phase` 与 `band`
 * 的**唯一权威**），判定结果 `true` 只是"没抛错"的副产品。**不在这里复制允许表**：
 * 那张表是"说出焦点词算不算违规"的判定，属于校验层；loop 的降档逻辑不依赖它的返回值。
 *
 * @throws {TypeError} phase 不是 `session.mjs` 的 PHASES 之一 / band 非法
 */
function assertPhaseAndBand(phase, band) {
  focusLeakApplies(phase, band);
}

/**
 * 跑一个回合。
 *
 * 流程：组装提示词（六槽缺一在这里就炸，**一个请求都不发**）→ 调 `generate` → 校验 →
 * 违规就记原因、降一档、重来 → 用完 `MAX_ATTEMPTS` 仍不行 ⇒ 模板话术。
 *
 * @param {{
 *   generate: (input: { prompt: string, attempt: number }) => Promise<string>,
 *   phase: string, method: string, band: number, focus: object, learnerState: string, scene: string
 * }} input
 *   - `generate`：**必须是函数**，本模块不自己发请求也不兜底。返回非空字符串才算一次有效尝试。
 *   - `phase`：原样透传给 `checkReply`，**不许改写**（改写会让判定静默变紧或变松，见文件头偏离 ①）。
 *   - `focus.meaning`：作为 `focusMeaning` 交给 `checkReply`（4 档必须连释义一起隐去）。
 * @returns {Promise<{ text: string, method: string, band: number, degraded: boolean, attempts: number }>}
 *   - `band`：**实际生效**的档位（重试会降档，降级时是降过档的那个）。
 *   - `attempts`：**实际发起的尝试次数**；不是"失败次数"，降级时等于 `MAX_ATTEMPTS`。
 * @throws {TypeError} `generate` 不是函数；或六槽 / 档位 / 方法名 / 拍子违约（由 `prompt.mjs` 抛出，
 *   且**在第一次请求之前**）
 */
export async function runTurn({ generate, phase, method, band, focus, learnerState, scene } = {}) {
  if (typeof generate !== 'function') {
    throw new TypeError('runTurn: generate 必须是函数（把模型调用注入进来，本模块不自己发请求）');
  }
  // 发请求之前的判定式守卫（见 `assertPhaseAndBand`）。
  assertPhaseAndBand(phase, band);

  let currentBand = band;
  /** 上一次尝试的失败原因（机械校验的违规码，或 `generate_failed`）。 */
  let lastReasons = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // 组装提示词在 try **之外**：契约违约（缺槽位 / 非法档位 / 非法方法名）必须**响亮抛穿**，
    // 不许被当成"模型这次不行"而降级。六槽缺一不发调用是设计稿 §3.6.3 的第一层。
    const prompt = assemblePrompt({
      phase, method, band: currentBand, focus, learnerState, scene,
      // 第二次起把上一次的原因回灌给模型——否则它会原样再犯同一个错（计划第 1628–1630 行）
      retryHint: violationHint(lastReasons),
    });

    let raw;
    try {
      raw = await generate({ prompt, attempt });
    } catch {
      // 抛错与坏返回值走**同一条路**（偏离 ②）：算一次失败尝试，降档，重来。
      lastReasons = ['generate_failed'];
      currentBand = stepDown(currentBand);
      continue;
    }

    const text = usableText(raw);
    if (text === null) {
      // `null` / `undefined` / 空串 / 非字符串：**这不是一次有效的教学回复**。
      // 不许 `String()` 它——那会把 `'null'` 变成一条"合规"的回复（见文件头偏离 ②）。
      lastReasons = ['generate_failed'];
      currentBand = stepDown(currentBand);
      continue;
    }

    // 实参口径：`phase` 原样、`band` 用**当次**档位、`focusMeaning` 给释义。
    const verdict = checkReply({ text, focusRef: focus.ref, band: currentBand, phase, focusMeaning: focus.meaning });
    if (verdict.ok) {
      return { text, method, band: currentBand, degraded: false, attempts: attempt };
    }

    lastReasons = verdict.violations;
    currentBand = stepDown(currentBand);   // 卡住先降档，不先给答案（§3.6.2 正面约束 3）
  }

  return {
    text: fallbackText({ method, band: currentBand }),
    method,
    band: currentBand,
    degraded: true,
    attempts: MAX_ATTEMPTS,
  };
}
