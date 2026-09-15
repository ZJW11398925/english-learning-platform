// tests/pending.test.mjs
//
// 待补反馈队列的**纯逻辑**（设计文档 §5.1：「失败后自动重试 3 次（间隔 10s / 30s / 90s）；
// 仍失败则保留在队列，界面显示"待补反馈"，用户可手动重试。原句永不丢弃。」）
//
// ── 权威是谁 ──────────────────────────────────────────────────────────────────
//
// **事件流是唯一权威**：队列不是一份独立的存储，而是**从事件流派生出来的视图**。
// 因此本模块只有"读事件、算状态"两类函数，**没有任何写到别处去的状态**——
// 没有第二份真相，也就没有"两份真相迟早漂移"这件事（本项目已因此吃过多次亏）。
//
// ── 怎么判断一条待补条目已经补上了 ────────────────────────────────────────────
//
// 靠**事件之间的显式指针**，不靠猜：
//   · `feedback_pending` 事件的 payload 带 `pendingId`（由 `withPendingId` 生成，见 `pendingIdOf`）；
//   · 补交成功落的那条判定事件（`feedback_ok` / `uncertain`）payload 带 `retriedPendingId`，
//     指回它补的是哪一条。
// 不用"同一句话的先后"来猜，是因为同一句话本来就可能在一次会话里被提交多次
// （回环改一版再交），时间先后分不清"补交"与"用户自己又写了一遍"。
//
// ── 补交拿到的判定必须与原始判定可区分 ────────────────────────────────────────
//
// 补交落的事件 payload 带 `retried: true` / `attempt` / `retriedAt`（`retryEventFor` 生成）——
// 否则数据里分不清哪些判定是"当时拿到的"、哪些是"事后补回来的"，
// 而这两批数据的可信度不同（补交的判定反映的是用户早已不在场的那句话）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRY_DELAYS_MS, MAX_AUTO_RETRIES, PENDING_ENTRY_LABEL,
  pendingIdOf, withPendingId, pendingFeedbackQueue, pendingFeedbackArchive,
  nextPendingRetry, manualRetryCandidate, retryEventFor,
} from '../web/units/pending.mjs';

/** 造一条事件（形状与 `event-log.mjs` 的 `recordEvent` 产出的一致）。 */
const ev = (type, payload, over = {}) => ({
  ts: 1_000, type, wordId: null, roundIndex: 1, sessionId: 's1', payload, ...over,
});

/**
 * 一条待补条目（真实形状：判定的三个上下文都在 payload 里）。
 *
 * `withId: false` 时**不带** `pendingId`——那是"更早版本落下的、还没有 id 的事件"，
 * 用来钉住 `pendingIdOf` 的派生规则（队列必须能读得懂历史数据，否则升级那一刻
 * 所有旧欠账都会从界面上消失）。
 */
const pendingEvent = (over = {}, payloadOver = {}, eventOver = {}, { withId = true } = {}) => {
  const e = ev('feedback_pending', {
    sentence: 'I use a cup.',
    word: 'mug',
    scene: 'kitchen',
    reason: 'timeout',
    error: 'timeout',
    detail: '等太久了',
    ...payloadOver,
  }, { ts: 1_000, ...eventOver });
  if (withId && !('pendingId' in e.payload)) e.payload = withPendingId(e);
  return e;
};

// ─────────────────────────── 设定值 ───────────────────────────

test('重试间隔是设计 §5.1 的首轮设定值：10s / 30s / 90s，共 3 次', () => {
  assert.deepEqual(RETRY_DELAYS_MS, [10_000, 30_000, 90_000]);
  assert.equal(MAX_AUTO_RETRIES, 3, '自动重试次数与间隔表必须一一对应');
  assert.equal(RETRY_DELAYS_MS.length, MAX_AUTO_RETRIES,
    '两者一旦不等，"第 4 次怎么办"就会变成一处没人定义的空白');
  assert.ok(Object.isFrozen(RETRY_DELAYS_MS), '统计/调度口径不许被运行时改写');
});

// ─────────────────────────── 从事件流派生队列 ───────────────────────────

