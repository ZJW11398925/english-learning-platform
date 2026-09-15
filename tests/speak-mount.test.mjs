// tests/speak-mount.test.mjs
//
// Task 9 的**跟读接线**测试：`units/speak.mjs` 的结论接进 `mount()` 之后，界面与事件对不对。
//
// 与 `tests/speak.test.mjs` 的分工：那份测判定本身（token 规则、原样保留转写），
// 这一份只测"结论有没有真的走到学习者眼前、有没有落成该落的事件"：
//   · 念对了 → `reading_done` + 进造句；
//   · 念错了 → **留在跟读这一格**（重试是同一格里的选择，不新增状态机状态），如实说"这次没听到"，
//     而且**不许**落 `reading_done`（没念对就是没念对）；
//   · 转写不可用 → 落一次 `speech_unsupported`，给「我读过了」手动打勾与「跳过跟读」，
//     **降级路径不许伪装成"读对了"**（不落 `reading_done`）。
//
// 转写是**注入**进来的（`speechWin`）：浏览器里 `mount` 默认取 `globalThis`，
// 而 Node 里没有 `SpeechRecognition` —— 于是不注入就正好是"转写不可用"那条降级路径，
// 注入假引擎就是"可用"那条路径。两条路都真跑一遍，而不是在夹具里模拟判定。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  reachReading,
  fakeRecognition,
  disposeAllHarnesses,
} from './helpers/mount-harness.mjs';

// 每条用例之后拆掉 mount 挂的定时器（待补反馈的自动重试会挂 10 秒的 setTimeout，
// 而 node --test 会等事件循环空掉才退出——不清的话每个挂载测试文件都白等 10 秒起）。
afterEach(disposeAllHarnesses);
import { btn, text } from './helpers/dom.mjs';

/** 转写可用的夹具：`{ speechWin, speech }`（`speech` 用来驱动假引擎）。 */
function withSpeech(over = {}) {
  const speech = fakeRecognition();
  return { speech, over: { ...over, speechWin: { SpeechRecognition: speech.FakeRecognition } } };
}

/** 跟读屏上那个"开始说"的按钮（标签是界面文案，改文案时这里要跟着改）。 */
const SPEAK_LABEL = '点一下，念出这个词';

/** 点一下开始说，并把引擎实例取回来（`start()` 在同一个同步段里就发生了）。 */
function startSpeaking(h, speech) {
  const clicked = btn(h.root, SPEAK_LABEL).click();
  const rec = speech.instances.at(-1);
  assert.ok(rec, '点"开始说"必须真的创建一个转写引擎实例');
  return { clicked, rec };
}

// ─────────────────────────── 转写可用：判定那条路 ───────────────────────────

test('念出目标词 → 落 reading_done（带原样转写）并推进到造句', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const { clicked, rec } = startSpeaking(h, speech);
  assert.equal(speech.calls.started, 1, '必须真的启动一次转写');
  rec.say('I see a mug.');
  await clicked;

  assert.equal(h.machine.state, 'composing', '念对了就该进入造句这一格');
  const done = h.events.filter((e) => e.type === 'reading_done');
  assert.equal(done.length, 1, '念对必须落且只落一条 reading_done');
  assert.equal(done[0].payload.word, 'mug', '事件要说清是哪个词的跟读');
  assert.equal(done[0].payload.transcript, 'I see a mug.', '转写原样进事件（它是"用户到底说了什么"的唯一证据）');
  assert.equal(done[0].payload.scene, 'kitchen');
  assert.equal(done[0].sessionId, h.sessionId);
  // 念对了就不该有"引擎不可用"那条
  assert.equal(h.events.filter((e) => e.type === 'speech_unsupported').length, 0);
});

test('念错（说成别的词）→ 留在跟读、如实说"这次没听到"，且绝不落 reading_done', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const { clicked, rec } = startSpeaking(h, speech);
  rec.say('I see a cup');
  await clicked;

  assert.equal(h.machine.state, 'reading', '没念对不许推进到造句（推进了就等于放行一次没发生的跟读）');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0, '没念对就是没念对，不许记成读完了');
  const shown = text(h.root);
  assert.match(shown, /这次没听到/, '要如实告诉用户这次没听到（而不是沉默或假装成功）');
  assert.match(shown, /mug/, '要说出没听到的是哪个词');
  assert.ok(btn(h.root, '跳过跟读'), '重试是同一格里的选择，跳过跟读这条出口必须留着');
});

