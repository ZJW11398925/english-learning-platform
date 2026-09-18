// web/units/write/client.mjs
//
// 「从零写」这条链路的模型出口：把一组 OpenAI 形状的 messages 交给 DeepSeek
// （`/v1/chat/completions`，浏览器直连），拿回**一个字符串**。
//
// ── 它刻意不做什么 ────────────────────────────────────────────────────────────
// **不解析、不校验、不猜结构。** 本模块的返回值里只有 `content` 这个字符串，
// 它可能是任何东西（JSON、散文、空话）。"这段文本合不合约定"是 `./parse.mjs` 与
// `./validate.mjs` 的职责，本模块**绝不**替它们兜底——绝不对 content 做 JSON.parse、
// 绝不"从散文里抠字段"。理由与 `../compose.mjs` 文件头第 2 条同源：**失败绝不许长得像成功**。
// 于是这条链路的失败分档只有四档，每一档都指向一个**不同的**处置方向：
//
//   · `no_key`            —— 没传 Key（或传了个非字符串）。**不发请求**（那个请求必然 401），
//                            处置：引导去「设置（API Key）」。
//   · `timeout`           —— 我们设的上限到点（fetch 阶段或 res.json() 阶段都可能），
//                            处置：重试/看链路。**绝不与 `response_invalid` 混档**
//                            （`../recognize.mjs` 文件头第 4 条、Task 7 复审 Important 1 的同一课）。
//   · `request_failed`    —— 请求发不出去（断网/DNS/CORS/被拦）或 HTTP 非 2xx。
//                            处置：看端侧网络与模型服务状态。
//   · `response_invalid`  —— HTTP 成功了但信封不合契约（缺 `choices[0].message.content`、
//                            content 不是非空白字符串）。处置：改模型契约。
//
// ── 这一腿有上限（`WRITE_REQUEST_TIMEOUT_MS`）──────────────────────────────────
// `fetch` 默认**没有**超时：模型服务半开时 Promise 永久 pending——界面卡在「提交中」，
// 而这一回合的程序状态（`callsThisRound`）会一直停在半路。直连之后本值是**唯一**的腿
// （原「客户端必须大于服务端上限」的跨模块关系随服务端代理退役，见 `../compose.mjs` 文件头）。
// 取值理由：既有两条腿的实弹值——识物 1.86s、造句反馈 1.29–3.44s（`DEC-…b3.7`）。
// 本链路的提示词更长、要求模型产出的结构更大（教点 + 三级台阶 + 逐词释义），
// 故不沿用 24s 而取 **30s**（对既有最慢实弹值约 8.7 倍余量）。⚠️ **这是拍的值，不是标定值**：
// 本任务零计费、零实弹，真模型下这条腿的真实分布**未知**（报告里如实登记）。
//
// ── 每条失败路径都带 detail，且 detail 能定位问题 ──────────────────────────────
// `reason` 是封闭枚举（统计按它分组），`detail` 是给人读的一句话。
// 两者分工与 `../compose.mjs` 的 `reason`/`error`/`detail` 同源：绝不把散文塞进枚举位。
//
// 纯逻辑模块：零浏览器 API（`fetch` 是注入点，缺省在**调用时**取全局 `fetch`），
// 可在 Node 中直接测、直接变异（照抄 `../compose.mjs` 的调用形状，不自创风格）。
import { DEEPSEEK_API_BASE, DEEPSEEK_MODEL, chatUrl, extractContent } from '../deepseek.mjs';

/**
 * `callModel` 落空的原因枚举——**这里是权威定义处**。
 * 冻结：这是统计口径的一部分，任何一处 import 都不该能悄悄改写它。
 */
export const WRITE_FAIL_REASONS = Object.freeze({
  NO_KEY: 'no_key',
  TIMEOUT: 'timeout',
  REQUEST_FAILED: 'request_failed',
  RESPONSE_INVALID: 'response_invalid',
});

/**
 * 本链路的请求上限（毫秒）——**首轮设定值，未标定**（见文件头）。
 * 可在调用处覆盖（`callModel({ timeoutMs })`）；测试用一个小值即可，不必真等 30 秒。
 */
export const WRITE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 这次中止/异常是不是"我们设的上限到点了"（与 `../compose.mjs` / `../recognize.mjs` 同一判定）。
 * 用 `signal?.` 而不是 `signal.`：信号缺失时这里**不许多抛**一种错误。
 */
const isTimeoutAbort = (err, signal) => signal?.aborted === true
  || err?.name === 'TimeoutError' || err?.name === 'AbortError';

/** 落空结果的统一构造：四个字段一个不少，`detail` 一律是非空字符串（调用方可直接显示）。 */
function failure(reason, detail) {
  return { ok: false, reason, detail: String(detail ?? reason) };
}

