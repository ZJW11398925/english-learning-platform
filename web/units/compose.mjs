// web/units/compose.mjs
//
// 造句反馈链路：把学习者写的那句话**浏览器直连**发给 DeepSeek（`/v1/chat/completions`，
// Task 12A，项目转向 DEC-…23/26——服务端代理退役），拿回结构化判定。
// Key 由访问者提供（页面「设置」里保存，经参数进来）；本模块**不碰任何存储**。
//
// ── 为什么这条链路比识物那条更要紧 ────────────────────────────────────────────
// 整个产品的赌注是"成人愿不愿意付出**造句**这份主动产出成本"。学习者写下的句子、以及它换回来的
// 判定，就是那个赌注的证据本身。所以本模块有两条不许破的性质：
//   1. **原句永不丢**（A2/A4）：成功与失败两条路的返回值里都带着 `sentence`，一字不改。
//      失败档（`feedback_pending`）里它同样在——"待反馈队列"与验证三的语料都从它来。
//   2. **失败绝不长得像成功**（全局约束 3）：`status: 'ok'` 的意思是"校验通过、可用"，
//      **不是**"HTTP 200"。一份 200 但字段不合契约的响应体是 `pending`，不是 `ok`。
//
// ── 自旧服务端代理（已退役）逐字移植的口径（parity 由 tests/compose.test.mjs 钉住）──
// 服务端代理退役后，模型契约整体搬到客户端：
//   · 强约束提示词 `FEEDBACK_PROMPT` 与四条**单独成常量**的规则（可被单独断言/变异），逐字移植；
//   · 消息组装：system 放提示词，user 放 `Target word / Scene / Learner's sentence` 三行；
//   · 信封校验：`choices[0].message.content` 必须是非空白字符串、content 必须是 JSON、
//     解出来必须是对象（信封共享解析在 `./deepseek.mjs`）——客户端是最后一道信封闸。
//
// ── 校验不在这里，也不许在这里重写 ────────────────────────────────────────────
// 响应的四个字段由 `validateFeedback`（Task 4，冻结）判，本模块只**路由**它的结论：
// 通过 → `ok`（`value` 就是入参本身，原样入库）；不通过 → `pending`，原因就是它给的 `errors`
// （每条都点名出错字段，`join('; ')` 后进事件流，供排查与"待补反馈"队列）。
// **绝不猜字段、不补默认值、不把失败静默降级成成功。**
//
// ── 失败分档（12A 最小扩展，报告里已说明）─────────────────────────────────────
// 直连后 Key 是访问者自己的：401（Key 无效/无权限）单独归 `auth_failed`、没配 Key 也归
// `auth_failed`（不发请求）、429（限频）单独归 `rate_limited`——这三档"用户自己能修/能等"，
// 与泛泛的 `http_error` 处置方向不同，混在一档用户只能看到"服务挂了"。
//
// ── `uncertain` 是合法结果，不是错误 ──────────────────────────────────────────
// 三个档位并列（设计文档 §4.2）。`uncertain` 走 `ok` 且带 `uncertain: true` 标记，
// 事件流里落**单独一条** `uncertain`（不混进 `feedback_ok`），因为口径是"单独统计、不计入通过率"。
//
// ── 这一腿有上限（`FEEDBACK_REQUEST_TIMEOUT_MS`）──────────────────────────────
// `fetch` 默认**没有**超时：模型服务半开时这个 Promise 会永久 pending——界面卡在提交中、
// 学习者以为自己的句子没交出去，而且**一条事件都不会落**。上限到点可能在 `fetch()` 或
// `res.json()` 两处，都归 `timeout` 一档，绝不归 `response_invalid`（Task 7 复审 Important 1
// 的同一课）。直连后没有"服务端那条腿"了：原"必须大于服务端 20s"的跨模块关系随代理退役，
// 本值是**唯一的**腿。
//
// 纯逻辑模块：零浏览器 API（`fetch` 是注入点，缺省在**调用时**取全局 `fetch`），可在 Node 中直接测。
import { validateFeedback } from './feedback.mjs';
import { DEEPSEEK_API_BASE, DEEPSEEK_MODEL, chatUrl, extractContent } from './deepseek.mjs';

