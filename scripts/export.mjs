/**
 * 数据导出：把**事件流 + 词表**变成**判据所需的数**。
 *
 * ── 给谁用、怎么用 ────────────────────────────────────────────────────────────
 * 给 **Task 11（契约级验收与回填）** 用，也给任何要回答"这一轮跑成什么样"的人用。
 * 它在 **Node** 里跑（零浏览器 API），两种用法：
 *
 *   1. **命令行**（Task 11 走这条，不必写代码）：
 *        node scripts/export.mjs <事件.json> [--words <词表.json>] [--expect <判定表.json>]
 *                                 [--out <摘要.json>] [--csv <事件.csv>]
 *      输入 = 诊断页 localStorage 里那两个键的**原样 JSON**：
 *        · 事件：`JSON.parse(localStorage.getItem('elp.events'))` 的数组
 *          （每条形如 `{ ts, type, wordId, roundIndex, sessionId, payload }`）
 *        · 词表：`JSON.parse(localStorage.getItem('elp.words'))` 的对象
 *        · 判定表（可选，只有算 top1/top3 才需要，见下）
 *      输出 = 摘要 JSON（判据数值 + measurements 映射）与事件 CSV（带 UTF-8 BOM，Excel 直接开）。
 *
 *   2. **当成模块**：`import { summarize, toCsv } from './scripts/export.mjs'`。
 *
 * ── 这一份的口径从哪来（任何一处改动都要先改那三处权威）──────────────────────
 *   · **判据 B（`retry_rate`）**：`web/units/rounds.mjs` 的**文件头**是唯一权威定义处。
 *     本模块**只用它的原语**（`roundCountOfSession` / `needsReshoot`），一行公式都不另写。
 *   · **事件种类**：`web/units/event-log.mjs` 的 `EVENT_TYPES`（未登记的类型在这里只计数、
 *     不猜测语义，见 `unknownTypes`）。
 *   · **各数的口径**：`web/diagnostics.html` 的汇总段。导出脚本必须与它一致——它是走查的人
 *     在手机上看到的那一份，两处口径漂移过一次，此后就再也说不清哪个数是对的。
 *
 * ── 七条口径，逐条写死在这里（brief §2 的硬要求）────────────────────────────
 *
 * **① 造句总数只数 `compose_submitted`。** `feedback_ok` / `uncertain` / `feedback_pending`
 * 的 `payload.sentence` 是**同一句的另一笔账**（产出成本 vs 判定结果），**绝不相加**。
 * 诊断页把这句话原样写在页面上（"数句子总数时只数「造句落盘」那张表"），此处与它同口径。
 *
 * **② 补交的判定单独数。** Task 9B 的 `retryEventFor` 给补交落的事件加四个字段：
 * `retried: true` / `attempt` / `retriedAt` / `retriedPendingId`（**只有真补上了才带指针**）。
 * 于是：`retriedJudged` = 拿到判定的补交条数；`retriedResolved` = 真补上的条数；
 * `retriedFailed` = 补交又失败的条数（这类是 `feedback_pending` + `retried`，且**没有**指针）。
 * 没有这几个数就算不出"补交成功率"——而补交成功率正是 §5.1 那条队列存在的意义。
 *
 * **③ 复现两模式分列，且 `sceneChanged` 再分一列。** §3.4 要看的"跨场景到底有没有被兑现"
 * 是 `sceneChanged === true` 的那一批；合并成一个数就把它抹掉了。`sceneChanged` **不是 true
 * 就是 false**（拿不准时调用方记 `false`，见 `web/app.mjs` 的 `noteRecurrence`）。
 *
 * **④ 跟读没通过率的分母 = `reading_done + reading_missed`。**
 * **不含** `speech_unsupported` 与 `skipped_reading`：那两个是"**没判过**"（系统压根没判，
 * 或用户主动跳过），不是"判了没通过"。混进分母就是伪造一个更低的失败率。
 *
 * **⑤ 判据 B 用 `rounds.mjs` 的口径**（按**轮次**去重、三类结论事件都算），
 * 不是"某会话 `frame_rejected` 的条数 ≥ 2"。plan 的示例 `summarize` 用的是后者，两者在
 * **同一轮被重复落多条**时会给出不同的数（旧口径虚高）。差异与逐样本对照见
 * `tests/export.test.mjs` 的"旧口径…与 rounds.mjs 口径给出不同的数"一例；
 * 旧口径的结果仍作为 `retryRateByFrameRejects` 并列报出，**只为对照，不作判据**。
 *
 * 分母的定义（`rounds.mjs` 文件头边界 3 把选择权交给本模块）：**只含 R(s) ≥ 1 的会话**
 * ——"真的拍过至少一次并走到了结论的会话"。理由：生产代码**没有任何一处**发
 * `session_start`，不存在一份完整会话清单；把"只落了 `blocked_permission`、一次快门都没按过"
 * 的会话算进分母，等于把它当成"没重拍"，重拍率会被稀释（相机没授权的用户会拉低这个数）。
 *
 * **⑥ `uncertain` 的分母只含"真的拿到了判定"的那些**（`feedback_ok` + `uncertain`）。
 * plan 的示例把 `feedback_pending` 也算进分母，理由是"它是一次反馈尝试"；但 pending 的语义是
 * **"没拿到判定"**（请求失败/超时/响应非法），把它算进分母等于说"没拿到判定"是一种"判得不含糊"
 * 的结果——方向恰好反了：网络越差，线上看起来越稳。因此：
 * `uncertaintyRate = uncertain / (feedback_ok + uncertain)`，分母单列为 `feedbackJudged`；
 * `feedback_pending` **自己单列**（`feedbackPending`），不与上两者相加。
 * 与设计 Global Constraint 2（`uncertain` 单独统计、不计入通过率）一致。
 *
 * **⑦ `storage_full` 单列。** §5.1 第七档。混进别的桶就等于把它藏起来。
 *
 * ── 三个**算不出来**的数（如实报缺口，不假装）─────────────────────────────────
 * 判据 A（`VAL-…38`）要 `top3` / `top1` / `latency_p95`，但它们**不在事件流里**：
 *   · `top1/top3` 需要两样东西：①"预声明可接受词集"（实验方案 §1，按测试物体声明，
 *     不在事件里）；②候选的**顺序**（`recognize_ok.payload.candidates` 有顺序、只存了 label）。
 *     故必须由 `--expect` 外部给判定表；不给就报 `null` + `gaps`，**绝不假装算出了准确率**。
 *   · `latency_p95` 需要每次识别的耗时。`payload.latencyMs` **当前生产代码不写**
 *     （`web/app.mjs` 的 `recognize_ok` 只落 word/attempts/candidates，服务端回的
 *     `latency_ms` 没进事件）。有则算，没有则 `latencyP95 = null` + `gaps` 里写明
 *     "要么改写入路径、要么由实验装置另外记时"。**本任务不改 `web/units/*` 的契约**
 *     （brief §3 红线），所以这一条交给控制器裁决。
 * `gaps` 是给 Task 11 看的一张"还缺什么"的清单，缺什么就写什么，不写空话。
 */
