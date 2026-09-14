// web/units/recognize.mjs
//
// 识物链路：把一帧送到**我们自己的服务端**（`/api/recognize`），拿回排序后的候选词，
// 再用 `pickWord` 判定"这一轮到底取到了哪个词"。密钥只在服务端，本模块永远看不到它
// （共享上下文全局约束 1）。
//
// ── 三处刻意的设计，都是共享上下文某条约束的直接后果 ──────────────────────────
//
// 1. **端侧帧质检前置**（`judgeFrame`，省调用也省延迟）。一帧不合格就当场退回重拍，
//    **不发请求、不消耗 attempts**（attempts 的口径是"真的问过模型几次"）。
//
// 2. **不做自动连拍兜底**（全局约束 6）。`grab()` = "用户按了一次快门"，一次调用只取一帧；
//    两次"尝试"重试的是**网络请求**，不是重新取帧。计划之所以禁止自动连拍，是因为
//    `retry_rate`（判据 B，`VAL-…50`）要测的正是"用户要不要重拍"——系统替他连拍，这个数就永远测不出来。
//
// 3. **失败绝不静默降级为成功**（全局约束 3）。取不到词就是 `mode: 'manual'` + `word: null`，
//    绝不把模型给的 top-1 或上位词塞进 `word` 冒充取词成功（`pickWord` 也是同一立场：
//    `null` 是它唯一的失败表达）。手选的活由用户来做，界面回归 `MANUAL_PICK_SCENE_WORDS`。
//
// 4. **这一腿有上限**（`RECOGNIZE_REQUEST_TIMEOUT_MS`）。`fetch` 默认不超时：上游半开时
//    Promise 永久 pending，界面卡在 capturing、每点一次快门多挂一个请求，而且**一条事件都不落**
//    （判据 B 连这一轮都统计不到）。上限的取值理由、以及"客户端那条腿必须比服务端长"的关系
//    写在那个常量的注释里。
//    上限到点**可能发生在两个地方**——`fetch()` 那一句（连接都没建起来），或 `res.json()` 那一句
//    （**响应头已经到了、body 还在流**）。两处都归"超时"（`request_failed`，消息里说清是超时），
//    绝不归成 `response_invalid`：后者在枚举里的处置方向是"改服务端或模型契约"，
//    把一次网络停滞记进那一档，Task 10 从失败分布里会读成"契约有问题"（复审 Important 1）。
//
// 纯逻辑模块：零浏览器 API（`fetch` / `grab` / `frameQC` 全是注入点），可在 Node 中直接测。
import { judgeFrame } from './frame-qc.mjs';
import { pickWord } from './pick-word.mjs';

/**
 * `recognizeWithFallback` 落空的原因枚举——**这里是权威定义处**。
 *
 * 为什么需要它（Task 3 review 记下的数据质量缺口）：`pickWord` 返回 `null` 有两种完全不同的
 * 成因，计划原先只能把它们记成同一件事，于是**内容配置问题**（可接受集里根本没写模型给的那个词）
 * 与**模型能力问题**（模型没认出东西）在下游统计里长得一模一样，看数据的人不知道该去改词表
 * 还是该换模型。第三、四种（请求失败 / 响应结构非法）同样是外部不可控，与前面两类不是一件事。
 *
 * 各档的处置方向（写在定义处，免得下游各猜一套）：
 *   - `no_candidates`        —— 模型没给出任何候选。看模型/提示词，不是看词表。
 *   - `not_in_acceptable_set`—— 模型给了候选，但没有一个命中可接受集。**内容配置问题**：
 *                               要么词表该补，要么这个物体根本不在本产品的取词范围里。
 *   - `all_matched_excluded` —— 有候选命中了可接受集，但全被 `exclude` 排除（复现时
 *                               "别再把刚学过的那个词取一遍"）。看排除规则，**不要去改词表**。
 *   - `request_failed`       —— 请求本身失败（网络错 / HTTP 非 2xx / fetch 抛异常）。
 *   - `response_invalid`     —— HTTP 成功了，但响应不是约定的结构（`ok !== true`、
 *                               `candidates` 不是数组、响应体不是 JSON）。要改的是服务端或模型契约。
 *
 * 冻结：这是统计口径的一部分，任何一处 import 都不该能悄悄改写它。
 */
