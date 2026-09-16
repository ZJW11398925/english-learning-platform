// tests/speak.test.mjs
//
// 跟读示范音单元（`web/units/speak.mjs`）的测试。Task 12B（转向 DEC-…23/26）把跟读这一格
// 从「SpeechRecognition 自动判定」改成「听示范 → 自己念 → 自评」——本模块的职责随之收窄成
// **一件事：把目标词用浏览器本地的 speechSynthesis 念出来**。
//
// 识别与判定（checkSpeech / isSpeechAvailable / token 规则）已随 SpeechRecognition 一并退役：
// `reading_done` / `reading_missed` / `speech_unsupported` 三个事件类型保留在 schema 里
//（历史数据要在诊断页继续渲染），但新流程不再产生它们——"有没有念出这个词"从此由
// 学习者自己确认，系统不判定。这份文件 therefore 只钉四件事：
//   1. `pickVoice`：语音选择——优先 en-US，选不到退任何英文声（en-GB / en / en_US 同类），
//      再没有就 null（界面照播，靠 u.lang='en-US' 让引擎自己挑）；
//   2. `isTtsAvailable`：可用性判定——speechSynthesis.speak 与 SpeechSynthesisUtterance
//      **都必须是函数**（调用方会 `new` 它，占位对象会把一次"点击即崩"留给用户）；
//   3. `playWord`：播放——成功/失败都要收口（不留挂住的 Promise）、空词不播、
//      失败带引擎错误码、清理不把主流程带崩；
//   4. `playWord` 的**墙钟上限**（Task 12C，12B 移交的遗留风险）：onend/onerror 谁都不来时
//      到点先 `synth.cancel()` 再拒绝——"正在播放…"绝不永久挂住（循 recognize.mjs 的
//      请求上限先例：挂住 ≠ 干净失败；时钟是注入点，测试不真等）。
//
// 与旧版同一条架构纪律：**零 import、零浏览器全局**（speechSynthesis / Utterance 全部经
// 参数注入，`mount()` 的 deps 缺省才给 globalThis），于是它能在 Node 里直接测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pickVoice, isTtsAvailable, playWord, PLAY_WORD_TIMEOUT_MS } from '../web/units/speak.mjs';

// ─────────────────────────── pickVoice：语音选择 ───────────────────────────

test('有 en-US 就选 en-US（优先级最高），且返回的就是列表里那个对象', () => {
  const enUS = { lang: 'en-US', name: 'A' };
  const enGB = { lang: 'en-GB', name: 'B' };
  assert.equal(pickVoice([enGB, enUS]), enUS, '必须选 en-US 那一个（不是第一个）');
});

test('没有 en-US 时退任何英文声：en-GB 也可以', () => {
  const enGB = { lang: 'en-GB', name: 'B' };
  assert.equal(pickVoice([{ lang: 'fr-FR' }, enGB]), enGB);
});

test('裸 lang（不带地区）也算英文声：en 与 en-US 同族', () => {
  const en = { lang: 'en' };
  assert.equal(pickVoice([{ lang: 'de-DE' }, en]), en);
});

test('下划线写法（en_US）与大小写差异（EN-us）都归一后匹配（真实平台两种都有）', () => {
  const underscore = { lang: 'en_US' };
  assert.equal(pickVoice([{ lang: 'ja-JP' }, underscore]), underscore);
  const weirdCase = { lang: 'EN-us' };
  assert.equal(pickVoice([weirdCase]), weirdCase, '首选匹配同样大小写无关');
});

test('一个英文声都没有 → null（调用方照播，靠 u.lang=en-US 让引擎自己挑，不硬塞非英文声）', () => {
  assert.equal(pickVoice([{ lang: 'fr-FR' }, { lang: 'zh-CN' }]), null);
  assert.equal(pickVoice([]), null);
});

test('坏输入不吃惊：null / undefined / 非数组 / 条目缺 lang 都安全跳过', () => {
  for (const bad of [null, undefined, 42, 'en-US', {}, () => {}]) {
    assert.equal(pickVoice(bad), null, `pickVoice(${String(bad)}) 必须是 null 而不是抛错`);
  }
  assert.equal(pickVoice([null, undefined, {}, { name: 'no lang' }, { lang: 'en-US' }])?.lang, 'en-US',
    '坏条目跳过后仍要能选到好条目');
});

