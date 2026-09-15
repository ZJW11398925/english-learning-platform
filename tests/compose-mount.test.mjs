// tests/compose-mount.test.mjs
//
// Task 8 的装配接线测试：`units/compose.mjs` 的结论接进 `mount()` 之后，**界面与事件**对不对。
//
// 与 `tests/compose.test.mjs` 的分工：那份测链路本身（分档、原句保留、事件映射），
// 这一份只测"结论有没有真的走到学习者眼前与事件流里"。控制器 A1 的要求正是这件事：
// `uncertain` 必须**端到端**活着——它得进界面（如实显示"拿不准"，不伪装成判定），
// 也得进事件流（单独一条 `uncertain`，不混进 `feedback_ok`，否则通过率被它污染）。
//
// 注入方式：`mount({ compose: { submitSentence } })`。假提交器让本文件不碰网络，
// 于是"界面与事件对不对"与"网络路径对不对"两件事各自可测（后者在 compose.test.mjs
// 与 feedback-endpoint.test.mjs 里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reachComposing as reachComposingShared } from './helpers/mount-harness.mjs';
import { btn, byTag, text } from './helpers/dom.mjs';
import { FEEDBACK_FAIL_REASONS, feedbackEventFor } from '../web/units/compose.mjs';

/** 一次合法的模型反馈（flawed）。 */
const FLAWED = { verdict: 'flawed', error_type: 'word_choice', rewrite: 'I use a mug.', note: '词选得更准' };

/**
 * 走完整条闭环，停在 composing：拍照 → 快门 → 我会读了 → **我读过了**。
 *
 * Task 9 起跟读那一格有两副样子（转写可用 → 判定；不可用 → 手动打勾），
 * 而这里注入的世界里没有转写引擎，所以走的是**手动打勾**那条路（`skipReading: false`，
 * 为的是让 `skippedReading` 保持 false——本文件的用例不测跳过跟读）。
 * 路径本身与夹具同源（`tests/helpers/mount-harness.mjs`），免得两份夹具各自漂移。
 */
async function reachComposing(over = {}) {
  return reachComposingShared(over, { skipReading: false });
}

/** 在 composing 里写下 `sentence` 并提交（返回 click 的 Promise）。 */
async function submitSentence(h, sentence) {
  const box = byTag(h.root, 'TEXTAREA')[0];
  assert.ok(box, 'composing 态必须有输入框');
  box.value = sentence;
  return btn(h.root, '提交造句').click();
}

/** 只等结论落到界面（超时即响亮失败）。 */
async function settle(h, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!text(h.root).includes('正在看你这句')) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('等到超时：反馈结论没有落到界面（界面一直停在"正在看你这句…"）');
}

/**
 * 提交并等到**结论落到界面**（或超时）。
 *
 * 为什么要等：`onSubmit` 是同步的（状态当场推进到 feedback），而拿反馈是**异步**的
 * （`submitForFeedback` 里的 await）。所以 click 回调 resolve 时界面还停在"正在看你这句…"。
 * 不用固定 sleep：那会让测试变成"睡够久就过"；这里轮询到界面真的变了为止。
 */
async function submitAndSettle(h, sentence, timeoutMs = 1000) {
  await submitSentence(h, sentence);
  await settle(h, timeoutMs);
}

/**
 * 一个"照实返回"的假提交器：把 `result` 原样交给 `mount()`，并记下每次收到的入参。
 * **它不做任何加工**——加工是被测的那段代码的事，夹具替它做就等于把被测行为搬进了夹具。
 *
 * 返回的是 `mount({ compose })` 要的那个形状（`{ submitSentence }`），
 * `calls` 挂在返回对象上供断言。
 */
function fakeCompose(result) {
  const calls = [];
  const submitSentence = async (input) => {
    calls.push(input);
    return typeof result === 'function' ? result(input) : result;
  };
  return { submitSentence, calls };
}

const okResult = (feedback, over = {}) => ({
  status: 'ok',
  feedback,
  uncertain: feedback.verdict === 'uncertain',
  sentence: 'I use a cup.',
  word: 'mug',
  scene: 'kitchen',
  ...over,
});

// ─────────────────────────────────── 成功路径 ───────────────────────────────────