// ── Task 9B：判定**没通过**要有事件（`DEC-OPI-…73` 授权的契约变更）──────────────
//
// 没有它的话，"用户念了却被判没说"的失败率在事件流里完全看不见（`reading_done` 只在
// 通过时落）——引擎听错、词表配错、口音问题全都会藏在这个盲区里。

test('念错 → 落一条 reading_missed，带目标词与**原样转写**（复核引擎有没有听错只能靠它）', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const { clicked, rec } = startSpeaking(h, speech);
  rec.say('I see a cup');
  await clicked;

  const missed = h.events.filter((e) => e.type === 'reading_missed');
  assert.equal(missed.length, 1, '判定没通过必须落**一条** reading_missed');
  assert.equal(missed[0].payload.word, 'mug', '要带目标词（不然不知道用户该念的是哪个词）');
  assert.equal(missed[0].payload.transcript, 'I see a cup', '转写逐字带上（用户到底说了什么）');
  assert.equal(missed[0].payload.scene, 'kitchen');
  assert.equal(missed[0].roundIndex, 1, '跟读属于取词那一轮（它不是一次新的快门）');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0,
    '与 reading_done **互斥**：一次跟读判定只落一条');
});

test('一次跟读判定只落一条：念对了就不会落 reading_missed（两者互斥）', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const { clicked, rec } = startSpeaking(h, speech);
  rec.say('a mug');
  await clicked;

  assert.equal(h.events.filter((e) => e.type === 'reading_missed').length, 0,
    '念对了就不是"没通过"，不许两条都落');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 1);
});

test('念错两次 → 两条 reading_missed（每一次判定都算，失败率才数得清）', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const first = startSpeaking(h, speech);
  first.rec.say('nope one');
  await first.clicked;
  const second = startSpeaking(h, speech);
  second.rec.say('nope two');
  await second.clicked;

  const missed = h.events.filter((e) => e.type === 'reading_missed');
  assert.equal(missed.length, 2, '每次判定算一条（只留最后一条的话，失败率的分母就错了）');
  assert.deepEqual(missed.map((e) => e.payload.transcript), ['nope one', 'nope two']);
});

test('转写**不可用**不算 missed：系统没判过，不许记成"用户念错了"', async () => {
  // 不注入 speechWin = Node/不支持的浏览器走降级路径（手动打勾 + speech_unsupported）。
  const h = await reachReading();
  assert.equal(h.events.filter((e) => e.type === 'speech_unsupported').length, 1);
  assert.equal(h.events.filter((e) => e.type === 'reading_missed').length, 0,
    '不可用时没判过 → 不能记 missed（否则"不支持率"会污染"判定失败率"）');
  // 手动打勾照样进造句，也不落 missed
  await btn(h.root, '我读过了').click();
  assert.equal(h.machine.state, 'composing');
  assert.equal(h.events.filter((e) => e.type === 'reading_missed').length, 0);
});

test('引擎报错 / 超时不算 missed（那两条路没有产出任何判定）', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const { rec, clicked } = startSpeaking(h, speech);
  rec.fail('no-speech');
  await clicked;

  assert.equal(h.events.filter((e) => e.type === 'reading_missed').length, 0,
    '引擎报错是"这次没能听清"，不是"用户没说出目标词"——两个失败率的真凶不同，不能混记');
  assert.match(text(h.root), /没能听清/);
});

test('跳过跟读不算 missed（那是用户的选择，另一档 skipped_reading）', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);
  await btn(h.root, '跳过跟读').click();

  assert.equal(h.machine.state, 'composing');
  assert.equal(h.events.filter((e) => e.type === 'reading_missed').length, 0,
    '跳过跟读没有产生任何判定，不该被记成"念错"');
  assert.equal(h.events.filter((e) => e.type === 'skipped_reading').length, 0,
    '跳过跟读本来就不另开事件（Task 9 的裁决：它随 compose_submitted.payload.skippedReading 落盘）');
});

