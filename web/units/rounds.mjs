// web/units/rounds.mjs
//
// 轮次（round）计数与判据 B（`retry_rate`，dmcp `VAL-…50`）在**事件流**上的口径
// ——**这里是权威定义处**（Task 7 修复轮 · Critical 1）。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────────
// 识物链路对**同一帧**最多发两次模型请求（`units/recognize.mjs` 的两次 attempt），于是
// 事件里的 `attempts: 2` 既可能是"一次快门、两次请求"，也可能是"按了两次快门、各请求一次"。
// 三类结论事件原先都没有轮次字段，Task 10 从事件流里既分不清这两种情况，也数不出
// "用户重拍了几次"——而 `retry_rate` 要测的正是这件事。
//
// ── 三个数各有各的口径，任何一处混用都会污染判据 B ────────────────────────────
//   · `roundIndex` —— **一次快门 = 一轮**。会话内从 1 开始、单调递增、按会话重置
//     （`createRoundCounter()` 一次会话一个实例）。它标识"用户按了几次快门"，
//     与这一轮发了几次模型请求、取了几帧都无关。
//   · `attempts`  —— 这一轮**真的问过模型几次**：0 = 帧被端侧质检拦下、1 或 2 = 发过几次请求。
//     `attempts: 2` 与"用户按了两次快门"是两件完全不同的事，**永远不能互相推算**。
//   · `frame_rejected` —— 帧被端侧质检拦下（没送到模型、attempts = 0），
//     但它**同样是一次快门**，同样算一轮。
//
// ── 判据 B（retry_rate）在事件流上的可计算定义 ────────────────────────────────
// 设 events 是事件流，每条事件形状为
//   `{ ts, type, wordId, roundIndex, sessionId, payload }`（`roundIndex` 在**顶层**，
//   由 `units/event-log.mjs` 的 `recordEvent` 写出去；不是某一轮的事件写 `null`）。
// 对某个会话 s（= 某一个 `sessionId` 上的全部事件）：
//
//   R(s)       = |{ e.roundIndex : e.sessionId === s 且 e.type ∈ ROUND_EVENT_TYPES }|
//                会话 s 的**轮数** = 用户按了几次快门。取**并集**（同一个 roundIndex 只算一次），
//                因此即使某一轮被重复记录，轮数也不会虚增。
//   reShoot(s) = max(0, R(s) − 1)
//                **重拍次数**：第一次快门不算重拍，之后每一轮都是用户被逼着再按的一次。
//   needs(s)   = reShoot(s) ≥ 2   ⟺   R(s) ≥ 3
//                "需重拍 ≥2 次的会话"——判据 B 的分子口径。
//   retryRate  = |{ s : needs(s) }| / |{ 全部会话 }|
//                分母是**会话数**（不是识别事件数、也不是轮数总和）。分母怎么定义归
//                Task 10 的 `scripts/export.mjs`；本模块只提供 R(s) 与 needs(s) 两个原语，
//                免得两处各解释一遍、各漂移一次。
//
// ── 分母的陷阱（review 原文）─────────────────────────────────────────────────
// 绝不能把"轮数"写成 `recognize_ok` 的条数加 `recognize_failed` 的条数：被端侧质检拦下的
// 那一轮（`frame_rejected`）**也是一次快门**——用户按了、系统退回了、他得再按一次，
// 这就是重拍。漏掉它，"太暗/太糊"造成的重拍会在判据 B 里整体消失，而端侧前置拦截
// 恰恰是最主要的重拍来源。`ROUND_EVENT_TYPES` 同时包含这三类，就是为这件事。
//
// ── 无轮次字段时**响亮报错**，不静默跳过 ─────────────────────────────────────
// `roundCountOfSession` 遇到结论事件却没有 `roundIndex` 时抛错。静默跳过会让"写入路径漏了
// 字段"长得像"这一轮不存在"——少算重拍，而看数据的人不会知道（共享上下文全局约束 3
// 禁止的静默降级）。空轮数（一次都没拍）与"字段缺失"是两件必须分清的事。
//
// ── 四个边界条件（Task 7 复审确立，Task 10 必须一并继承）──────────────────────
// 公式本身是对的，但下面四条边界决定了这些数**在什么范围内才算数**。复审逐条查证过，
// 不写下来 Task 10 就会各自猜一套口径。
//
// 1. **口径是"倾向重拍"的刻意扩展，不是字面照抄。** 判据 B 的字面要求是"需重拍 ≥2 次
//    **才能取到可用词**"；而 `needs(s) = R(s) ≥ 3` 也把"重拍 ≥2 次、最后**仍然没取到**词"
//    的会话算进分子。这是**有意的**：重拍两次还是失败，是比"重拍两次终于取到"更糟的结果，
//    没有理由把它排除在外（把它排除掉，等于奖励"最后干脆放弃"的会话）。
// 2. **"R = 快门次数"只对"走到了结论"的那些快门成立。** 没有任何结论的轮次——取帧时
//    `VIDEO_NOT_READY`（画面还没出画）、`judgeFrame` 的 `RangeError`、`grab()` 自身抛错——
//    **不分配轮次**，事件流里也**一条都不出现**（`app.mjs` 的 `onShutter` 在这三种情形下
//    return 或原样重抛）。所以 R(s) 读作"产出过结论的快门次数"，不是"用户点过多少次快门"。
// 3. **分母"全部会话"必须从流里现存的 `sessionId` 反推。** 生产代码**没有任何一处**发出
//    `session_start`（事件类型表里有它，但没有消费者），所以不存在"一份完整的会话清单"：
//    - 一次事件都没落的会话**看不见**（例如相机还没打开就退出）；
//    - 相机被拒的会话只落一条 `blocked_permission`（R(s) = 0，不在 ROUND_EVENT_TYPES 里），
//      它若进了分母就会**稀释**重拍率（一个压根没拍过的会话被算成"没重拍"）。
//    因此建议分母定义为 **R(s) ≥ 1 的会话**（即"真的拍过至少一次并走到结论的会话"）；
//    这个定义由 Task 10 落地，本模块只提供 R(s) 与 needs(s) 两个原语。
// 4. **三轮取最差值（gate 的聚合）不是本模块的事。** 判据 B 的协议是同一批人跑三轮、
//    取最差的一轮成闸；那是 Task 10 / 协议层的聚合口径，`rounds.mjs` 只算**单个会话**的
//    R(s) 与 needs(s)，不做任何跨轮、跨会话的合并——免得两处各写一套聚合、各漂移一次。
//
// 纯逻辑模块：零 import、零浏览器 API、零 Node API，浏览器与 Node 都能直接用。
// 真链路上跑出来的事件流由 `tests/recognize-mount.test.mjs` 断言（代码路径与公式对数），
// 纯公式由 `tests/rounds.test.mjs` 覆盖。