/**
 * 把一组 messages 发给模型，拿回一个字符串。
 *
 * @param {object} input
 *   - `messages`：OpenAI 形状 `[{role, content}]`。本模块**原样上行**，不改一个字
 *     （"模型看到的是不是我们以为的东西"只有一个改动点，那在 `./prompt.mjs`）。
 *   - `apiKey`：访问者的 DeepSeek API Key。**必传**——空/非字符串当场落 `no_key`，
 *     不发那个必然 401 的请求（省一次注定失败的往返，并把"用户自己能修的一档"当场说清）。
 *   - `apiBase` / `model`：直连契约的注入点（生产缺省）。
 *   - `timeoutMs`：这一腿的上限（默认 `WRITE_REQUEST_TIMEOUT_MS`）。
 *   - `fetchImpl`：注入点；**缺省在调用时**取全局 `fetch`（"谁是网络出口"只有一个决定点）。
 *   - `nowImpl`：耗时的时钟注入点，缺省 `() => Date.now()`（与 `createEngine({ now })` 同源，
 *     单位是毫秒的墙钟）。
 * @returns {Promise<
 *   { ok: true, content: string, usage: object|null, latencyMs: number }
 *   | { ok: false, reason: 'no_key'|'timeout'|'request_failed'|'response_invalid', detail: string }
 * >}
 *   **本函数不抛错**：外界的一切失败都是"这一次没拿到 content"，必须变成一条有档位的
 *   失败（调用方据档位处置），而不是把整条链路炸掉。
 * @throws {RangeError} `timeoutMs` 非法（例如 NaN）时由 `AbortSignal.timeout` 抛出
 *   （Node 24.13 实测是 `ERR_OUT_OF_RANGE` 的 RangeError；`../compose.mjs` 的注释写的是
 *   TypeError，措辞随 V8 版本而变）。要守的性质是：**它在 try 之外发生**，
 *   所以不会被包装成一次"请求失败"（参数写错是编程错误，不是用户情形）。
 */
export async function callModel({
  messages,
  apiKey,
  apiBase = DEEPSEEK_API_BASE,
  model = DEEPSEEK_MODEL,
  timeoutMs = WRITE_REQUEST_TIMEOUT_MS,
  fetchImpl = null,
  nowImpl = null,
} = {}) {
  // 没配 Key：与 `../compose.mjs` 同一处置哲学——必 401 的请求不花那次往返。
  // Key 的存取在 `../keyring.mjs`，本模块只认参数（装配层在调用那一刻读好传入）。
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return failure(
      WRITE_FAIL_REASONS.NO_KEY,
      '还没有配置 API Key：这条链路是浏览器直连模型服务，需要你自己的 Key。'
      + '请点「设置（API Key）」粘贴保存（platform.deepseek.com 可以创建）。',
    );
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const now = nowImpl ?? (() => Date.now());

  // 上限在 try 之外装好：参数非法要响亮地成为 TypeError，而不是被 catch 成"请求发不出去"。
  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = now();

  const body = {
    model,
    messages,
    // JSON 模式兜底"必须是 JSON"：它保证**语法**，语义（有哪些字段、字段对不对）
    // 仍由 `./parse.mjs` 与 `./validate.mjs` 把关。这里只是省掉一类低级失败。
    response_format: { type: 'json_object' },
    // 低温度：这一档要的是"读这一版 / 改这一版"，不是发挥。
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
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // 网络层失败也要带档位，否则调用方分不清它与"响应不合契约"。
    // 超时单独说清：`AbortSignal.timeout` 触发时 fetch 以 TimeoutError 拒绝
    // （部分实现报 AbortError），这两种都不是"发不出去"，而是"等太久了"。
    const timedOut = isTimeoutAbort(err, signal);
    return failure(
      timedOut ? WRITE_FAIL_REASONS.TIMEOUT : WRITE_FAIL_REASONS.REQUEST_FAILED,
      timedOut
        ? `写作请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`
        : `写作请求发不出去：${String(err?.message ?? err)}`,
    );
  }

  if (!res.ok) {
    // 401/429/5xx 在这一层**不细分**（与 `../compose.mjs` 的分档有意不同）：
    // 本链路的四档是冻结契约（任务书第四节逐字给定），多造档位就是改契约。
    // 但状态码必须进 detail——否则"Key 无效"与"模型服务 500"看起来一模一样。
    return failure(
      WRITE_FAIL_REASONS.REQUEST_FAILED,
      `模型服务返回 HTTP ${res.status}`,
    );
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    // 这个 catch 里有**两种完全不同的成因**，必须分开（Task 7 复审 Important 1）：
    //   · 响应体不是 JSON（网关吐了一页 HTML）→ `response_invalid`：要改的是模型契约；
    //   · **响应头到了、body 还在流时上限到点**（网络停滞）→ `timeout` + 说清是超时。
    if (isTimeoutAbort(err, signal)) {
      return failure(
        WRITE_FAIL_REASONS.TIMEOUT,
        `写作请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`,
      );
    }
    return failure(
      WRITE_FAIL_REASONS.RESPONSE_INVALID,
      `模型响应不是合法 JSON：${String(err?.message ?? err)}`,
    );
  }

  // 信封（共享解析在 `../deepseek.mjs`）：`choices[0].message.content` 必须是**非空白字符串**。
  // 缺失/空串/不是字符串都归 `response_invalid`——绝不 "String(null)" 得一个 `"null"` 当内容
  // （那正是本项目已核实过的一条真缺陷的成因，见 AGENTS.md 的下游预检结论）。
  const content = extractContent(payload);
  if (content === null) {
    return failure(
      WRITE_FAIL_REASONS.RESPONSE_INVALID,
      '模型响应缺少 choices[0].message.content（信封不合法）',
    );
  }

  const elapsed = now() - startedAt;
  return {
    ok: true,
    content,
    // usage 原样带出（可能为 null）：**不补 0**——0 是"合法且极好"的读数，
    // 用它冒充"不知道"会把成本账算成假漂亮（红线 4）。
    usage: (payload?.usage !== null && typeof payload?.usage === 'object') ? payload.usage : null,
    // 时钟坏了（读不到有限数）也如实：调用方见 `!Number.isFinite` 就知道这次没量到。
    latencyMs: Number.isFinite(elapsed) ? elapsed : NaN,
  };
}
