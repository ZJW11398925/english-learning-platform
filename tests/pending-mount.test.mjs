// tests/pending-mount.test.mjs
//
// 待补反馈队列在**装配层**的行为（设计文档 §5.1 / 真机清单）。
//
// 这一层要钉住的是"接线"，不是纯逻辑（纯逻辑在 tests/pending.test.mjs）：
//   · 失败 → 自动重试 3 次（10s / 30s / 90s），**定时器由注入的 setTimeout 驱动**——
//     用真 `setTimeout` 就得让测试睡 130 秒，或者把设定值改小到失去意义；
//   · 仍失败 → 出现「待补反馈」入口（每屏都挂着），原句逐字可见，可手动补交；
//   · 补交成功 → 判定与原始判定**可区分**（`retried` / `attempt` / `retriedAt`），
//     且**不重复落 `compose_submitted`**（产出成本只在用户提交那一刻记一次）；
//   · **重开页面后待补条目仍在**（它是事件流，不是内存队列）；
//   · 存储写满时停止重试轮转（再写也只是继续失败，而"写不进去"这件事有自己的档位）。
//
// ⚠️ 每条用例结尾都 `withCleanup(t, …)` 拆掉定时器：`mount()` 一进来就会"接管上次欠账"，
// 于是即使这条用例不关心重试，也可能挂着一个 10 秒的定时器，而 `node --test` 会等事件循环
// 空掉才退出（Task 9B 实测：不清的话整个文件从 0.1 秒变成 130 秒）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, reachComposing, submitCompose, settleFeedback } from './helpers/mount-harness.mjs';
import { btn, byTag, text } from './helpers/dom.mjs';

/** 这一份夹具用完之后，把它挂的定时器清掉（理由见文件头）。 */
const withCleanup = (t, h) => { t.after(() => h.dispose()); return h; };

/** 一条待补的判定结果（`submitSentence` 的 pending 形状，全字段）。 */
const pendingResult = (over = {}) => ({
  status: 'pending',
  reason: 'timeout',
  error: 'timeout',
  detail: '等太久了',
  sentence: 'I use a cup.',
  word: 'mug',
  scene: 'kitchen',
  ...over,
});

/** 一条"补交成功"的判定结果。 */
const okResult = (over = {}) => ({
  status: 'ok',
  uncertain: false,
  sentence: 'I use a cup.',
  word: 'mug',
  scene: 'kitchen',
  feedback: { verdict: 'flawed', error_type: 'word_choice', note: '用词不准', rewrite: 'I use a mug.' },
  ...over,
});

/**
 * 造一个可控的假定时器 + 假时钟。
 *
 * 为什么两者必须成对（Task 9B 实测踩到）：调度逻辑读的是**注入的时钟**，而等待时长由
 * 定时器承载。若测试只推定时器、不推时钟，"下一次该等多久"就会算出 0，于是
 * **回调里再排一个 0ms 回调 → 无限自旋**（首版就是这么把整轮测试挂到超时的）。
 * 这里把 `now` 与定时器绑在一起：`advanceToNext()` 先走到定时器的排定时刻再把回调跑掉，
 * 跑的过程中新排的定时器若也已到点也会被跑到（有限步内收敛：每次重试都推时刻，上限 3 次）。
 */
