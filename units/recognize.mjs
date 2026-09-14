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
 * 把一帧发给自己的服务端识物，返回服务端给的候选（原样，不选词——选词是 `pickWord` 的事）。
 *
 * @param {Blob} blob 一张 JPEG（`camera.grabFrame` 产出的那一帧）
 * @param {{ fetchImpl?: typeof fetch }} [options]
 *   `fetchImpl` 是注入点；**缺省在调用时**取全局 `fetch`（不是模块加载时绑定的那份），
 *   于是"谁是网络出口"始终只有一个决定点，浏览器与测试看到的都是同一个全局。
 * @returns {Promise<{ candidates: Array<{label: string, score: number, scene: string}> }>}
 * @throws {Error} `code === 'request_failed'`：HTTP 非 2xx，或 fetch 自身抛（断网/被中断）
 * @throws {Error} `code === 'response_invalid'`：响应不是合法 JSON，或结构不是 `{ ok: true, candidates: [] }`
 *   这两种失败**必须抛出**：返回空候选会看起来像"识物成功但没认出东西"，
 *   把"服务不可用"记成"模型能力不足"（全局约束 3）。
 */
export async function recognize(blob, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const form = new FormData();
  form.append('image', blob, 'frame.jpg');

  let res;
  try {
    res = await doFetch('/api/recognize', { method: 'POST', body: form });
  } catch (err) {
    // 网络层失败（断网、请求被浏览器中断）也要带上 code，否则调用方分不清它与"响应结构非法"。
    const wrapped = new Error(`识物请求发不出去：${String(err?.message ?? err)}`);
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
  grab, acceptableSets, exclude, fetchImpl, frameQC = { judgeFrame },
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
      const { candidates } = await recognize(blob, { fetchImpl });
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
