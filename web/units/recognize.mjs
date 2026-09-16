// web/units/recognize.mjs
//
// 识物链路：把一帧**浏览器直连**发给 DeepSeek（`/v1/chat/completions`，Task 12A，
// 项目转向 DEC-…23/26——服务端代理退役），拿回候选，再用 `pickWord` 判定"这一轮到底
// 取到了哪个词"。Key 由访问者提供（页面「设置」里保存到本机存储，键 `elp.apiKey`）、
// 经参数进来；本模块**永不碰本机存储**（存取在 `./keyring.mjs`，装配层读好再传入）。
//
// ── 从 server/recognize-upstream.mjs 移植的口径（parity 由 tests/deepseek.test.mjs 钉住）──
// 服务端代理退役后，原来在 `server/recognize-upstream.mjs` 里的**模型契约**整体搬到客户端：
//   · 提示词 `RECOGNIZE_PROMPT`（逐字移植）；
//   · 候选校验 `normalizeCandidate`（label 非空、score/scene 缺→null 不编 0）与
//     `MAX_CANDIDATES` 三条截断（设计 §4.1）——**客户端现在是最后一道校验口**，
//     模型吐的垃圾在这里响亮失败，绝不静默放行；
//   · 32 MiB data URL 上限（官方限制，超过就不发，省一次注定失败的往返）；
//   · `choices[0].message.content` 信封解析（共享部分在 `./deepseek.mjs`）。
//
// ── 三处刻意的设计，都是共享上下文某条约束的直接后果 ──────────────────────────
//
// 1. **端侧帧质检前置**（`judgeFrame`，省调用也省延迟）。一帧不合格就当场退回重拍，
//    **不发请求、不消耗 attempts**（attempts 的口径是"真的问过模型几次"）。
//
// 2. **不做自动连拍兜底**（全局约束 6）。`grab()` = "用户按了一次快门"，一次调用只取一帧；
//    两次"尝试"重试的是**网络请求**，不是重新取帧。
//
// 3. **失败绝不静默降级为成功**（全局约束 3）。取不到词就是 `mode: 'manual'` + `word: null`，
//    绝不把模型给的 top-1 或上位词塞进 `word` 冒充取词成功。手选的活由用户来做。
//
// 4. **这一腿有上限**（`RECOGNIZE_REQUEST_TIMEOUT_MS`）。`fetch` 默认不超时：模型服务半开时
//    Promise 永久 pending，界面卡在 capturing、每点一次快门多挂一个请求，而且一条事件都不落。
//    上限到点可能发生在 `fetch()` 或 `res.json()` 两处，都归"超时"（`request_failed`），
//    绝不归 `response_invalid`（Task 7 复审 Important 1 的同一课）。
//    直连之后没有"服务端那条腿"了：原来的"客户端必须大于服务端上限"的跨模块关系随代理
//    一起退役，本值是**唯一的**腿。
//
// ── latencyMs 的口径在 12A 有意变化（写在代码里，不是只写在注释里）────────────────────
// 旧口径：`recognize_ok.payload.latencyMs` = **服务端自报**的处理耗时（响应信封 `latency_ms`）。
// 新口径：直连后没有服务端了，这个数是**客户端 `performance.now()` 实测**"取到词那一次"
// 的耗时——从发出请求到解出可用候选（含网络往返与解析）。两个口径不是同一个数
// （旧数不含网络那一段，新数含），看历史数据时要知道这里有一步换尺。
// 不变的红线：拿不到实测值（时钟异常）就如实 `null`，**绝不补 0**——0 是"合法且极好"的
// 读数，用它冒充"不知道"会把 latency_p95 变成假漂亮（判据 A 不能建立在编造的数据上）。
//
// ── 失败分档（12A 最小扩展，报告里已说明）─────────────────────────────────────
// 401（Key 无效/无权限）单独归 `auth_failed`、429（限频）单独归 `rate_limited`：
// 直连之后 Key 是访问者自己的，这两档**用户自己能修/能等**，与"请求发不出去"
// （`request_failed`）的处置方向不同，混在一档里用户只能看到一句"服务挂了"。
//
// 纯逻辑模块：零浏览器 API（`fetch` / `grab` / `frameQC` / 时钟全是注入点），可在 Node 中直接测。
import { judgeFrame } from './frame-qc.mjs';
import { pickWord } from './pick-word.mjs';
import { DEEPSEEK_API_BASE, DEEPSEEK_MODEL, VISION_DETAIL, chatUrl, extractContent } from './deepseek.mjs';

