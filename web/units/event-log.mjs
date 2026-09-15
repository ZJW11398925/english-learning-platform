// 事件 schema 与落盘。契约：类型必须是 `EVENT_TYPES` 里登记过的一个（未登记即**响亮抛错**，
// 不静默放行——放行会让事件表在若干轮之后变成一张谁也不知道有多少种的表）。
//
// 存储写满（配额异常）的处置见 `recordEvent` 的 JSDoc：**唯一的吞错点**，理由写在那里。
import { isStoreFullError } from './store.mjs';

export const EVENT_TYPES = [
  'session_start',
  'frame_rejected',
  'blocked_permission',
  'recognize_ok',
  'recognize_failed',
  'word_shown',
  'reading_done',
  // 跟读**判定未通过**（用户念了，引擎也听清了，但那句话里没有目标词）。
  // 与 `reading_done` **互斥**：一次跟读判定只落一条（判过了就是 done，没判过就是 missed）。
  //
  // 为什么必须有它（Task 9B，`DEC-OPI-…73` 显式授权的契约变更）：`reading_done` 只在通过时落，
  // 于是"用户念了却被判没说"的失败率在事件流里**完全看不见**——而这正是判据层面
  // 最需要的一个数（引擎听错、词表配错、口音问题都藏在它里面）。这是"能测量"层面的缺口，
  // 与 Task 7 那条教训同源。
  //
  // 两个**不算** missed 的相邻档位（别混记）：
  //   · 跳过跟读 → `skipped_reading`（那是用户的选择，不是判定失败；它也随
  //     `compose_submitted.payload.skippedReading` 落盘）；
  //   · 转写不可用 / 引擎报错 / 超时 → `speech_unsupported` 或**什么都不落**
  //     （系统根本没判过，不能记成"用户念错了"）。
  'reading_missed',
  'skipped_reading',
  'speech_unsupported',
  'compose_submitted',
  'compose_rewrite',
  'feedback_ok',
  'feedback_pending',
  'uncertain',
  'recurrence_scene',
  'recurrence_manual',
  'storage_full',
];

const REQUIRED = ['ts', 'type', 'wordId', 'sessionId', 'payload'];

export function validateEvent(e) {
  const errors = [];
  if (e === null || typeof e !== 'object') return { ok: false, errors: ['event 必须是对象'] };
  for (const k of REQUIRED) {
    if (!(k in e)) errors.push(`缺少字段 ${k}`);
  }
  if ('type' in e && !EVENT_TYPES.includes(e.type)) {
    errors.push(`未登记的 type: ${String(e.type)}`);
  }
  if ('ts' in e && !Number.isFinite(e.ts)) errors.push('ts 必须是有限数字');
  if ('payload' in e && (e.payload === null || typeof e.payload !== 'object')) {
    errors.push('payload 必须是对象');
  }
  // `roundIndex` **不在 REQUIRED 里**：不是每条事件都属于某一次快门（`session_start`、
  // `blocked_permission`…），`recordEvent` 会给它们写 `null`。但只要它出现在事件上，
  // 就必须是 ≥1 的整数——轮次是判据 B（`retry_rate`）的输入，口径见 `units/rounds.mjs`。
  if ('roundIndex' in e && e.roundIndex !== null
    && (!Number.isInteger(e.roundIndex) || e.roundIndex < 1)) {
    errors.push(`roundIndex 必须是 ≥1 的整数或 null，收到 ${String(e.roundIndex)}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 记录一条事件：校验后写入 store，并返回完整事件对象。
 *
 * 第三个参数的形状是 `{ sessionId, wordId?, roundIndex?, ...payload }`：
 * - `sessionId`（必填）、`wordId`（可选，缺省 null）与 `roundIndex`（可选，缺省 null）
 *   会被**提取到事件顶层**，不留在 payload 里；
 *   因此调用方无法把这三个名字记进 `payload`（同名键会被摘出）
 * - 其余字段整体成为事件的 `payload`
 *
 * `roundIndex` 是**一次快门 = 一轮**的标识（会话内从 1 开始、单调递增，`units/rounds.mjs`
 * 的 `createRoundCounter()` 产出）。它与 `payload.attempts`（这一轮真的问过模型几次）是
 * 两个不同的数：同一帧发两次请求仍只算一轮。判据 B（`retry_rate`）的公式写在
 * `units/rounds.mjs` 的文件头，**别在别处另立一套**。
 *
 * ── 存储写满时的行为（Task 9B 的契约变更，逐条列出）────────────────────────────
 *
 * `store.appendEvent` 抛出的**配额异常**（`isStoreFullError` 认得的那几种形状）在这里
 * 被翻译成"**一条都没有记下来**"：
 *   · 返回值是 `null`（事件没落盘），**不再是抛错**；
 *   · `store.markStoreFull()` 会被调一次（幂等），界面据此停止派发新任务并提示导出；
 *   · **不重试**：存储已经满了，重试只是让同一个异常再发生一次。
 *
 * 为什么在这里吞掉而不是让它冒泡（这是本模块**唯一**一处吞错，理由要站得住）：
 *   1. 落 `storage_full` 标签**本身也要写存储**——这是一处自反悖论（brief §2.2）。
 *      若配额异常继续冒泡，`storage_full` 这条标签就永远落不下去，而调用点还会各自
 *      用不同的方式处理它（现状就是如此：有的 catch 成一句界面文案，有的没有 catch）。
 *   2. 它**不是编程错误**，也不该让用户看到崩溃：它是设计 §5.1 明确枚举的一个档位。
 *      把它降级成"没记下来 + 界面提示 + 停止派发"才是诚实的处置。
 *   3. **其它错误照旧抛**（`validateEvent` 不通过、非配额的写失败）——那些是编程错误
 *      或未知故障，静默吞掉就会变成"记了其实没记"。
 *
 * 调用方**必须**检查返回值（`null` = 写不进去），并且在拿到 `null` 时：
 * 不重试、不继续派发新任务、把这件事告诉用户。`web/app.mjs` 就是这么做的。
 *
 * @param {{ appendEvent: (e: object) => void, markStoreFull?: () => boolean }} store 注入的存储层
 * @param {string} type EVENT_TYPES 中登记的事件类型
 * @param {{ sessionId: string, wordId?: string|null, roundIndex?: number|null, [key: string]: unknown }} fields 见上
 * @param {() => number} [now] 时间戳注入点，默认 Date.now
 * @returns {{ ts: number, type: string, wordId: string|null, roundIndex: number|null, sessionId: string, payload: object } | null}
 *   `null` 表示**这条事件没有被记下来**（存储写满）
 */
export function recordEvent(
  store, type, { sessionId, wordId = null, roundIndex = null, ...payload }, now = Date.now,
) {
  const e = { ts: now(), type, wordId, roundIndex, sessionId, payload };
  const v = validateEvent(e);
  if (!v.ok) throw new Error(`非法事件: ${v.errors.join('; ')}`);
  try {
    store.appendEvent(e);
  } catch (err) {
    if (!isStoreFullError(err)) throw err;
    // 尽力为之后留一句话（幂等、失败不重试），然后如实返回"没记下来"。
    store.markStoreFull?.();
    return null;
  }
  return e;
}