function fakeTimers(startAt = 1_000_000) {
  let seq = 0;
  let now = startAt;
  const scheduled = [];
  const clock = () => now;
  const setTimeoutImpl = (fn, ms) => {
    seq += 1;
    const t = { id: seq, fn, ms, at: now + Math.max(0, ms), cancelled: false, ran: false };
    scheduled.push(t);
    return t;
  };
  const clearTimeoutImpl = (t) => { if (t) t.cancelled = true; };
  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    clock,
    scheduled,
    /** 下一个还没跑、没被取消的定时器。 */
    firstPending: () => scheduled.find((t) => !t.ran && !t.cancelled) ?? null,
    /** 走到下一个定时器的排定时刻，把到点的回调跑掉。 */
    async advanceToNext() {
      const t = scheduled.find((x) => !x.ran && !x.cancelled);
      if (!t) throw new Error('当前没有挂着任何定时器');
      now = Math.max(now, t.at);
      for (let guard = 0; guard < 50; guard += 1) {
        const due = scheduled.find((x) => !x.ran && !x.cancelled && x.at <= now);
        if (!due) return t;
        due.ran = true;
        await due.fn();
      }
      throw new Error('定时器推进没有收敛（超过 50 步）——调度逻辑可能出现自旋');
    },
    pendingCount: () => scheduled.filter((t) => !t.ran && !t.cancelled).length,
  };
}

/** 一次会话：识物取到 mug → 跳过跟读 → 造句提交。返回夹具。 */
async function composeOnce(over = {}) {
  const h = await reachComposing(over);
  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);
  return h;
}

/** 三次自动重试全部跑完（每次都等结论落地）。 */
async function runAllAutoRetries(timer, h) {
  for (let i = 0; i < 3; i += 1) {
    await timer.advanceToNext();
    try {
      await settleFeedback(h, 50);
    } catch {
      // 自动重试发生在"用户还看着反馈屏"的时候，界面本来就不会动——这是预期之内的。
    }
  }
}

/** 一条上一次会话留下的待补事件（重开页面的现场）。 */
const priorPending = (over = {}) => ({
  ts: 900_000,
  type: 'feedback_pending',
  wordId: null,
  roundIndex: 1,
  sessionId: 's-old',
  payload: {
    sentence: 'She go to school yesterday.',
    word: 'book',
    scene: 'desk',
    reason: 'request_failed',
    error: 'request_failed',
    detail: '断网',
    pendingId: 'p_s-old_900000',
  },
  ...over,
});

// ─────────────────────────── 落一条待补 + 自动重试 ───────────────────────────

test('提交失败 → 落一条 feedback_pending，并带 pendingId（队列靠它认这条）', async (t) => {
  const h = withCleanup(t, await composeOnce({ compose: { submitSentence: async () => pendingResult() } }));
  const pendings = h.events.filter((e) => e.type === 'feedback_pending');
  assert.equal(pendings.length, 1, '失败就是一条待补条目');
  assert.equal(pendings[0].payload.sentence, 'I use a cup.', '原句在事件里（它就是队列的载体）');
  assert.match(String(pendings[0].payload.pendingId), /^p_.+_\d+$/,
    '待补条目要有 id（由 sessionId + ts 派生）：补交成功后靠它把这条勾掉');
});

test('未到 10s 之前不自动重试（不是失败后立刻连发三次）', async (t) => {
  let calls = 0;
  const h = withCleanup(t, await composeOnce({
    compose: { submitSentence: async () => { calls += 1; return pendingResult(); } },
  }));
  assert.equal(calls, 1, '第一次是用户提交那一次');
  assert.equal(h.events.filter((e) => e.type === 'feedback_pending').length, 1,
    '没到点之前不许有任何补交动作');
});

test('10s 到点 → 自动补交一次；补交成功落带标记的判定事件', async (t) => {
  const timer = fakeTimers();
  let calls = 0;
  const h = withCleanup(t, await composeOnce({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    compose: {
      submitSentence: async () => {
        calls += 1;
        return calls === 1 ? pendingResult() : okResult();
      },
    },
  }));
  assert.equal(timer.pendingCount(), 1, '失败后必须挂上一个定时器（否则永远不会有自动重试）');
  assert.equal(timer.scheduled[0].ms, 10_000, '第一次自动重试的等待就是设计 §5.1 的 10s');
  assert.equal(calls, 1, '到点之前不重试——这一步同时证明"挂上定时器"不是"立刻重试"');

  await timer.advanceToNext();
  await settleFeedback(h);

  assert.equal(calls, 2, '到点应当真的又发了一次请求');
  const ok = h.events.filter((e) => e.type === 'feedback_ok');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].payload.retried, true, '补交拿到的判定必须与"当时拿到的"可区分');
  assert.equal(ok[0].payload.attempt, 1, '第 1 次自动重试');
  assert.equal(typeof ok[0].payload.retriedAt, 'number');
  assert.equal(h.events.filter((e) => e.type === 'feedback_pending').length, 1, '补上了就不再是待补');
});