/**
 * `recognizeWithFallback` 落空的原因枚举——**这里是权威定义处**。
 *
 * 各档的处置方向（写在定义处，免得下游各猜一套）：
 *   - `no_candidates`        —— 模型没给出任何候选。看模型/提示词，不是看词表。
 *   - `not_in_acceptable_set`—— 模型给了候选，但没有一个命中可接受集。**内容配置问题**。
 *   - `all_matched_excluded` —— 有候选命中了可接受集，但全被 `exclude` 排除（复现时
 *                               "别再把刚学过的那个词取一遍"）。看排除规则，**不要去改词表**。
 *   - `request_failed`       —— 请求本身失败（网络错 / HTTP 非 2xx（401/429 除外）/ fetch 抛异常 / 超时）。
 *   - `response_invalid`     —— HTTP 成功了，但响应不是约定的结构（信封缺 content、content
 *                               不是 JSON、candidates 不是数组、候选缺 label）。要改的是模型契约。
 *   - `auth_failed`          —— 12A 新增：模型服务回 401（Key 无效/无权限），或本机根本没配 Key。
 *                               处置：引导去「设置（API Key）」检查/重新粘贴——访问者自己能修的一档。
 *   - `rate_limited`         —— 12A 新增：模型服务回 429（请求太频繁）。处置：稍等再试。
 *
 * 冻结：这是统计口径的一部分，任何一处 import 都不该能悄悄改写它。
 */
export const RECOGNIZE_FAIL_REASONS = Object.freeze({
  NO_CANDIDATES: 'no_candidates',
  NOT_IN_ACCEPTABLE_SET: 'not_in_acceptable_set',
  ALL_MATCHED_EXCLUDED: 'all_matched_excluded',
  REQUEST_FAILED: 'request_failed',
  RESPONSE_INVALID: 'response_invalid',
  AUTH_FAILED: 'auth_failed',
  RATE_LIMITED: 'rate_limited',
});

/** 本模块会挂到 Error 上的 code（要求上游抛出的错误也带同类 code 时，必须从这一组里取）。 */
const REASON_CODES = new Set(Object.values(RECOGNIZE_FAIL_REASONS));

/**
 * 客户端这一腿的请求上限（毫秒）——**首轮设定值**，不是定论：第一周用真实弱网数据标定。
 *
 * 为什么必须有它：`fetch` 默认**没有**超时。模型服务连接半开时这个 Promise 会永久 pending
 * ——界面卡在 `capturing`、快门按钮还在、每多点一次就多挂一个请求，而且**一条事件都不会落**。
 * 直连后本值是唯一的腿（原"必须大于服务端 8s"的跨模块关系随代理退役）。
 * 取值理由不变：实弹探针实测端到端 1.8s / 3.0s（task-7-report §3.1），本值约有 4 倍余量。
 * 最坏情形：同一帧两次尝试都在上限处收口，用户最多等 `2 × 本值`。
 *
 * 可在调用处覆盖（`recognize(blob, { timeoutMs })` / `recognizeWithFallback({ timeoutMs })`），
 * 测试用一个小值即可，不必真等生产上限。
 */
export const RECOGNIZE_REQUEST_TIMEOUT_MS = 12000;

/**
 * 降级到 `mode: 'manual'` 时给用户手挑的场景词包（设计文档 §5.1「退到场景词包手选」）。
 *
 * **它是预声明的，不是"模型候选的兜底"**：后者会把上位词放回界面，而 `pick-word` 明确拒绝上位词。
 * 12A 核实：本词包一直是**客户端静态声明**（这个冻结数组），不来自任何服务端接口，
 * 无需改造为静态 JSON。首版够用即可——真正的场景词表属于词库建设，不在本切片范围。
 *
 * 冻结：手选词表直接决定用户能选到什么词，不该被任何一处 import 悄悄改写。
 */
