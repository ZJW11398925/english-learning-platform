// web/units/state-machine.mjs
//
// 单页七态状态机：ready → capturing → word → reading → composing → feedback → done。
//
// **纯逻辑：零 import、零浏览器 API、零副作用**，可在 Node 中直接测（`tests/state-machine.test.mjs`）。
// DOM 渲染与副作用在 `web/app.mjs` 的 `mount()` 里，只在浏览器路径被调用。
//
// 为什么状态机必须"严"（设计文档 §3.1）：这个产品要回答的问题是**成人愿不愿意付出"造句"
// 这份主动产出成本**。如果 `composing` 能被跳过，完成率数据量的就是"用户在哪儿退出"，
// 而不是"用户愿不愿意写"。所以：
//   · `composing` 的唯一出口是 `submit`（没有 cancel / skip / finish）；
//   · `word` 之前拿不到词就不许造句（未取词时 `submit` 是非法动作，被静默忽略）；
//   · 停留时长与改写次数进快照，供后续筛出敷衍样本（打开就提交、零停留）。
//
// 本模块的两条既有约定（与 shared-context 一致）：
//   1. 非法动作**静默忽略**并返回 `false`——不抛错（UI 里"用户点了一个当前不可用的按钮"
//      不是异常），但也绝不悄悄改状态。
//   2. 契约被违反（onEnter/now 不是函数）**响亮抛错**：那是编程错误，不是用户操作。
//
// `rewriteCount` 的口径（task-6 报告 §歧义 2 已记）：每次 `submit` 自增，因此第一轮造句
// 提交后为 1、回改一版再提交为 2；**>1 即"用户真的改过"**。它与"进入 composing 的次数"
// 在离开 composing 之后恒等（composing 只有 submit 一个出口），差别只在"人还在 composing 里"
// 的那一刻（读到 0 vs 1）——统计在会话结束时读，两者同值。此处照 brief 的实现放在 submit 上。

/** 七个状态，顺序即正常闭环的顺序（快照里的 `dwellMs` 按这个顺序建键，形状稳定）。 */
export const STATES = Object.freeze([
  'ready', 'capturing', 'word', 'reading', 'composing', 'feedback', 'done',
]);

/**
 * 转移表：`TRANSITIONS[当前状态][动作] = 下一个状态`。
 *
 * 冻结（外层与内层都冻）：这张表是"能不能跳过造句"这条产品约束的**唯一**载体，
 * 任何一处 import 都能改它的话，约束就变成可运行时改写的东西，而且改完不报错。
 *
 * `finish` 在 brief 的动作清单里，但**有意不绑定任何状态**：brief 自己的"composing 不可跳过"
 * 用例就靠 `finish` 无效才成立（`feedback → next` 已经是收尾动作）。它现在等价于一个
 * 未登记动作——被静默忽略，见报告 §自查发现。
 */
export const TRANSITIONS = Object.freeze({
  ready: Object.freeze({ capture: 'capturing' }),
  // frameOk → word（图上取到词），frameBad → 退回 ready 重拍。识物失败**不**走 frameBad：
  // frameBad 只表示"这帧不能送识别"，由端侧质检（frame-qc）判定（Task 7 接）。
  capturing: Object.freeze({ frameOk: 'word', frameBad: 'ready' }),
  // word 与 reading 分开：word 是"词已取到、等用户开始跟读"，reading 是跟读进行中。
  word: Object.freeze({ wordReady: 'reading' }),
  reading: Object.freeze({ readDone: 'composing', skipReading: 'composing' }),
  composing: Object.freeze({ submit: 'feedback' }),
  feedback: Object.freeze({ rewrite: 'composing', next: 'done' }),
  done: Object.freeze({}),
});

/** 允许作为"拒帧理由"透传给界面的取值，与 frame-qc 的 reason 枚举一致。 */
export const REJECT_REASONS = Object.freeze(['too_dark', 'too_blurry']);

/**
 * 造一台状态机。
 *
 * @param {{ onEnter: (state: string) => void, now?: () => number }} options
 *   - `onEnter(state)`：进入某状态时回调，**构造时先以 `'ready'` 调一次**（否则首屏没有任何渲染时机）
 *   - `now()`：时钟注入点，默认 `Date.now`（算停留时长用；测试注入假时钟即可确定性地断言时长）
 * @returns {{
 *   readonly state: string,
 *   can: (action: string) => boolean,
 *   send: (action: string, payload?: { reason?: string }) => boolean,
 *   snapshot: () => object,
 * }}
 * @throws {TypeError} `onEnter` / `now` 不是函数（契约违约，响亮失败）
 */
export function createMachine({ onEnter, now = Date.now } = {}) {
  if (typeof onEnter !== 'function') {
    throw new TypeError('createMachine: onEnter 必须是函数（进入每个状态时回调，用于渲染）');
  }
  if (typeof now !== 'function') {
    throw new TypeError('createMachine: now 必须是返回时间戳的函数');
  }

  let state = 'ready';
  let enteredAt = now();
  const ctx = {
    rewriteCount: 0,
    frameRejections: 0,
    skippedReading: false,
    lastRejectReason: null,
    // 七个状态都先建键（含未访问过的）：形状稳定，下游统计不必区分"没这个键"与"值为 0"。
    dwellMs: Object.fromEntries(STATES.map((s) => [s, 0])),
  };

  // 构造即进入 ready：调用方拿到机器时首屏就有一次渲染时机。
  onEnter(state);

  const settle = (t) => {
    // 离开当前状态：把这趟停留结算进账本
    ctx.dwellMs[state] += t - enteredAt;
    enteredAt = t;
  };

  return {
    get state() { return state; },

    /** 当前状态下该动作是否合法（UI 据此决定按钮可用性；不改状态）。 */
    can: (action) => TRANSITIONS[state][action] !== undefined,

    /** 只读快照：含状态、三项记录标志/计数与按状态累计的停留时长。 */
    snapshot: () => ({
      state,
      rewriteCount: ctx.rewriteCount,
      frameRejections: ctx.frameRejections,
      skippedReading: ctx.skippedReading,
      lastRejectReason: ctx.lastRejectReason,
      // 当前状态**尚未结算**的那一段也算进去（读到快照的那一刻为止）——否则"在 composing 里
      // 磨了 90 秒还是提交了"这种样本会丢掉全部时间。返回副本，调用方改它改不到内部账本。
      dwellMs: { ...ctx.dwellMs, [state]: ctx.dwellMs[state] + (now() - enteredAt) },
    }),

    /**
     * 发一个动作。
     * @returns {boolean} 被接受（状态已推进）为 `true`；非法动作静默忽略并返回 `false`。
     */
    send(action, payload) {
      const next = TRANSITIONS[state][action];
      // 非法动作：不改状态、不触发 onEnter、不抛错。返回 false 而不是真值——调用方靠它区分
      // "这次点击被接受了"和"这次点击什么也没发生"。
      if (next === undefined) return false;

      settle(now());

      if (action === 'frameBad') {
        ctx.frameRejections += 1;
        const reason = payload?.reason;
        // 只放行枚举内的理由：界面要拿它告诉用户"太暗/太糊"，透传脏值等于替系统编一个理由。
        ctx.lastRejectReason = REJECT_REASONS.includes(reason) ? reason : null;
      }
      // 新手一次拍照即清掉上一条拒帧理由，避免界面拿旧理由解释新一次失败。
      if (action === 'capture') ctx.lastRejectReason = null;
      if (action === 'skipReading') ctx.skippedReading = true;
      if (action === 'submit') ctx.rewriteCount += 1;

      state = next;
      onEnter(state);
      return true;
    },
  };
}