test('队列从事件流派生：一条 feedback_pending 就是一条待补，原句、词、场景全带出来', () => {
  const q = pendingFeedbackQueue([pendingEvent()]);
  assert.equal(q.length, 1);
  assert.equal(q[0].sentence, 'I use a cup.', '原句必须带出来（它永不丢弃）');
  assert.equal(q[0].word, 'mug');
  assert.equal(q[0].scene, 'kitchen');
  assert.equal(q[0].reason, 'timeout', '落空的档位要留着，否则不知道该去查哪儿');
  assert.equal(q[0].resolved, false);
  assert.equal(q[0].autoAttempts, 0);
});

test('队列是事件流的**视图**：不落 feedback_pending 就没有队列（不存在第二份真相）', () => {
  const q = pendingFeedbackQueue([
    ev('recognize_ok', { word: 'mug' }),
    ev('compose_submitted', { sentence: 'x' }),
  ]);
  assert.deepEqual(q, [], '只有事件流里有的东西才会出现在队列里');
});

test('乱序事件流也按时间排序（队列是"最早那条先补"）', () => {
  const q = pendingFeedbackQueue([
    pendingEvent({}, { sentence: 'later' }, { ts: 5_000 }),
    pendingEvent({}, { sentence: 'earlier' }, { ts: 1_000 }),
  ]);
  assert.deepEqual(q.map((i) => i.sentence), ['earlier', 'later']);
});

test('补交成功后这条不再是待补：靠事件里的指针认，不靠猜', () => {
  const p = pendingEvent();
  const done = ev('feedback_ok', {
    sentence: 'I use a cup.',
    word: 'mug',
    scene: 'kitchen',
    verdict: 'flawed',
    retried: true,
    attempt: 1,
    retriedPendingId: pendingIdOf(p),
    retriedAt: 2_000,
  }, { ts: 2_000 });
  const q = pendingFeedbackQueue([p, done]);
  assert.equal(q.length, 1, '归档视图里那条条目还在（原句始终可见）');
  assert.equal(q[0].resolved, true, '但它已经补上了');
  assert.equal(q[0].sentence, 'I use a cup.', '原句不许因为补交成功就消失');
});

test('同一句话被用户自己又写了一遍（无指针）不算补交：那条待补仍挂着', () => {
  const p = pendingEvent();
  const unrelated = ev('feedback_ok', {
    sentence: 'I use a cup.', word: 'mug', scene: 'kitchen', verdict: 'correct',
  }, { ts: 3_000 });
  assert.equal(pendingFeedbackQueue([p, unrelated])[0].resolved, false,
    '没有 retriedPendingId 指针的判定不是补交——否则用户重写一遍就会把欠账悄悄勾掉');
});

test('只有当前未补的条目会进重试轮转（已补的不再重发）', () => {
  const p1 = pendingEvent({}, { sentence: 'a' }, { ts: 1_000 });
  const p2 = pendingEvent({}, { sentence: 'b' }, { ts: 2_000 });
  const done = ev('feedback_ok', { retried: true, retriedPendingId: pendingIdOf(p1) }, { ts: 9_000 });
  const due = nextPendingRetry([p1, p2, done], 100_000);
  assert.equal(due.pendingId, pendingIdOf(p2), '补过的那条不该再被重发');
});

// ─────────────────────────── 重试时序 ───────────────────────────

test('首次重试等 10s；到点之前不重试（不是立刻连发三次）', () => {
  const p = pendingEvent({}, {}, { ts: 1_000 });
  assert.equal(nextPendingRetry([p], 1_000), null, '刚失败的那一刻不该立刻重试');
  assert.equal(nextPendingRetry([p], 10_999), null, '差 1ms 也不行');
  assert.equal(nextPendingRetry([p], 11_000).pendingId, pendingIdOf(p), '满 10s 才轮到它');
});