test('补交**不重复落** compose_submitted（产出成本只在用户提交那一刻记一次）', async (t) => {
  const timer = fakeTimers();
  let calls = 0;
  const h = withCleanup(t, await composeOnce({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    compose: {
      submitSentence: async () => {
        calls += 1;
        return calls === 1 ? pendingResult() : okResult({ feedback: { verdict: 'correct', error_type: 'none', note: '好', rewrite: null } });
      },
    },
  }));
  await timer.advanceToNext();
  await settleFeedback(h);

  assert.equal(h.events.filter((e) => e.type === 'compose_submitted').length, 1,
    '补交不是一次新的产出：再落一条就等于把"成人愿为造句付多少成本"这个分母记大了');
});

test('三次重试的间隔依次是 10s / 30s / 90s（用注入的时钟逐次驱动）', async (t) => {
  const timer = fakeTimers();
  const h = withCleanup(t, await composeOnce({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    compose: { submitSentence: async () => pendingResult() },
  }));
  const waits = [];
  for (let i = 0; i < 3; i += 1) {
    const pendingTimer = timer.firstPending();
    assert.ok(pendingTimer, `第 ${i + 1} 次重试之前应当挂着一个定时器`);
    waits.push(pendingTimer.ms);
    await timer.advanceToNext();
    try { await settleFeedback(h, 50); } catch { /* 重试时界面不动，预期之内 */ }
  }
  assert.deepEqual(waits, [10_000, 30_000, 90_000], '三次重试的间隔就是设计 §5.1 的首轮设定值');
  assert.equal(h.events.filter((e) => e.type === 'feedback_pending').length, 4,
    '第一次 + 三次重试各落一条失败（同一条待补条目）');
  assert.equal(timer.pendingCount(), 0, '三次用完就不再自动重试（仍失败 → 交给手动补交）');
});

// ─────────────────────────── 界面入口与手动补交 ───────────────────────────

test('自动重试用完仍失败 → 出现「待补反馈」入口（**数的是句子，不是重试记录**）', async (t) => {
  const timer = fakeTimers();
  const h = withCleanup(t, await composeOnce({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    compose: { submitSentence: async () => pendingResult() },
  }));
  await runAllAutoRetries(timer, h);

  // 此刻还在 feedback 那一屏——入口必须**每屏都挂着**（自动重试失败可能发生在任意一屏）。
  const entry = btn(h.root, '待补反馈');
  assert.ok(entry, '仍失败之后，界面上必须有「待补反馈」入口（§5.1 明文要求）');
  assert.match(entry.textContent, /（1 条）/, '一条欠账重试失败 3 次仍只算**一条**（数句子，不数重试记录）');

  await entry.click();
  assert.match(text(h.root), /I use a cup\./, '原句在待补界面上逐字可见（原句永不丢弃）');
  assert.match(text(h.root), /已自动重试 3 次/, '把"已经自动试过几次"如实摊给用户');
  assert.ok(btn(h.root, '手动补交'), '要有手动补交的按钮');
});