export const RECOGNIZE_FAIL_REASONS = Object.freeze({
  NO_CANDIDATES: 'no_candidates',
  NOT_IN_ACCEPTABLE_SET: 'not_in_acceptable_set',
  ALL_MATCHED_EXCLUDED: 'all_matched_excluded',
  REQUEST_FAILED: 'request_failed',
  RESPONSE_INVALID: 'response_invalid',
});

/** 本模块会挂到 Error 上的 code（要求上游抛出的错误也带同类 code 时，必须从这一组里取）。 */
const REASON_CODES = new Set(Object.values(RECOGNIZE_FAIL_REASONS));

/**
 * 客户端这一腿的请求上限（毫秒）——**首轮设定值**，不是定论：第一周用真实弱网数据标定，
 * 每次调整都要记入变更记录（与 `frame-qc.mjs` 的 `DARK_THRESHOLD` / `BLUR_THRESHOLD` 同一条纪律）。
 *
 * 为什么必须有它：`fetch` 默认**没有**超时。上游连接半开（服务端不回、也不断）时这个 Promise
 * 会永久 pending——界面卡在 `capturing`、快门按钮还在、每多点一次就多挂一个请求，
 * 而且**一条事件都不会落**（判据 B 连这一轮都统计不到）。这正是本项目反复出现的
 * "挂死而不是失败"。
 *
 * 与服务端那条腿的关系（**硬要求，有跨模块用例钉住**）：本值必须**大于**服务端的
 * `UPSTREAM_TIMEOUT_MS`（`server/recognize-upstream.mjs`，8000ms）。上游慢但活着时，
 * 应当由服务端先超时、先如实返回它自己的失败形状（`502 {ok:false,error:'upstream_failed'}`），
 * 客户端只是收到一个 HTTP 非 2xx → 落 `recognize_failed{reason:'request_failed'}`。
 * 若客户端先超时，我们只会知道"我等烦了"，永远分不清是模型慢、服务端挂了还是网络断了。
 * 12s / 8s 之间留的 4s 用于服务端把响应写回来。
 *
 * 调大 = 用户干等更久；调小 = 真实模型偶发变慢就被误报成失败（`request_failed` 偏高，判据 B 同样失真）。
 * 标定依据：实弹探针实测端到端 1.8s / 3.0s（task-7-report §3.1），本值约有 4 倍余量。
 * 最坏情形：同一帧两次尝试都在上限处收口，用户最多等 `2 × 本值`——真机标定时一并复核。
 *
 * 可在调用处覆盖（`recognize(blob, { timeoutMs })` / `recognizeWithFallback({ timeoutMs })`），
 * 测试用一个小值即可，不必真等生产上限。
 */
export const RECOGNIZE_REQUEST_TIMEOUT_MS = 12000;

/**
 * 降级到 `mode: 'manual'` 时给用户手挑的场景词包（设计文档 §5.1「退到场景词包手选」）。
 *
 * **它是预声明的，不是"模型候选的兜底"**：后者会把上位词（`container`、`vessel`）放回界面，
 * 而 `pick-word` 明确拒绝上位词（"拍的是马克杯，学到 container 等于没学到"）。手选词表由我们
 * 定，与模型这一轮吐了什么无关。首版够用即可——真正的场景词表属于词库建设，不在本切片范围。
 *
 * 冻结：手选词表直接决定用户能选到什么词，不该被任何一处 import 悄悄改写。
 */
export const MANUAL_PICK_SCENE_WORDS = Object.freeze([
  'mug', 'cup', 'bottle', 'bowl', 'kettle',
  'book', 'pen', 'phone', 'laptop', 'keys',
  'chair', 'lamp', 'bag', 'shoe', 'umbrella',
]);

/** 把任意错误归一成枚举里的一档（不认识的一律按"请求失败"——它一定是从请求那条路上来的）。 */
const reasonOf = (err) => (REASON_CODES.has(err?.code) ? err.code : RECOGNIZE_FAIL_REASONS.REQUEST_FAILED);

/** 错误里携带的可读细节：进 `recognize_failed` 的 payload 供排查，但**不参与**分档。 */
const detailOf = (err) => String(err?.message ?? err);

