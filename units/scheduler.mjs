/**
 * 复现调度（设计文档 §4.5）：固定间隔 1 天 → 3 天 → 7 天。
 *
 * `stage` 是同一个字段，但**进出含义不同**，两者不得混用（Task 6/7 会读它做就绪态与进度
 * 展示，说错就是向用户谎报学习进度）：
 * - **入参** `stage` = 该词**已完成的间隔档数**（字段缺失按 0 处理）。新词是 `stage: 0`：
 *   一档都还没跑完。
 * - **返回** `stage` = **本次刚排上的那一档的序号**（= 入参 + 1）。新词学完第一次返回
 *   `stage: 1`：刚排上第 1 档（1 天后复习），此时"已完成的档数"仍然是 0；返回 `stage: 4`
 *   表示刚跑完第 3 档（7 天），即"已完成的档数"是 3。
 * - 返回值**大于** `INTERVALS_DAYS.length`（即 4）是 `maintained` 的**哨兵值**：第 4 档并不
 *   存在，它只表示"7 天档刚完成"——跑完 7 天档即转终态，`dueAt` 置 `null`，**不再主动推送**，
 *   但词记录与事件记录永久保留（§4.6）。
 * - 自评"这次难 / 一般 / 顺"（`difficulty`）**首版只记录、不影响间隔**——自适应算法留到
 *   有真实数据之后再做，现在做等于凭想象调参（§4.4）。
 * - 间隔从**本次复习完成时刻** `now` 起算，不从旧的 `dueAt` 起算：否则一个拖到超过间隔
 *   才复习的词，会在完成的一刻立刻再次到期（连环到期），与 §4.5"每次到期需在新场景中
 *   重新取词"的顺序执行相矛盾。
 * - 本模块不创建也不改 `createdAt`：那是存储层（`store.mjs` 的 `putWord`）的职责，
 *   它还会在复现写回时保留原值，避免 `pruneImages` 把老词的图误判成最新。
 * - **词记录的前置条件（调用方契约）**：`dueAt` 必须是**有限数**或 `null`。本模块是纯函数，
 *   不校验也不抛错：若 `dueAt` 缺失、为 `NaN`、字符串或其他非有限数，`dueWords` 会**静默略过**
 *   该词（不报错、不打标签，它就此从待办里消失），`isMaintained` 也仍报 `false`——既不算
 *   已维护，又永远不到期，是一个无声的夹缝状态。因此**写词记录的一方必须让 `dueAt` 由
 *   `nextState` 产生**（新词落盘时也要先经 `nextState` 定出首个 `dueAt`），不要在模块外手写。
 * - 全程纯函数、同步、零 import（不碰浏览器 API，也不依赖存储层），可在 Node 里直接测。
 */

/** 固定间隔（天）。冻结：排期是设计文档写死的契约，调用方不得在运行时改。 */
export const INTERVALS_DAYS = Object.freeze([1, 3, 7]);

const DAY_MS = 86400000;

/**
 * 已维护 = 不再进入待办。`maintained` 标志与 `dueAt === null` 是同一件事的两种写法，二者一致。
 * `dueAt` 既非有限数也非 `null`（缺失 / `NaN` / 字符串）时返回 `false`：那不是"已维护"，
 * 而是模块头所说"永远不到期"的夹缝记录，`dueWords` 会静默略过它。
 */
export function isMaintained(word) {
  return word.maintained === true || word.dueAt === null;
}

/**
 * 复习完成后的新状态。**返回新对象，不就地改写入参**——调用方要留旧状态做阶段对比与日志。
 * 入参 `stage` 是**已完成的档数**（缺失按 0）；返回的 `stage` 是**刚排上的那一档的序号**
 * （= 入参 + 1），大于 `INTERVALS_DAYS.length`（4）时是 `maintained` 哨兵值（见模块头）。
 * @param {{ stage?: number, dueAt?: number|null }} word 复习前的记录（`stage` = 已完成的间隔档数）
 * @param {number} now 本次复习完成时刻（ms）
 * @returns {{ stage: number, dueAt: number|null, lastReviewedAt: number, maintained?: true }} 新记录
 */
export function nextState(word, now) {
  const stage = (word.stage ?? 0) + 1;
  if (stage > INTERVALS_DAYS.length) {
    return { ...word, stage, dueAt: null, maintained: true, lastReviewedAt: now };
  }
  return { ...word, stage, dueAt: now + INTERVALS_DAYS[stage - 1] * DAY_MS, lastReviewedAt: now };
}

/** 同刻到期时的兜底键：id 的**码位序**升序（纯 `<`/`>` 比较，不依赖 ICU 与运行环境语言）。 */
function compareId(x, y) {
  const a = String(x);
  const b = String(y);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 当前到期待办：未维护、有 `dueAt`、且 `dueAt <= now`（到期当刻即算到期）。
 * 按到期时间从早到晚排序，同刻到期按 id 的**码位序**兜底（不用 `localeCompare`：那取决于 ICU
 * 与运行环境语言，会让同刻的先后在不同机器上不一样），使输出只取决于数据、不取决于词表键
 * 的插入顺序。
 *
 * 中间那条 `w.dueAt !== null` 在 `isMaintained` 认 `dueAt === null` 的前提下是**冗余**的：
 * 留着是为了让"两种已维护写法"在调用点可见，并防住日后有人削弱 `isMaintained`
 * （`tests/scheduler.test.mjs` 有用例专门钉住 `isMaintained` 的 `dueAt === null` 分支）。
 * 前置条件见模块头：`dueAt` 既非有限数也非 `null` 的记录会被本函数**静默略过**。
 */
export function dueWords(words, now) {
  return Object.values(words)
    .filter((w) => !isMaintained(w) && w.dueAt !== null && w.dueAt <= now)
    .sort((a, b) => (a.dueAt - b.dueAt) || compareId(a.id, b.id));
}
