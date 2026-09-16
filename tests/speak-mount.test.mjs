// tests/speak-mount.test.mjs
//
// Task 12B 的**跟读接线**测试：`units/speak.mjs`（示范音）接进 `mount()` 之后，
// 界面与事件对不对。
//
// 与 `tests/speak.test.mjs` 的分工：那份测示范音单元本身（语音选择、可用性、播放收口），
// 这一份只测"接线"：
//   · 「听示范」→ 真的调了注入环境里的 speak，utterance 带目标词，播放中按钮置灰、播完恢复；
//   · 「我读过了（自评打勾）」与「跳过跟读」→ 都进造句，**都不落任何判定事件**
//     （手动打勾只是"我读了"，不是"系统听到我说出了目标词"——既有裁决原样沿用；
//     跳过由快照与 compose_submitted.payload.skippedReading 承载）；
//   · 判定路径**退役**：新流程走完一整轮，事件流里没有 reading_done / reading_missed /
//     speech_unsupported（三个类型保留在 schema 里是为了历史数据，不是新流程还会产生）；
//   · 无 speechSynthesis（Node 缺省）→ 如实提示，只剩「跳过跟读」。
//
// TTS 环境是**注入**进来的（`ttsWin`）：浏览器里 `mount` 默认取 `globalThis`，
// 而 Node 里没有 `speechSynthesis`——于是不注入就正好是"无示范音"那一档，
// 注入 `fakeTts().win` 就是"可播示范音"那条路。两条路都真跑一遍。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  reachReading,
  fakeTts,
  disposeAllHarnesses,
} from './helpers/mount-harness.mjs';

// 每条用例之后拆掉 mount 挂的定时器（待补反馈的自动重试会挂 10 秒的 setTimeout，
// 而 node --test 会等事件循环空掉才退出——不清的话每个挂载测试文件都白等 10 秒起）。
afterEach(disposeAllHarnesses);
import { btn, text, errorText } from './helpers/dom.mjs';

/** TTS 可用的夹具：`{ tts, over }`（`tts` 用来驱动假合成引擎）。 */
function withTts(over = {}) {
  const tts = fakeTts();
  return { tts, over: { ...over, ttsWin: tts.win } };
}

/** 判定事件三个类型在新流程里一个都不许再出现。 */
const VERDICT_TYPES = ['reading_done', 'reading_missed', 'speech_unsupported'];
const verdictEventsOf = (h) => h.events.filter((e) => VERDICT_TYPES.includes(e.type));

// ─────────────────────────── 示范音可用：听示范 → 自评 / 跳过 ───────────────────────────

test('跟读屏（TTS 可用）三件套：「听示范」「我读过了（自评打勾）」「跳过跟读」', async () => {
  const { over } = withTts();
  const h = await reachReading(over);

  assert.ok(btn(h.root, '听示范'));
  assert.ok(btn(h.root, '我读过了'), '自评打勾入口（按钮全文是「我读过了（自评打勾）」）');
  assert.ok(btn(h.root, '跳过跟读'));
  const shown = text(h.root);
  assert.match(shown, /听示范/, '三步流程要说清第一步');
  assert.match(shown, /自己念|自己打勾/, '自评这一步要说清是用户自己确认');
  assert.match(shown, /不判断|不判断你念得准不准|自动判定已退役/, '要如实说明系统不再判定');
});

test('「听示范」→ 真的调了 speak，utterance 带目标词与 lang，播完按钮恢复', async () => {
  const { tts, over } = withTts();
  const h = await reachReading(over);

  // 不先 await click：播放这条腿的收口在 onend（见下）——先 await 就死等了。
  const playing = btn(h.root, '听示范').click();
  assert.equal(tts.spoken.length, 1, '必须真的调了一次 speak');
  assert.equal(tts.utterances[0].text, 'mug', '合成的是目标词本身');
  assert.equal(tts.utterances[0].lang, 'en-US');
  assert.equal(verdictEventsOf(h).length, 0, '播示范音不是判定，一条事件都不落');

  // 播放中按钮置灰、文案换成"正在播放…"；onend 之后恢复可点（收口在 units/speak.mjs）。
  const busyBtn = btn(h.root, '正在播放…');
  assert.ok(busyBtn, '播放期间按钮要变成「正在播放…」');
  assert.equal(busyBtn.disabled, true, '播放期间不许重复点');
  tts.utterances[0].onend?.({});
  await playing;
  assert.ok(btn(h.root, '听示范'), '播完要恢复成「听示范」且可再点');
  assert.equal(btn(h.root, '听示范').disabled, false);
});

test('自评打勾 → 进造句，skippedReading 为否，**不落任何判定事件**', async () => {
  const { tts, over } = withTts();
  const h = await reachReading(over);
  // 先听一遍示范再打勾：完整走一遍"听示范 → 自己念 → 自评"
  const p = btn(h.root, '听示范').click();
  tts.utterances[0].onend?.({});
  await p;

  await btn(h.root, '我读过了').click();
  assert.equal(h.machine.state, 'composing');
  assert.equal(h.machine.snapshot().skippedReading, false, '自评打勾不是跳过（快照口径不变）');
  assert.deepEqual(verdictEventsOf(h), [],
    '手动打勾只是"我读了"，不是"系统听到我说出了目标词"——三个判定事件类型一个都不许落');
  assert.deepEqual(h.events.map((e) => e.type), ['recognize_ok'],
    '这一格从头到尾只该有取词那一条事件');
});