/**
 * 这次中止/异常是不是"我们设的上限到点了"。
 *
 * 为什么单列一个判定（Task 7 复审 Important 1）：上限到点**可能发生在两个地方**——
 * `fetch()` 那一句（连接都没建起来）或 `res.json()` 那一句（**响应头已经到了、body 还在流**）。
 * 后者原先落进"响应不是合法 JSON"那一档，于是**一次网络停滞**被记成 `response_invalid`，
 * 而这一档在 `RECOGNIZE_FAIL_REASONS` 里的处置方向是"改服务端或模型契约"——
 * Task 10 从 `recognize_failed.reason` 的分布里会读成"契约有问题"。
 *
 * 两种证据任一成立即可：① 信号已经 aborted（本模块只装过 `AbortSignal.timeout`，
 * 所以它一定是我们那条上限）；② 错误本身是超时/中止（`AbortSignal.timeout` 触发时是
 * DOMException `TimeoutError`，部分实现报 `AbortError`）。
 * 用 `signal?.` 而不是 `signal.`：信号缺失时这里**不许多抛**一种错误（那会把分类问题变成崩溃）。
 */
const isTimeoutAbort = (err, signal) => signal?.aborted === true
  || err?.name === 'TimeoutError' || err?.name === 'AbortError';

/**
 * 把一帧发给自己的服务端识物，返回服务端给的候选（原样，不选词——选词是 `pickWord` 的事）。
 *
 * @param {Blob} blob 一张 JPEG（`camera.grabFrame` 产出的那一帧）
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 *   `fetchImpl` 是注入点；**缺省在调用时**取全局 `fetch`（不是模块加载时绑定的那份），
 *   于是"谁是网络出口"始终只有一个决定点，浏览器与测试看到的都是同一个全局。
 *   `timeoutMs` 是这一腿的上限（默认 `RECOGNIZE_REQUEST_TIMEOUT_MS`），测试用小值即可。
 * @returns {Promise<{ candidates: Array<{label: string, score: number, scene: string}> }>}
 * @throws {Error} `code === 'request_failed'`：HTTP 非 2xx，或 fetch 自身抛（断网 / 超时 / 被中断）。
 *   上限到点（含"响应头到了、body 还在流"时被中止）一律走这一档，消息里说清是超时。
 * @throws {Error} `code === 'response_invalid'`：响应不是合法 JSON（且**不是**被我们的上限中止的），
 *   或结构不是 `{ ok: true, candidates: [] }`
 *   这两种失败**必须抛出**：返回空候选会看起来像"识物成功但没认出东西"，
 *   把"服务不可用"记成"模型能力不足"（全局约束 3）。
 * @throws {TypeError} `timeoutMs` 非法（例如 NaN）时由 `AbortSignal.timeout` 抛出。
 *   它**在 try 之外**发生，所以不会被包装成一次"请求失败"——参数写错是编程错误，不是用户情形。
 */
export async function recognize(blob, { fetchImpl = null, timeoutMs = RECOGNIZE_REQUEST_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const form = new FormData();
  form.append('image', blob, 'frame.jpg');

  // 上限在这里就装好（不放进下面的 try）：参数非法要响亮地成为 TypeError，
  // 而不是被 catch 成"识物请求发不出去"。
  const signal = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await doFetch('/api/recognize', { method: 'POST', body: form, signal });
  } catch (err) {
    // 网络层失败（断网、请求被浏览器中断）也要带上 code，否则调用方分不清它与"响应结构非法"。
    // 超时单独说清楚：`AbortSignal.timeout` 触发时 fetch 会以 `TimeoutError` 拒绝
    // （部分实现报 `AbortError`），这两种都不是"发不出去"，而是"等太久了"。
    const wrapped = new Error(isTimeoutAbort(err, signal)
      ? `识物请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`
      : `识物请求发不出去：${String(err?.message ?? err)}`);
    wrapped.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
    throw wrapped;
  }

  if (!res.ok) {
    const err = new Error(`识物请求失败 HTTP ${res.status}`);
    err.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    // 这个 catch 里有**两种完全不同的成因**，必须分开（Task 7 复审 Important 1）：
    //   · 响应体不是 JSON（例如网关吐了一页 HTML）→ `response_invalid`：要改的是服务端/模型契约；
    //   · **响应头已经到了、body 还在流时上限到点**（网络停滞）→ `request_failed` + 说清是超时。
    // 后者原先被归成 `response_invalid`：一次网络停滞被丢进"改服务端契约"那一档，
    // Task 10 从 `recognize_failed.reason` 的分布里就读不出真实的失败来源。
    // 判定见 `isTimeoutAbort`（信号已 aborted，或错误本身是 TimeoutError/AbortError）。
    if (isTimeoutAbort(err, signal)) {
      const timedOut = new Error(
        `识物请求超时（${timeoutMs}ms 未返回，已主动中止）：${String(err?.message ?? err)}`,
      );
      timedOut.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
      throw timedOut;
    }
    // 非 JSON 响应（例如网关吐了一页 HTML）绝不能被当成"没有候选"。
    const wrapped = new Error(`识物响应不是合法 JSON：${String(err?.message ?? err)}`);
    wrapped.code = RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID;
    throw wrapped;
  }

  if (data === null || typeof data !== 'object' || data.ok !== true || !Array.isArray(data.candidates)) {
    const err = new Error('识物响应结构非法（期望 { ok: true, candidates: [...] }）');
    err.code = RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID;
    throw err;
  }

  return { candidates: data.candidates };
}

