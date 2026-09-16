// web/units/pending.mjs
//
// 待补反馈队列（设计文档 §5.1）：
//
// > 失败后自动重试 3 次（间隔 10s / 30s / 90s）；仍失败则保留在队列，
// > 界面显示"待补反馈"，用户可手动重试。原句永不丢弃。
//
// ── 权威是谁：**事件流**，本模块不持有任何状态 ────────────────────────────────
//
// 本模块里没有队列对象、没有内存表、没有第二份存储。它只有两类函数：
// **读事件**（`pendingFeedbackQueue` / `nextPendingRetry` / `manualRetryCandidate`）
// 与**算事件**（`withPendingId` / `retryEventFor`，都只返回"该落一条什么样的事件"，
// 落盘由调用方交给 `recordEvent`）。于是：
//   · "队列"永远是 `readEvents()` 的一个**视图**，重开页面自然重建（无状态可丢）；
//   · 不存在"两份真相漂移"这件事——本项目已因此吃过多次亏
//     （Task 8 的 `feedbackEventFor` 就是为此不设注入点）。
//
// ── 一条待补条目怎么被认出来、怎么被勾掉 ──────────────────────────────────────
//
//   · **认出来**：`feedback_pending` 的 payload 带 `pendingId`（`withPendingId` 生成，
//     由 `sessionId` + `ts` 派生 → **同一个事件永远派生出同一个 id**，重开页面后也一致）。
//   · **勾掉**：补交成功落的那条判定事件（`feedback_ok` / `uncertain`）payload 带
//     `retriedPendingId` **指回**它补的是哪一条。
//   不用"同一句话的先后顺序"来猜：同一句话在一次会话里本来就可能被提交多次
//   （回环改一版再交），按时间先后分不清"补交"与"用户自己又写了一遍"——
//   后者会让欠账被悄悄勾掉，于是那条句子再也不催了。
//
// ── 重试次数怎么数（无状态地数）────────────────────────────────────────────────
//
// 一条待补条目每被重试一次，就再落一条 `feedback_pending`（它也是失败），
// **带着同一个 `pendingId`** 与 `attempt`。于是"已经自动试过几次" = "事件流里
// 有多少条带这个 `pendingId` 的事件"（原始那条算 0 次）。计数因此也是无状态的。
//
// ── 补交拿到的判定必须与原始判定可区分 ────────────────────────────────────────
//
// `retryEventFor` 在判定本体之上补 `retried: true` / `attempt` / `retriedAt` /
// `retriedPendingId`。判定本体（verdict / error_type / note / rewrite）**仍然由
// `units/compose.mjs` 的 `feedbackEventFor` 产出**——本模块只加标记，不另写一套映射
// （两套映射迟早漂移；Task 10 要按 `retried` 分组，靠的就是这四个字段）。
//
// ── 补交**不是**一次新的产出 ──────────────────────────────────────────────────
//
// `retryEventFor` 只产出**判定**事件，绝不产出 `compose_submitted`：产出成本只在用户
// 提交那一刻记一次，补交再记一条就等于把"成人愿为造句付多少成本"这个分母记大了。
// 这一点由 `tests/pending-mount.test.mjs` 与变异体 Q5 钉住。
//
// 纯逻辑：零 import、零浏览器 API、零副作用（定时器由调用方注入，见 `web/app.mjs`）。
import { feedbackEventFor } from './compose.mjs';

/**
 * 自动重试的间隔（毫秒）——**首轮设定值**，不是定论。
 *
 * 出处：设计文档 §5.1「失败后自动重试 3 次（间隔 10s / 30s / 90s）」。
 * 与 `DARK_THRESHOLD` / `BLUR_THRESHOLD` / `FEEDBACK_REQUEST_TIMEOUT_MS`
 * **同一条纪律**：第一周用真实数据标定，每次调整都要记入变更记录。
 * （12B：`SPEECH_LISTEN_TIMEOUT_MS` 随 SpeechRecognition 判定路径一并退役，从这份清单里移除。）
 *
 * 为什么把三个数都留着（而不是只留"3 次 + 指数退避"）：间隔本身是设计写下来的产品行为
 * （10 → 30 → 90 的手感是"越等越久，但不至于让人等不下去"），不是实现细节。
 * 调用方可以用 `retryDelaysMs` 覆盖（测试用小值驱动，不必睡 130 秒）。
 */
export const RETRY_DELAYS_MS = Object.freeze([10_000, 30_000, 90_000]);