export const MANUAL_PICK_SCENE_WORDS = Object.freeze([
  'mug', 'cup', 'bottle', 'bowl', 'kettle',
  'book', 'pen', 'phone', 'laptop', 'keys',
  'chair', 'lamp', 'bag', 'shoe', 'umbrella',
]);

// ─────────────────── 从 server/recognize-upstream.mjs 移植的模型契约 ───────────────────

/** data URL 上限 32 MiB（官方限制）。超过就没有必要发出去——早点响亮失败，省一次往返。 */
const MAX_DATA_URL_BYTES = 32 * 1024 * 1024;
/** 候选上限：设计文档 §4.1「三候选 + 人工重拍」。多出来的直接砍掉，不返回给界面。 */
export const MAX_CANDIDATES = 3;

/**
 * 提示词：要求严格 JSON、按置信度排序、给场景标签。**逐字移植自 server/recognize-upstream.mjs**
 * （parity 闸：tests/deepseek.test.mjs 断言两份逐字相等，server 退役前不许漂移）。
 *
 * `label` 用**具体名词**（`mug` 而不是 `container`）是有意的：`pickWord` 只认预声明的可接受集，
 * 上位词对"学一个能指着说的具体名词"毫无价值。提示词只能"劝"，判定权仍在 `pickWord`。
 */
export const RECOGNIZE_PROMPT = [
  'Look at the photo and identify the single main object the user is pointing at.',
  'Return STRICT JSON only, no prose, in exactly this shape:',
  '{"candidates":[{"label":"mug","score":0.9,"scene":"kitchen"}]}',
  'Rules:',
  '- 1 to 3 candidates, ordered by confidence, most likely first.',
  '- "label": ONE lowercase English concrete noun, singular, of the physical object itself',
  '  (e.g. "mug", "kettle", "book"). NEVER a hypernym or category word such as',
  '  "container", "vessel", "object", "thing", "item".',
  '- "score": a number between 0 and 1.',
  '- "scene": one short lowercase English word for where the object is (e.g. "kitchen", "desk", "street").',
  '- If you cannot identify any object, return {"candidates":[]}.',
].join('\n');

/** 一条候选的形状：`label` 必须是非空字符串；`score` 有限数或 null；`scene` 字符串或 null。 */
function normalizeCandidate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (label === '') return null;
  const score = Number.isFinite(raw.score) ? raw.score : null;
  const scene = typeof raw.scene === 'string' && raw.scene.trim() !== '' ? raw.scene.trim() : null;
  return { label, score, scene };
}

/** Uint8Array → base64（分块拼，避开一次性超长参数；btoa 在 Node 与浏览器都有）。 */
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 把任意错误归一成枚举里的一档（不认识的一律按"请求失败"——它一定是从请求那条路上来的）。 */
const reasonOf = (err) => (REASON_CODES.has(err?.code) ? err.code : RECOGNIZE_FAIL_REASONS.REQUEST_FAILED);

/** 错误里携带的可读细节：进 `recognize_failed` 的 payload 供排查，但**不参与**分档。 */
const detailOf = (err) => String(err?.message ?? err);

/**
 * 这次中止/异常是不是"我们设的上限到点了"。
 * 上限到点可能发生在 `fetch()`（连接都没建起来）或 `res.json()`（响应头到了、body 还在流）
 * 两处，都归"超时"。判定：信号已 aborted，或错误本身是 TimeoutError/AbortError。
 * 用 `signal?.`：信号缺失时这里不许多抛一种错误。
 */
const isTimeoutAbort = (err, signal) => signal?.aborted === true
  || err?.name === 'TimeoutError' || err?.name === 'AbortError';

