// tests/recognize-mount.test.mjs
//
// Task 7 的装配接线测试：**真实的 `units/recognize.mjs`** 接进 `mount()` 之后，界面与事件对不对。
//
// 与 `tests/app-mount.test.mjs` 的分工：那份测骨架（相机、状态机、报错清空），
// 这一份专测"识物链路的结论怎么落到状态、事件与文字上"。夹具同一个（helpers/mount-harness.mjs），
// 只是把 `recognize` 换成真模块、并用 `withFetch()` 接管全局 fetch（浏览器的真实网络出口）。
//
// 这一份要钉住的四条（对应控制器的三条追加要求）：
//   1. **判帧只有一处起源**：`mount()` 不再自己 `judgeFrame`，`frame_rejected` 全部来自识别链路的返回值；
//   2. **配置问题与识别失败分开记**：`recognize_failed` 的 `reason` 区分"词表里没有"与"请求挂了"；
//   3. **取不到词时界面不出现任何英文单词**，只给手选词包，且手选的结果明说是手选；
//   4. 取到词时**必须**落 `recognize_ok`（否则下游算不出识物成功率）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  withFetch, openCameraAndShoot, makeBlob, okFetch, failingFetch, realRecognizeWithFallback,
} from './helpers/mount-harness.mjs';
import { btn, byTag, text } from './helpers/dom.mjs';
import {
  roundIndicesOfSession, roundCountOfSession, reShootCountOfSession, needsReshoot,
} from '../web/units/rounds.mjs';

/** 一帧"太暗"的统计（端侧质检必然拦下）。 */
const DARK = { brightness: 10, laplacianVar: 10 };
/** 一帧"可用"的统计。 */
const OK = { brightness: 128, laplacianVar: 200 };

/**
 * 连按 `times` 次快门：被拦下的帧会退回 ready，所以每次都要重新点一次「拍照」。
 * 这也是"一次快门 = 一轮"的前提在**代码路径**上的体现（每次快门恰好取一帧）。
 */
async function pressShutter(h, times) {
  for (let i = 0; i < times; i += 1) {
    if (h.machine.state === 'ready') await btn(h.root, '拍照').click();
    await btn(h.root, '快门').click();
  }
}

/** 上游给的是"可接受集里没有的词"（典型的内容配置问题）。 */
const offSetFetch = async (url) => {
  assert.ok(String(url).endsWith('/api/recognize'));
  return {
    ok: true,
    json: async () => ({ ok: true, candidates: [{ label: 'container', score: 0.95, scene: 'kitchen' }] }),
  };
};

/** 上游说"什么都没认出来"。 */
const emptyFetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, candidates: [] }),
});

test('识别成功：界面显示取到的词、落 recognize_ok，并说明是第几次尝试取到的', async () => {
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'word');
  assert.equal(byTag(h.root, 'h2')[0].textContent, 'mug');
  assert.match(text(h.root), /第 1 次尝试取到/, '要如实说明是第几次取到的（重试过就该看得出来）');

  const ok = h.events.filter((e) => e.type === 'recognize_ok');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].payload.word, 'mug');
  assert.equal(ok[0].payload.attempts, 1);
  assert.deepEqual(ok[0].payload.candidates, ['mug']);
  assert.equal(ok[0].wordId, null, 'wordId 归 Task 9 的落盘口径，这里只报 null');
  h.restoreFetch();
});