test('**首页**（ready）同样有入口：重开页面的人第一眼就能看到还欠着什么', async (t) => {
  const timer = fakeTimers();
  const h = withCleanup(t, await harness({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    priorEvents: [priorPending()],
  }));
  assert.equal(h.machine.state, 'ready', '这条用例要看的就是首页');
  const entry = btn(h.root, '待补反馈');
  assert.ok(entry, '首页要有「待补反馈」入口');
  assert.match(entry.textContent, /（1 条）/);
  await entry.click();
  assert.match(text(h.root), /She go to school yesterday\./);
  assert.ok(btn(h.root, '返回'), '待补那一屏要有回原来那一屏的路');
  await btn(h.root, '返回').click();
  assert.ok(btn(h.root, '拍照'), '返回之后首页照旧可用');
});

test('入口长出来的时候队列里已经有内容了（点进去就是那句话，不是空列表）', async (t) => {
  // 钉一个真实的时序陷阱：入口按钮是在 `viewFor` 的**最后**挂上去的，而它算条数用的
  // 那份队列是在**开头**算的（`viewFor` 每次调用都重新算，所以两处一致）。
  // 若实现改成"算一次、后面复用"，就会出现"按钮说有 1 条、点进去却什么都没有"
  // ——一个很显眼、但很容易在重构里被引入的缺陷。
  const timer = fakeTimers();
  const h = withCleanup(t, await harness({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    priorEvents: [priorPending()],
  }));
  await btn(h.root, '待补反馈').click();
  assert.match(text(h.root), /She go to school yesterday\./, '点进去就该看到原句（不是空列表）');
  assert.equal(btn(h.root, '手动补交').disabled, false, '有待补时补交按钮必须可点');
});

test('手动补交：立即发一次（不受自动重试的时刻与次数限制）', async (t) => {
  const timer = fakeTimers();
  let calls = 0;
  const h = withCleanup(t, await composeOnce({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    compose: {
      submitSentence: async () => {
        calls += 1;
        return calls <= 4 ? pendingResult() : okResult({ feedback: { verdict: 'flawed', error_type: 'grammar', note: '语法问题', rewrite: 'I used a cup.' } });
      },
    },
  }));
  await runAllAutoRetries(timer, h);
  assert.equal(calls, 4, '三次自动重试都发出去了');

  await btn(h.root, '待补反馈').click();
  await btn(h.root, '手动补交').click();
  await settleFeedback(h);

  assert.equal(calls, 5, '手动补交就是要再发一次（此时自动次数已用完）');
  const ok = h.events.filter((e) => e.type === 'feedback_ok');
  assert.equal(ok.length, 1, '补交成功');
  assert.equal(ok[0].payload.retried, true);
  assert.equal(ok[0].payload.attempt, 4, '第 3 次自动重试之后的一次手动补交');
  assert.match(text(h.root), /已补交/, '补上之后界面要如实说明这条已经补上了');
  assert.equal(btn(h.root, '手动补交').disabled, true, '没有待补的了，按钮就该禁用（而不是点了没反应）');
});

test('手动补交时**原句原样再发一次**（不是另写一条网络路径、也不改上下文）', async (t) => {
  const timer = fakeTimers();
  const seen = [];
  const h = withCleanup(t, await composeOnce({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    compose: {
      submitSentence: async (input) => {
        seen.push(input);
        return pendingResult({ sentence: input.sentence });
      },
    },
  }));
  await timer.advanceToNext();
  try { await settleFeedback(h, 50); } catch { /* 预期 */ }

  assert.equal(seen.length, 2);
  assert.equal(seen[1].sentence, 'I use a cup.', '补交要把**原来那句话**原样再发一次');
  assert.equal(seen[1].word, 'mug', '目标词与场景同样原样带上（判定离不开上下文）');
  assert.equal(seen[1].scene, 'kitchen');
});

// ─────────────────────────── 重开页面：队列不许消失 ───────────────────────────

test('**重开页面后待补条目仍在**（它是事件流，不是内存队列）', async (t) => {
  // 第二次 mount 的 store 只带"上次留下的那一条事件"——没有队列、没有内存标志。
  const timer = fakeTimers();
  const h = withCleanup(t, await harness({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    priorEvents: [priorPending()],
  }));
  const entry = btn(h.root, '待补反馈');
  assert.ok(entry, '重开页面后仍要有入口（数据在事件流里，不随页面消失）');
  await entry.click();
  assert.match(text(h.root), /She go to school yesterday\./, '原句必须还在');
});