test('提交造句 → 反馈屏显示判定、错误类型、改写建议与说明', async () => {
  const compose = fakeCompose(okResult(FLAWED));
  const h = await reachComposing({ compose });
  await submitAndSettle(h, 'I use a cup.');

  assert.equal(h.machine.state, 'feedback');
  const shown = text(h.root);
  assert.match(shown, /I use a mug\./, '要给出改写建议（设计文档 §4.2 的四个字段之一）');
  assert.match(shown, /词选得更准/, 'note 是给学习者看的那句话，必须显示');
  assert.match(shown, /用词|词/, '要如实说明问题出在"用词"这一档');
});

test('提交的入参就是用户写下的原句 + 目标词与场景（一字不改）', async () => {
  const compose = fakeCompose(okResult(FLAWED));
  const h = await reachComposing({ compose });
  const said = '  I use a cup .  ';
  await submitAndSettle(h, said);
  assert.equal(compose.calls.length, 1, '一次提交 = 一次调用（不做隐式重试）');
  assert.deepEqual(compose.calls[0], { sentence: said, word: 'mug', scene: 'kitchen' });
});

test('反馈屏也把**原句**摊出来：用户要能对着自己的句子看反馈', async () => {
  const compose = fakeCompose(okResult(FLAWED, { sentence: 'I use a cup.' }));
  const h = await reachComposing({ compose });
  await submitAndSettle(h, 'I use a cup.');
  assert.match(text(h.root), /I use a cup\./, '原句要在反馈屏上（否则"哪里错了"无从对照）');
});

// ───────────────────────────── A1：uncertain 端到端活着 ─────────────────────────────

test('uncertain：界面如实说"拿不准"，并显示改写建议（不伪装成判定）', async () => {
  const compose = fakeCompose(okResult(
    { verdict: 'uncertain', error_type: 'none', rewrite: 'The mug is on my desk.', note: '这句我拿不准' },
    { sentence: 'The mug it is on desk maybe.' },
  ));
  const h = await reachComposing({ compose });
  await submitAndSettle(h, 'The mug it is on desk maybe.');

  const shown = text(h.root);
  assert.match(shown, /拿不准/, 'uncertain 必须如实显示为"拿不准"，不许伪装成对/错');
  assert.match(shown, /The mug is on my desk\./, '§4.2：拿不准时仍要给改写建议');
  assert.doesNotMatch(shown, /这句没问题|完全正确/, '不许把拿不准说成"没问题"');
});

test('uncertain：事件流里是**单独一条** uncertain，不是 feedback_ok（通过率才不会被污染）', async () => {
  const compose = fakeCompose(okResult(
    { verdict: 'uncertain', error_type: 'none', rewrite: 'The mug is on my desk.', note: '拿不准' },
    { sentence: 'blah blah' },
  ));
  const h = await reachComposing({ compose });
  await submitAndSettle(h, 'blah blah');

  const types = h.events.map((e) => e.type);
  assert.ok(types.includes('uncertain'), `事件流里必须有 uncertain，实际：${types.join('/')}`);
  assert.equal(types.includes('feedback_ok'), false, 'uncertain 那一轮不许同时落 feedback_ok（双记会污染通过率）');
  const un = h.events.find((e) => e.type === 'uncertain');
  assert.equal(un.payload.verdict, 'uncertain');
  assert.equal(un.payload.sentence, 'blah blah', 'A4：事件里必须带原句（语料靠它）');
});

// ───────────────────────────── A2/A4：pending 与原句 ─────────────────────────────