test('三次重试的间隔依次是 10s / 30s / 90s（累计 10s / 40s / 130s）', () => {
  const p = pendingEvent({}, {}, { ts: 0 });
  const id = pendingIdOf(p);
  // 第 1 次重试：10s
  const r1 = nextPendingRetry([p], 10_000);
  assert.equal(r1.autoAttempts, 0, '第一次重试之前，已经自动试过 0 次');
  assert.equal(r1.scheduledAt, 10_000, '排定时刻就在条目上，界面要显示"什么时候再试"');
  // 第 1 次重试失败后的现场：多了一条指向同一条欠账的 pending（**不带勾掉指针**）
  const p2 = ev('feedback_pending', {
    sentence: 'I use a cup.', word: 'mug', scene: 'kitchen', reason: 'timeout',
    pendingId: id, retried: true, attempt: 1,
  }, { ts: 10_000 });
  assert.equal(nextPendingRetry([p, p2], 39_999), null,
    '第 2 次重试要从**最初失败**起算 40s，不是从上次重试起算 30s');
  assert.equal(nextPendingRetry([p, p2], 40_000).autoAttempts, 1);
  // 第 2 次重试失败后：90s
  const p3 = ev('feedback_pending', {
    sentence: 'I use a cup.', word: 'mug', scene: 'kitchen', reason: 'timeout',
    pendingId: id, retried: true, attempt: 2,
  }, { ts: 40_000 });
  assert.equal(nextPendingRetry([p, p2, p3], 129_999), null);
  assert.equal(nextPendingRetry([p, p2, p3], 130_000).autoAttempts, 2);
});

test('自动重试 3 次用完就停：不再自动重发，但界面上的手动入口仍在', () => {
  const p = pendingEvent({}, {}, { ts: 0 });
  const id = pendingIdOf(p);
  const attempts = [1, 2, 3].map((n) => ev('feedback_pending', {
    sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
    reason: 'timeout', pendingId: id, retried: true, attempt: n,
  }, { ts: n * 1_000 }));
  assert.equal(nextPendingRetry([p, ...attempts], 10_000_000), null,
    '3 次都用完了就到此为止（无限重发会把服务端打爆，也永远不算"仍失败"）');
  assert.equal(manualRetryCandidate([p, ...attempts])?.pendingId, id,
    '自动重试用完 ≠ 这条没救了：手动补交永远还在（§5.1 的"仍失败则保留在队列"）');
});

test('手动补交不受自动重试的次数与时刻限制（用户点了就该发）', () => {
  const p = pendingEvent({}, {}, { ts: 0 });
  assert.equal(manualRetryCandidate([p], 0)?.pendingId, pendingIdOf(p),
    '手动补交与"到没到点"无关——用户就在屏幕前等着');
  assert.equal(manualRetryCandidate([]), null);
});

test('多次失败但每次都是同一条时，重试次数按**这条**数，不按全事件流的 pending 条数', () => {
  const p = pendingEvent({}, { sentence: 'target' }, { ts: 0 });
  const noise = [
    pendingEvent({}, { sentence: '别的' }, { ts: 100 }),
    pendingEvent({}, { sentence: '别的另一个' }, { ts: 200 }),
  ];
  assert.equal(nextPendingRetry([p, ...noise], 10_000).pendingId, pendingIdOf(p),
    '别人欠的账不该消耗这条的重试次数');
});

// ─────────────────────────── 补交落的事件 ───────────────────────────