// ─────────────────────────── isTtsAvailable：可用性判定 ───────────────────────────

test('speechSynthesis.speak 与 SpeechSynthesisUtterance 都是函数才算可用', () => {
  const ok = { speechSynthesis: { speak() {} }, SpeechSynthesisUtterance: function U() {} };
  assert.equal(isTtsAvailable(ok), true);
});

test('缺任何一个（或不是函数）都不可用：占位对象会把"点击即崩"留给用户', () => {
  assert.equal(isTtsAvailable({ speechSynthesis: { speak() {} } }), false, '缺 Utterance 构造器');
  assert.equal(isTtsAvailable({ SpeechSynthesisUtterance: function U() {} }), false, '缺 speechSynthesis');
  assert.equal(isTtsAvailable({ speechSynthesis: {}, SpeechSynthesisUtterance: function U() {} }), false,
    'speak 不是函数');
  assert.equal(isTtsAvailable({ speechSynthesis: { speak: 'yes' }, SpeechSynthesisUtterance: function U() {} }),
    false, 'speak 是字符串同样不算');
});

test('可用性判定不吃坏入参：undefined / null / 数字 / 字符串一律"不可用"且不抛错', () => {
  for (const bad of [undefined, null, 0, 1, 'window', true, Symbol('w')]) {
    assert.equal(isTtsAvailable(bad), false, `isTtsAvailable(${String(bad)}) 必须是 false 而不是抛错`);
  }
});

// ─────────────────────────── playWord：播放 ───────────────────────────

/** 可用的假环境：`{ win, spoken, utterances }`（`utterances` 用来驱动 onend/onerror）。 */
function fakeTts({ voices = [] } = {}) {
  const spoken = [];
  const utterances = [];
  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.lang = '';
      utterances.push(this);
    }
  }
  const win = {
    speechSynthesis: {
      getVoices: () => voices,
      speak(u) { spoken.push(u); },
    },
    SpeechSynthesisUtterance: FakeUtterance,
  };
  return { win, spoken, utterances };
}

test('播一个词：utterance 带目标词、lang=en-US，播完（onend）才收口', async () => {
  const { win, spoken, utterances } = fakeTts();
  const done = playWord('mug', { win });
  let settled = false;
  done.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(spoken.length, 1, 'playWord 必须真的调了 speak');
  assert.equal(utterances[0].text, 'mug', '合成的是目标词本身');
  assert.equal(utterances[0].lang, 'en-US');
  assert.equal(spoken[0], utterances[0], '交给 speak 的就是那个 utterance');
  await new Promise((r) => setTimeout(r, 1));   // 给微任务一次机会：onend 没回调就不许收口
  assert.equal(settled, false, 'onend 还没回调时绝不 resolve（挂住而不是失败，本项目吃过的亏）');
  utterances[0].onend?.({});
  await done;
  assert.equal(settled, true);
});

test('有英文声就设 voice 与 lang（en-US 优先；只有 en-GB 时用 en-GB 的 voice 与 lang）', async () => {
  const enUS = { lang: 'en-US', name: 'A' };
  const a = fakeTts({ voices: [{ lang: 'fr-FR' }, enUS] });
  const p = playWord('mug', { win: a.win });
  a.utterances[0].onend?.({});
  await p;
  assert.equal(a.utterances[0].voice, enUS);
  assert.equal(a.utterances[0].lang, 'en-US');

  const enGB = { lang: 'en-GB', name: 'B' };
  const b = fakeTts({ voices: [enGB] });
  const q = playWord('mug', { win: b.win });
  b.utterances[0].onend?.({});
  await q;
  assert.equal(b.utterances[0].voice, enGB);
  assert.equal(b.utterances[0].lang, 'en-GB', 'lang 跟着选中的 voice 走（引擎按它挑音色）');
});

test('没有任何英文声（或引擎没给 voices）→ 照播：voice 不设、lang 兜底 en-US', async () => {
  const { win, spoken, utterances } = fakeTts({ voices: [{ lang: 'zh-CN' }] });
  const p = playWord('mug', { win });
  utterances[0].onend?.({});
  await p;
  assert.equal(spoken.length, 1, '选不到英文声不该变成"播不了"');
  assert.equal(utterances[0].lang, 'en-US');
  assert.equal(utterances[0].voice, undefined);
});