/**
 * `submitSentence` 落空的原因枚举——**这里是权威定义处**。
 *
 * 各档的**处置方向完全不同**，混在一起说话，看失败分布的人不知道该去改哪儿：
 *   - `empty_sentence`   —— 输入是空的（用户没写，或读不到输入框）。**当场拦下，不发请求**。
 *   - `timeout`          —— 上限到点或调用方主动取消（含"响应头到了、body 还在流"时被中止）。
 *                           要查的是网络/链路；**处置是重试**（补交队列会再发一次）。
 *   - `request_failed`   —— 请求发不出去（断网、DNS、CORS、被浏览器拦；401/429 除外）。
 *                           要查的是端侧网络环境。
 *   - `http_error`       —— 模型服务回了一个其他非 2xx。要看的是请求与模型服务的状态。
 *   - `response_invalid` —— HTTP 成功了，但那份东西不合约定（信封缺 content、content 不是
 *                           JSON、解出来不是对象、或过不了 Task 4 的校验器）。要改的是模型契约。
 *   - `auth_failed`      —— 12A 新增：没配 Key（不发请求）或模型服务回 401。处置：到
 *                           「设置（API Key）」检查/重新粘贴——访问者自己能修的一档。
 *   - `rate_limited`     —— 12A 新增：模型服务回 429（请求太频繁）。处置：稍等再试。
 *
 * 冻结：这是统计口径的一部分，任何一处 import 都不该能悄悄改写它。
 */
export const FEEDBACK_FAIL_REASONS = Object.freeze({
  EMPTY_SENTENCE: 'empty_sentence',
  TIMEOUT: 'timeout',
  REQUEST_FAILED: 'request_failed',
  HTTP_ERROR: 'http_error',
  RESPONSE_INVALID: 'response_invalid',
  AUTH_FAILED: 'auth_failed',
  RATE_LIMITED: 'rate_limited',
});

/**
 * 客户端这一腿的请求上限（毫秒）——**首轮设定值**，不是定论：第一周用真实数据标定。
 * 取值依据：实弹探针 7 次真实调用实测 1068–3439 ms，最慢一次自报 `latency_ms` 3210ms
 * （task-8-report 实弹探针一节）；本值约有 7 倍余量。直连后本值是唯一的腿
 * （原"必须大于服务端 20s"的跨模块关系随代理退役）。可在调用处覆盖，测试用小值即可。
 */
export const FEEDBACK_REQUEST_TIMEOUT_MS = 24_000;

/** 同一个值的短别名：调用方读起来更顺（`FEEDBACK_TIMEOUT_MS`）。 */
export const FEEDBACK_TIMEOUT_MS = FEEDBACK_REQUEST_TIMEOUT_MS;

// ─────────────── 自旧服务端代理（已退役）逐字移植的提示词───────────────
//
// 四条规则逐条单独成常量的理由：每一条都对应一个必须成立的行为，而"整段提示词里出现过
// 某几个字"这种断言拦不住"把其中一条删掉"。拆开之后每条都能被单独断言，也就能被
// 变异探针单独钉住——提示词里被删掉一句，测试必须响。

export const FEEDBACK_RULE_VERDICTS = '- "verdict": one of "correct", "flawed", "uncertain".';
export const FEEDBACK_RULE_ERROR_TYPES = '- "error_type": one of "word_choice", "collocation", "grammar", "none".';
export const FEEDBACK_RULE_CORRECT = [
  '- "verdict":"correct" MUST come with "error_type":"none".',
].join('\n');
export const FEEDBACK_RULE_FLAWED = [
  '- "verdict":"flawed" MUST name the single most important problem in "error_type"',
  '  (never "none"), and MUST give a corrected sentence in "rewrite".',
].join('\n');
export const FEEDBACK_RULE_UNCERTAIN = [
  '- Use "uncertain" only when you genuinely cannot judge the sentence. It is a real,',
  '  acceptable answer — never guess a confident wrong verdict instead.',
  '  When you answer "uncertain", STILL put a suggested rewrite in "rewrite"',
  '  (keep the learner\'s own meaning), and say in "note" why you are unsure.',
].join('\n');

/**
 * 提示词：强约束"只输出这四个字段"，并要求 `uncertain` 时**也给**改写建议。
 * **逐字移植自旧服务端代理**（parity 闸：tests/compose.test.mjs 断言两份
 * 逐字相等，server 退役前不许漂移）。校验器仍是权威：它放行的东西才往下走。
 */
export const FEEDBACK_PROMPT = [
  'You are an English tutor for an adult learner who is practising one target vocabulary word.',
  'The learner wrote their own sentence using the target word.',
  'Judge the sentence, then return STRICT JSON only, no prose, in exactly this shape:',
  '{"verdict":"flawed","error_type":"word_choice","rewrite":"I use a mug.","note":"…"}',
  'It must be a JSON object with exactly these four fields:',
  FEEDBACK_RULE_VERDICTS,
  FEEDBACK_RULE_ERROR_TYPES,
  '- "rewrite": a better version of the sentence as a plain string, or null.',
  '- "note": one short sentence for the learner, in Chinese, no jargon.',
  'Rules:',
  FEEDBACK_RULE_CORRECT,
  FEEDBACK_RULE_FLAWED,
  FEEDBACK_RULE_UNCERTAIN,
  '- Never add extra fields or commentary outside the JSON object.',
].join('\n');