/** 自动重试次数 = 间隔表的长度（两者必须一致，有测试钉住，见 tests/pending.test.mjs）。 */
export const MAX_AUTO_RETRIES = RETRY_DELAYS_MS.length;

/**
 * 首页那个入口的文案（**界面、测试与真机走查清单三者之间的约定**）。
 *
 * 写在模块里而不是散在 `app.mjs` 的模板串里：走查清单第 49 项让非技术读者去首页找
 * 这四个字，测试也认这四个字；两处各写一份的话，改文案时会静默失配
 * （清单让人找一个屏幕上不存在的东西）。
 */
export const PENDING_ENTRY_LABEL = '待补反馈';

/**
 * 一条待补条目的 id，由事件本身派生：`p_<sessionId>_<ts>`。
 *
 * 为什么是派生的而不是随机生成的：**重开页面后队列从事件流重建**，那时没有内存里的
 * 任何东西可用；只有"同一个事件永远派生出同一个 id"，补交事件里的指针才能在重建之后
 * 仍然指向正确的那一条。随机 id 存进 payload 也能用，但那样"id 从哪来"就多了一处
 * 需要保证稳定的地方；派生则只有这一条规则。
 *
 * 不撞号的理由：同一会话内两条 `feedback_pending` 的 `ts` 相同且指向同一条待补条目，
 * 本来就应该共用一个 id（重试失败再落的那条正是这种情况）。
 */
export const pendingIdOf = (event) => {
  if (typeof event?.payload?.pendingId === 'string' && event.payload.pendingId !== '') {
    return event.payload.pendingId;
  }
  return `p_${String(event?.sessionId ?? 'nosession')}_${Number(event?.ts ?? 0)}`;
};

/** 这条事件是不是一条"待补"（只有 `feedback_pending` 是；判定事件永远不是）。 */
const isPendingEvent = (e) => e?.type === 'feedback_pending';

/**
 * 给一条 `feedback_pending` 的 payload 补上 `pendingId`（已经有了就原样保留）。
 *
 * 返回的是**新的 payload 对象**，调用方拿它去 `recordEvent`。这样"id 怎么来"只有一处，
 * 而 `event-log.mjs` 的契约一个字都不用动。
 */
export const withPendingId = (event) => {
  const payload = { ...(event?.payload ?? {}) };
  if (typeof payload.pendingId !== 'string' || payload.pendingId === '') {
    payload.pendingId = pendingIdOf(event);
  }
  return payload;
};

/**
 * 把一次提交的结果映射成"补交"该落的事件。
 *
 * **判定本体不在这里重写**：`ok` / `uncertain` / `pending` 三档的 payload 仍由
 * `units/compose.mjs` 的 `feedbackEventFor` 产出（它是那套映射的唯一起源），
 * 本函数只在它之上补四个**可区分性字段**：
 *   · `retried: true`         —— 这条判定是补交来的（Task 10 按它分组）
 *   · `attempt`               —— 补交到第几次（1 起；自动与手动共用一个计数）
 *   · `retriedAt`             —— 补交发生的时刻
 *   · `retriedPendingId`      —— 指回它补的是哪一条（**只有补上了才带**：它是"勾掉"的凭据）
 * 补交**又失败**时带 `pendingId` + `retried: true` + `attempt` + `retriedAt`，
 * 但**不带** `retriedPendingId`——否则一条失败的补交会把自己的欠账勾销。
 *
 * @param {{ pendingId: string }} entry `pendingFeedbackQueue()` 里的一条
 * @param {object} result `submitSentence` 的返回值
 * @param {number} attempt 这是第几次补交（1 起）
 * @param {number} retriedAt 补交时刻
 * @returns {{ type: string, payload: object }} 交给 `recordEvent` 的事件（**不含** sessionId/wordId/roundIndex）
 */
export function retryEventFor(entry, result, attempt, retriedAt) {
  // 指针是"补交勾掉哪一条"的唯一凭据，**缺了它这条待补就永远勾不掉**（会被无限重发）。
  // 所以这里不假定调用方一定传对形状：队列条目（有 pendingId）与原始事件（在 payload 里）
  // 都认——`pendingIdOf` 本来就能从事件派生。宁可多一次派生，也不许指针静默变成 undefined。
  const pendingId = typeof entry?.pendingId === 'string' && entry.pendingId !== ''
    ? entry.pendingId
    : pendingIdOf(entry);
  const base = feedbackEventFor(result);
  if (base.type === 'feedback_pending') {
    // 补交**又失败**：仍是同一条欠账（`pendingId`），但**不带** `retriedPendingId`
    // ——那个指针的语义是"这条把它勾掉了"，而这次并没有勾掉。两者混用会让
    // 一条失败的补交把自己的欠账勾销（见 `pendingFeedbackArchive` 里的说明）。
    return {
      type: base.type,
      payload: {
        ...base.payload,
        pendingId,
        retried: true,
        attempt,
        retriedAt,
      },
    };
  }
  return {
    type: base.type,
    payload: {
      ...base.payload,
      retried: true,
      attempt,
      retriedAt,
      retriedPendingId: pendingId,
    },
  };
}