test('引擎报错（onerror）→ 拒绝，错误消息带引擎原样错误码', async () => {
  const { win, utterances } = fakeTts();
  const done = playWord('mug', { win });
  utterances[0].onerror?.({ error: 'not-allowed' });
  await assert.rejects(() => done, /not-allowed/);
});

test('speak 当场抛错 → 拒绝（不留挂住的 Promise）', async () => {
  const { win, utterances } = fakeTts();
  win.speechSynthesis.speak = () => { throw new Error('engine boom'); };
  await assert.rejects(() => playWord('mug', { win }), /engine boom/);
  assert.equal(utterances.length, 1);
});

test('空词 / 纯空白 / 非字符串 → 拒绝且不碰引擎（不播一个空示范音）', async () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    const { win, spoken } = fakeTts();
    // 不用 await assert.rejects 直接等：它若变成"永不收口"（挂住而不是失败），
    // 这条测试就得跟着挂死。用有限等待把"挂住"变成一种**可断言的失败**。
    const outcome = await Promise.race([
      playWord(bad, { win }).then(
        () => 'resolved',
        (err) => ({ rejected: String(err?.message ?? err) }),
      ),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
    ]);
    assert.notEqual(outcome, 'hung', `playWord(${String(bad)}) 必须当场收口（挂住是最坏的收口）`);
    assert.equal(typeof outcome, 'object', `playWord(${String(bad)}) 必须是拒绝，不是照常 resolve`);
    assert.match(outcome.rejected, /词/);
    assert.equal(spoken.length, 0, `playWord(${String(bad)}) 不许调 speak`);
  }
});

test('没有 speechSynthesis / 没有 Utterance 构造器 → 拒绝（rejected promise，不是同步抛错）', async () => {
  await assert.rejects(() => playWord('mug', { win: {} }));
  await assert.rejects(() => playWord('mug', { win: { speechSynthesis: { speak() {} } } }),
    undefined, '缺 Utterance 构造器同样播不了');
  await assert.rejects(() => playWord('mug', { win: null }));
});

test('Utterance 构造器自己抛错 → 拒绝', async () => {
  const { win } = fakeTts();
  win.SpeechSynthesisUtterance = function Boom() { throw new Error('ctor boom'); };
  await assert.rejects(() => playWord('mug', { win }), /ctor boom/);
});

// ─────────────────────────── playWord：墙钟上限（Task 12C）───────────────────────────

/** 手动时钟：回调只在测试显扣扳机时才跑（不真等）；`events` 按序记下 set/clear 供排序断言。 */
function fakeClock() {
  const pending = [];
  const events = [];
  return {
    timers: {
      setTimer: (fn, ms) => {
        const h = { fn, ms };
        pending.push(h);
        events.push(['set', ms]);
        return h;
      },
      clearTimer: (h) => {
        const i = pending.indexOf(h);
        if (i >= 0) pending.splice(i, 1);
        events.push(['clear']);
      },
    },
    pending,
    events,
  };
}