/**
 * 算作"一轮"的事件类型：**一次快门必定落且只落其中一条**（mount 里是 if/else，三选一）。
 *
 * 被端侧质检拦下的 `frame_rejected` 也在里面——它同样是一次快门（见文件头"分母的陷阱"）。
 * 冻结：这是统计口径的一部分，任何一处 import 都不该能悄悄改写它。
 */
export const ROUND_EVENT_TYPES = Object.freeze(['frame_rejected', 'recognize_ok', 'recognize_failed']);

/**
 * 判据 B 的门槛：**需重拍 ≥2 次**（`VAL-…50` 的"重拍率 ≤ 0.2"就是按这个口径算比例的）。
 * 等价说法是"这一会话 ≥3 轮"——见 `needsReshoot`。
 */
export const RESHOOTS_FOR_RETRY = 2;

/**
 * 造一个会话内的轮次计数器：`next()` 从 1 开始、单调递增。
 *
 * **一次会话一个实例**（`mount()` 里与 `sessionId` 同寿命）：换会话就换实例，
 * 于是新会话的第一轮又是 1（`tests/rounds.test.mjs` 钉住了"按会话重置"）。
 *
 * @returns {{ next: () => number }} `next()` 开一轮并返回它的编号
 */
export function createRoundCounter() {
  let last = 0;
  return {
    next() {
      last += 1;
      return last;
    },
  };
}

