// web/units/chat/client.mjs
//
// 对话客厅的模型出口：把一组 OpenAI 形状的 messages 发到**访问者自己配的**
// OpenAI 兼容端点（`/v1/chat/completions`），拿回一个字符串。
//
// ── 与 `../write/client.mjs` 的关系（本文件由它泛化而来）──────────────────────
// 写作链路的 client 把 DeepSeek 写死（`import { DEEPSEEK_API_BASE, DEEPSEEK_MODEL }
// from '../deepseek.mjs'`）。对话形态的契约改成了 BYOK 零预置：baseURL / 模型名 /
// API Key **全部来自设置**（`./settings.mjs`，存 localStorage），本模块**不 import
// 任何厂商常量**——一个 `deepseek` 字符串都不许出现在这里（唯一例外见下面 thinking 段）。
// 四档失败分档、`AbortSignal.timeout` 这一腿的上限、usage 不补 0，全部沿用写作链路
// 已被实弹验证过的形状（`DEC-…db.209/211/214` 那几轮修出来的）。
//
// ── 失败分档（五档，比写作链路多一档）─────────────────────────────────────────
//   · `no_endpoint`   —— 没配 baseURL / 模型名。**不发请求**。处置：引导去设置。
//   · `no_key`        —— 没配 Key。**不发请求**（本地 BYOK 端点也可能要 Key，
//                        所以 Key 与端点分开判、分开说）。
//   · `timeout`       —— 我们设的上限到点（fetch 阶段或 res.json() 阶段都可能）。
//   · `request_failed`—— 请求发不出去（断网/DNS/CORS/被拦）或 HTTP 非 2xx。
//   · `response_invalid` —— HTTP 成功了但信封不合契约（缺 `choices[0].message.content`）。
// 多出的 `no_endpoint` 是 BYOK 的诚实需要：「端点没配」与「Key 没配」在设置页是
// 两个不同的空格，混成一档用户就不知道该填哪个。
//
// ── `thinking: {type:'disabled'}` 只在 DeepSeek 端点上发（本文件唯一的厂商感知）────
// 依据 TASK F 实弹对照（`docs/live-write-2026-09-18-thinking-off/`）：思考模式吃掉
// 82.5% 的钱、单次 27 秒；关掉后 7.0× 便宜、6.9× 快（人裁 `DEC-…OPI-…db.217`）。
// 但 OpenAI 官方端点会对**未识别的顶层参数**回 400（"Unrecognized request argument"），
// 无条件发这个字段会把「用户配了 OpenAI」变成必 400。⇒ 折中：**只在 base 的 host 里
// 含 `deepseek` 时**带上它。这是一条兼容垫片，不是预置厂商——用户不配 DeepSeek 时
// 本模块对端点形状零假设。别的带思考的端点（各家网关）拿不到这层省钱保护，
// 如实登记在报告里，不猜、不扩展名单。
//
// ── `response_format` 只在要 JSON 那一腿带（人设生成）────────────────────────
// 聊天腿要的是自然语言，带了 `json_object` 反而把对话锁死成 JSON。所以它是参数
// （`jsonMode: true` 时才发），不是默认——与写作链路「恒定带」的差异是任务差异，不是漂移。
//
// ── 不设 `temperature` ────────────────────────────────────────────────────────
// BYOK 下各家的聊天缺省温度就是它们各自的推荐值；替用户拍一个未标定的数
// （写作链路的 0.2 是「读这一版/改这一版」的任务值，不适用聊天）没有依据。
// 缺省交给端点，要调是将来带着实弹数据的事。
//
// ── 超时上限 ──────────────────────────────────────────────────────────────────
// `CHAT_REQUEST_TIMEOUT_MS = 30_000`，沿用写作链路的取值理由（对实弹最慢值约 8.7 倍
// 余量）。聊天腿的提示词比写作短、产出也比「教点+三级台阶+逐词释义」小，30s 只宽不紧。
//
// 纯逻辑模块：零浏览器 API（`fetch` 是注入点，缺省在**调用时**取全局 `fetch`），
// 可在 Node 中直接测（生产由 `web/chat.mjs` 装配、探针由记录壳包着装配）。

/** 失败原因枚举——**这里是权威定义处**（统计口径的一部分，冻结）。 */
export const CHAT_FAIL_REASONS = Object.freeze({
  NO_ENDPOINT: 'no_endpoint',
  NO_KEY: 'no_key',
  TIMEOUT: 'timeout',
  REQUEST_FAILED: 'request_failed',
  RESPONSE_INVALID: 'response_invalid',
});

/** 本链路的请求上限（毫秒）——首轮设定值，未按聊天腿单独标定（见文件头）。 */
export const CHAT_REQUEST_TIMEOUT_MS = 30_000;

/** 落空结果的统一构造：三个字段一个不少，`detail` 一律是非空字符串（调用方可直接显示）。 */
function failure(reason, detail) {
  return { ok: false, reason, detail: String(detail ?? reason) };
}

const isTimeoutAbort = (err, signal) => signal?.aborted === true
  || err?.name === 'TimeoutError' || err?.name === 'AbortError';

