// tests/rounds.test.mjs
//
// 轮次（round）计数与判据 B（`retry_rate`，dmcp `VAL-…50`）在**事件流**上的口径
// —— Task 7 修复轮 Critical 1 的落点。
//
// 为什么需要这一份：识物链路对**同一帧**最多发两次模型请求，所以事件里的 `attempts: 2`
// 既可能是"一次快门、两次请求"，也可能是"按了两次快门、各请求一次"；而三类结论事件
// 原先都没有轮次字段，Task 10 从事件流里根本算不出"用户重拍了几次"。这里钉住的是
// **公式本身**：轮数怎么数、重拍次数怎么从轮数推、什么算"需重拍 ≥2 次"。
//
// 事件形状取自 `web/units/event-log.mjs` 的 `recordEvent`：`roundIndex` 与 `sessionId` /
// `wordId` 一样在**事件顶层**，不在 `payload` 里。
//
// 端到端那半边（真 `mount()` + 真 `units/recognize.mjs` 跑出来的事件流）在
// `tests/recognize-mount.test.mjs`：那里断言"代码路径数出来的快门次数"与"事件流数出来的轮数"
// 是同一个数。本文件只测纯函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ROUND_EVENT_TYPES, RESHOOTS_FOR_RETRY, createRoundCounter, roundIndexOf,
  roundIndicesOfSession, roundCountOfSession, reShootCountOfSession, needsReshoot,
} from '../web/units/rounds.mjs';
import { recordEvent } from '../web/units/event-log.mjs';

/** 造一条事件（与 `recordEvent` 写出来的形状一致：roundIndex 在顶层）。 */
const ev = (type, roundIndex, sessionId = 's1') => ({
  ts: 1, type, wordId: null, roundIndex, sessionId, payload: {},
});

// ─────────────────────────────────── 计数器：会话内单调、按会话重置 ───────────────────────────────────

test('createRoundCounter：会话内从 1 开始、单调递增（一次快门调一次 next）', () => {
  const rounds = createRoundCounter();
  assert.deepEqual([rounds.next(), rounds.next(), rounds.next()], [1, 2, 3]);
});

test('计数器按会话重置：另一个计数器（= 另一个会话）从 1 重新开始', () => {
  // 会话 A 按了 2 次；会话 B（新 mount、新 sessionId）必须从 1 开始，
  // 否则 B 的第一轮会被当成"第 3 轮"，重拍次数凭空多算。
  const a = createRoundCounter();
  assert.deepEqual([a.next(), a.next()], [1, 2]);
  const b = createRoundCounter();
  assert.equal(b.next(), 1, '新会话必须从 1 开始（每会话重置）');
  assert.equal(a.next(), 3, '旧会话不受影响，仍是单调递增');
});

// ─────────────────────────────────── 判据 B：轮数 → 重拍次数 → 是否成闸 ───────────────────────────────────

test('判据 B 公式：1 / 2 / 3 次快门 → 轮数 1/2/3、重拍 0/1/2、需重拍 否/否/是', () => {
  // 「重拍次数 = 轮数 − 1」：第一次快门不算重拍，之后每一轮都是用户被逼着重按的一次。
  // 「需重拍 ≥2 次」等价于「轮数 ≥3」——这就是判据 B 的分子口径。
  for (const presses of [1, 2, 3]) {
    const events = Array.from({ length: presses }, (_, i) => ev('recognize_ok', i + 1));
    const rounds = roundCountOfSession(events, 's1');
    assert.equal(rounds, presses, `${presses} 次快门 → 轮数应为 ${presses}`);
    assert.equal(reShootCountOfSession(events, 's1'), presses - 1, `${presses} 次快门 → 重拍 ${presses - 1} 次`);
    assert.equal(needsReshoot(rounds), presses >= 3, `${presses} 次快门 → 需重拍 ≥2 次 = ${presses >= 3}`);
  }
});

test('被端侧质检拦下的帧（frame_rejected）**同样算一轮**：它是用户按下去、系统退回的一次', () => {
  // 这是 review 点名的分母陷阱：只数 recognize_ok + recognize_failed 的话，
  // "太暗/太糊"造成的重拍会整体消失——而端侧前置拦截正是最主要的重拍来源。
  const events = [
    ev('frame_rejected', 1), ev('frame_rejected', 2), ev('recognize_ok', 3),
  ];
  assert.equal(roundCountOfSession(events, 's1'), 3, '三次快门 = 三轮（两次被拦 + 一次识物）');
  assert.equal(reShootCountOfSession(events, 's1'), 2);
  assert.equal(needsReshoot(roundCountOfSession(events, 's1')), true, '这一会话"需重拍 2 次"，必须计数');
  // 反面对照：只数识别事件会得到 1 —— 那个数会把这一会话判成"没重拍过"
  assert.equal(events.filter((e) => e.type !== 'frame_rejected').length, 1, '只数识别事件 = 1（错误口径）');
});

test('同一帧的两次模型请求不会算成两轮：roundIndex 相同就只算一轮', () => {
  // attempts: 2（同一帧问了模型两次）不能读成"用户拍了两次"。轮次由 roundIndex 决定。
  const events = [ev('recognize_ok', 1)];
  events[0].payload = { attempts: 2, word: 'mug' };
  assert.equal(roundCountOfSession(events, 's1'), 1, '一次快门永远只有一轮');
  assert.equal(reShootCountOfSession(events, 's1'), 0, 'attempts=2 不是重拍');
});