import fs from 'node:fs';
import { needsReshoot, roundCountOfSession } from '../web/units/rounds.mjs';

/** 判据 A / B 的对象 id（Task 11 直接照抄进 `validation_submit` 的 `measurements`）。 */
export const CRITERION_IDS = Object.freeze({
  top3: 'VAL-OPI-ecb3037d-1a56-46d3-b931-4d482dcc668f.38',
  retryRate: 'VAL-OPI-ecb3037d-1a56-46d3-b931-4d482dcc668f.50',
});

/** 结论事件（一次快门必落且只落其中一条）——与 `units/rounds.mjs` 的 `ROUND_EVENT_TYPES` 同源。 */
const CONCLUSION_TYPES = Object.freeze(['frame_rejected', 'recognize_ok', 'recognize_failed']);
/** 拿到判定的反馈事件（口径 ⑥）。 */
const JUDGED_TYPES = Object.freeze(['feedback_ok', 'uncertain']);
/** 复现两种模式。 */
const RECURRENCE_TYPES = Object.freeze(['recurrence_scene', 'recurrence_manual']);

/**
 * `EVENT_TYPES` 的逐字副本（`web/units/event-log.mjs`）。
 *
 * **为什么不 import**：`event-log.mjs` 会 `import './store.mjs'`，而 `store.mjs` 是存储层
 * （浏览器 API 的宿主）。导出脚本要在 Node 里跑、还要能被变异探针驱动，所以这里只抄一份
 * **类型名字表**，且**不用它校验**——只在 `unknownTypes` 里如实报出"流里有没登记的类型"。
 * 抄错一个字不会造成静默错误：这里不做判断，未知类型在 `countByType` 里照样计数。
 */