test('跳过跟读 → 进造句，skippedReading 为真，不落 skipped_reading 也不落判定事件', async () => {
  const { over } = withTts();
  const h = await reachReading(over);
  await btn(h.root, '跳过跟读').click();

  assert.equal(h.machine.state, 'composing');
  assert.equal(h.machine.snapshot().skippedReading, true, '状态机已经记了（完成页与落盘还要用它）');
  assert.equal(h.events.filter((e) => e.type === 'skipped_reading').length, 0,
    '跳过这件事由快照与 compose_submitted.payload.skippedReading 承载（既有裁决，一字不动）');
  assert.deepEqual(verdictEventsOf(h), []);
});

test('示范音播放失败（引擎报错）→ 错误区如实说明、按钮恢复，仍可自评或跳过', async () => {
  const { tts, over } = withTts();
  const h = await reachReading(over);

  const p = btn(h.root, '听示范').click();
  tts.utterances[0].onerror?.({ error: 'not-allowed' });
  await p;

  assert.match(errorText(h.root), /示范音没能播出来/, '失败要如实说，不许沉默或假装播过');
  assert.match(errorText(h.root), /not-allowed/, '引擎给的原样错误码要摊出来（诊断要用）');
  const again = btn(h.root, '听示范');
  assert.ok(again, '失败后按钮要恢复可点');
  assert.equal(again.disabled, false);
  assert.ok(btn(h.root, '我读过了'), '播放失败不影响自评与跳过这两条出口');
  assert.ok(btn(h.root, '跳过跟读'));
  assert.deepEqual(verdictEventsOf(h), [], '播放失败不是判定失败，不落任何事件');
});

test('注入点不被忽略：ttsWin 注入了就绝不去读 globalThis（Node 的 globalThis 没有 TTS）', async () => {
  // 反向证据：往 globalThis 上挂一个**会抛错的** speechSynthesis。若 mount 忽略注入点、
  // 直接读 globalThis，这条用例会以"示范音可用性为假（听示范按钮消失）"或"构造器抛错"的形式红。
  const original = globalThis.speechSynthesis;
  const originalCtor = globalThis.SpeechSynthesisUtterance;
  globalThis.speechSynthesis = { get voices() { throw new Error('不许碰全局的 speechSynthesis'); } };
  try {
    const { tts, over } = withTts();
    const h = await reachReading(over);
    const p = btn(h.root, '听示范').click();
    tts.utterances[0].onend?.({});
    await p;
    assert.equal(tts.spoken.length, 1, '用的是注入的环境');
    assert.ok(btn(h.root, '我读过了'));
  } finally {
    if (original === undefined) delete globalThis.speechSynthesis;
    else globalThis.speechSynthesis = original;
    if (originalCtor === undefined) delete globalThis.SpeechSynthesisUtterance;
    else globalThis.SpeechSynthesisUtterance = originalCtor;
  }
});

// ─────────────────────────── 判定路径退役 ───────────────────────────

test('新流程走完一整轮（示范音可用那条路）：事件流里没有任何跟读判定事件', async () => {
  const { tts, over } = withTts();
  const h = await reachReading(over);
  const p = btn(h.root, '听示范').click();
  tts.utterances[0].onend?.({});
  await p;
  await btn(h.root, '我读过了').click();
  assert.equal(h.machine.state, 'composing');
  assert.deepEqual(verdictEventsOf(h), [],
    'reading_done / reading_missed / speech_unsupported 随判定路径退役（类型还在 schema，事件不再产生）');
});

// ─────────────────────────── 无 speechSynthesis：只剩跳过 ───────────────────────────

test('无 speechSynthesis → 如实提示播不了示范音，只剩「跳过跟读」', async () => {
  const h = await reachReading();            // 不注入 ttsWin：Node 里没有 speechSynthesis

  const shown = text(h.root);
  assert.match(shown, /没有语音合成|speechSynthesis/, '要明说这个浏览器播不了示范音');
  assert.ok(btn(h.root, '跳过跟读'), '唯一的出口是跳过');
  assert.equal(btn(h.root, '我读过了'), undefined, '没有示范音就没有自评打勾（12B 转向裁决：只剩跳过）');
  assert.equal(btn(h.root, '听示范'), undefined, '不该给一个按下去必然失败的「听示范」按钮');
  assert.deepEqual(verdictEventsOf(h), [],
    '无 TTS 也不再落 speech_unsupported——那是判定时代的降级标签，判定已退役');
});

test('无 speechSynthesis 时跳过 → 进造句，skippedReading 为真，不落任何事件', async () => {
  const h = await reachReading();
  await btn(h.root, '跳过跟读').click();

  assert.equal(h.machine.state, 'composing');
  assert.equal(h.machine.snapshot().skippedReading, true);
  assert.deepEqual(h.events.map((e) => e.type), ['recognize_ok'],
    '这一格只该有取词那一条事件（连降级标签都没有了）');
});