test('已补交的条目留在界面上（显示"已补交"），不会从列表里消失', async (t) => {
  const timer = fakeTimers();
  const h = withCleanup(t, await harness({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    priorEvents: [
      priorPending({ payload: { ...priorPending().payload, sentence: '旧句子 one.', pendingId: 'p_old_1' } }),
      {
        ts: 950_000,
        type: 'feedback_ok',
        wordId: null,
        roundIndex: 1,
        sessionId: 's-old',
        payload: {
          sentence: '旧句子 one.', word: 'book', scene: 'desk', verdict: 'correct',
          retried: true, attempt: 1, retriedPendingId: 'p_old_1', retriedAt: 950_000,
        },
      },
      priorPending({ ts: 960_000, payload: { ...priorPending().payload, sentence: '旧句子 two.', pendingId: 'p_old_2' } }),
    ],
  }));
  const entry = btn(h.root, '待补反馈');
  assert.match(entry.textContent, /（1 条）/, '入口只数**还没补上**的（补过的不再催）');
  await entry.click();
  const shown = text(h.root);
  assert.match(shown, /旧句子 one\./, '补过的那条也留在界面上（原句始终可见）');
  assert.match(shown, /旧句子 two\./);
  assert.match(shown, /已补交/, '要如实标出哪条补过了');
});

test('重开页面后的**自动**补交也不落 compose_submitted（补交永远不是一次新的产出）', async (t) => {
  // 现场：上一次会话留下一句话没拿到判定，而 `compose_submitted` **已经**记过产出成本了。
  const timer = fakeTimers();
  let calls = 0;
  const h = withCleanup(t, await harness({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    priorEvents: [
      {
        ts: 899_000,
        type: 'compose_submitted',
        wordId: null,
        roundIndex: 1,
        sessionId: 's-old',
        payload: { sentence: '旧句子.', word: 'book', scene: 'desk', submitCount: 1, revisions: 0, dwellMs: 1000, skippedReading: true },
      },
      priorPending({ payload: { ...priorPending().payload, sentence: '旧句子.' } }),
    ],
    compose: {
      submitSentence: async () => {
        calls += 1;
        return okResult({ sentence: '旧句子.', word: 'book', scene: 'desk', feedback: { verdict: 'correct', error_type: 'none', note: '好', rewrite: null } });
      },
    },
  }));
  await timer.advanceToNext();
  await settleFeedback(h);

  assert.equal(calls, 1, '重开页面后自动补交给了它一次机会');
  assert.equal(h.events.filter((e) => e.type === 'compose_submitted').length, 1,
    '整段历史里仍然只有那**一条** compose_submitted（补交再记一条就把产出成本的分母记大了）');
  const ok = h.events.filter((e) => e.type === 'feedback_ok');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].payload.retriedPendingId, 'p_s-old_900000',
    '补交的判定要指回上一次会话留下的那条欠账');
});

test('两条不同的欠账各算一条、分别显示（去重只去掉**重试记录**，不是把句子合并）', async (t) => {
  const timer = fakeTimers();
  const h = withCleanup(t, await harness({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    priorEvents: [
      priorPending({ ts: 900_000, payload: { ...priorPending().payload, sentence: '第一句.', pendingId: 'p_a' } }),
      // 同一条欠账的两次重试记录（同 id）：**不许**被数成另外两条
      priorPending({ ts: 910_000, payload: { ...priorPending().payload, sentence: '第一句.', pendingId: 'p_a', retried: true, attempt: 1 } }),
      priorPending({ ts: 920_000, payload: { ...priorPending().payload, sentence: '第一句.', pendingId: 'p_a', retried: true, attempt: 2 } }),
      priorPending({ ts: 930_000, payload: { ...priorPending().payload, sentence: '第二句.', pendingId: 'p_b' } }),
    ],
  }));
  const entry = btn(h.root, '待补反馈');
  assert.match(entry.textContent, /（2 条）/, '两条欠账 → 2 条（三条重试记录仍只算一条）');
  await entry.click();
  const shown = text(h.root);
  assert.match(shown, /第一句\./);
  assert.match(shown, /第二句\./);
  assert.equal((shown.match(/第一句\./g) ?? []).length, 1, '同一条欠账的句子只铺一次（重试次数写在下面那句里）');
  assert.match(shown, /已自动重试 2 次/);
});