export const KNOWN_EVENT_TYPES = Object.freeze([
  'session_start', 'frame_rejected', 'blocked_permission', 'recognize_ok', 'recognize_failed',
  'word_shown', 'reading_done', 'reading_missed', 'skipped_reading', 'speech_unsupported',
  'compose_submitted', 'compose_rewrite', 'feedback_ok', 'feedback_pending', 'uncertain',
  'recurrence_scene', 'recurrence_manual', 'storage_full',
]);

/** 比例：分母为 0 时返回 0（不是 NaN——NaN 会让 JSON 里出现 `null` 而看起来像"没这一项"）。 */
const rate = (num, den) => (den === 0 ? 0 : num / den);

/** 升序取第 p 百分位（最近秩法，`p` 取 0–1）。空数组返回 `null`（不是 0：0 是个合法的耗时）。 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** 数某类事件的条数。 */
const countOf = (events, type) => events.filter((e) => e.type === type).length;

/** 一条事件是不是"补交来的判定"（口径 ②）。 */
const isRetried = (e) => e?.payload?.retried === true;

/**
 * 把事件流与词表折算成判据所需的数。
 *
 * @param {object[]} events 事件流（`store.readEvents()` / `elp.events` 的数组）
 * @param {object} [words] 词表（`store.readWords()` / `elp.words` 的对象）
 * @param {{acceptable?: Array<string[]|null>}} [expect] 判定表：第 N 个元素是第 N 条
 *   `recognize_ok`（按事件流顺序）的可接受词集；不给则 top1/top3 报 `null` + 缺口。
 * @returns {object} 摘要（字段含义见各段注释与文件头）
 * @throws {Error} 结论事件缺 `roundIndex` 时——`rounds.mjs` 刻意"响亮报错，不静默跳过"
 *   （静默跳过会让"写入路径漏了字段"长得像"这一轮不存在"）。这条纪律由本模块**继承**，
 *   不在这里 catch 成一个更好看的数。
 */