test('第一次失败、第二次成功：attempts=2 如实记，界面照常显示词', async () => {
  let call = 0;
  const flaky = async (url) => {
    call += 1;
    return call === 1 ? failingFetch(502)(url) : okFetch(url);
  };
  const h = await withFetch({ fetchImpl: flaky, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'word');
  const ok = h.events.filter((e) => e.type === 'recognize_ok');
  assert.equal(ok[0].payload.attempts, 2, '第二次才取到 → attempts 必须是 2（retry_rate 的输入）');
  assert.match(text(h.root), /第 2 次尝试取到/);
  h.restoreFetch();
});

test('两轮都落空 → manual 档：界面出现手选词包，且**一个英文词都不显示为识别结果**', async () => {
  const h = await withFetch({ fetchImpl: failingFetch(502), recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  // 手选与重拍是**同一格里的两个选择**（"没认出来：你自己挑，或者再拍一张"），
  // 所以状态停在 capturing——上一格"帧可用"没走完，词是在这一格里补上的。
  assert.equal(h.machine.state, 'capturing');
  assert.equal(h.machine.snapshot().frameRejections, 0, '识物失败不是"帧被拒"，不许记进 retry_rate');

  // 关键断言：没有 h2 标题写着某个"取到的词"——标题是那句"没能自动认出这个词"
  const titles = byTag(h.root, 'h2').map((e) => e.textContent);
  assert.deepEqual(titles, ['没能自动认出这个词'], '取不到词时不许给出任何"取到的词"');
  assert.doesNotMatch(text(h.root), /我会读了/, '没词就不许出现"开始跟读"的入口');
  assert.match(text(h.root), /自己挑一个/, '要明确告诉用户这一步是他自己挑，不是识别结果');

  // 手选词包必须在，否则用户无路可走
  const choices = byTag(h.root, 'button').map((b) => b.textContent);
  assert.ok(choices.includes('mug'), `手选词包里应有 mug，实际按钮：${choices.join('/')}`);
  assert.ok(choices.includes('再拍一张'), '也要留一条立刻重拍的路（重拍率是正式闸门，用户得能选择重拍）');
  h.restoreFetch();
});

test('手选之后：显示所选词，并**明说这是手选的**（不冒充识别结果）', async () => {
  const h = await withFetch({ fetchImpl: failingFetch(502), recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  await btn(h.root, 'book').click();

  assert.equal(h.machine.state, 'word', '手选到词之后推进到 word');
  assert.equal(byTag(h.root, 'h2')[0].textContent, 'book');
  assert.match(text(h.root), /这是你自己挑的词，不是识别出来的/, '手选必须与识别结果长得不一样');
  // 手选之后仍能继续走闭环
  assert.ok(btn(h.root, '我会读了（开始跟读）'), '手选到词之后要能进跟读');
  // 事件：手选本身不产生新的 recognize_ok（那个词不是识别出来的）
  assert.equal(h.events.filter((e) => e.type === 'recognize_ok').length, 0);
  h.restoreFetch();
});

test('降级事件如实带 reason：模型给的候选不在可接受集里 → not_in_acceptable_set', async () => {
  const h = await withFetch({ fetchImpl: offSetFetch, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  const failed = h.events.filter((e) => e.type === 'recognize_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.reason, 'not_in_acceptable_set', '这是内容配置问题，不是"识物服务挂了"');
  assert.equal(failed[0].payload.attempts, 2);
  assert.deepEqual(failed[0].payload.candidates, ['container'], '候选要如实带出来（排查词表缺什么就靠它）');
  assert.match(String(failed[0].payload.detail), /container/);
  h.restoreFetch();
});

test('降级事件如实带 reason：请求本身失败 → request_failed（与配置问题分开记）', async () => {
  const h = await withFetch({ fetchImpl: failingFetch(502), recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  const failed = h.events.filter((e) => e.type === 'recognize_failed');
  assert.equal(failed[0].payload.reason, 'request_failed');
  assert.notEqual(failed[0].payload.reason, 'not_in_acceptable_set');
  assert.match(String(failed[0].payload.detail), /502/, 'detail 要留下可排查的线索');
  h.restoreFetch();
});

test('降级事件如实带 reason：模型没认出东西 → no_candidates', async () => {
  const h = await withFetch({ fetchImpl: emptyFetch, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  const failed = h.events.filter((e) => e.type === 'recognize_failed');
  assert.equal(failed[0].payload.reason, 'no_candidates');
  h.restoreFetch();
});

test('判帧只有一处起源：整条链路上 frame_rejected 只落一条、且 attempts 为 0', async () => {
  // 追加要求 1：mount() 里那条 judgeFrame 已拆掉。若两处都判，这里会落两条事件
  // （或者界面显示的理由与记录里的理由不一致）。这条用例就是那个"两套机制"的哨兵。
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    grabResult: { blob: makeBlob(9), stats: { brightness: 10, laplacianVar: 10 } },
  });
  await openCameraAndShoot(h);
  const rejected = h.events.filter((e) => e.type === 'frame_rejected');
  assert.equal(rejected.length, 1, '一帧只该落一条拒帧事件');
  assert.equal(h.machine.snapshot().frameRejections, 1, '状态机的计数也只该加 1');
  assert.equal(h.machine.snapshot().lastRejectReason, 'too_dark');
  // 帧被拒 → 一次模型调用都没有
  assert.equal(h.events.filter((e) => e.type === 'recognize_ok' || e.type === 'recognize_failed').length, 0);
  h.restoreFetch();
});

test('界面上说"重拍不消耗识物调用"，且这句与 attempts=0 的口径一致', async () => {
  // 首屏那句话是给用户看的承诺。它必须与实现一致：帧被拒时不发请求（省调用、省延迟）。
  let calls = 0;
  const counting = async (url) => { calls += 1; return okFetch(url); };
  const h = await withFetch({
    fetchImpl: counting,
    recognize: realRecognizeWithFallback,
    grabResult: { blob: makeBlob(9), stats: { brightness: 10, laplacianVar: 10 } },
  });
  assert.match(text(h.root), /不消耗识物调用/, '首屏承诺');
  await openCameraAndShoot(h);
  assert.equal(calls, 0, '承诺必须兑现：被拒的帧一次调用都不发');
  h.restoreFetch();
});

test('识别成功后没再落任何失败事件（成功与失败不双记）', async () => {
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  assert.equal(h.events.filter((e) => e.type === 'recognize_failed').length, 0);
  h.restoreFetch();
});

test('再拍一张：立刻重来一轮（重新取帧 + 重新识物），手选词包仍留着', async () => {
  // 手选界面上的"再拍一张"与「快门」是同一个动作：**再取一帧、再送一次识别**。
  // 状态机本来就在 capturing，所以这一步不需要回 ready、也不需要重开相机
  // （若把手选渲染在 word 态，"重拍"按钮会被状态机静默拒绝，用户只看到没反应——已实测）。
  // 本用例的桩上游永远 502，所以第二轮也失败：手选词包必须**还在**（用户还有路可走），
  // 而每次重试都真的重新取帧、重新请求（不是复用上一轮的结果）。
  const h = await withFetch({ fetchImpl: failingFetch(502), recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'capturing');
  assert.equal(h.calls.grabFrame.length, 1);
  assert.equal(h.calls.recognize.length, 1);
  assert.ok(btn(h.root, '再拍一张'), '手选界面要留一条重拍的路');

  await btn(h.root, '再拍一张').click();
  assert.equal(h.machine.state, 'capturing', '还是在取景态（手选档不推进状态机）');
  assert.equal(h.calls.grabFrame.length, 2, '要真的再取一帧（不是复用上一帧）');
  assert.equal(h.calls.recognize.length, 2, '要真的再走一轮识物');
  assert.ok(btn(h.root, '再拍一张'), '第二轮又失败 → 手选这条路必须还在');
  assert.ok(btn(h.root, 'book'), '手选词包也还在');
  assert.equal(h.events.filter((e) => e.type === 'recognize_failed').length, 2, '两轮都如实落失败事件');
  h.restoreFetch();
});

// ───────────────────────── 轮次标识（Task 7 修复轮 · Critical 1）─────────────────────────
//
// review 的原话：`attempts: 2` 既可能是"一次快门、两次模型请求"，也可能是"按了两次快门、
// 各请求一次"；而三类结论事件原先都没有轮次字段，Task 10 从这里算不出"用户重拍了几次"。
// 下面四条把 **一次快门 = 一轮** 钉在真链路上，并把"代码路径数出来的快门次数"与
// "事件流用 rounds.mjs 的公式数出来的轮数"对上。

test('一次快门 = 一轮：同一帧发了两次模型请求，roundIndex 也只加 1（attempts 与轮数是两个数）', async () => {
  let call = 0;
  const flaky = async (url) => {
    call += 1;
    return call === 1 ? failingFetch(502)(url) : okFetch(url);
  };
  const h = await withFetch({ fetchImpl: flaky, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);

  const ok = h.events.filter((e) => e.type === 'recognize_ok');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].payload.attempts, 2, '这一轮真的问了模型两次');
  assert.equal(ok[0].roundIndex, 1, '但它只是**一次**快门 → 只占一轮');
  assert.equal(roundCountOfSession(h.events, h.sessionId), 1, '事件流里也只有一轮');
  assert.equal(reShootCountOfSession(h.events, h.sessionId), 0, 'attempts=2 绝不能被读成"重拍了一次"');
  assert.equal(h.calls.grabFrame.length, 1, '一次快门只取一帧（轮次与取帧次数同源）');
  h.restoreFetch();
});

test('被端侧拦下的那一轮也带 roundIndex，且 attempts 如实为 0（拒帧同样是一次快门）', async () => {
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    grabResult: { blob: makeBlob(9), stats: DARK },
  });
  await openCameraAndShoot(h);
  const rejected = h.events.filter((e) => e.type === 'frame_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].roundIndex, 1, '拒帧那一轮必须有轮次标识（否则它就"不存在"，判据 B 少算）');
  assert.equal(rejected[0].payload.attempts, undefined, 'frame_rejected 的 payload 只有 reason（attempts 是"问过模型几次"）');
  assert.equal(roundCountOfSession(h.events, h.sessionId), 1);
  h.restoreFetch();
});

test('1 / 2 / 3 次快门：事件流数出 0 / 1 / 2 次重拍，且与代码路径（取帧次数）逐个吻合', async () => {
  // 三次那一轮故意做成"两次被端侧拦下 + 第三次识物成功"：只数 recognize_* 的口径会数出 1 轮
  // （判成"没重拍过"），而正确答案是 3 轮 = 重拍 2 次 = 成闸。这就是 review 说的分母陷阱。
  for (const presses of [1, 2, 3]) {
    let shot = 0;
    const h = await withFetch({
      fetchImpl: okFetch,
      recognize: realRecognizeWithFallback,
      grabResult: () => {
        shot += 1;
        return { blob: makeBlob(9), stats: shot <= presses - 1 ? DARK : OK };
      },
    });
    await pressShutter(h, presses);

    const rounds = roundCountOfSession(h.events, h.sessionId);
    assert.equal(h.calls.grabFrame.length, presses, `按了 ${presses} 次快门就该取 ${presses} 帧（代码路径）`);
    assert.deepEqual(
      roundIndicesOfSession(h.events, h.sessionId),
      Array.from({ length: presses }, (_, i) => i + 1),
      `${presses} 次快门 → 事件流里的轮次应是连续的 1…${presses}（每会话重置、单调递增）`,
    );
    assert.equal(rounds, presses, `事件流数出来的轮数必须等于快门次数（${presses}）`);
    assert.equal(reShootCountOfSession(h.events, h.sessionId), presses - 1, `${presses} 次快门 = 重拍 ${presses - 1} 次`);
    assert.equal(needsReshoot(rounds), presses >= 3, `${presses} 次快门 → 需重拍 ≥2 次 = ${presses >= 3}`);
    h.restoreFetch();
  }
});

test('重拍率的两个数不能混：一次会话里 attempts 总和可以是 3，但轮数仍是 2', async () => {
  // 会话：第 1 次快门被端侧拦下（attempts 0）；第 2 次快门通过质检但第一次请求失败、
  // 第二次成功（attempts 2）。模型请求共 2 次、快门 2 次 → 轮数 2、重拍 1 次。
  let call = 0;
  const flaky = async (url) => {
    call += 1;
    return call === 1 ? failingFetch(502)(url) : okFetch(url);
  };
  let shot = 0;
  const h = await withFetch({
    fetchImpl: flaky,
    recognize: realRecognizeWithFallback,
    grabResult: () => {
      shot += 1;
      return { blob: makeBlob(9), stats: shot === 1 ? DARK : OK };
    },
  });
  await pressShutter(h, 2);

  const attemptsTotal = h.events
    .filter((e) => e.type === 'recognize_ok' || e.type === 'recognize_failed')
    .reduce((n, e) => n + (e.payload.attempts ?? 0), 0);
  assert.equal(attemptsTotal, 2, '第 2 轮问了两次模型');
  assert.equal(roundCountOfSession(h.events, h.sessionId), 2, '但用户只按了两次快门 → 2 轮');
  assert.equal(reShootCountOfSession(h.events, h.sessionId), 1, '重拍 1 次');
  assert.equal(needsReshoot(roundCountOfSession(h.events, h.sessionId)), false, '重拍 1 次不成闸');
  h.restoreFetch();
});

test('轮次按会话重置：另一次 mount（= 另一个会话）从 1 重新开始', async () => {
  const h1 = await withFetch({
    fetchImpl: okFetch, recognize: realRecognizeWithFallback, grabResult: { blob: makeBlob(9), stats: DARK },
  });
  await pressShutter(h1, 2);
  assert.equal(roundCountOfSession(h1.events, h1.sessionId), 2);
  h1.restoreFetch();

  const h2 = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h2);
  assert.equal(h2.events.filter((e) => e.type === 'recognize_ok')[0].roundIndex, 1, '新会话的第一轮必须是 1');
  assert.equal(roundCountOfSession(h2.events, h2.sessionId), 1);
  h2.restoreFetch();
});