test('念错之后可以重试：第二次念对了照常前进（重试不新增状态机状态）', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const first = startSpeaking(h, speech);
  first.rec.say('I see a cup');
  await first.clicked;

  const second = startSpeaking(h, speech);
  assert.notEqual(second.rec, first.rec, '重试要开一次新的转写，不能复用上一次那个引擎实例');
  second.rec.say('a mug');
  await second.clicked;

  assert.equal(h.machine.state, 'composing');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 1, '只有真的念对那一次才落 reading_done');
});

test('空转写（引擎没听清任何东西）→ 算没说出，留在跟读', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const { clicked, rec } = startSpeaking(h, speech);
  rec.say('');
  await clicked;

  assert.equal(h.machine.state, 'reading');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0);
  assert.match(text(h.root), /这次没听到/);
});

test('转写引擎报错（no-speech 等）→ 如实说没听清、留在跟读、可重试', async () => {
  const { speech, over } = withSpeech();
  const h = await reachReading(over);

  const { clicked, rec } = startSpeaking(h, speech);
  rec.fail('no-speech');
  await clicked;

  assert.equal(h.machine.state, 'reading');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0, '引擎报错不等于念对了');
  const shown = text(h.root);
  assert.match(shown, /没能听清|没听清/, '要如实说这次没听清（不是"没听到你说的词"那种判定）');
  assert.match(shown, /no-speech/, '把引擎给的错误码摊出来（诊断要靠它区分"没说话"与"没权限"）');
  assert.ok(btn(h.root, SPEAK_LABEL), '重试按钮必须还在');
});

test('引擎不回调（onend 永不来）→ 到上限就收口并释放麦克风，不永远停在"正在听"', async () => {
  // 本项目的反复教训：**挂住而不是失败**是最坏的一种收口（fetch 无超时、上游半开都吃过）。
  // 转写这条腿若引擎不回调，界面会永远停在"正在听…"且按钮一直是禁用的。
  const { speech, over } = withSpeech({ speechTimeoutMs: 30 });
  const h = await reachReading(over);

  const { clicked, rec } = startSpeaking(h, speech);
  // 什么都不回调（`say` / `fail` 都不调），等上限到点
  await new Promise((r) => setTimeout(r, 120));
  await clicked;

  assert.equal(h.machine.state, 'reading');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0);
  assert.match(text(h.root), /没能听清|没听清|超时/, '到上限要如实说这次没成，而不是继续转圈');
  assert.ok(btn(h.root, SPEAK_LABEL), '收口之后按钮要恢复可点（否则只剩跳过这一条路）');
  assert.equal(speech.calls.aborted + speech.calls.stopped > 0, true,
    '收口时必须主动放掉麦克风（abort/stop），不能让它一直开着');
});

test('念对时才用注入的引擎：注入点没被忽略（真代码不去读浏览器全局）', async () => {
  // 反向证据：把一个**会抛错的**全局 SpeechRecognition 挂上去。若 mount 忽略注入点、
  // 直接读 globalThis，这条用例会以"构造器抛错"的形式红；注入点被用到时它一次都不会被碰。
  const boom = function Boom() { throw new Error('不许碰全局的 SpeechRecognition'); };
  const original = globalThis.SpeechRecognition;
  globalThis.SpeechRecognition = boom;
  try {
    const { speech, over } = withSpeech();
    const h = await reachReading(over);
    const { clicked, rec } = startSpeaking(h, speech);
    rec.say('mug');
    await clicked;
    assert.equal(h.machine.state, 'composing');
  } finally {
    if (original === undefined) delete globalThis.SpeechRecognition;
    else globalThis.SpeechRecognition = original;
  }
});

// ─────────────────────── 转写不可用：降级那条路 ───────────────────────