export function summarize(events, words = {}, expect = {}) {
  const list = Array.isArray(events) ? events : [];
  const wordMap = words !== null && typeof words === 'object' ? words : {};

  // ── 会话分组与轮数（判据 B 的全部输入都来自这里）────────────────────────────
  const sessions = new Map();
  for (const e of list) {
    const sid = e?.sessionId ?? '(无会话号)';
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid).push(e);
  }
  // R(s) 只经 rounds.mjs 的原语算：**不许**在这里自己数 `frame_rejected` 的条数（口径 ⑤）。
  const roundCounts = new Map();
  for (const sid of sessions.keys()) roundCounts.set(sid, roundCountOfSession(list, sid));
  // 分母：真的拍过至少一次并走到结论的会话（见文件头口径 ⑤ 的理由）。
  const counted = [...roundCounts.entries()].filter(([, r]) => r >= 1);
  const needing = counted.filter(([, r]) => needsReshoot(r));

  // ── 造句（口径 ①）与判定（口径 ⑥）────────────────────────────────────────
  const composeTotal = countOf(list, 'compose_submitted');
  const feedbackOk = countOf(list, 'feedback_ok');
  const uncertainCount = countOf(list, 'uncertain');
  const feedbackPending = countOf(list, 'feedback_pending');
  // 分母只含"真的拿到了判定"的那些；pending 是"没拿到"，不在这里（口径 ⑥）。
  const feedbackJudged = list.filter((e) => JUDGED_TYPES.includes(e?.type)).length;

  // ── 补交（口径 ②）───────────────────────────────────────────────────────
  const retriedAttempts = list.filter(isRetried);
  const retriedJudged = retriedAttempts.filter((e) => JUDGED_TYPES.includes(e?.type)).length;
  const retriedResolved = retriedAttempts.filter(
    (e) => typeof e?.payload?.retriedPendingId === 'string' && e.payload.retriedPendingId !== '',
  ).length;
  const retriedFailed = retriedAttempts.filter(
    (e) => e?.type === 'feedback_pending',
  ).length;

  // ── 跟读（口径 ④）────────────────────────────────────────────────────────
  const readingDone = countOf(list, 'reading_done');
  const readingMissed = countOf(list, 'reading_missed');
  // 分母**只含判过的**：加上 speech_unsupported / skipped_reading 就是伪造一个更低的失败率。
  const readingJudged = readingDone + readingMissed;

  // ── 复现（口径 ③）────────────────────────────────────────────────────────
  const recurrence = list.filter((e) => RECURRENCE_TYPES.includes(e?.type));
  // `sceneChanged !== true` 一律算"没换"：字段缺失/拿不准时调用方记 false，
  // 导出这一侧**不许把它默认成"换了"**（那会让 §3.4 的信号虚高）。
  const sceneChangedTrue = recurrence.filter((e) => e?.payload?.sceneChanged === true).length;

  // ── 词表 ────────────────────────────────────────────────────────────────
  const wordList = Object.values(wordMap);
  const wordsMaintained = wordList.filter((w) => w?.maintained === true || w?.dueAt === null).length;

  // ── 判据 A 的两个数（有判定表才算，见文件头"算不出来的数"）─────────────────
  const recognized = list.filter((e) => e?.type === 'recognize_ok');
  const acceptable = Array.isArray(expect?.acceptable) ? expect.acceptable : null;
  let top1Hits = null;
  let top3Hits = null;
  if (acceptable !== null) {
    top1Hits = 0;
    top3Hits = 0;
    recognized.forEach((e, i) => {
      const set = acceptable[i];
      if (!Array.isArray(set) || set.length === 0) return;
      const cands = Array.isArray(e?.payload?.candidates) ? e.payload.candidates : [];
      if (cands.slice(0, 3).some((c) => set.includes(c))) top3Hits += 1;
      if (set.includes(cands[0])) top1Hits += 1;
    });
  }

  // ── 耗时（当前生产代码不写 latencyMs，见文件头）───────────────────────────
  const latencies = list
    .filter((e) => CONCLUSION_TYPES.includes(e?.type) && Number.isFinite(e?.payload?.latencyMs))
    .map((e) => e.payload.latencyMs);

  // ── 缺口清单：Task 11 照它决定"还缺什么"─────────────────────────────────
  const gaps = [];
  if (acceptable === null) {
    gaps.push('top1/top3 未计算：缺"预声明可接受词集"判定表（--expect）。事件里的 candidates '
      + '只有 label、没有测试物体标识，无法自动对齐。');
  } else if (acceptable.length !== recognized.length) {
    gaps.push(`判定表样本数（${acceptable.length}）与 recognize_ok 条数（${recognized.length}）不一致：`
      + 'tpop1/top3 只在两者对齐的那部分上成立，结论前必须核对。');
  }
  if (latencies.length === 0) {
    gaps.push('latency_p95 未计算：事件流里没有任何 payload.latencyMs——生产写入路径当前不落这个字段'
      + '（服务端回的 latency_ms 没有进 recognize_ok）。要么改写入路径（需控制器授权，动 web/ 契约），'
      + '要么由实验装置另外记时。');
  }
  const unknownTypes = [...new Set(list.map((e) => e?.type).filter((t) => !KNOWN_EVENT_TYPES.includes(t)))];

  return {
    // 会话与判据 B（口径 ⑤）
    sessions: sessions.size,
    countedSessions: counted.length,
    retryRate: rate(needing.length, counted.length),
    // 旧口径（plan 示例）并列报出，**仅供对照**：按"某会话 frame_rejected 条数 ≥ 2"数。
    retryRateByFrameRejects: rate(
      [...sessions.values()].filter((l) => l.filter((e) => e?.type === 'frame_rejected').length >= 2).length,
      counted.length,
    ),
    // 判据 B 的三个组成数（分子/分母/口径说明）一起交出去：只给一个比例，
    // 读的人无法判断它是在几个会话上算的。
    gate: {
      metric: 'retry_rate',
      value: rate(needing.length, counted.length),
      sessionsCounted: counted.length,
      sessionsNeedingReshoot: needing.length,
      definition: '需重拍 ≥2 次（R(s) ≥ 3）的会话数 / 真的拍过至少一次并走到结论的会话数'
        + '（权威公式：web/units/rounds.mjs 文件头）',
      altByFrameRejects: rate(
        [...sessions.values()].filter((l) => l.filter((e) => e?.type === 'frame_rejected').length >= 2).length,
        counted.length,
      ),
    },
    // 造句（口径 ①）与反馈判定（口径 ⑥）
    composeTotal,
    composeRewrite: countOf(list, 'compose_rewrite'),
    feedbackOk,
    uncertainCount,
    feedbackPending,
    feedbackJudged,
    uncertaintyRate: rate(uncertainCount, feedbackJudged),
    // 补交（口径 ②）
    retriedAttempts: retriedAttempts.length,
    retriedJudged,
    retriedResolved,
    retriedFailed,
    retriedRate: rate(retriedJudged, feedbackJudged),
    // 补交**成功率**的分母是"试过几次补交"，不是"拿到判定的补交"——补交失败的那些
    // 拿不到判定，若把它们从分母里剔掉，分母剩 1、成功率恒为 1（首版就是这么写错的，
    // 被 `tests/export.test.mjs` 的"补交判定单列"一例当场抓住）。
    retrySuccessRate: rate(retriedResolved, retriedAttempts.length),
    // 识物结论（四个原始计数，逐条对应 EVENT_TYPES）
    frameRejected: countOf(list, 'frame_rejected'),
    recognizeOk: recognized.length,
    recognizeFailed: countOf(list, 'recognize_failed'),
    wordShown: countOf(list, 'word_shown'),
    // 跟读（口径 ④）
    readingDone,
    readingMissed,
    readingJudged,
    readingMissRate: rate(readingMissed, readingJudged),
    speechUnsupported: countOf(list, 'speech_unsupported'),
    skippedReading: countOf(list, 'skipped_reading'),
    // 复现（口径 ③）
    sceneRecurrence: countOf(list, 'recurrence_scene'),
    manualRecurrence: countOf(list, 'recurrence_manual'),
    recurrenceTotal: recurrence.length,
    recurrenceSceneChangedTrue: sceneChangedTrue,
    recurrenceSceneChangedFalse: recurrence.length - sceneChangedTrue,
    // 存储（口径 ⑦）与词表
    storageFull: countOf(list, 'storage_full'),
    blockedPermission: countOf(list, 'blocked_permission'),
    wordsTracked: wordList.length,
    wordsMaintained,
    // 判据 A 的两个数（可能为 null，见 gaps）
    recognizedRounds: recognized.length,
    top1Hits,
    top3Hits,
    top1Rate: top1Hits === null ? null : rate(top1Hits, recognized.length),
    top3Rate: top3Hits === null ? null : rate(top3Hits, recognized.length),
    latencySamples: latencies.length,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    // 缺口与异常
    unknownTypes,
    gaps,
  };
}