/**
 * 把一帧直连发给视觉模型，返回候选（已校验、已截断——选词是 `pickWord` 的事）。
 *
 * @param {Blob} blob 一张 JPEG（`camera.grabFrame` 产出的那一帧）
 * @param {object} [options]
 *   - `apiKey`：访问者的 DeepSeek API Key（**必传**；缺了当场响亮失败，不发必 401 的请求）
 *   - `fetchImpl`：注入点；**缺省在调用时**取全局 `fetch`（"谁是网络出口"只有一个决定点）
 *   - `timeoutMs`：这一腿的上限（默认 `RECOGNIZE_REQUEST_TIMEOUT_MS`），测试用小值即可
 *   - `apiBase` / `model` / `visionDetail` / `mime`：直连契约的注入点（测试桩换 base；生产缺省）
 *   - `nowImpl`：耗时实测的时钟注入点，缺省 `() => performance.now()`
 * @returns {Promise<{ candidates: Array<{label: string, score: number|null, scene: string|null}>, latencyMs: number|null }>}
 *   `latencyMs` = **客户端实测**的取词耗时（口径变化的说明见文件头）：`nowImpl` 从进函数到
 *   解出可用候选的差值。直连后不再有服务端自报的 `latency_ms`；时钟读数不是有限数时是
 *   `null`——绝不补 0。
 * @throws {Error} `code === 'auth_failed'`：没传 Key（发请求之前就拦下——那个请求必然 401），
 *   或模型服务回 401（消息引导回设置页）。
 * @throws {Error} `code === 'rate_limited'`：模型服务回 429。
 * @throws {Error} `code === 'request_failed'`：HTTP 其他非 2xx、网络错、超时、图片超限（未发出）。
 *   这两种失败**必须抛出**：返回空候选会看起来像"识物成功但没认出东西"，
 *   把"服务不可用"记成"模型能力不足"（全局约束 3）。
 * @throws {Error} `code === 'response_invalid'`：HTTP 成功但信封/content/候选不合法（移植口径）。
 * @throws {TypeError} `timeoutMs` 非法（例如 NaN）时由 `AbortSignal.timeout` 抛出——
 *   它在 try 之外发生，不会被包装成一次"请求失败"（参数写错是编程错误，不是用户情形）。
 */
