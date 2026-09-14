// web/units/compose.mjs
//
// 造句反馈链路：把学习者写的那句话送到**我们自己的服务端**（`/api/feedback`），拿回结构化判定。
// 密钥只在服务端，本模块永远看不到它（共享上下文全局约束 1）。
//
// ── 为什么这条链路比识物那条更要紧 ────────────────────────────────────────────
// 整个产品的赌注是"成人愿不愿意付出**造句**这份主动产出成本"。学习者写下的句子、以及它换回来的
// 判定，就是那个赌注的证据本身。所以本模块有两条不许破的性质：
//   1. **原句永不丢**（A2/A4）：成功与失败两条路的返回值里都带着 `sentence`，一字不改。
//      失败档（`feedback_pending`）里它同样在——"待反馈队列"与验证三的语料都从它来。
//   2. **失败绝不长得像成功**（全局约束 3）：`status: 'ok'` 的意思是"校验通过、可用"，
//      **不是**"HTTP 200"。一份 200 但字段不合契约的响应体是 `pending`，不是 `ok`。
//
// ── 校验不在这里，也不许在这里重写 ────────────────────────────────────────────
// 响应的四个字段由 `validateFeedback`（Task 4，冻结）判，本模块只**路由**它的结论：
// 通过 → `ok`（`value` 就是入参本身，原样入库）；不通过 → `pending`，原因就是它给的 `errors`
// （每条都点名出错字段，`join('; ')` 后进事件流，供排查与 Task 9 的"待补反馈"）。
// **绝不猜字段、不补默认值、不把失败静默降级成成功。**
//
// ── `uncertain` 是合法结果，不是错误 ──────────────────────────────────────────
// 三个档位并列（设计文档 §4.2）。`uncertain` 走 `ok` 且带 `uncertain: true` 标记，
// 事件流里落**单独一条** `uncertain`（不混进 `feedback_ok`），因为口径是"单独统计、不计入通过率"。
// 注意它与 `error_type` 是**两个维度**：`uncertain + grammar` 是契约合法的组合，
// 所以任何按 `error_type` 的计数都必须**先按 verdict 分组**，否则拿不准的句子会被混进
// "通过/不通过"里（判据口径的前提，见文件末尾的说明与 `tests/compose.test.mjs` 的用例）。
//
// ── 这一腿有上限（`FEEDBACK_REQUEST_TIMEOUT_MS`）──────────────────────────────
// `fetch` 默认**没有**超时：上游半开（服务端不回、也不断）时这个 Promise 会永久 pending——
// 界面卡在提交中、学习者以为自己的句子没交出去，而且**一条事件都不会落**。
// 上限到点**可能发生在两个地方**——`fetch()` 那一句（连接都没建起来），或 `res.json()` 那一句
// （**响应头已经到了、body 还在流**）。两处都归 `timeout` 一档，绝不归 `response_invalid`：
// 后者在枚举里的处置方向是"改服务端或模型契约"，而一次网络停滞的真凶是连接
// （Task 7 复审 Important 1 的同一课，本次在造句链路上重演一遍）。
//
// 纯逻辑模块：零浏览器 API（`fetch` 是注入点，缺省在**调用时**取全局 `fetch`），可在 Node 中直接测。
import { validateFeedback } from './feedback.mjs';

/**
 * `submitSentence` 落空的原因枚举——**这里是权威定义处**。
 *
 * 为什么需要它（而不是只给一句错误文案）：这几档的**处置方向完全不同**，混在一起说话，
 * 看失败分布的人不知道该去改哪儿：
 *   - `empty_sentence`   —— 输入是空的（用户没写，或读不到输入框）。**当场拦下，不发请求**：
 *                           一次调用要花钱，空句换来的一定是一份无用的判定。
 *   - `timeout`          —— 上限到点或调用方主动取消（含"响应头到了、body 还在流"时被中止）。
 *                           要查的是网络/链路；**处置是重试**（补交队列会再发一次）。
 *   - `request_failed`   —— 请求发不出去（断网、DNS、CORS、被浏览器拦）。
 *                           要查的是端侧网络环境。
 *   - `http_error`       —— 服务端回了一个非 2xx（含它自己报的 `upstream_failed` /
 *                           `upstream_invalid`）。要看的是服务端日志与上游。
 *   - `response_invalid` —— HTTP 成功了，但那份东西不合约定（信封不对，或过不了 Task 4 的
 *                           校验器）。要改的是服务端或模型契约。
 *
 * 冻结：这是统计口径的一部分，任何一处 import 都不该能悄悄改写它。
 */
export const FEEDBACK_FAIL_REASONS = Object.freeze({
  EMPTY_SENTENCE: 'empty_sentence',
  TIMEOUT: 'timeout',
  REQUEST_FAILED: 'request_failed',
  HTTP_ERROR: 'http_error',
  RESPONSE_INVALID: 'response_invalid',
});