test('pending：界面说"反馈还没拿到"、明说原句没丢，并如实报档位', async () => {
  const compose = fakeCompose({
    status: 'pending',
    reason: FEEDBACK_FAIL_REASONS.HTTP_ERROR,
    error: 'http_502',
    detail: '服务端返回 HTTP 502',
    sentence: 'I use a cup.',
    word: 'mug',
    scene: 'kitchen',
  });
  const h = await reachComposing({ compose });
  await submitAndSettle(h, 'I use a cup.');

  const shown = text(h.root);
  assert.match(shown, /I use a cup\./, 'A2/A4：失败时原句必须还在（补交全靠它）');
  assert.match(shown, /没拿到|待补|稍后|保留/, '要告诉用户这次没拿到反馈（而不是假装成功）');
  assert.doesNotMatch(shown, /完全正确|写得很好/, '没拿到反馈时不许编一个好评');

  const pending = h.events.filter((e) => e.type === 'feedback_pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.sentence, 'I use a cup.', '原句进事件流：Task 9 的持久化从这里读');
  assert.equal(pending[0].payload.reason, FEEDBACK_FAIL_REASONS.HTTP_ERROR);
  assert.equal(pending[0].payload.error, 'http_502');
  assert.equal(h.events.filter((e) => e.type === 'feedback_ok').length, 0, '失败不许同时落成功事件');
});

test('空句提交：在**发请求之前**就被拦下（不花钱），界面说清原因，仍留在造句屏', async () => {
  const compose = fakeCompose(okResult(FLAWED));
  const h = await reachComposing({ compose });
  await submitSentence(h, '   ');

  assert.equal(compose.calls.length, 0, '空句不许发起任何调用');
  assert.notEqual(h.machine.state, 'feedback', '空句不该把用户推进反馈屏（那一屏没有回去改的入口）');
  assert.match(text(h.root), /写一句|空/, '要告诉用户为什么没提交成功');
});

// ─────────────────────────────────── 忙碌态与回改 ───────────────────────────────────

test('提交中：界面明说"正在看"，不让用户对着不动的屏猜', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const compose = fakeCompose(async () => { await gate; return okResult(FLAWED); });
  const h = await reachComposing({ compose });
  const click = submitSentence(h, 'I use a cup.');
  await Promise.resolve(); // 让 click 回调跑到 await 处
  assert.match(text(h.root), /正在|稍等/, '等待期间要有明确文案（弱网下这一屏可能停十几秒）');
  release();
  await click;
  await settle(h);
  assert.equal(h.machine.state, 'feedback');
});

test('「再写一次」把上一版原句带回来，并且**反馈屏上不许有输入框**', async () => {
  const compose = fakeCompose(okResult(FLAWED));
  const h = await reachComposing({ compose });
  await submitAndSettle(h, 'I use a cup.');
  assert.equal(byTag(h.root, 'TEXTAREA').length, 0, '反馈屏是看结果的，不该还留一个可编辑的输入框');

  await btn(h.root, '再写一次').click();
  const box = byTag(h.root, 'TEXTAREA')[0];
  assert.equal(box.value, 'I use a cup.', '回改时带出上一版（别让用户重打一遍）');
});

// ──────────────────────────── 轮次标识（判据 B 的口径）────────────────────────────

test('反馈事件带 roundIndex：它属于取词那一轮（一次快门 = 一轮，不新开轮）', async () => {
  const compose = fakeCompose(okResult(FLAWED));
  const h = await reachComposing({ compose });
  await submitAndSettle(h, 'I use a cup.');
  const e = h.events.find((x) => x.type === 'feedback_ok');
  assert.equal(e.roundIndex, 1, '这一轮的 roundIndex 由取词那一轮定（feedback 不是新的快门）');
});

// ───────────────────── 与 compose.mjs 的映射函数同源（不是两套口径）─────────────────────

test('mount 落的反馈事件与 `feedbackEventFor` 的映射逐字一致（只有一处口径）', async () => {
  // 若 mount 自己另写一套 type/payload（而不是调 `feedbackEventFor`），两处迟早漂移：
  // 事件流里的字段名与 compose.test.mjs 钉住的那份就不一样了。
  for (const result of [
    okResult(FLAWED),
    okResult({ verdict: 'uncertain', error_type: 'none', rewrite: 'x', note: 'n' }),
    {
      status: 'pending',
      reason: FEEDBACK_FAIL_REASONS.TIMEOUT,
      error: 'timeout',
      detail: '超时',
      sentence: 'I use a cup.',
      word: 'mug',
      scene: 'kitchen',
    },
  ]) {
    const compose = fakeCompose(result);
    const h = await reachComposing({ compose });
    await submitAndSettle(h, 'I use a cup.');
    const expected = feedbackEventFor(result);
    const actual = h.events.filter((e) => e.type === expected.type);
    assert.equal(actual.length, 1, `应落一条 ${expected.type}`);
    for (const [k, v] of Object.entries(expected.payload)) {
      assert.deepEqual(actual[0].payload[k], v, `${expected.type} 的 payload.${k} 应与映射函数一致`);
    }
  }
});