/**
 * 这次中止/异常是不是"我们设的上限到点了"（与 `units/recognize.mjs` 同一判定，理由也同）。
 * 用 `signal?.` 而不是 `signal.`：信号缺失时这里**不许多抛**一种错误。
 */
const isTimeoutAbort = (err, signal) => signal?.aborted === true
  || err?.name === 'TimeoutError' || err?.name === 'AbortError';

/**
 * 落空结果的统一构造：**每一条失败路径都带原句**（A2/A4 的落点）。
 *
 * `reason` 与 `error` 两个字段的分工：
 *   · `reason` —— 档位之一（统计与事件流按它分组）。档位是封闭枚举，永远是这几个短串。
 *   · `error`  —— 一条**能定位问题**的诊断：字段不合规时就是 `validateFeedback` 给的 `errors`
 *     （每条都点名出错字段），HTTP 失败时是 `http_<状态码>`，缺 Key 时是 `missing_api_key`。
 *     它**不保证是枚举**，调用方要分档请读 `reason`。
 *   · `detail` —— 给人读的整句话（进 `feedback_pending` 的 payload 供排查）。
 */
function pending({ reason, error, detail = null, sentence, word, scene }) {
  return {
    status: 'pending', reason, error: error ?? reason, detail, sentence, word, scene,
  };
}

/**
 * 把学习者写的一句话直连交给模型判定。
 *
 * @param {{ sentence: unknown, word: string, scene: string }} input
 *   `sentence` 是学习者写的原句（**原样发出去**：只拿它判"是不是空的"，绝不 trim 后再发）
 * @param {object} [options]
 *   - `apiKey`：访问者的 DeepSeek API Key；缺了当场落 `auth_failed`（不发必 401 的请求）
 *   - `fetchImpl`：注入点；**缺省在调用时**取全局 `fetch`（"谁是网络出口"只有一个决定点）
 *   - `timeoutMs`：这一腿的上限（默认 `FEEDBACK_REQUEST_TIMEOUT_MS`），测试用小值即可
 *   - `apiBase` / `model`：直连契约的注入点（生产缺省）
 * @returns {Promise<
 *   { status: 'ok', feedback: object, uncertain: boolean, sentence: string, word: string, scene: string }
 *   | { status: 'pending', reason: string, error: string, sentence: unknown, word: string, scene: string }
 * >}
 *   `ok` 的 `feedback` 是**校验器放行的那个对象本身**（同一引用，原样入库）；
 *   **本函数不抛错**：外界的一切失败都是"这次没拿到反馈"，不是编程错误——它必须变成一条
 *   有出口的 pending（原句保留、可补交），而不是把调用方炸掉。
 * @throws {TypeError} `timeoutMs` 非法（例如 NaN）时由 `AbortSignal.timeout` 抛出——
 *   它在 try 之外发生，不会被包装成一次"请求失败"（参数写错是编程错误，不是用户情形）。
 */