/** 单元格转义：含 `"` / `,` / 换行就整体加引号，内部引号翻倍（plan 的规则，保留）。 */
const escapeCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 事件流转 CSV（一条事件一行）。
 *
 * **表头带 `roundIndex`**：判据 B 是按轮次算的，人拿 Excel 复核时得有这一列，
 * 否则"这个会话到底按了几次快门"在表里看不出来。
 *
 * **UTF-8 BOM 是有意的**（brief §2 第 8 条）：`payload` 是含中文的 JSON 字符串，
 * 而 Excel 打开无 BOM 的 UTF-8 CSV 会按本地编码（简中 Windows 上是 GBK）解释它 ——
 * 中文全成乱码，而乱码会让人以为"数据坏了"。`\uFEFF` 是让 Excel 认出 UTF-8 的标准做法；
 * 代价是别的程序读第一列时会多一个不可见字符，故 `parseArgs` 的入口在读回自己的 CSV 时
 * 要按需剥掉——本模块只**写** CSV，不回读，所以这个代价不落在代码里。
 *
 * @param {object[]} events 事件流
 * @returns {string} CSV 文本（**以 `\uFEFF` 开头**，行尾 `\n`）
 */
export function toCsv(events) {
  const list = Array.isArray(events) ? events : [];
  const header = ['ts', 'type', 'roundIndex', 'sessionId', 'wordId', 'payload'];
  const rows = list.map((e) => [
    e?.ts, e?.type, e?.roundIndex, e?.sessionId, e?.wordId,
    JSON.stringify(e?.payload ?? {}),
  ]);
  return `\uFEFF${[header, ...rows].map((r) => r.map(escapeCell).join(',')).join('\n')}\n`;
}