test('转写不可用 → 落一次 speech_unsupported，给手动打勾与跳过，且不假装判定了', async () => {
  const h = await reachReading();            // 不注入 speechWin：Node 里没有转写引擎

  const unsupported = h.events.filter((e) => e.type === 'speech_unsupported');
  assert.equal(unsupported.length, 1, '进入跟读这一格时如实落一条（不能只在界面说，数据里也要有）');
  assert.equal(unsupported[0].payload.word, 'mug');
  assert.equal(unsupported[0].sessionId, h.sessionId);
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0, '没判定过就不许有判定结果的事件');

  const shown = text(h.root);
  assert.match(shown, /不支持|没法自动判断|无法判断/, '要明说这个浏览器判断不了');
  assert.match(shown, /speech_unsupported/, '把降级标签摊给用户（真机走查要能一眼看到）');
  assert.ok(btn(h.root, '我读过了'), '降级路径要给手动打勾');
  assert.ok(btn(h.root, '跳过跟读'));
  assert.equal(btn(h.root, SPEAK_LABEL), undefined, '不该给一个按下去必然失败的"开始说"按钮');
});

test('降级路径手动打勾：进造句，但**不落 reading_done**（打勾不是判定）', async () => {
  const h = await reachReading();
  await btn(h.root, '我读过了').click();

  assert.equal(h.machine.state, 'composing');
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0,
    '手动打勾只表示"我读了"，不是"系统听到我说出了目标词"——混记会让跟读判定的通过率变成假的');
  assert.equal(h.events.filter((e) => e.type === 'speech_unsupported').length, 1, '降级标签仍是一条，不重复记');
});

test('降级路径跳过跟读：进造句，skippedReading 为真，且不为跳过单开事件', async () => {
  const h = await reachReading();
  await btn(h.root, '跳过跟读').click();

  assert.equal(h.machine.state, 'composing');
  assert.equal(h.machine.snapshot().skippedReading, true, '状态机已经记了（完成页也要显示它）');
  assert.equal(h.events.filter((e) => e.type === 'skipped_reading').length, 0,
    '别重复记：跳过这件事由快照与 compose_submitted.payload.skippedReading 承载（brief §3.2 的裁决）');
});

test('转写可用时跳过跟读照样可用（判定那条路不是单行道）', async () => {
  const { over } = withSpeech();
  const h = await reachReading(over);
  await btn(h.root, '跳过跟读').click();
  assert.equal(h.machine.state, 'composing');
  assert.equal(h.machine.snapshot().skippedReading, true);
  assert.equal(h.events.filter((e) => e.type === 'reading_done').length, 0);
});

test('拍照 → 跟读这条链上，跟读事件带得回取词那一轮的轮次号', async () => {
  // 跟读不是新的快门（与 Task 8 给反馈事件定的口径同一条）：它属于取词那一轮。
  // 少了轮次号，这些事件在事件流里就是"孤儿"——判据 B 按 roundIndex 分组时会被漏掉。
  const { speech, over } = withSpeech();
  const h = await reachReading(over);
  const { clicked, rec } = startSpeaking(h, speech);
  rec.say('mug');
  await clicked;
  assert.equal(h.events.find((e) => e.type === 'reading_done').roundIndex, 1);
});

test('转写不可用的降级事件同样带轮次号（两类跟读事件一个口径）', async () => {
  const h = await reachReading();
  assert.equal(h.events.find((e) => e.type === 'speech_unsupported').roundIndex, 1);
});

test('进跟读这一格只落一条 speech_unsupported（按"进入这一格"记，不按渲染记）', async () => {
  // 界面渲染会被调用很多次。降级标签若挂在"渲染时"记，一条会话里会刷出好几条，
  // 于是"多少人的浏览器不支持转写"这个数直接失真。
  // 如实记：这一条只能证明**当前这条路径**上恰好一条（转写不可用那一格不会重绘，
  // 所以没有"渲染两次"的现场可造；见 task-9-report 的弱断言清单）。
  const h = await reachReading();
  const types = h.events.map((e) => e.type);
  assert.equal(h.events.filter((e) => e.type === 'speech_unsupported').length, 1);
  assert.deepEqual(types, ['recognize_ok', 'speech_unsupported'],
    `这一格的事件应恰好是取词 + 降级标签两条，实测 ${types.join('/')}`);
});