/** 非空白字符串才算「配了」（设置页存进来之前已剪过空白，这里再防一手）。 */
const configured = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * baseURL → 完整请求地址。容忍三种粘贴姿势（都不猜协议、不猜路径）：
 *   `https://api.deepseek.com/v1`           → `…/v1/chat/completions`
 *   `https://api.deepseek.com/v1/`          → 同上（末尾斜杠剥掉）
 *   `https://api.deepseek.com/v1/chat/completions` → 原样（用户粘了全地址）
 */
export function chatCompletionsUrl(apiBase) {
  let s = String(apiBase ?? '').trim().replace(/\/+$/, '');
  if (s.endsWith('/chat/completions')) return s;
  return `${s}/chat/completions`;
}

/** 这个 base 是 DeepSeek 端点吗（唯一允许感知厂商的地方，理由见文件头 thinking 段）。 */
export function isDeepSeekEndpoint(apiBase) {
  try {
    const host = new URL(String(apiBase ?? '')).host.toLowerCase();
    return host.includes('deepseek');
  } catch {
    return false;
  }
}

/**
 * 把一组 messages 发给访问者自配的端点，拿回一个字符串。
 *
 * @param {object} input
 *   - `messages`：OpenAI 形状 `[{role, content}]`，本模块**原样上行**（改一个字的
 *     唯一改动点在 `./prompt.mjs`）。
 *   - `apiBase` / `model` / `apiKey`：**全部必传**（来自设置；缺哪件当场落对应档，
 *     不发那个注定失败的请求）。
 *   - `jsonMode`：`true` 时带 `response_format:{type:'json_object'}`（人设生成那一腿）。
 *   - `timeoutMs` / `fetchImpl` / `nowImpl`：与写作链路同名同义。
 * @returns {Promise<
 *   { ok: true, content: string, usage: object|null, latencyMs: number }
 *   | { ok: false, reason: keyof typeof CHAT_FAIL_REASONS, detail: string }
 * >} 本函数不抛错（`timeoutMs` 非法时 `AbortSignal.timeout` 抛的 RangeError 除外，
 *   它在 try 之外——参数写错是编程错误，不是用户情形）。
 */
export async function callModel({
  messages,
  apiBase,
  apiKey,
  model,
  jsonMode = false,
  timeoutMs = CHAT_REQUEST_TIMEOUT_MS,
  fetchImpl = null,
  nowImpl = null,
} = {}) {
  if (!configured(apiBase) || !configured(model)) {
    return failure(
      CHAT_FAIL_REASONS.NO_ENDPOINT,
      '还没配置接口端点：对话客厅是浏览器直连你自己的 OpenAI 兼容服务，'
      + '需要先在「设置」里填 baseURL 与模型名（占位里有格式示例）。',
    );
  }
  if (!configured(apiKey)) {
    return failure(
      CHAT_FAIL_REASONS.NO_KEY,
      '还没配置 API Key：请到「设置」粘贴保存。Key 只存在你本机浏览器里，'
      + '只随请求头发给你自己填的那个端点。',
    );
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const now = nowImpl ?? (() => Date.now());

  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = now();

  const body = {
    model: model.trim(),
    messages,
  };
  if (jsonMode) {
    // 只给「要 JSON」的那一腿：语法兜底，语义仍由 `./persona.mjs` 的归一把关。
    body.response_format = { type: 'json_object' };
  }
  if (isDeepSeekEndpoint(apiBase)) {
    // 见文件头：DeepSeek 关思考是人裁过的省钱默认；别的端点不发（OpenAI 会 400 未识别参数）。
    body.thinking = { type: 'disabled' };
  }

  let res;
  try {
    res = await doFetch(chatCompletionsUrl(apiBase), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 访问者自己的 Key，直达他自己配的端点——BYOK 世界里没有"替我们注入"这一层。
        authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const timedOut = isTimeoutAbort(err, signal);
    return failure(
      timedOut ? CHAT_FAIL_REASONS.TIMEOUT : CHAT_FAIL_REASONS.REQUEST_FAILED,
      timedOut
        ? `对话请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`
        : `对话请求发不出去：${String(err?.message ?? err)}`,
    );
  }

  if (!res.ok) {
    return failure(
      CHAT_FAIL_REASONS.REQUEST_FAILED,
      `模型服务返回 HTTP ${res.status}`,
    );
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    if (isTimeoutAbort(err, signal)) {
      return failure(
        CHAT_FAIL_REASONS.TIMEOUT,
        `对话请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`,
      );
    }
    return failure(
      CHAT_FAIL_REASONS.RESPONSE_INVALID,
      `模型响应不是合法 JSON：${String(err?.message ?? err)}`,
    );
  }

  // 信封口径与写作链路一致：`choices[0].message.content` 必须是非空白字符串。
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    return failure(
      CHAT_FAIL_REASONS.RESPONSE_INVALID,
      '模型响应缺少 choices[0].message.content（信封不合法）',
    );
  }

  const elapsed = now() - startedAt;
  return {
    ok: true,
    content,
    // usage 原样带出（可能为 null）：**不补 0**——0 是"合法且极好"的读数（红线 4）。
    usage: (payload?.usage !== null && typeof payload?.usage === 'object') ? payload.usage : null,
    latencyMs: Number.isFinite(elapsed) ? elapsed : NaN,
  };
}