test('墙钟到点（onend/onerror 都不来）：先 cancel 让引擎闭嘴、再拒绝收口，绝不永久挂住"正在播放…"', async () => {
  const { win, utterances } = fakeTts();
  const clock = fakeClock();
  const cancelCalls = [];
  win.speechSynthesis.cancel = () => {
    cancelCalls.push('cancel');
    clock.events.push(['cancel']); // 记进同一条时序线：cancel 必须排在"撤钟收口"之前
  };
  const played = playWord('mug', { win, timeoutMs: 1500, timers: clock.timers });
  // 扣扳机：墙钟到点（onend / onerror 谁都没来）——手动时钟，测试不真等。
  assert.equal(clock.pending.length, 1, '到点前：有且只有这一个墙钟在值守');
  clock.pending[0].fn();
  const outcome = await Promise.race([
    played.then(
      () => 'resolved',
      (err) => ({ message: String(err?.message ?? err) }),
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
  ]);
  assert.notEqual(outcome, 'hung', '墙钟就是为"挂住"而设：它自己绝不能挂');
  assert.equal(typeof outcome, 'object', '到点必须是拒绝（把挂住假扮成播过比挂住更坏）');
  assert.match(outcome.message, /超时/);
  assert.match(outcome.message, /1500/, '错误消息带上限毫秒数（界面/诊断要能如实转述等了多久）');
  assert.deepEqual(clock.events.map((e) => e[0]), ['set', 'cancel', 'clear'],
    '时序必须是：装钟 → cancel（abort）→ 撤钟收口——cancel 在收口之前');
  assert.deepEqual(cancelCalls, ['cancel'], 'synth.cancel() 恰好被调一次');
  // 迟到的 onend 不许再掀起任何波澜（settled 守卫：收口只有一次）。
  utterances[0].onend?.({});
  await new Promise((r) => setTimeout(r, 1));
});

test('正常播完与引擎报错都要撤掉墙钟（到点的回调绝不迟到放炮）', async () => {
  // onend 路径：播出的那一刻有钟在值守，收口时撤岗
  const a = fakeTts();
  const ca = fakeClock();
  const pa = playWord('mug', { win: a.win, timeoutMs: 5000, timers: ca.timers });
  assert.equal(ca.pending.length, 1, 'speak 之后必须有墙钟在值守');
  a.utterances[0].onend?.({});
  await pa;
  assert.equal(ca.pending.length, 0, 'onend 收口时墙钟撤岗');

  // onerror 路径：同样撤岗
  const b = fakeTts();
  const cb = fakeClock();
  const pb = playWord('mug', { win: b.win, timeoutMs: 5000, timers: cb.timers });
  b.utterances[0].onerror?.({ error: 'not-allowed' });
  await assert.rejects(() => pb, /not-allowed/);
  assert.equal(cb.pending.length, 0, 'onerror 收口时墙钟同样撤岗');
});

test('墙钟上限：缺省常量是充裕的正整数毫秒；注入的 ms 原样传给时钟；非法值当场拒绝且不碰引擎', async () => {
  assert.ok(Number.isInteger(PLAY_WORD_TIMEOUT_MS) && PLAY_WORD_TIMEOUT_MS >= 5000,
    `缺省上限 ${PLAY_WORD_TIMEOUT_MS}ms——一个词的示范音给足慢设备余量（首轮设定值，待真机数据标定）`);

  const a = fakeTts();
  const ca = fakeClock();
  const pa = playWord('mug', { win: a.win, timeoutMs: 1234, timers: ca.timers });
  assert.equal(ca.pending[0]?.ms, 1234, '注入的上限原样交给时钟（测试不必真等）');
  a.utterances[0].onend?.({});
  await pa;

  for (const bad of [0, -1, NaN, Infinity, '5000', null]) {
    const b = fakeTts();
    const cb = fakeClock();
    const outcome = await Promise.race([
      playWord('mug', { win: b.win, timeoutMs: bad, timers: cb.timers }).then(
        () => 'resolved',
        (err) => String(err?.message ?? err),
      ),
      new Promise((r) => setTimeout(() => r('hung'), 50)),
    ]);
    assert.notEqual(outcome, 'hung', `timeoutMs=${String(bad)} 也要当场收口`);
    assert.equal(typeof outcome, 'string', `timeoutMs=${String(bad)} 必须是拒绝`);
    assert.match(outcome, /上限/, '点名"墙钟上限"——它是"正在播放…"绝不久挂的保证');
    assert.equal(b.spoken.length, 0, '参数写错是编程错误：不碰引擎');
  }
});

// ─────────────────────────── 模块纪律 ───────────────────────────

test('本模块零 import、零浏览器全局（纯逻辑：Node 里可直接测，浏览器依赖全靠注入）', () => {
  const src = readFileSync(fileURLToPath(new URL('../web/units/speak.mjs', import.meta.url)), 'utf8');
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
  assert.deepEqual(importLines, [], '零 import：本模块不依赖任何别的模块');
  // **注释先剥掉再扫**：文件头正是用这些词解释"为什么这里不许碰它们"，不剥就等于
  // "注释里提一次就红"——那条断言会逼着人把解释删掉，方向是反的。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(document|window|navigator|localStorage|indexedDB|globalThis)\b/,
    '真代码里不许出现浏览器全局（globalThis 由 mount 的 deps 缺省提供）');
});