export async function recognize(blob, {
  fetchImpl = null, timeoutMs = RECOGNIZE_REQUEST_TIMEOUT_MS,
  apiKey = null, apiBase = DEEPSEEK_API_BASE, model = DEEPSEEK_MODEL,
  visionDetail = VISION_DETAIL, mime = 'image/jpeg', nowImpl = null,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const now = nowImpl ?? (() => performance.now());

  // 无 Key 当场拦下：直连世界里"没有 Key 的请求"是一个必然 401 的注定失败，
  // 不该花掉一次往返再教用户一遍。Key 的存取在 keyring.mjs，本模块只认参数。
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    const err = new Error('未配置 API Key：请先在页面「设置（API Key）」里保存你的 DeepSeek API Key。');
    err.code = RECOGNIZE_FAIL_REASONS.AUTH_FAILED;
    throw err;
  }

  // 帧 → base64 data URL。上限在这里判（移植口径：与原服务端同一把尺——data URL 字符串长度），
  // 超限就不发：明知会被上游拒绝的请求不花那次往返。
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
  if (dataUrl.length > MAX_DATA_URL_BYTES) {
    const err = new Error(`图片过大：data URL ${dataUrl.length} 字节，超过上限 ${MAX_DATA_URL_BYTES}，本帧不发送`);
    err.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
    throw err;
  }

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: RECOGNIZE_PROMPT },
        {
          type: 'image_url',
          // 图片**必须**在这一层（user message 的 content 数组）里。放进 system/assistant 会 400。
          image_url: { url: dataUrl, detail: visionDetail },
        },
      ],
    }],
    response_format: { type: 'json_object' },
    // 低温度：这一档要的是"看清是什么"，不是发挥。
    temperature: 0.1,
  };

  // 上限在这里装好（不放进下面的 try）：参数非法要响亮地成为 TypeError，
  // 而不是被 catch 成"识物请求发不出去"。
  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = now();

  let res;
  try {
    res = await doFetch(chatUrl(apiBase), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 访问者自己的 Key，随请求头直达模型服务——转向之后没有"服务端替我们注入"这一层了。
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const wrapped = new Error(isTimeoutAbort(err, signal)
      ? `识物请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`
      : `识物请求发不出去：${String(err?.message ?? err)}`);
    wrapped.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
    throw wrapped;
  }

  if (!res.ok) {
    // 401/429 与"普通请求失败"分开（12A 最小扩展，理由见文件头）：
    // 这两档访问者自己能修（回设置页换 Key）或能等（限频），文案必须指对方向。
    if (res.status === 401) {
      const err = new Error('识物请求失败 HTTP 401：API Key 无效或没有权限。请到「设置（API Key）」检查或重新粘贴。');
      err.code = RECOGNIZE_FAIL_REASONS.AUTH_FAILED;
      throw err;
    }
    if (res.status === 429) {
      const err = new Error('识物请求失败 HTTP 429：请求太频繁（模型服务限流）。稍等一会儿再试。');
      err.code = RECOGNIZE_FAIL_REASONS.RATE_LIMITED;
      throw err;
    }
    const err = new Error(`识物请求失败 HTTP ${res.status}`);
    err.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
    throw err;
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    // 这个 catch 里有两种成因，必须分开（Task 7 复审 Important 1）：
    // 响应体不是 JSON → response_invalid；响应头到了、body 还在流时上限到点 → request_failed（超时）。
    if (isTimeoutAbort(err, signal)) {
      const timedOut = new Error(
        `识物请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`,
      );
      timedOut.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
      throw timedOut;
    }
    const wrapped = new Error(`识物响应不是合法 JSON：${String(err?.message ?? err)}`);
    wrapped.code = RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID;
    throw wrapped;
  }

  // 信封 → content（移植口径：非空白字符串才算有；共享解析在 deepseek.mjs）。
  const content = extractContent(payload);
  if (content === null) {
    const err = new Error('上游响应缺少 choices[0].message.content');
    err.code = RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    // `response_format: json_object` 只是兜底，不是保证：真出现非 JSON 内容时**如实失败**，
    // 绝不"从文本里抠一个词"当成功（那是猜测，不是识别）。
    const wrapped = new Error(`识物响应 content 不是合法 JSON：${String(err?.message ?? err)}`);
    wrapped.code = RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID;
    throw wrapped;
  }

  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.candidates)) {
    const err = new Error('上游 JSON 缺少 candidates 数组');
    err.code = RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID;
    throw err;
  }

  // 逐条校验：**任意一条**连 label 都给不出来就整份判非法。宁可如实报"响应非法"，
  // 也不静默剔掉坏条目——后者会把"模型吐了垃圾"伪装成"模型很确定地给了这几条"。
  const normalized = [];
  for (const raw of parsed.candidates) {
    const c = normalizeCandidate(raw);
    if (c === null) {
      const err = new Error(`上游候选项缺少可用的 label：${JSON.stringify(raw)?.slice(0, 120)}`);
      err.code = RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID;
      throw err;
    }
    normalized.push(c);
  }

  const elapsed = now() - startedAt;
  return {
    candidates: normalized.slice(0, MAX_CANDIDATES),
    // 客户端实测口径（12A 起不再有服务端自报值）：时钟坏了就 null，绝不补 0——见文件头。
    latencyMs: Number.isFinite(elapsed) ? elapsed : null,
  };
}

/**
 * 一次取词的全过程：取一帧 → 端侧质检 → 最多问**两次**模型 → 仍落空则退到手选。
 *
 * 帧只取一次、只判一次：`grab()` 就是"用户按了快门"，重试的是网络请求而不是重新拍照。
 * 因此：
 *   - 无 Key / `frame_rejected` → 一帧、一次请求都没发生，`attempts === 0`；
 *   - 两次请求都落空 → `mode: 'manual'`、`word: null`、`attempts === 2`、`reason` 为枚举里的一档。
 *
 * @param {object} options
 *   - `grab()`：取帧，返回 `{ blob, stats }`（`camera.grabFrame` 的形状）
 *   - `acceptableSets` / `exclude`：透传给 `pickWord`
 *   - `apiKey`：访问者的 Key；**缺了在本函数最开头就降级**（attempts 0，连帧都不取）——
 *     "真的问过模型几次"的口径不许把"没 Key 的空转"记进去
 *   - `fetchImpl` / `timeoutMs` / `apiBase` / `model` / `visionDetail` / `nowImpl`：透传给 `recognize`
 *   - `frameQC`：帧质检模块注入点（默认 `./frame-qc.mjs`），只为测试能数"判了几次"
 * @returns {Promise<{
 *   mode: 'ok'|'manual'|'frame_rejected', word: string|null,
 *   candidates: Array<object>, attempts: number, reason?: string, detail?: string,
 *   latencyMs?: number|null,
 * }>}
 *   `reason` / `detail` 只在落空时出现（`frame_rejected` 的 `reason` 是质检枚举，不是本模块的失败枚举）
 *   `latencyMs` 只在 `mode: 'ok'` 时出现，且**取的是取到词的那一次尝试**（不是两次相加，
 *   也不是第一次失败的耗时）——判据 A 的 `latency_p95` 问的是"用户等这一轮等了多久"。
 *   直连后它是客户端实测值（口径变化见文件头）。`frame_rejected` / 无 Key 不发请求，故**不带**这个字段。
 * @throws {RangeError} `judgeFrame` 的契约违约（编程错误，**原样往上冒**）
 * @throws {Error} `grab()` 自身的错误（例如 `VIDEO_NOT_READY`：用户按快门太早，属用户情形）
 */
