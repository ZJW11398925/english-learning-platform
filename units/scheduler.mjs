/**
 * 复现调度（设计文档 §4.5）：固定间隔 1 天 → 3 天 → 7 天。
 *
 * - 一个词**学完即入队**，`stage` 数的是**已完成的间隔档数**：新词 `stage: 0`（字段缺失
 *   也按 0 处理），第一次复习把它排到 1 天后并留下 `stage: 1`。
 * - 跑完第 3 档（7 天，`stage` 由 3 变 4）即转 `maintained`：`dueAt` 置 `null`，**不再主动推送**，
 *   但词记录与事件记录永久保留（§4.6）。
 * - 自评"这次难 / 一般 / 顺"（`difficulty`）**首版只记录、不影响间隔**——自适应算法留到
 *   有真实数据之后再做，现在做等于凭想象调参（§4.4）。
 * - 间隔从**本次复习完成时刻** `now` 起算，不从旧的 `dueAt` 起算：否则一个拖到超过间隔
 *   才复习的词，会在完成的一刻立刻再次到期（连环到期），与 §4.5"每次到期需在新场景中
 *   重新取词"的顺序执行相矛盾。
 * - 本模块不创建也不改 `createdAt`：那是存储层（`store.mjs` 的 `putWord`）的职责，
 *   它还会在复现写回时保留原值，避免 `pruneImages` 把老词的图误判成最新。
 * - 全程纯函数、同步、零 import（不碰浏览器 API，也不依赖存储层），可在 Node 里直接测。
 */

/** 固定间隔（天）。冻结：排期是设计文档写死的契约，调用方不得在运行时改。 */
export const INTERVALS_DAYS = Object.freeze([1, 3, 7]);

const DAY_MS = 86400000;

/** 已维护 = 不再进入待办。`maintained` 标志与 `dueAt === null` 是同一件事的两种写法，二者一致。 */
export function isMaintained(word) {
  return word.maintained === true || word.dueAt === null;
}

/**
 * 复习完成后的新状态。**返回新对象，不就地改写入参**——调用方要留旧状态做阶段对比与日志。
 * @param {{ stage?: number, dueAt?: number|null }} word 复习前的记录
 * @param {number} now 本次复习完成时刻（ms）
 */
export function nextState(word, now) {
  const stage = (word.stage ?? 0) + 1;
  if (stage > INTERVALS_DAYS.length) {
    return { ...word, stage, dueAt: null, maintained: true, lastReviewedAt: now };
  }
  return { ...word, stage, dueAt: now + INTERVALS_DAYS[stage - 1] * DAY_MS, lastReviewedAt: now };
}

/**
 * 当前到期待办：未维护、有 `dueAt`、且 `dueAt <= now`（到期当刻即算到期）。
 * 按到期时间从早到晚排序（同刻按 id），使输出只取决于数据、不取决于词表键的插入顺序。
 */
export function dueWords(words, now) {
  return Object.values(words)
    .filter((w) => !isMaintained(w) && w.dueAt !== null && w.dueAt <= now)
    .sort((a, b) => (a.dueAt - b.dueAt) || String(a.id).localeCompare(String(b.id)));
}