export async function submitSentence(
  { sentence, word, scene },
  {
    fetchImpl = null, timeoutMs = FEEDBACK_REQUEST_TIMEOUT_MS,
    apiKey = null, apiBase = DEEPSEEK_API_BASE, model = DEEPSEEK_MODEL,
  } = {},
) {
  // 空句当场拦下：**一个字都没有**就不该花掉一次调用（空句换来的一定是一份无用的判定）。
  // 只判"空不空"，**不 trim 要发出去的内容**：前后的空格是用户打的字，不是我们的格式偏好。
  if (typeof sentence !== 'string' || sentence.trim() === '') {
    return pending({
      reason: FEEDBACK_FAIL_REASONS.EMPTY_SENTENCE,
      error: FEEDBACK_FAIL_REASONS.EMPTY_SENTENCE,
      sentence,
      word,
      scene,
    });
  }

  // 没配 Key：与空句同一处置哲学——必 401 的请求不花那次往返，当场给出可行动的失败档。
  // Key 的存取在 keyring.mjs，本模块只认参数（装配层在提交那一刻读好传入）。
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return pending({
      reason: FEEDBACK_FAIL_REASONS.AUTH_FAILED,
      error: 'missing_api_key',
      detail: '还没有配置 API Key：反馈判定是浏览器直连模型服务，需要你自己的 Key。'
        + '请点「设置（API Key）」粘贴保存（platform.deepseek.com 可以创建）。原句没有丢，配好 Key 再交一次就行。',
      sentence,
      word,
      scene,
    });
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  // 上限在这里就装好（不放进下面的 try）：参数非法要响亮地成为 TypeError，
  // 而不是被 catch 成"这次的反馈没拿到"。
  const signal = AbortSignal.timeout(timeoutMs);

  const body = {
    model,
    messages: [
      { role: 'system', content: FEEDBACK_PROMPT },
      {
        role: 'user',
        content: [
          `Target word: ${word}`,
          `Scene: ${scene}`,
          `Learner's sentence: ${sentence}`,
        ].join('\n'),
      },
    ],
    // JSON 模式兜底"必须是 JSON"：它保证**语法**，语义仍由客户端校验器把关。
    response_format: { type: 'json_object' },
    // 低温度：这一档要的是判定，不是发挥。
    temperature: 0.2,
  };

  let res;
  try {
    res = await doFetch(chatUrl(apiBase), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 访问者自己的 Key，随请求头直达模型服务——直连世界里没有"服务端替我们注入"这一层。
        authorization: `Bearer ${apiKey}`,
      },
      // 原句原样上行：模型看到的必须是用户写下的那句话。
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // 网络层失败（断网、请求被浏览器中断、上限到点）也要带上档位，否则调用方分不清
    // 它与"响应不合契约"。超时单独说清楚——`AbortSignal.timeout` 触发时 fetch 会以
    // `TimeoutError` 拒绝（部分实现报 `AbortError`），这两种都不是"发不出去"，而是"等太久了"。
    const timedOut = isTimeoutAbort(err, signal);
    return pending({
      reason: timedOut ? FEEDBACK_FAIL_REASONS.TIMEOUT : FEEDBACK_FAIL_REASONS.REQUEST_FAILED,
      error: timedOut
        ? `造句反馈请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`
        : `造句反馈请求发不出去：${String(err?.message ?? err)}`,
      sentence,
      word,
      scene,
    });
  }

  if (!res.ok) {
    // 401/429 与"普通 HTTP 失败"分开（12A 最小扩展，理由见文件头）：
    // 这两档访问者自己能修（回设置页换 Key）或能等（限频），文案必须指对方向。
    // 504/408 是标准网关超时码，归超时一档（真凶是上游慢，不是契约不对）。
    const gatewayTimeout = res.status === 504 || res.status === 408;
    const auth = res.status === 401;
    const rate = res.status === 429;
    return pending({
      reason: gatewayTimeout
        ? FEEDBACK_FAIL_REASONS.TIMEOUT
        : auth
          ? FEEDBACK_FAIL_REASONS.AUTH_FAILED
          : rate
            ? FEEDBACK_FAIL_REASONS.RATE_LIMITED
            : FEEDBACK_FAIL_REASONS.HTTP_ERROR,
      // 档位 + 状态码：`error` 保持"一条能定位的诊断"，而不是一句散文。
      error: `http_${res.status}`,
      detail: auth
        ? '模型服务说这个 API Key 无效或没有权限（HTTP 401）。请到「设置（API Key）」检查或重新粘贴。原句没有丢。'
        : rate
          ? '模型服务说请求太频繁（HTTP 429）。稍等一两分钟再交一次，原句没有丢。'
          : `模型服务返回 HTTP ${res.status}（这次没拿到判定，不是你的句子有问题）`,
      sentence,
      word,
      scene,
    });
  }

  let raw;
  try {
    raw = await res.json();
  } catch (err) {
    // 这个 catch 里有**两种完全不同的成因**，必须分开（Task 7 复审 Important 1）：
    //   · 响应体不是 JSON（例如网关吐了一页 HTML）→ `response_invalid`：要改的是模型契约；
    //   · **响应头已经到了、body 还在流时上限到点**（网络停滞）→ `timeout` + 说清是超时。
    if (isTimeoutAbort(err, signal)) {
      return pending({
        reason: FEEDBACK_FAIL_REASONS.TIMEOUT,
        detail: `造句反馈请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`,
        sentence,
        word,
        scene,
      });
    }
    return pending({
      reason: FEEDBACK_FAIL_REASONS.RESPONSE_INVALID,
      detail: `造句反馈响应不是合法 JSON：${String(err?.message ?? err)}`,
      sentence,
      word,
      scene,
    });
  }

  // 信封（移植口径）：上游约定 `choices[0].message.content` 里是严格 JSON。
  // content 缺失/空白/不是 JSON/解出来不是对象，都如实落 `response_invalid`
  // ——绝不"从散文里抠四个字段"当成功（那是猜测，不是判定）。
  const content = extractContent(raw);
  if (content === null) {
    return pending({
      reason: FEEDBACK_FAIL_REASONS.RESPONSE_INVALID,
      detail: '模型响应缺少 choices[0].message.content（信封不合法）',
      sentence,
      word,
      scene,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return pending({
      reason: FEEDBACK_FAIL_REASONS.RESPONSE_INVALID,
      detail: `模型响应 content 不是合法 JSON：${String(err?.message ?? err)}`,
      sentence,
      word,
      scene,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return pending({
      reason: FEEDBACK_FAIL_REASONS.RESPONSE_INVALID,
      detail: '模型响应 content 解出来不是对象（期望 verdict/error_type/rewrite/note）',
      sentence,
      word,
      scene,
    });
  }

  // 语义归 Task 4 的校验器（**这里不重写一套**）。`errors` 每条都点名出错字段——它就是
  // pending 的原因（"待补反馈"队列靠它定位模型少给了什么）。
  const verdict = validateFeedback(parsed);
  if (!verdict.ok) {
    return pending({
      reason: FEEDBACK_FAIL_REASONS.RESPONSE_INVALID,
      // `errors` 每条都点名出错字段，**原样**作为 pending 的诊断（Task 4 的复审把这条定成了
      // 契约：它就是被持久化成 pending 原因的东西，不点名就没法定位是模型少给了什么）。
      error: verdict.errors.join('; '),
      detail: `造句反馈响应不合契约：${verdict.errors.join('; ')}`,
      sentence,
      word,
      scene,
    });
  }

  return {
    status: 'ok',
    // `verdict.value` 就是入参本身（同一引用）：落库的必须是模型原话，本模块不当规整器。
    feedback: verdict.value,
    // `uncertain` 单列标记（设计文档 §4.2 的口径）：界面要如实显示"拿不准"，
    // 统计要把它单独算、不计入通过率。事件流里它是单独一条 `uncertain`，见 `feedbackEventFor`。
    uncertain: verdict.value.verdict === 'uncertain',
    sentence,
    word,
    scene,
  };
}

/**
 * 把一次提交的结果映射成一条**事件**（`{ type, payload }`），供调用方交给 `recordEvent` 落盘。
 *
 * 三条映射规则，每条都对应一个口径：
 *   1. `ok` 且非 `uncertain` → `feedback_ok`；
 *   2. `ok` 且 `uncertain`   → **`uncertain`**（单独一条，**不**同时落 `feedback_ok`）。
 *      **一轮只落一条结论事件**，与识物那条链路的 if/else 同一条纪律；
 *   3. 其余（`pending`）         → `feedback_pending`。
 *
 * `payload` 一定带 `sentence`（A4：学习者的句子就是语料，任何一条路径都不许把它丢掉），
 * 另带 `word`/`scene`（补交时要重发同一份上下文）。
 *
 * @param {{ status: string, [key: string]: unknown }} result `submitSentence` 的返回值
 * @returns {{ type: string, payload: object }} `type` 是 `EVENT_TYPES` 里已登记的类型；
 *   `payload` 不含 `sessionId`/`wordId`/`roundIndex`（那三个是 `recordEvent` 的事件顶层字段）
 */
export function feedbackEventFor(result) {
  const base = { sentence: result?.sentence ?? null, word: result?.word ?? null, scene: result?.scene ?? null };
  if (result?.status === 'ok' && result.uncertain === true) {
    return {
      type: 'uncertain',
      payload: {
        ...base,
        verdict: result.feedback?.verdict ?? null,
        error_type: result.feedback?.error_type ?? null,
        note: result.feedback?.note ?? null,
        rewrite: result.feedback?.rewrite ?? null,
        uncertain: true,
      },
    };
  }
  if (result?.status === 'ok') {
    return {
      type: 'feedback_ok',
      payload: {
        ...base,
        verdict: result.feedback?.verdict ?? null,
        error_type: result.feedback?.error_type ?? null,
        note: result.feedback?.note ?? null,
        rewrite: result.feedback?.rewrite ?? null,
      },
    };
  }
  return {
    type: 'feedback_pending',
    payload: {
      ...base,
      // 落空的档位、给统计用的 `error`，以及给人读的一行诊断——"待补反馈"队列靠这几个字段工作。
      reason: result?.reason ?? null,
      error: result?.error ?? null,
      detail: result?.detail ?? null,
    },
  };
}