export async function recognizeWithFallback({
  grab, acceptableSets, exclude, fetchImpl, timeoutMs, frameQC = { judgeFrame },
  apiKey = null, apiBase = DEEPSEEK_API_BASE, model = DEEPSEEK_MODEL,
  visionDetail = VISION_DETAIL, nowImpl = null,
}) {
  // 无 Key 在**取帧之前**就收口：没有 Key 的取词是一个必然 401 的空转，帧、请求、
  // attempts 一个都不该消耗。attempts 的口径是"真的问过模型几次"——这里是 0。
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return {
      mode: 'manual', word: null, candidates: [], attempts: 0,
      reason: RECOGNIZE_FAIL_REASONS.AUTH_FAILED,
      detail: '未配置 API Key：识物调用是浏览器直连模型服务，需要访问者自己的 Key（在页面「设置（API Key）」里保存）。',
    };
  }

  const { blob, stats } = await grab();
  const verdict = frameQC.judgeFrame(stats);
  if (!verdict.ok) {
    // 没送模型 → attempts 0；candidates 给空数组而不是 undefined，调用方不必区分两种"没有"。
    return { mode: 'frame_rejected', reason: verdict.reason, word: null, candidates: [], attempts: 0 };
  }

  let attempts = 0;
  let lastFailure = null;
  let lastCandidates = [];
  for (let i = 0; i < 2; i += 1) {
    attempts += 1;
    try {
      const { candidates, latencyMs } = await recognize(blob, {
        fetchImpl, timeoutMs, apiKey, apiBase, model, visionDetail, nowImpl,
      });
      lastCandidates = candidates;
      const picked = pickWord({ candidates, acceptableSets, exclude });
      if (picked !== null) {
        // 带的是**这一次成功尝试**的耗时：attempts=2 时不把两次相加，
        // 否则 p95 会把"重试救回来的那一轮"算成双倍慢。
        return { mode: 'ok', word: picked.word, candidates, attempts, latencyMs };
      }
      lastFailure = classifyMiss(candidates, { acceptableSets, exclude });
    } catch (err) {
      lastFailure = { reason: reasonOf(err), detail: detailOf(err) };
    }
  }
  // 两轮都落空：如实降级，**不假造词**。带出最后一次的候选供排查。
  // 这里**不带** `latencyMs`：这一轮没有"取到词的耗时"可言。
  return {
    mode: 'manual', word: null, candidates: lastCandidates, attempts, ...lastFailure,
  };
}

/**
 * `pickWord` 返回 `null` 时判断**是哪种落空**——不改 `pick-word.mjs` 的契约，
 * 而是用它的纯函数性再问一次："如果没有任何排除，这些候选里能选出词吗？"
 */
function classifyMiss(candidates, { acceptableSets, exclude }) {
  if (candidates.length === 0) {
    return { reason: RECOGNIZE_FAIL_REASONS.NO_CANDIDATES, detail: '模型没有返回任何候选' };
  }
  const withoutExclude = pickWord({ candidates, acceptableSets });
  if (withoutExclude !== null) {
    return {
      reason: RECOGNIZE_FAIL_REASONS.ALL_MATCHED_EXCLUDED,
      detail: `命中的候选 ${withoutExclude.word} 被 exclude 排除（exclude: ${exclude?.join(', ') ?? ''}）`,
    };
  }
  return {
    reason: RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET,
    detail: `模型候选 ${candidates.map((c) => c.label).join(', ')} 无一命中可接受集`,
  };
}