/**
 * 把事件流折算成待补队列（**最早失败的在最前**）。
 *
 * @param {object[]} events `store.readEvents()` 的结果
 * @returns {Array<{
 *   pendingId: string, sentence: unknown, word: unknown, scene: unknown,
 *   reason: unknown, error: unknown, detail: unknown, event: object,
 *   failedAt: number, autoAttempts: number, retried: boolean, resolved: boolean,
 * }>}
 *   `sentence` 等字段**逐字取自原事件**（原句永不丢弃，界面上要显示的就是它）；
 *   `autoAttempts` 已经自动试过几次；`retried` 至少补交过一次（不论成没成）；
 *   `resolved` 补交成功过。补过的条目**仍留在队列里**（界面显示成"已补交"），
 *   不会从列表里消失——用户需要看得见自己那句话。
 */
export function pendingFeedbackArchive(events) {
  const list = Array.isArray(events) ? events : [];
  const byId = new Map();
  const resolvedIds = new Set();

  for (const e of list) {
    // 判定事件里的指针：它勾掉的是**别的**条目。
    //
    // ⚠️ 判据必须带上 `!isPendingEvent(e)`：**补交又失败**时落的那条也是 `feedback_pending`，
    // 它若带着 `retriedPendingId`、就会把自己的欠账勾掉——后果是"补交失败"被读成"补交成功"，
    // 那条句子从"还没补上"里消失，界面不再催，用户永远拿不到判定。
    // （首版写漏过这一条，`tests/pending.test.mjs` 的用例当场抓住了它。）
    // 与之配套：**只有"补上了"才带 `retriedPendingId`**，补交失败那条只带 `pendingId` + `attempt`
    // —— 于是"指针存在"与"这条被补上了"是同一件事，不需要第三处约定。
    const back = e?.payload?.retriedPendingId;
    if (typeof back === 'string' && back !== '' && !isPendingEvent(e)) resolvedIds.add(back);
    if (!isPendingEvent(e)) continue;
    const id = pendingIdOf(e);
    const prev = byId.get(id);
    // 同一个 id 的第一条就是"最初那条失败"（原句的出处）；后来的都是重试记录。
    //
    // ★ **这一段是"一条欠账 = 一个条目"的唯一起源**：重试失败再落的 `feedback_pending`
    //   带着同一个 `pendingId`，于是全部归并到同一条上（`autoAttempts` 随之 +1）。
    //   界面上「待补反馈（N 条）」里的 N 就是这个数组的长度——**调用方不许再去重一次**
    //   （验证：变异体 Q6 把调用方的去重删掉后全仓测试仍全绿，即那一层没有任何证据；
    //    与其留一行没人验证的冗余，不如把不变式钉在这里）。
    if (prev === undefined) {
      byId.set(id, {
        pendingId: id,
        sentence: e.payload?.sentence ?? null,
        word: e.payload?.word ?? null,
        scene: e.payload?.scene ?? null,
        reason: e.payload?.reason ?? null,
        error: e.payload?.error ?? null,
        detail: e.payload?.detail ?? null,
        event: e,
        failedAt: Number.isFinite(e?.ts) ? e.ts : 0,
        // 到这一刻为止，"上一次尝试"就是最初那次失败
        lastAttemptAt: Number.isFinite(e?.ts) ? e.ts : 0,
        autoAttempts: 0,
        retried: false,
      });
    } else {
      prev.autoAttempts += 1;
      prev.retried = true;
      // **最后一次尝试的时刻**：下一次重试的间隔从它起算（设计 §5.1 的三个间隔
      // 是"上一次之后再过多久"：失败 →10s→ 重试 →30s→ 重试 →90s→ 重试）。
      // 从最初失败时刻起算的话，第 2 次重试会比设定早 10s 发生——那等于把间隔表
      // 悄悄改掉了，而界面上"约 30 秒后再试"这句话会跟着变成假话。
      // 取 max 而不是"最后一条"：事件流的顺序由 storage 保证，但边界上（同 ts）
      // 取最大值更稳，且它不依赖"后来的事件一定排在后面"这条假设。
      if (Number.isFinite(e?.ts)) prev.lastAttemptAt = Math.max(prev.lastAttemptAt, e.ts);
    }
  }

  return [...byId.values()]
    .map((it) => ({ ...it, resolved: resolvedIds.has(it.pendingId) }))
    .sort((a, b) => (a.failedAt - b.failedAt) || a.pendingId.localeCompare(b.pendingId));
}