test('补交拿到的判定与原始判定可区分：带 retried / attempt / retriedAt 与指回原条的 id', () => {
  const p = pendingEvent({}, { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' });
  const first = retryEventFor(p, {
    status: 'ok', uncertain: false, sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
    feedback: { verdict: 'flawed', error_type: 'word_choice', note: '用词不准', rewrite: 'I use a mug.' },
  }, 2, 77_000);

  assert.equal(first.type, 'feedback_ok');
  assert.equal(first.payload.sentence, 'I use a cup.', '原句照旧带上（它就是语料）');
  assert.equal(first.payload.retried, true, '补交来的判定必须一眼可辨（否则两批数据混在一起）');
  assert.equal(first.payload.attempt, 2, '第几次补交（Task 10 要按它分组）');
  assert.equal(first.payload.retriedAt, 77_000);
  assert.equal(first.payload.retriedPendingId, pendingIdOf(p), '指回它补的是哪一条');
  assert.equal(first.payload.verdict, 'flawed', '判定本体一个字都不许改（映射仍由 compose.mjs 负责）');
});

test('补交仍然失败：落的还是 feedback_pending、仍挂在同一条欠账上，**且不许把自己勾掉**', () => {
  const p = pendingEvent({}, {}, { ts: 0 });
  const id = pendingIdOf(p);
  const again = retryEventFor(p, {
    status: 'pending', reason: 'http_error', error: 'http_502', sentence: 'I use a cup.',
  }, 1, 20_000);
  assert.equal(again.type, 'feedback_pending');
  assert.equal(again.payload.pendingId, id, '它仍属于同一条待补条目');
  assert.equal(again.payload.retried, true, '补过一次这件事要在数据里看得出');
  assert.equal(again.payload.attempt, 1);
  assert.equal(again.payload.retriedPendingId, undefined,
    '失败的补交**不许**带"勾掉"指针：那个指针的语义是"这条把它补上了"');

  const q = pendingFeedbackQueue([p, ev('feedback_pending', again.payload, { ts: 20_000 })]);
  assert.equal(q.length, 1, '两条记录仍是同一条欠账');
  assert.equal(q[0].resolved, false, '补交又失败 ≠ 补上了（这条如果不钉住，欠账会被静默勾销）');
  assert.equal(q[0].autoAttempts, 1, '补过一次要算进重试次数，否则会无限重发');
  assert.equal(q[0].sentence, 'I use a cup.', '原句仍在');
});

test('兜底不变式：**待补事件自己带的指针不算"补上了"**（历史数据形状不同也要读得对）', () => {
  // 这条钉的是 `pendingFeedbackArchive` 里那个 `!isPendingEvent(e)` 守卫。
  //
  // 它防的是"事件流里躺着一条 `feedback_pending`，却带着 `retriedPendingId`"这种形状——
  // 当前生产代码产不出它（`retryEventFor` 的失败分支明确不带这个字段），但手机上躺着的
  // **历史事件**不由当前代码决定。手机上的记录是长期资产：某个老版本、某次手工修补、
  // 或将来某次改动都可能留下这种形状，而后果非常不对称——
  // 一条"补交失败"被读成"补上了"，那条句子就从"还没补上"里消失、界面不再催，
  // 用户永远拿不到判定。所以这里按"数据就是这个形状"来钉住守卫（变体 Q8）。
  const p = pendingEvent({}, {}, { ts: 0 });
  const id = pendingIdOf(p);
  const odd = pendingEvent({}, {
    sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
    reason: 'timeout', pendingId: id, retried: true, attempt: 1,
    retriedPendingId: id,      // ← 这一形状当前产不出来，但守卫必须挡住它
  }, { ts: 20_000 });
  const q = pendingFeedbackQueue([p, odd]);
  assert.equal(q.length, 1, '仍然是同一条欠账');
  assert.equal(q[0].resolved, false,
    '带指针的**待补**事件不许勾掉任何东西：它只是又一次失败的记录');
  assert.equal(q[0].autoAttempts, 1, '它照样算一次重试（否则会无限重发）');
});

test('补交拿到 uncertain 也照样带标记（它是合法判定，不是失败）', () => {
  const p = pendingEvent({}, {}, { ts: 0 });
  const r = retryEventFor(p, {
    status: 'ok', uncertain: true, sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
    feedback: { verdict: 'uncertain', error_type: 'none', note: '拿不准', rewrite: null },
  }, 1, 30_000);
  assert.equal(r.type, 'uncertain');
  assert.equal(r.payload.retried, true);
  assert.equal(r.payload.retriedPendingId, pendingIdOf(p));
});

test('补交的判定事件**不许**自己变成一条新的待补（指针只认待补事件）', () => {
  const p = pendingEvent({}, {}, { ts: 0 });
  const ok = retryEventFor(p, { status: 'ok', sentence: 'x', feedback: { verdict: 'correct' } }, 1, 1);
  const q = pendingFeedbackQueue([p, ev(ok.type, ok.payload, { ts: 5 })]);
  assert.equal(q.length, 1, '一条待补 + 一次补交成功 = 仍然只有一条队列条目');
});

// ─────────────────────────── 界面入口的文案 ───────────────────────────

test('"待补反馈"这个入口在界面上就叫这个名字（清单里的走查步骤认它）', () => {
  assert.equal(PENDING_ENTRY_LABEL, '待补反馈',
    '入口文案是界面、测试与走查清单三者之间的约定，改名要同步改清单');
});

// ─────────────────────────── pendingId 的生成 ───────────────────────────

test('pendingId 由事件派生且稳定：重开页面后派生出的 id 与当时那条一致', () => {
  const e = ev('feedback_pending', { sentence: 'x' }, { ts: 1_234, sessionId: 's9' });
  const a = pendingIdOf(e);
  const b = pendingIdOf({ ...e, payload: { ...e.payload } });
  assert.equal(a, b, '同一个事件派生出同一个 id（不靠内存、不靠时间随机）');
  assert.notEqual(a, pendingIdOf({ ...e, ts: 1_235 }), '不同事件不许撞 id');
  assert.match(a, /^p_/, 'id 形状要能一眼认出是待补条目的 id');
});

test('更早版本落下的、没有 pendingId 的事件也读得懂（队列升级后不许把旧欠账弄丢）', () => {
  const legacy = pendingEvent({}, {}, { ts: 500 }, { withId: false });
  assert.equal(legacy.payload.pendingId, undefined, '现场就是"payload 里没有 id"');
  const q = pendingFeedbackQueue([legacy]);
  assert.equal(q.length, 1, '没有 id 的旧事件照样进队列（按 sessionId+ts 派生）');
  assert.equal(q[0].pendingId, pendingIdOf(legacy));
  assert.equal(q[0].sentence, 'I use a cup.', '原句一样不许丢');
});

test('已有 pendingId 的事件不会被覆盖（补交失败后重落的那条继承同一个 id）', () => {
  const e = ev('feedback_pending', { sentence: 'x' }, { ts: 1 });
  const first = withPendingId(e);
  const second = withPendingId({ ...e, payload: { ...first } });
  assert.equal(second.pendingId, first.pendingId);
});

test('归档视图把同一条欠账的重试记录**归并成一条**（"一条 = 一句"的唯一起源）', () => {
  // 界面上的「待补反馈（N 条）」直接取这个数组的长度，**调用方不再去重**
  // （变异体 Q6 把调用方的去重删掉后全仓测试仍全绿 —— 去重只能在这一处做，否则就是
  // 两处机制产出同一结果，而那意味着两处都没被验证）。
  const id = 'p_s1_1000';
  const events = [
    pendingEvent({}, {}, { ts: 1_000 }, { withId: false }),
    ...([1, 2, 3].map((n) => ev('feedback_pending', {
      sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
      pendingId: id, retried: true, attempt: n,
    }, { ts: 1_000 + n * 1_000 }))),
    // 另一条欠账（不同 id）必须是**另一个**条目
    pendingEvent({}, { sentence: '另一句。', pendingId: 'p_s1_2000' }, { ts: 2_000 }, { withId: false }),
  ];
  const q = pendingFeedbackQueue(events);
  assert.equal(q.length, 2, '4 条同 id 记录 → 1 条欠账；再加另一句 → 共 2 条');
  const first = q[0];
  assert.equal(first.pendingId, id);
  assert.equal(first.autoAttempts, 3, '同一个 id 的后三条都是重试记录');
  assert.equal(first.sentence, 'I use a cup.', '原句取最初那条（重试记录里也带着它，但不是权威）');
  assert.equal(q[1].pendingId, 'p_s1_2000');
  assert.equal(q[1].autoAttempts, 0);
});

test('归档视图与队列同源：归档是队列的超集（界面上"原句始终可见"靠它）', () => {
  const p = pendingEvent();
  const done = ev('feedback_ok', { retried: true, retriedPendingId: pendingIdOf(p) }, { ts: 9 });
  const archive = pendingFeedbackArchive([p, done]);
  const queue = pendingFeedbackQueue([p, done]);
  assert.equal(archive.length, 1);
  assert.equal(queue.length, 1);
  assert.equal(archive[0].resolved, true);
  assert.equal(queue[0].resolved, true, '补过的也留在界面上（显示成"已补交"），不是从列表里消失');
});