/**
 * 客户端这一腿的请求上限（毫秒）——**首轮设定值**，不是定论：第一周用真实数据标定，
 * 每次调整都要记入变更记录（与 `frame-qc.mjs` 的阈值、以及识物那条腿同一条纪律）。
 *
 * 为什么必须有它：见文件头"这一腿有上限"。上限到点是一条**有出口的失败**
 * （落 `feedback_pending`，原句保留、可补交），而不是让界面永远停在"提交中"。
 *
 * 与服务端那条腿的关系（**硬要求，有跨模块用例钉住**）：本值必须**大于**服务端的
 * `UPSTREAM_TIMEOUT_MS`（`server/feedback-upstream.mjs`，20000ms）。上游慢但活着时，
 * 应当由服务端先超时、先如实返回它自己的失败形状（`502 {ok:false,error:'upstream_failed'}`），
 * 客户端只是收到一个 HTTP 非 2xx → 落 `feedback_pending{reason:'http_error'}`。
 * 若客户端先超时，我们只会知道"我等烦了"，永远分不清是模型慢、服务端挂了还是网络断了。
 * 两者之间留的余量用于服务端把响应写回来。
 *
 * 调大 = 学习者对着"提交中"干等更久；调小 = 真实模型偶发变慢就被误报成失败。
 * 标定依据：实弹探针四次真实调用实测 1079 / 1137 / 1313 / 2129 / 3210 / 3439 ms，
 * 最慢一次服务端自报 `latency_ms` 3210ms（task-8-report 实弹探针一节）；本值约有 7 倍余量。
 * 上界还受一条硬约束压着：服务端的 `SERVER_REQUEST_TIMEOUT_MS`（30s）必须大于本值
 * （`tests/compose.test.mjs` 有用例钉住），否则慢请求会被服务端先掐断、客户端只看到一次网络中断。
 *
 * 可在调用处覆盖（`submitSentence(..., { timeoutMs })`），测试用一个小值即可，不必真等生产上限。
 */
export const FEEDBACK_REQUEST_TIMEOUT_MS = 24_000;

/** 同一个值的短别名：调用方读起来更顺（`FEEDBACK_TIMEOUT_MS`），两条腿的关系用例会钉住它。 */
export const FEEDBACK_TIMEOUT_MS = FEEDBACK_REQUEST_TIMEOUT_MS;

/**
 * 这次中止/异常是不是"我们设的上限到点了"（与 `units/recognize.mjs` 同一判定，理由也同）。
 *
 * 三种证据任一成立即可：① 信号已 aborted（本模块只装过 `AbortSignal.timeout`，所以除了上限到点，
 * 只剩调用方主动取消——两者的处置方向相同：重试，而不是去改模型契约）；
 * ② 错误本身是超时/中止（`AbortSignal.timeout` 触发时是 DOMException `TimeoutError`，
 * 部分实现报 `AbortError`）；③ 服务端自己说的 504/408（标准网关超时码，端到端超时的一种）。
 * 用 `signal?.` 而不是 `signal.`：信号缺失时这里**不许多抛**一种错误。
 */
const isTimeoutAbort = (err, signal) => signal?.aborted === true
  || err?.name === 'TimeoutError' || err?.name === 'AbortError';

/**
 * 落空结果的统一构造：**每一条失败路径都带原句**（A2/A4 的落点）。
 *
 * `reason` 与 `error` 两个字段的分工（都是 brief 与 Task 4 已经定下的口径，这里只是让它们各就各位）：
 *   · `reason` —— 五档**档位**之一（统计与事件流按它分组）。档位是封闭枚举，永远是这几个短串。
 *   · `error`  —— 一条**能定位问题**的诊断：字段不合规时就是 `validateFeedback` 给的 `errors`
 *     （每条都点名出错字段，Task 4 的复审明确规定**它就是被持久化成 pending 原因的那个东西**），
 *     HTTP 失败时是 `http_<状态码>`。它**不保证是枚举**，调用方要分档请读 `reason`。
 *   · `detail` —— 给人读的整句话（进 `feedback_pending` 的 payload 供排查）。
 */
function pending({ reason, error, detail = null, sentence, word, scene }) {
  return {
    status: 'pending', reason, error: error ?? reason, detail, sentence, word, scene,
  };
}