/**
 * 把摘要折算成 **`validation_submit` 的 `measurements`**（Task 11 直接照抄）。
 *
 * 字段名对齐两条判据的登记口径（`英语学习平台/验证二-…实验方案.md` §4）：
 *   · `VAL-…38`：`top3_recognition_accuracy` / `top1_recognition_accuracy` / `latency_ms_p95`
 *   · `VAL-…50`：`retry_rate`
 *
 * **值可能是 `null`**（top1/top3 缺判定表、p95 缺写入字段）——`null` 是"没算出来"，
 * 不许在回填时被当成 0。`gaps` 里写了为什么、以及怎么补。
 *
 * @param {object} summary `summarize()` 的返回值
 * @returns {Record<string, object>} 判据对象 id → measurements
 */
export function measurementsOf(summary) {
  return {
    [CRITERION_IDS.top3]: {
      top3_recognition_accuracy: summary?.top3Rate ?? null,
      top1_recognition_accuracy: summary?.top1Rate ?? null,
      latency_ms_p95: summary?.latencyP95 ?? null,
    },
    [CRITERION_IDS.retryRate]: {
      retry_rate: summary?.retryRate ?? null,
      // 附报：口径本身就是判据的一部分，回填时把分母一起交出去（否则对方无法判断这个比例
      // 是在几个会话上算的）。这三个是**附加证据**，不是判据值。
      sessions_counted: summary?.countedSessions ?? null,
      sessions_needing_reshoot: summary?.gate?.sessionsNeedingReshoot ?? null,
    },
  };
}