/**
 * 队列视图：与 `pendingFeedbackArchive` 同源（**同一个函数，不是第二套口径**）。
 *
 * 保留两个名字是因为它们在界面上是两件事：归档是"原句始终可见"的那张列表（含已补交的），
 * 待补是"还欠着的"。两个名字若各自实现一套过滤，迟早会漂移成两个不一致的数。
 */
export const pendingFeedbackQueue = (events) => pendingFeedbackArchive(events);

/**
 * 这条条目下一次自动重试该在什么时刻（毫秒时间戳）；次数用完返回 `null`。
 *
 * **间隔锚在"上一次尝试"上**（设计 §5.1 的三个数是"上一次之后再过多久"）：
 * 最初失败 →10s→ 第 1 次重试 →30s→ 第 2 次 →90s→ 第 3 次。
 * 锚在"最初失败"上会让第 2、3 次比设定更早发生，间隔表就被悄悄改掉了。
 *
 * 这个值要显示给用户看（"约 30 秒后自动再试一次"）：**一次自动重试要等 90 秒**，
 * 界面上不写清楚的话，用户只会看到"没有反应"——那是本项目反复吃过的一种失败形状。
 */
export const scheduledRetryAt = (item, delays = RETRY_DELAYS_MS) => {
  if (item.resolved || item.autoAttempts >= delays.length) return null;
  const anchor = Number.isFinite(item.lastAttemptAt) ? item.lastAttemptAt : item.failedAt;
  return anchor + delays[item.autoAttempts];
};

/**
 * 现在该轮到哪一条自动重试（**没有到点的就返回 `null`**）。
 *
 * 时序按设计 §5.1 的间隔表**从"上一次尝试"起算**：10s / +30s / +90s
 * （累计 10s / 40s / 130s）。因此"到点了没有"只需要两个数：**上一次尝试的时刻 + 已试次数**
 * ——两者都直接来自事件流（重试失败落的那条 pending 的 `ts` 就是上一次尝试时刻），
 * 不需要在页面上另存任何状态（页面上存的状态在重开页面时就没了）。
 *
 * 返回的是队列条目的副本 + `scheduledAt`（**排定时刻也一起交出去**：界面要显示
 * "还要等多久"，而那个数只有这里算得出来）。
 *
 * @param {object[]} events
 * @param {number} now 当前时刻（注入）
 * @param {number[]} [delays] 间隔表（测试可用小值）
 */
export function nextPendingRetry(events, now, delays = RETRY_DELAYS_MS) {
  let best = null;
  let bestAt = Infinity;
  for (const item of pendingFeedbackQueue(events)) {
    const at = scheduledRetryAt(item, delays);
    if (at === null || at > now) continue;
    if (at < bestAt) { best = item; bestAt = at; }
  }
  return best === null ? null : { ...best, scheduledAt: bestAt };
}

/**
 * 手动补交的对象（§5.1 的"用户可手动重试"）：**最早那条还没补上的**。
 *
 * 与 `nextPendingRetry` 的关键区别：**它不看时刻、也不看自动次数用没用完**。
 * 自动重试用完正是"仍失败则保留在队列，界面显示待补反馈"的成立条件——
 * 若手动也受次数限制，那条条目就永远补不上了。
 */
export function manualRetryCandidate(events) {
  return pendingFeedbackQueue(events).find((it) => !it.resolved) ?? null;
}

/**
 * 这条事件的结果是不是"存储写不进去"（配额满）——**重试轮转必须识别它并让路**。
 *
 * 为什么放在这里而不是各调用点自己判：`store.mjs` 的 `isStoreFullError` 判的是
 * "这个异常是不是配额异常"，而这里判的是"**这次补交失败的原因是存储写不进去**"
 * （补交**又失败**时 `recordEvent` 会返回 `null`，那就是写不进去的记号）。
 * 两者一个是异常分类、一个是"没落盘"的记号，判据不同，混用会把一次正常的
 * 语义失败（HTTP 502）误判成存储问题。
 */
export const recordedNothing = (event) => event === null || event === undefined;