/**
 * 把学习者写的一句话交给服务端判定。
 *
 * @param {{ sentence: unknown, word: string, scene: string }} input
 *   `sentence` 是学习者写的原句（**原样发出去**：只拿它判"是不是空的"，绝不 trim 后再发）
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 *   `fetchImpl` 是注入点；**缺省在调用时**取全局 `fetch`（不是模块加载时绑定的那份），
 *   于是"谁是网络出口"始终只有一个决定点，浏览器与测试看到的都是同一个全局。
 *   `timeoutMs` 是这一腿的上限（默认 `FEEDBACK_REQUEST_TIMEOUT_MS`），测试用小值即可。
 * @returns {Promise<
 *   { status: 'ok', feedback: object, uncertain: boolean, sentence: string, word: string, scene: string }
 *   | { status: 'pending', reason: string, error: string, sentence: unknown, word: string, scene: string }
 * >}
 *   `ok` 的 `feedback` 是**校验器放行的那个对象本身**（同一引用，原样入库）；
 *   `pending` 的 `error` 是一条可定位的诊断（点名出错的字段或状态码），`reason` 是上面那五档之一。
 *   **本函数不抛错**：外界的一切失败都是"这次没拿到反馈"，不是编程错误——它必须变成一条
 *   有出口的 pending（原句保留、可补交），而不是把调用方炸掉。
 * @throws {TypeError} `timeoutMs` 非法（例如 NaN）时由 `AbortSignal.timeout` 抛出。
 *   它**在 try 之外**发生，所以不会被包装成一次"请求失败"——参数写错是编程错误，不是用户情形。
 */
export async function submitSentence(
  { sentence, word, scene },
  { fetchImpl = null, timeoutMs = FEEDBACK_REQUEST_TIMEOUT_MS } = {},
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

  const doFetch = fetchImpl ?? globalThis.fetch;
  // 上限在这里就装好（不放进下面的 try）：参数非法要响亮地成为 TypeError，
  // 而不是被 catch 成"这次的反馈没拿到"。
  const signal = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await doFetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 原句原样上行：服务端与模型看到的必须是用户写下的那句话。
      body: JSON.stringify({ sentence, word, scene }),
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
    // 服务端自己报的失败形状（502 upstream_failed / upstream_invalid、400 bad_request…）
    // 也走这一档：`ok` 只表示"HTTP 成功"，非 2xx 一律不是成功。
    // 504/408 是标准网关超时码，归超时一档（真凶是上游慢，不是契约不对）。
    const gatewayTimeout = res.status === 504 || res.status === 408;
    return pending({
      reason: gatewayTimeout ? FEEDBACK_FAIL_REASONS.TIMEOUT : FEEDBACK_FAIL_REASONS.HTTP_ERROR,
      // 档位 + 状态码：`error` 保持"一条能定位的诊断"，而不是一句散文。
      error: `http_${res.status}`,
      detail: `服务端返回 HTTP ${res.status}（要看的是服务端日志与上游，不是端侧输入）`,
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
    //   · 响应体不是 JSON（例如网关吐了一页 HTML）→ `response_invalid`：要改的是服务端/模型契约；
    //   · **响应头已经到了、body 还在流时上限到点**（网络停滞）→ `timeout` + 说清是超时。
    // 后者若被归成 `response_invalid`，一次网络停滞就被丢进"改服务端契约"那一档。
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

  // 先看**信封**：服务端约定 `{ ok: true, ...四个字段 }`。
  // 这里**只在 `ok` 出现时**要求它是 true（`ok: false` 的 200 是"服务端说自己失败了"，
  // 绝不能当成一份反馈往下走）。`ok` 缺席时不拦：四个字段齐备就能判，而"齐备"由下面
  // Task 4 的校验器说了算。多加一道 `ok !== true` 就把校验器的权威搬到了这里，
  // 也把一份字段齐备的响应判成了不可用——那是收紧契约，不是保守。
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.ok === false) {
    return pending({
      reason: FEEDBACK_FAIL_REASONS.RESPONSE_INVALID,
      detail: '造句反馈响应结构非法（期望一个带 verdict/error_type/rewrite/note 的对象）',
      sentence,
      word,
      scene,
    });
  }

  // 语义归 Task 4 的校验器（**这里不重写一套**）。`errors` 每条都点名出错字段——它就是
  // pending 的原因（Task 9 把它落进"待补反馈"队列，将来排查时靠它定位）。
  const verdict = validateFeedback(raw);
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
 *      设计文档 §4.2 要求 `uncertain` 单独统计、不计入通过率——两条都记的话，"通过率"的分子
 *      里就混进了拿不准的句子，而分母不变，读出来的通过率是错的。**一轮只落一条结论事件**，
 *      与识物那条链路的 if/else 同一条纪律；
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
      // 落空的档位（五档之一）、给统计用的 `error`，以及给人读的一行诊断——Task 9 的
      // "待补反馈"队列靠这几个字段工作。
      reason: result?.reason ?? null,
      error: result?.error ?? null,
      detail: result?.detail ?? null,
    },
  };
}