/**
 * 一次取词的全过程：取一帧 → 端侧质检 → 最多问**两次**模型 → 仍落空则退到手选。
 *
 * 帧只取一次、只判一次：`grab()` 就是"用户按了快门"，重试的是网络请求而不是重新拍照
 * （不做自动连拍，见文件头第 2 条）。因此：
 *   - `frame_rejected` → 一帧都没送到模型，`attempts === 0`；
 *   - 两次请求都落空 → `mode: 'manual'`、`word: null`、`attempts === 2`、`reason` 为枚举里的一档。
 *
 * @param {object} options
 *   - `grab()`：取帧，返回 `{ blob, stats }`（`camera.grabFrame` 的形状）
 *   - `acceptableSets` / `exclude`：透传给 `pickWord`
 *   - `fetchImpl`：透传给 `recognize`
 *   - `timeoutMs`：这一次请求的上限，透传给 `recognize`（缺省用 `RECOGNIZE_REQUEST_TIMEOUT_MS`；
 *     两次尝试各自计时，所以最坏等待是它的两倍）
 *   - `frameQC`：帧质检模块注入点（默认 `./frame-qc.mjs`），只为测试能数"判了几次"
 * @returns {Promise<{
 *   mode: 'ok'|'manual'|'frame_rejected', word: string|null,
 *   candidates: Array<object>, attempts: number, reason?: string, detail?: string,
 * }>}
 *   `reason` / `detail` 只在落空时出现（`frame_rejected` 的 `reason` 是质检枚举，不是本模块的失败枚举）
 * @throws {RangeError} `judgeFrame` 的契约违约（编程错误，**原样往上冒**，绝不 catch 成一次"这张照片不行"）
 * @throws {Error} `grab()` 自身的错误（例如 `VIDEO_NOT_READY`：用户按快门太早，属用户情形）
 */
export async function recognizeWithFallback({
  grab, acceptableSets, exclude, fetchImpl, timeoutMs, frameQC = { judgeFrame },
}) {
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
      const { candidates } = await recognize(blob, { fetchImpl, timeoutMs });
      lastCandidates = candidates;
      const picked = pickWord({ candidates, acceptableSets, exclude });
      if (picked !== null) return { mode: 'ok', word: picked.word, candidates, attempts };
      lastFailure = classifyMiss(candidates, { acceptableSets, exclude });
    } catch (err) {
      lastFailure = { reason: reasonOf(err), detail: detailOf(err) };
    }
  }
  // 两轮都落空：如实降级，**不假造词**。带出最后一次的候选供排查。
  return {
    mode: 'manual', word: null, candidates: lastCandidates, attempts, ...lastFailure,
  };
}

/**
 * `pickWord` 返回 `null` 时判断**是哪种落空**——不改 `pick-word.mjs` 的契约（那个模块已定稿），
 * 而是用它的纯函数性再问一次："如果没有任何排除，这些候选里能选出词吗？"
 *   - 能选出来 → 这次落空是 `exclude` 造成的（`all_matched_excluded`）；
 *   - 仍选不出来 → 候选里没有可接受集的词（`not_in_acceptable_set`）；
 *   - 候选本身是空的 → 模型什么都没给（`no_candidates`）。
 *
 * 三次判定共用同一个纯函数，因此不存在"两套选词逻辑各自漂移"的问题。
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