/**
 * 取一条事件的轮次编号。
 *
 * @param {{ type?: string, roundIndex?: unknown, sessionId?: string }} event
 * @returns {number} ≥1 的整数
 * @throws {Error} 缺失或不是 ≥1 的整数时**抛错**（不返回 0/undefined 冒充"没有这一轮"）。
 *   结论事件缺这个字段，说明写入路径漏了它——那会让判据 B 少算重拍，
 *   必须响亮到被人发现，而不是静默变成"这一轮不存在"。
 */
export function roundIndexOf(event) {
  const v = event?.roundIndex;
  if (v === null || v === undefined) {
    throw new Error(
      `事件 ${String(event?.type)}（会话 ${String(event?.sessionId)}）没有 roundIndex：`
      + '结论事件必须带轮次编号（见 web/units/rounds.mjs 的口径说明）；'
      + '若这是一条"不属于任何一轮"的事件，它本就不该出现在轮数统计里',
    );
  }
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(
      `roundIndex 必须是 ≥1 的整数，收到 ${String(v)}（事件 ${String(event?.type)}）——`
      + '轮次按会话从 1 开始单调递增',
    );
  }
  return v;
}

/**
 * 会话 `sessionId` 的轮次编号（升序、去重）。非结论事件（`session_start`、
 * `blocked_permission`、`compose_submitted`…）不参与——它们不属于任何一次快门。
 *
 * @param {Array<object>} events 事件流
 * @param {string} sessionId 会话号
 * @returns {number[]} 例如 `[1, 2, 3]`
 * @throws {Error} 结论事件缺 `roundIndex` 时（见 `roundIndexOf`）
 */
export function roundIndicesOfSession(events, sessionId) {
  const seen = new Set();
  for (const e of events ?? []) {
    if (e?.sessionId !== sessionId) continue;
    if (!ROUND_EVENT_TYPES.includes(e?.type)) continue;
    seen.add(roundIndexOf(e));
  }
  return [...seen].sort((a, b) => a - b);
}

/** 会话的**轮数** `R(s)`：用户按了几次快门（= 结论事件里不同 `roundIndex` 的个数）。 */
export function roundCountOfSession(events, sessionId) {
  return roundIndicesOfSession(events, sessionId).length;
}

/** 会话的**重拍次数** `reShoot(s) = max(0, R(s) − 1)`：第一次快门不算重拍。 */
export function reShootCountOfSession(events, sessionId) {
  return Math.max(0, roundCountOfSession(events, sessionId) - 1);
}

/**
 * 判据 B 的分子口径：这一会话是否"需重拍 **≥2** 次"。
 *
 * @param {number} roundCount 会话的轮数 `R(s)`——**一个计数，不是事件列表**
 * @returns {boolean} `roundCount − 1 >= RESHOOTS_FOR_RETRY`（⟺ `roundCount >= 3`）
 * @throws {TypeError} `roundCount` 不是 ≥0 的整数。**这是一道类型闸，不是洁癖**（复审 Minor 5）：
 *   传事件数组进来时，`events - 1` 是 `NaN`、`NaN >= 2` 是 `false`——"这一会话需重拍吗"
 *   会**静默**回答 false，判据 B 的分子永远是 0，而导出的表看起来完全正常。
 *   与 `roundIndexOf()` 的"缺 roundIndex 就抛"同一条纪律：宁可响亮地炸，不要安静地少算。
 *   合法的域是 `R(s)` 本身：0（一次都没拍，不成闸）与正整数。
 */
export function needsReshoot(roundCount) {
  if (!Number.isInteger(roundCount) || roundCount < 0) {
    throw new TypeError(
      `needsReshoot 只接受"轮数"（≥0 的整数），收到 ${describeArg(roundCount)}——`
      + '若你手上是事件流，请先过 roundCountOfSession(events, sessionId)；'
      + '传事件列表会静默算出 false（判据 B 的分子永远为 0）',
    );
  }
  return roundCount - 1 >= RESHOOTS_FOR_RETRY;
}

/** 把非法实参说清楚：数组只说长度，不把整条事件流打进入错误信息（错误信息也会进日志）。 */
function describeArg(value) {
  if (Array.isArray(value)) return `数组（${value.length} 条事件）`;
  if (typeof value === 'number') return `数字 ${String(value)}`;
  return `${typeof value} ${String(value)}`;
}