/**
 * 命令行参数解析（`export.mjs` 的入口用；导出来是为了能单测，不必起子进程）。
 *
 * 支持 `--k v` 与 `--k=v` 两种写法；位置参数只有一个（事件文件）。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{input: string, wordsPath: string|null, expectPath: string|null, outPath: string|null, csvPath: string|null}}
 * @throws {Error} 用法错误（缺输入文件 / 未知参数 / 选项缺值）——**响亮退出**，
 *   不许把"参数写错了"变成"跑出一个空摘要"（那看起来像"这一轮没数据"）。
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const opts = { input: null, wordsPath: null, expectPath: null, outPath: null, csvPath: null };
  const valueOf = (i, name) => {
    const v = args[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`参数 ${name} 缺值`);
    return v;
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    // `--k=v` 拆成 `--k` + `v` 再走下面同一条路（两种写法只有一处实现）。
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (inline !== undefined) { args[i] = flag; args.splice(i + 1, 0, inline); }
    if (flag === '--words') { i += 1; opts.wordsPath = valueOf(i, flag); } else if (flag === '--expect') { i += 1; opts.expectPath = valueOf(i, flag); } else if (flag === '--out') { i += 1; opts.outPath = valueOf(i, flag); } else if (flag === '--csv') { i += 1; opts.csvPath = valueOf(i, flag); } else if (flag.startsWith('--')) { throw new Error(`未知参数 ${flag}`); } else { positional.push(flag); }
  }
  if (positional.length === 0) {
    throw new Error('用法：node scripts/export.mjs <事件.json> [--words 词表.json] [--expect 判定表.json] [--out 摘要.json] [--csv 事件.csv]');
  }
  if (positional.length > 1) throw new Error(`只接受一个事件文件，收到 ${positional.length} 个：${positional.join(', ')}`);
  [opts.input] = positional;
  return opts;
}

/** 读一个 JSON 文件；读不到就抛错（**不吞**——吞掉会产出"看起来正常的空摘要"）。 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 一屏给人类看的摘要（Task 11 不必打开 JSON 就能读）。 */
function render(summary, opts) {
  const lines = [];
  lines.push('英语学习平台 · 数据导出摘要');
  lines.push(`  输入：${opts.input}${opts.wordsPath ? ` ｜ 词表：${opts.wordsPath}` : ''}${opts.expectPath ? ` ｜ 判定表：${opts.expectPath}` : ''}`);
  lines.push(`  会话 ${summary.sessions} 个，其中真的拍过并走到结论的 ${summary.countedSessions} 个`);
  lines.push(`  判据 B 重拍率 retryRate = ${summary.retryRate}（需重拍 ≥2 次的会话 ${summary.gate.sessionsNeedingReshoot} / ${summary.countedSessions}）`
    + `　[旧口径（不作判据）retryRateByFrameRejects = ${summary.retryRateByFrameRejects}]`);
  lines.push(`  造句 composeTotal = ${summary.composeTotal}（只数 compose_submitted；判定事件里的同一句不在此列）`
    + `　改写 composeRewrite = ${summary.composeRewrite}`);
  lines.push(`  反馈：拿到 ${summary.feedbackJudged}（ok ${summary.feedbackOk} / uncertain ${summary.uncertainCount}）`
    + `　没拿到 ${summary.feedbackPending}　uncertaintyRate = ${summary.uncertaintyRate}`);
  lines.push(`  补交：拿到判定的 ${summary.retriedJudged}（补上 ${summary.retriedResolved} / 又失败 ${summary.retriedFailed}）`
    + `　补交成功率 = ${summary.retrySuccessRate}`);
  lines.push(`  跟读：念对 ${summary.readingDone} / 没通过 ${summary.readingMissed}（判定合计 ${summary.readingJudged}，没通过率 ${summary.readingMissRate}）`
    + `　语音不可用 ${summary.speechUnsupported}　跳过 ${summary.skippedReading}（这两档不算没通过）`);
  lines.push(`  复现：识物命中 ${summary.sceneRecurrence} / 自己手选 ${summary.manualRecurrence}`
    + `　换了场景 ${summary.recurrenceSceneChangedTrue} / 没换 ${summary.recurrenceSceneChangedFalse}`);
  lines.push(`  识物：退回 ${summary.frameRejected} / 成功 ${summary.recognizeOk} / 失败 ${summary.recognizeFailed}`
    + `　存储写满 ${summary.storageFull}　相机未授权 ${summary.blockedPermission}`);
  lines.push(`  词表 ${summary.wordsTracked} 个（已维护 ${summary.wordsMaintained}）`);
  lines.push(`  判据 A：top1 = ${summary.top1Rate}　top3 = ${summary.top3Rate}　latency_p95 = ${summary.latencyP95}`
    + `（样本 ${summary.recognizedRounds} / 耗时样本 ${summary.latencySamples}）`);
  if (summary.unknownTypes.length > 0) lines.push(`  ⚠️ 未登记的事件类型：${summary.unknownTypes.join(', ')}`);
  for (const g of summary.gaps) lines.push(`  ⚠️ 缺口：${g}`);
  lines.push(`  measurements 映射：${JSON.stringify(summary.measurementsMap)}`);
  return `${lines.join('\n')}\n`;
}

/** CLI 主体。返回退出码（导出是为了能被测试直接调用，不必起子进程）。 */
export function run(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const opts = parseArgs(argv);
  const events = readJson(opts.input);        // 读不到就抛（main 里转成非零退出）
  if (!Array.isArray(events)) throw new Error(`事件文件必须是 JSON 数组，收到 ${typeof events}`);
  const words = opts.wordsPath ? readJson(opts.wordsPath) : {};
  const expect = opts.expectPath ? readJson(opts.expectPath) : {};
  const base = summarize(events, words, expect);
  const summary = {
    input: opts.input,
    generatedAt: new Date().toISOString(),
    ...base,
    measurementsMap: measurementsOf(base),
  };
  if (opts.outPath) fs.writeFileSync(opts.outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  if (opts.csvPath) fs.writeFileSync(opts.csvPath, toCsv(events), 'utf8');
  out.write(render(summary, opts));
  return 0;
}

// 只有"被当成命令跑"时才执行（被 import 时不执行）：`import.meta.main` 是 Node 24 的正式字段，
// 旧版本上退化为比较 argv[1] 与自身路径。
const invokedDirectly = typeof import.meta.main === 'boolean'
  ? import.meta.main
  : process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    // 读不到输入 / 参数写错 / 结论事件缺 roundIndex：一律非零退出，且**不留下**半份摘要文件。
    process.stderr.write(`导出失败：${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