// ─────────────────────────── 存储写满 ───────────────────────────

test('存储写满时不再排重试：**欠账已经存在**也不再继续重试', async (t) => {
  // 现场（这才是真实的那一种）：先有一次"提交失败"记下了待补条目，然后存储满了。
  // 关键点是**待补条目在存储满之前就已经在事件流里**——如果存储满这件事不挡住调度，
  // 那条欠账会被无限重试下去（每次都写不进去），而"写不进去"有自己的档位。
  const timer = fakeTimers();
  const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  let calls = 0;
  const h = withCleanup(t, await composeOnce({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    failAppendAfter: 3,          // 前三条（recognize_ok / speech_unsupported / compose_submitted）写得进
    appendError: quota,
    compose: {
      submitSentence: async () => {
        calls += 1;
        return calls === 1 ? pendingResult() : pendingResult();   // 补交也失败
      },
    },
  }));
  // 走到这里：`feedback_pending` 那条**没写进去**，store 已被标记为满。
  assert.equal(h.store.isFull(), true, '配额异常被 store 认出来（界面据此停止派发新任务）');
  assert.equal(h.events.filter((e) => e.type === 'feedback_pending').length, 0,
    '记录里确实没有这条欠账（写不进去）——所以下面那条断言查的是"调度有没有被挡住"');
  assert.equal(timer.pendingCount(), 0,
    '存储写满时不该再排重试（真实场景里欠账已在事件流中，挡住调度的就是这一处判断）');
  assert.equal(calls, 1, '存储满之后不该再发任何补交请求');
});

test('存储写满时，**已经躺在事件流里的**欠账也不再排自动重试（守卫的真正现场）', async (t) => {
  const timer = fakeTimers();
  const h = withCleanup(t, await harness({
    clock: timer.clock,
    setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl,
    // 欠账的失败时刻取"10 秒前" → 第一次重试正好落在现在（延迟 0），
    // 这样"没被守卫挡住时**一定**会有一次重试"这件事在最紧的时序上也成立。
    priorEvents: [priorPending({ ts: timer.now - 10_000 })],
    compose: { submitSentence: async () => pendingResult() },
  }));
  assert.equal(timer.pendingCount(), 1, '对照：存储没满时这条欠账会被排上重试（此刻就到点）');

  // 让存储变满（等价于：某一次写入撞上了配额上限），然后要求系统**重新评估**要不要重试。
  //
  // 顺序很要紧：先 `dispose()` 把已挂的那个定时器拆掉。否则 `scheduleAutoRetry()` 会被
  // 自己的"已经挂着一个了"早退掉，于是这条用例对"存储满"这个守卫**毫无分辨力**
  // ——那正是变异体 Q7 第一次跑成 MISSED 的原因（测试放过了被删掉的守卫）。
  h.store.markStoreFull();
  h.mounted.dispose();
  assert.equal(timer.pendingCount(), 0, 'dispose 拆掉了已挂的定时器（对照点）');
  h.mounted.resumePendingRetries();
  assert.equal(timer.pendingCount(), 0,
    '欠账在事件流里、存储已满 → 不再排重试（重试只会让同一个写失败再发生一次，"写不进去"有自己的档位）');
});