test('轮数取 roundIndex 的**并集**（不是事件条数）：同一轮多落一条也只算一轮', () => {
  // 三类结论事件互斥（mount 里是 if/else），但公式取并集之后，
  // 即使某一轮被重复记录，也不会把"轮数"和"重拍次数"算多。
  const both = [ev('recognize_failed', 1), ev('recognize_ok', 1), ev('recognize_ok', 2)];
  assert.equal(roundCountOfSession(both, 's1'), 2);
  assert.equal(reShootCountOfSession(both, 's1'), 1);
});

test('只数本会话：别的会话的轮次不许串进来', () => {
  const events = [
    ev('recognize_ok', 1, 's1'), ev('recognize_ok', 1, 's2'),
    ev('recognize_ok', 2, 's1'), ev('frame_rejected', 2, 's2'), ev('frame_rejected', 3, 's2'),
  ];
  assert.deepEqual(roundIndicesOfSession(events, 's1'), [1, 2]);
  assert.equal(roundCountOfSession(events, 's1'), 2);
  assert.equal(reShootCountOfSession(events, 's1'), 1, 's1 只重拍过 1 次');
  assert.equal(roundCountOfSession(events, 's2'), 3);
  assert.equal(needsReshoot(roundCountOfSession(events, 's2')), true, 's2 才需要"重拍 ≥2 次"');
});

test('非 round 类事件（session_start / blocked_permission…）不参与轮数', () => {
  const events = [
    { ts: 1, type: 'session_start', wordId: null, roundIndex: null, sessionId: 's1', payload: {} },
    ev('recognize_ok', 1),
    { ts: 3, type: 'blocked_permission', wordId: null, roundIndex: null, sessionId: 's1', payload: { reason: 'denied' } },
  ];
  assert.equal(roundCountOfSession(events, 's1'), 1);
});

test('还没按过快门（没有任何结论事件）→ 轮数 0、重拍 0、不成闸', () => {
  assert.equal(roundCountOfSession([], 's1'), 0);
  assert.equal(reShootCountOfSession([], 's1'), 0, '一次都没拍，重拍次数是 0 而不是 -1');
  assert.equal(needsReshoot(0), false);
});

// ─────────────────────────────────── 响亮失败：不许静默少算 ───────────────────────────────────

test('结论事件缺 roundIndex → 响亮报错，绝不静默跳过（跳过 = 少算重拍，判据 B 失真）', () => {
  for (const bad of [undefined, null, 0, -1, 1.5, '1', NaN]) {
    const events = [ev('recognize_ok', bad)];
    assert.throws(
      () => roundCountOfSession(events, 's1'),
      /roundIndex/,
      `roundIndex=${String(bad)} 应被判为非法（静默跳过会让这一轮凭空消失）`,
    );
  }
  assert.doesNotThrow(() => roundIndexOf(ev('recognize_ok', 2)), '合法的那条不该抛（反面对照）');
  assert.equal(roundIndexOf(ev('recognize_ok', 2)), 2);
});

// ─────────────────────────────────── 常量与纯逻辑纪律 ───────────────────────────────────

test('口径常量冻结且自洽：三类结论事件都算一轮；"需重拍"门槛是 2', () => {
  assert.deepEqual([...ROUND_EVENT_TYPES].sort(), ['frame_rejected', 'recognize_failed', 'recognize_ok']);
  assert.ok(Object.isFrozen(ROUND_EVENT_TYPES), 'ROUND_EVENT_TYPES 冻结：统计口径不许被运行时改写');
  assert.equal(RESHOOTS_FOR_RETRY, 2, '判据 B 的门槛是"需重拍 ≥2 次"');
  assert.equal(needsReshoot(RESHOOTS_FOR_RETRY), false, '恰好重拍 1 次（2 轮）不成闸');
  assert.equal(needsReshoot(RESHOOTS_FOR_RETRY + 1), true, '重拍 2 次（3 轮）成闸');
});

test('本模块是纯逻辑：零 import、零浏览器 API（shared-context 的约定）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../web/units/rounds.mjs', import.meta.url)), 'utf8');
  assert.equal(
    src.split(/\r?\n/).filter((l) => /^\s*(import|export\s+.*\s+from)\b/.test(l)).length,
    0,
    'rounds.mjs 不许 import 任何东西（浏览器与 Node 都要能直接用）',
  );
  assert.doesNotMatch(src, /\b(document|window|navigator|localStorage|indexedDB|fetch)\b/);
});

// ───────────────────────── 事件写入侧：roundIndex 真的落在事件顶层（不是 payload 里） ─────────────────────────

test('recordEvent 把 roundIndex 提到事件顶层（与 sessionId / wordId 同级），不留在 payload', () => {
  const memory = [];
  const store = { appendEvent: (e) => memory.push(e) };
  const e = recordEvent(store, 'recognize_ok', { sessionId: 's1', roundIndex: 2, word: 'mug' }, () => 7);
  assert.equal(e.roundIndex, 2);
  assert.equal(e.sessionId, 's1');
  assert.deepEqual(e.payload, { word: 'mug' }, 'roundIndex 不该留在 payload 里（否则下游要去猜它在哪）');
});

test('不是某一轮的事件（如 blocked_permission）roundIndex 是 null，而不是 undefined', () => {
  const memory = [];
  const store = { appendEvent: (e) => memory.push(e) };
  const e = recordEvent(store, 'blocked_permission', { sessionId: 's1', reason: 'denied' }, () => 7);
  assert.equal(e.roundIndex, null, '字段始终存在（null 表示"不属于任何一轮"），下游不必区分两种"没有"');
});
