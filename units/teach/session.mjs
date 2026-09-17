// web/units/teach/session.mjs
//
// 教学会话的拍子状态机：idle → intake → diagnose → stage → elicit → assist → close。
//
// **纯逻辑：零 import、零浏览器 API、零副作用**，可在 Node 中直接测。
//
// 为什么需要它：设计稿 §2.2 的四拍（诊断 → 搭台 → 逼产出 → 给够用的帮助）是**顺序约束**，
// 不是建议。没有状态机，"系统一次把答案讲完"就永远只是提示词里的一句恳求——
// 模型会本能地帮忙帮到底。把它变成转移表之后，"跳步"在结构上不可能。
//
// 两条与 `units/state-machine.mjs` 一致的约定：
//   1. 非法动作**静默忽略**并返回 false（用户点了当前不可用的按钮不是异常）；
//   2. 契约违约（onEnter/now 不是函数）**响亮抛错**。
//
// 代价（如实记）：`close` 之后没有回到 `intake` 的转移——一次会话就是一次会话。
// 想继续练要新开一次（`createSession`），这是有意的：会话边界是"这一轮教了什么"的账本边界。

/** 拍子顺序（快照的 dwellMs 按这个顺序建键，形状稳定）。 */
export const PHASES = Object.freeze([
  'idle', 'intake', 'diagnose', 'stage', 'elicit', 'assist', 'close',
]);

/**
 * 转移表：TRANSITIONS[当前拍子][动作] = 下一拍子。
 *
 * `cancel` 是**每个活动拍子**都有的出口：学习者随时可以不想聊了。它与"卡住"（stuck）
 * 严格分开——stuck 是"想说但说不出来"（要继续教，降到 assist），cancel 是"不想聊了"
 * （结束，什么都不记）。把两者混为一谈会把"放弃"当成"需要帮助"，是最粗暴的一种误诊。
 */
export const TRANSITIONS = Object.freeze({
  idle: Object.freeze({ content: 'intake', cancel: 'idle' }),
  intake: Object.freeze({ focusPicked: 'diagnose', cancel: 'idle' }),
  diagnose: Object.freeze({ staged: 'stage', cancel: 'idle' }),
  stage: Object.freeze({ produced: 'elicit', stuck: 'assist', cancel: 'idle' }),
  // elicit 上的 produced **指回自己**：说出来了就继续说（一次会话可以练好几轮），
  // 直到学习者自己说够了（close）。这与"不许跳过逼产出"不冲突——那条护栏管的是
  // **进不来** elicit，不限制在 elicit 里待多久。全表通往 elicit 的入边只有两条：
  // `elicit.produced`（自环）与 `stage.produced`（唯一入口）。
  elicit: Object.freeze({ assisted: 'assist', produced: 'elicit', close: 'close', cancel: 'idle' }),
  // assist 的两个出口都是 close：`produced`（拿到帮助后又产出一次，见 brief 的正典路径）
  // 与 `closed`（拿到帮助够了，就此收尾）。后者是设计稿 §2.3「不替用户决定下一步」与
  // §2.2「给到能往下走的最小帮助」的落地——帮助给完就该由学习者决定继续还是收尾，
  // 状态机不替他决定。两条出口都指向同一个终态，所以护栏分毫未动：护栏管的是入边
  // （见上一条注释），不是 assist 有几个出口。
  assist: Object.freeze({ produced: 'close', closed: 'close', cancel: 'idle' }),
  close: Object.freeze({}),
});

/** 造一台教学会话状态机。 */
export function createSession({ onEnter, now = Date.now } = {}) {
  if (typeof onEnter !== 'function') {
    throw new TypeError('createSession: onEnter 必须是函数（进入每个拍子时回调，用于渲染）');
  }
  if (typeof now !== 'function') {
    throw new TypeError('createSession: now 必须是返回时间戳的函数');
  }

  let phase = 'idle';
  let enteredAt = now();
  const dwellMs = Object.fromEntries(PHASES.map((p) => [p, 0]));

  const settle = () => {
    dwellMs[phase] += now() - enteredAt;
    enteredAt = now();
  };

  onEnter(phase);

  return {
    get phase() { return phase; },
    can(action) { return Boolean(TRANSITIONS[phase]?.[action]); },
    send(action) {
      const next = TRANSITIONS[phase]?.[action];
      if (!next) return false;           // 非法动作：静默忽略，绝不悄悄改状态
      settle();
      phase = next;
      onEnter(phase);
      return true;
    },
    snapshot() { return { phase, dwellMs: { ...dwellMs } }; },
  };
}
