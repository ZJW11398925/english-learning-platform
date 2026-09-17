// tests/app-mount.test.mjs
//
// `mount()`（web/app.mjs 的浏览器装配层）的测试。用**假 DOM** 跑，所以整份都能在 Node 里跑。
//
// 为什么值得测这一层（而不是"骨架而已，等 Task 7 再说"）：这一层是唯一把"识物链路的结论"
// 翻译成**状态与事件**的地方，而它最容易犯的错正是全局约束 3 禁止的那两种：
//   ① 识物说 `frame_rejected` 却不落 `frame_rejected` 事件（用户看到重拍提示，但计数里没有——retry_rate 失真）；
//   ② `judgeFrame` 抛的 RangeError 被 catch 成"这张照片不行"（编程缺陷被伪装成用户问题）。
// 两条都有专门用例。
//
// 注入的是 store / camera / urlApi / 时钟；**不注入** recordEvent——
// 用真实的 event-log（顺带验证 mount 落的事件类型都是登记过的）。
//
// Task 7 起本文件主要测**骨架**：识物接线（识别成功 / 手选降级 / 事件 payload）在
// `tests/recognize-mount.test.mjs` 里单独覆盖。夹具在 tests/helpers/mount-harness.mjs，
// 两份测试共用，免得同一个 mount() 在两份夹具有两种行为。
//
// 走**真识物链路**的用例写成 `withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback })`：
// `mount()` 有意不传 `fetchImpl`，"网络出口"就是全局 `fetch`，所以测试接管的是**真实那条路径**。
// 用完必须调 `h.restoreFetch()`（用例中途抛错时，下一次 `withFetch()` 调用会兜底还原）。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../web/app.mjs';
import { createKeyring, API_KEY_STORAGE_KEY } from '../web/units/keyring.mjs';
import { fakeLocalStorage } from './helpers/fakes.mjs';
import {
  harness, openCameraAndShoot, withFetch, makeBlob, OK_STATS, okFetch, realRecognizeWithFallback,
  settleFeedback, fakeTts, gotoLearn,
  disposeAllHarnesses,
} from './helpers/mount-harness.mjs';

// 每条用例之后拆掉 mount 挂的定时器（待补反馈的自动重试会挂 10 秒的 setTimeout，
// 而 node --test 会等事件循环空掉才退出——不清的话每个挂载测试文件都白等 10 秒起）。
afterEach(disposeAllHarnesses);
import { btn, byTag, text, errorText, makeEl } from './helpers/dom.mjs';

// ───────────────────────────────────── 用例 ─────────────────────────────────────

test('学习页停在 ready：只有「拍照」一个主动作，没有任何假入口', async () => {
  // 阶段 A：应用默认落在**首页**，取词那一条流程搬进了「学习」页签 ⇒ 先导航再断言。
  // 断言语义未变（"ready 这一屏有哪些按钮"），变的是"这一屏现在在第几个页签上"。
  const h = await harness();
  await gotoLearn(h.root);
  assert.equal(h.machine.state, 'ready');
  assert.ok(btn(h.root, '拍照'), 'ready 态必须有拍照按钮');
  assert.equal(btn(h.root, '开始跟读'), undefined, '没取到词之前不许出现"进入跟读"');
  assert.equal(btn(h.root, '提交造句'), undefined, '没取到词之前不许出现造句框');
  assert.match(text(h.root), /状态：ready/);
});

test('点「拍照」：开后置相机、把流接上 video，进 capturing 并出现「快门」', async () => {
  const h = await harness();
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'capturing');
  const video = byTag(h.root, 'video')[0];
  assert.ok(video, 'capturing 态必须把 video 挂进 DOM（否则用户看不到画面）');
  assert.equal(video.playsInline, true, 'iOS 上必须内联播放，否则会被拉去全屏播放器');
  assert.equal(video.muted, true, '静音才能自动播放');
  assert.equal(video.playCalls, 1);
  assert.equal(h.calls.openCamera.length, 1);
  assert.equal(h.calls.openCamera[0].video, video);
  assert.equal(h.calls.openCamera[0].opts.facingMode, 'environment', '要后置相机（对着物体拍）');
  assert.ok(btn(h.root, '快门'));
});

test('注入的 cameraOptions 覆盖取景默认值（默认后置有断言，覆盖这半边此前没人看守）', async () => {
  // `mount(root, { cameraOptions })` 是文档化的注入点：注入了就以注入的为准。
  // 少了实现里的 `...cameraOptions`，这类覆盖会被静默忽略（用户拿到的是另一颗镜头）。
  const h = await harness({ cameraOptions: { facingMode: 'user', width: { ideal: 640 } } });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.deepEqual(h.calls.openCamera[0].opts, { facingMode: 'user', width: { ideal: 640 } });
});

test('快门：质检通过 → 冻结这一帧进 word，并显示真实取到的词（占位已拆）', async () => {
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'word');
  assert.equal(h.calls.grabFrame.length, 1, '快门必须真的取一帧');
  assert.equal(h.events.filter((e) => e.type === 'frame_rejected').length, 0, '通过的帧不该落拒帧事件');

  const img = byTag(h.root, 'img')[0];
  assert.ok(img, 'word 态要显示冻结的那一帧');
  assert.equal(img.src, 'blob:fake-1');

  // Task 7 起这一屏显示的是**真实取到的词**（夹具里是 mug）。此前那句"识物尚未接入"的占位
  // 已经拆掉——留着它等于在界面上说一句假话。
  assert.equal(byTag(h.root, 'h2')[0].textContent, 'mug', 'word 态要把取到的词显示出来');
  assert.doesNotMatch(text(h.root), /尚未接入/, '占位文案必须拆掉（识物已接入）');
  assert.equal(h.events.filter((e) => e.type === 'recognize_ok').length, 1, '取到词要落 recognize_ok');
  // 镜头必须关掉：摄像头灯亮着整个会话既费电又吓人
  assert.deepEqual(h.stream.tracks.map((t) => t.stopped), [true, true]);
  h.restoreFetch();
});

test('快门：质检不通过 → 如实落一条 frame_rejected（带 reason），退回 ready 并提示重拍', async () => {
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    grabResult: { blob: makeBlob(9), stats: { brightness: 10, laplacianVar: 10 } },
  });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'ready', '被拒的帧要退回拍摄态重拍');
  assert.equal(h.machine.snapshot().frameRejections, 1);

  const rejected = h.events.filter((e) => e.type === 'frame_rejected');
  assert.equal(rejected.length, 1, '拒帧必须落事件，否则 retry_rate 失真');
  assert.deepEqual(rejected[0].payload, { reason: 'too_dark' });
  assert.equal(rejected[0].sessionId, h.sessionId);
  assert.equal(rejected[0].wordId, null);
  assert.ok(Number.isFinite(rejected[0].ts));
  // 断言必须匹配**拒帧提示独有**的措辞：首屏那句静态说明里本来就有"画面太暗或太糊"，
  // 所以 /太暗/ 这种关键词即使 `send('frameBad')` 丢掉了 `{ reason }`（界面退化成通用文案）
  // 也照样绿——一条永不可能红的断言。这里钉住 REJECT_HINT.too_dark 的开头。
  assert.match(text(h.root), /刚才那张太暗/, '要告诉用户为什么被退回（且必须来自拒帧提示，不是首屏静态说明）');
  assert.ok(btn(h.root, '拍照'), '退回后还能重拍');
  // 判帧只有一处起源：mount 把取帧函数交给识物链路，而不是自己再判一次（追加要求 1）
  assert.equal(typeof h.calls.recognize[0].grab, 'function');
  h.restoreFetch();
});

test('快门：模糊帧同样退回并落 too_blurry（不是一律报太暗）', async () => {
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    grabResult: { blob: makeBlob(9), stats: { brightness: 128, laplacianVar: 1 } },
  });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'ready');
  assert.deepEqual(h.events.filter((e) => e.type === 'frame_rejected')[0].payload, { reason: 'too_blurry' });
  // 同上：/糊/ 会被首屏那句"太糊"满足；只有拒帧提示独有的措辞才能证明理由真的传到了界面。
  assert.match(text(h.root), /刚才那张有点糊/, '模糊这一档也要给出它自己的那句提示');
  assert.doesNotMatch(text(h.root), /刚才那张太暗/, 'too_blurry 不许被渲染成"太暗"（理由不许串档）');
  h.restoreFetch();
});

test('落事件用注入的时钟：ts 等于注入值，而不是偷偷回退到 Date.now', async () => {
  // `recordEvent(store, type, fields, now)` 的第四个参数就是时钟注入点。少了它，
  // 事件的 ts 变成"记下来的那一刻"（Date.now）——注入假时钟的测试与重放都对不上时间轴。
  const T = 1_700_000_000_000;                 // 固定值：与真实 Date.now() 必然不等
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    clock: () => T,
    grabResult: { blob: makeBlob(9), stats: { brightness: 10, laplacianVar: 10 } },
  });
  await openCameraAndShoot(h);
  const rejected = h.events.filter((e) => e.type === 'frame_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].ts, T, 'frame_rejected 的 ts 必须来自注入时钟');
  h.restoreFetch();

  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const h2 = await harness({ clock: () => T, openError: denied });
  await gotoLearn(h2.root);
  await btn(h2.root, '拍照').click();
  const blocked = h2.events.filter((e) => e.type === 'blocked_permission');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].ts, T, 'blocked_permission 同样要走注入时钟');
});

test('快门：judgeFrame 抛 RangeError 时绝不改判成"这张照片不行"（显示 + 原样重抛）', async () => {
  // stats 里放 NaN：judgeFrame 按契约抛 RangeError（编程错误）。它必须是**刺眼的**，
  // 不许被 catch 成一次用户可见的拒帧——那会把 bug 记到用户头上，并污染 retry_rate。
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    grabResult: { blob: makeBlob(9), stats: { brightness: NaN, laplacianVar: 10 } },
  });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  await assert.rejects(() => btn(h.root, '快门').click(), RangeError, 'RangeError 必须继续往上冒');
  assert.equal(h.machine.state, 'capturing', '状态不许被这次异常推动');
  assert.equal(h.machine.snapshot().frameRejections, 0);
  assert.equal(h.events.length, 0, '一条 frame_rejected 都不许落');
  assert.match(errorText(h.root), /程序缺陷/, '界面上也要说清这是程序问题，不是照片问题');
  h.restoreFetch();
});

test('快门：视频还没出画（按太早）→ 只提示稍候，不落事件、不改状态', async () => {
  const notReady = Object.assign(new Error('grabFrame: 视频还没出画'), { code: 'VIDEO_NOT_READY' });
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback, grabError: notReady });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
  assert.equal(h.machine.state, 'capturing', '还在取景，等下一按');
  assert.equal(h.events.length, 0, '这不是一次"照片被拒"，不该落 frame_rejected');
  assert.equal(h.machine.snapshot().frameRejections, 0);
  assert.match(text(h.root), /稍等|准备好/);
  h.restoreFetch();
});

test('快门：其它取帧错误原样重抛（不静默变成功、也不变成拒帧）', async () => {
  const boom = new Error('取帧时炸了');
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback, grabError: boom });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  await assert.rejects(() => btn(h.root, '快门').click(), /取帧时炸了/);
  assert.equal(h.machine.state, 'capturing');
  assert.equal(h.events.length, 0);
  assert.match(errorText(h.root), /取帧失败/);
  h.restoreFetch();
});

test('报错文案清空（开机）：授权被拒后重试成功 → 上一次的报错必须消失', async () => {
  // 报错元素不属于任何一屏（它挂在 root 上，不在会被 replaceChildren 换掉的 body 里），
  // 所以**只有**显式的 setError('') 能清掉它。少了那一句，用户改好权限、第二次成功进到
  // 拍摄画面后，屏幕上仍然挂着"相机没有授权……"，看起来像又失败了。
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  let attempt = 0;
  const h = await harness({ openError: () => (attempt++ === 0 ? denied : null) });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.match(errorText(h.root), /相机没有授权/, '第一次失败要说清原因');
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'capturing', '权限改好后重试应当成功');
  assert.equal(errorText(h.root), '', '重试成功后，上一次的报错必须被清掉');
});

test('报错文案清空（快门）：按太早之后补按成功 → 那句"稍等"必须消失', async () => {
  const notReady = Object.assign(new Error('grabFrame: 视频还没出画'), { code: 'VIDEO_NOT_READY' });
  let attempt = 0;
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    grabError: () => (attempt++ === 0 ? notReady : null),
  });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
  assert.match(errorText(h.root), /稍等|准备好/);
  await btn(h.root, '快门').click();
  assert.equal(h.machine.state, 'word', '第二按取到帧 → 进 word');
  assert.equal(errorText(h.root), '', '帧取到之后，那句"稍等"必须被清掉');
  h.restoreFetch();
});

test('连点两次「拍照」只开一路相机（手机上双击不该开出两路流）', async () => {
  const h = await harness();
  await gotoLearn(h.root);
  const first = btn(h.root, '拍照').click();
  const second = btn(h.root, '拍照').click();   // 状态还没变，按钮还在，第二次点击真的会发生
  await Promise.all([first, second]);
  assert.equal(h.machine.state, 'capturing');
  assert.equal(h.calls.openCamera.length, 1, '第二次点击必须被"正在开相机"挡住，否则多一路流没人关');
});

test('相机授权被拒：落 blocked_permission(denied)、留在 ready、按钮留着让用户改完设置再试', async () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const h = await harness({ openError: denied });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'ready', '没有相机就没有取词，状态机不许前进');
  const blocked = h.events.filter((e) => e.type === 'blocked_permission');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.reason, 'denied');
  assert.match(text(h.root) + errorText(h.root), /相机|授权|权限/);
  assert.ok(btn(h.root, '拍照'));
  assert.equal(btn(h.root, '开始跟读'), undefined);
});

test('没有 mediaDevices（http:// + 局域网 IP）：落 blocked_permission(unavailable) 并指向 HTTPS', async () => {
  const unavailable = Object.assign(new Error(
    'openCamera: 这个环境没有可用的摄像头接口（navigator.mediaDevices 缺失）。'
    + 'getUserMedia 只在安全上下文可用：https:// 域名或 localhost。',
  ), { name: 'Error' });
  const h = await harness({ openError: unavailable });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'ready');
  assert.equal(h.events.filter((e) => e.type === 'blocked_permission')[0].payload.reason, 'unavailable');
  assert.match(errorText(h.root), /https/i, '要直接告诉用户换 HTTPS 地址，而不是让他去翻浏览器设置');
});

test('走完一整轮：rewrite 回环、跳过跟读、各态停留时长都进得了快照', async () => {
  let t = 10_000;
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback, clock: () => t });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  t += 3000;                                   // capturing 停留 3s
  await btn(h.root, '快门').click();
  await btn(h.root, '我会读了（开始跟读）').click();
  t += 1000;
  await btn(h.root, '跳过跟读').click();
  t += 4000;                                   // 第一轮 composing 停留 4s
  byTag(h.root, 'textarea')[0].value = 'I put the mug on the desk.';
  await btn(h.root, '提交造句').click();
  // Task 8 起提交是**异步**的（要等服务端/模型回话）：结论落地前界面停在"正在看你这句…"，
  // 那时点「再写一次」是点不到的。所以先等结论落地，再继续走（不用固定 sleep，见夹具说明）。
  await settleFeedback(h);
  t += 500;
  await btn(h.root, '再写一次').click();
  t += 9000;                                   // 第二轮 composing 停留 9s
  byTag(h.root, 'textarea')[0].value = 'I put my mug on the desk.';
  await btn(h.root, '提交造句').click();
  await settleFeedback(h);
  await btn(h.root, '下一个词').click();

  assert.equal(h.machine.state, 'done');
  const snap = h.machine.snapshot();
  assert.equal(snap.rewriteCount, 2, '改写过一版 → 2');
  assert.equal(snap.skippedReading, true);
  assert.equal(snap.dwellMs.composing >= 13_000, true, `composing 停留应 ≥13s，实测 ${snap.dwellMs.composing}`);
  assert.equal(snap.dwellMs.capturing, 3000);
  // 完成页四项指标逐项钉住（只验"改写次数"的话，另外三项被删掉测试不会红）：
  // 提交了 2 次 = 改写过 1 版，所以显示的是 **改写 1 次**（见下一条用例的口径说明）。
  const doneText = text(h.root);
  assert.match(doneText, /改写 1 次/, '完成页要把这些指标摊出来，别只写"完成"');
  assert.doesNotMatch(doneText, /改写 2 次/, '显示的必须是改写次数（提交次数 - 1），不是提交次数');
  assert.match(doneText, /跳过跟读：是/);
  assert.match(doneText, /被退回的帧：0/);
  assert.match(doneText, /各态停留：/);
  assert.match(doneText, /capturing 3\.0s/, '各态停留要摊出真实数值（capturing 实测 3s）');
  assert.match(doneText, /reading 1\.0s/);
  assert.match(doneText, /composing 13\.0s/);
  assert.match(doneText, /feedback 0\.5s/);
  h.restoreFetch();
});

test('完成页：零改写的会话不许说发生过改写（提交 1 次 ≠ 改写 1 次）', async () => {
  // `rewriteCount` 的口径是**提交次数**：第一次提交后它就已经是 1，而这位学习者一次都没回改。
  // 直接把它渲染成"改写 1 次"是在界面上说一句假话，并会误导后续关于"改写行为"的统计。
  const h = await withFetch({
    fetchImpl: okFetch, recognize: realRecognizeWithFallback, ttsWin: fakeTts().win,
  });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
  await btn(h.root, '我会读了（开始跟读）').click();
  await btn(h.root, '我读过了').click();      // 自评打勾那条路（reading → composing，不落判定事件）
  byTag(h.root, 'textarea')[0].value = 'This is my mug.';
  await btn(h.root, '提交造句').click();
  await settleFeedback(h);
  await btn(h.root, '下一个词').click();

  assert.equal(h.machine.state, 'done');
  assert.equal(h.machine.snapshot().rewriteCount, 1, '快照里的字段仍是"提交次数"口径（本任务不重命名字段）');
  const doneText = text(h.root);
  assert.match(doneText, /改写 0 次/, '一次都没回改 → 改写次数必须是 0');
  assert.doesNotMatch(doneText, /改写 [1-9]\d* 次/, '绝不许声称发生过改写');
  h.restoreFetch();
});

test('完成页：被退回一次、没跳过跟读的会话 → 指标各自如实（不是把 0/否 写死）', async () => {
  // 上一轮全轮用例里"被退回的帧：0"与"跳过跟读：是"只钉住了一半：写死常量也能绿。
  // 这一轮把另外两个取值跑出来（被退回 1 次、没跳过），四项指标才算两头都钉住。
  let shot = 0;
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    ttsWin: fakeTts().win,
    grabResult: () => (shot++ === 0
      ? { blob: makeBlob(9), stats: { brightness: 10, laplacianVar: 10 } }
      : { blob: makeBlob(9), stats: OK_STATS }),
  });
  await openCameraAndShoot(h);                 // 第 1 帧太暗 → 退回重拍
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();           // 第 2 帧通过
  await btn(h.root, '我会读了（开始跟读）').click();
  await btn(h.root, '我读过了').click();       // 不是跳过跟读（示范音可用 → 自评打勾）
  byTag(h.root, 'textarea')[0].value = 'I put the mug on the desk.';
  await btn(h.root, '提交造句').click();
  await settleFeedback(h);
  await btn(h.root, '下一个词').click();

  assert.equal(h.machine.state, 'done');
  assert.equal(h.machine.snapshot().frameRejections, 1);
  const doneText = text(h.root);
  assert.match(doneText, /被退回的帧：1/, '被退回的次数要如实摊出来');
  assert.match(doneText, /跳过跟读：否/);
  assert.match(doneText, /改写 0 次/);
  h.restoreFetch();
});

test('造句原文交给注入的钩子，并落一条 compose_submitted（Task 9 起本层自己落盘）', async () => {
  const seen = [];
  // 造句链路注入一个假提交器：本用例测的是**钩子接线**，不是网络。
  // 不注入的话，`mount()` 会去打真的 `/api/feedback`（本用例的全局 fetch 只认识物那条路径，
  // 于是它必然失败——那会把"钩子有没有被调用"这条断言混进一次网络失败里）。
  const compose = { submitSentence: async () => ({ status: 'pending', reason: 'timeout', error: 'timeout', sentence: '' }) };
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    onCompose: (x) => seen.push(x),
    compose,
  });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
  await btn(h.root, '我会读了（开始跟读）').click();
  await btn(h.root, '跳过跟读').click();
  const ta = byTag(h.root, 'textarea')[0];
  assert.ok(ta, 'composing 态必须有输入框');
  ta.value = 'I put the mug on the desk.';
  await btn(h.root, '提交造句').click();
  // 钩子是**提交即回调**（不等反馈）：造句原文的采集不该被模型那边的快慢牵连。
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'I put the mug on the desk.');
  assert.equal(seen[0].rewriteCount, 1);
  assert.equal(seen[0].skippedReading, true);
  // Task 9 起句子**真的落盘**了：`compose_submitted` 是"成人愿为造句付多少成本"这批数据的载体
  // （progress 必办 2；Task 6 曾刻意延后到本任务，免得与 Task 8 的反馈事件重复计数）。
  // 注意它带的是 `submitCount`/`revisions` 两个口径清楚的名字，**不带** `rewriteCount`
  // ——那个名字的含义其实是"提交次数"，落进采集数据就是错的（progress 必办 1）。
  const submitted = h.events.filter((e) => e.type === 'compose_submitted');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].payload.sentence, 'I put the mug on the desk.', '原句一字不改地落盘');
  assert.equal(submitted[0].payload.submitCount, 1, '零改写会话的提交次数是 1');
  assert.equal(submitted[0].payload.revisions, 0);
  assert.equal('rewriteCount' in submitted[0].payload, false, '错名字的字段不许进采集数据');
  // 回改时带出上一版原文：改写回环的意义就是"改"，不该让人重打一遍
  await settleFeedback(h);
  await btn(h.root, '再写一次').click();
  assert.equal(byTag(h.root, 'textarea')[0].value, 'I put the mug on the desk.');
  await btn(h.root, '提交造句').click();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].rewriteCount, 2, '第二轮提交时轮次应为 2');
  await settleFeedback(h);
  const submitted2 = h.events.filter((e) => e.type === 'compose_submitted');
  assert.equal(submitted2.length, 2, '回环第二次提交也要落盘（每次提交各一条）');
  assert.equal(submitted2[1].payload.submitCount, 2);
  assert.equal(submitted2[1].payload.revisions, 1);
  h.restoreFetch();
});

test("「提交造句」按钮只在 composing 态存在：那句 `send('submit')` 的死防御因此不可达", async () => {
  // progress 必办 3 要求"未验证的分支不许静默留在判定路径上"。处置选的是**保留**那句
  // `if (!machine.send('submit')) return;`（fail-closed：万一它真被触发了，那次点击什么都不做，
  // 而不是把一次状态机不知道的提交算进数据），代价是必须给出"它为什么不可能为 false"的证据。
  // 证据就是这条用例：把七态逐个走一遍，`提交造句` 按钮**当且仅当** state === 'composing' 时存在，
  // 而 `machine.can('submit')` 与它逐态一致——`onSubmit` 只可能由这个按钮触发、且只在那一格。
  const compose = { submitSentence: async () => ({ status: 'ok', feedback: {}, sentence: '' }) };
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback, compose });
  // 阶段 A：先把这条"逐态走一遍"钉在**学习页**上——`提交造句` 的存在性判据没变，
  // 变的是"这一屏现在在哪个页签上"。七态仍要逐个走到（下面那条 deepEqual 还在）。
  await gotoLearn(h.root);
  const seen = [];
  const record = (label) => {
    const able = h.machine.can('submit');
    const hasButton = btn(h.root, '提交造句') !== undefined;
    seen.push({ label, state: h.machine.state, able, hasButton });
    assert.equal(hasButton, h.machine.state === 'composing',
      `${label}：提交按钮的存在必须与状态一致（实测 state=${h.machine.state} hasButton=${hasButton}）`);
    assert.equal(able, h.machine.state === 'composing', `${label}：can('submit') 同样只在 composing 为真`);
  };

  record('ready');
  await btn(h.root, '拍照').click();                 // ready → capturing
  record('capturing');
  await btn(h.root, '快门').click();                 // capturing → word
  record('word');
  await btn(h.root, '我会读了（开始跟读）').click();  // word → reading
  record('reading');
  await btn(h.root, '跳过跟读').click();             // reading → composing
  record('composing');
  byTag(h.root, 'textarea')[0].value = 'This is a mug.';
  await btn(h.root, '提交造句').click();             // composing → feedback
  await settleFeedback(h);
  record('feedback');
  await btn(h.root, '下一个词').click();             // feedback → done
  record('done');

  assert.deepEqual(seen.map((s) => s.state),
    ['ready', 'capturing', 'word', 'reading', 'composing', 'feedback', 'done'],
    '七个状态都要走到（少一个这条证据就不完整）');
  assert.equal(seen.filter((s) => s.hasButton).length, 1, '全程只有 composing 那一格有提交按钮');
  h.restoreFetch();
});

test('mount 的入参契约：容器不是元素时抛 TypeError（而不是挂到一半白屏）', async () => {
  const deps = { doc: { createElement: makeEl }, camera: {}, store: { appendEvent() {} } };
  await assert.rejects(() => mount(null, deps), TypeError);
  await assert.rejects(() => mount(undefined, deps), TypeError);
  await assert.rejects(() => mount({}, deps), TypeError);
});

// ─────────────────────── Task 12A：API Key 的设置入口与无 Key 引导 ───────────────────────

/** 一把没有配置任何 Key 的 keyring（空存储）。 */
const emptyKeyring = () => createKeyring({ storage: fakeLocalStorage() });

test('设置（API Key）入口每屏可达：ready 屏与 word 屏都点得进去', async () => {
  const h = await harness();
  // 阶段 A：入口按钮仍然每屏都挂着（壳尾），但"ready 屏"现在指**学习页**那一屏
  // ⇒ 先导航过去，"这一屏上真的够得着设置入口"才算被验到（留在首页验的是另一件事）。
  await gotoLearn(h.root);
  assert.ok(btn(h.root, '设置（API Key）'), 'ready 屏要有设置入口');
  await btn(h.root, '设置（API Key）').click();
  assert.match(text(h.root), /设置 · API Key/);
  await btn(h.root, '返回').click();
  assert.equal(h.machine.state, 'ready', '返回要回到原来的屏');
  // 阶段 A 追加：返回要回到**来处那一页**（不是硬编码回首页）——切走再切回是页签的基本语义
  assert.ok(btn(h.root, '拍照'), '「返回」回到的是点入口时所在的学习页，不是首页');

  const h2 = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback });
  await openCameraAndShoot(h2);
  assert.equal(h2.machine.state, 'word');
  assert.ok(btn(h2.root, '设置（API Key）'), 'word 屏同样要有设置入口（任务书点名 ready/word 可达）');
  h2.restoreFetch();
});

test('设置屏显示"已配置/未配置"，**不回显明文**，输入框永远从空白开始', async () => {
  const h = await harness(); // 夹具默认注入"已配置合成 Key"的 keyring
  await btn(h.root, '设置（API Key）').click();
  assert.match(text(h.root), /已配置/);
  assert.doesNotMatch(text(h.root), /sk-test-harness/, '已配置的 Key 内容绝不回显');
  const inputs = byTag(h.root, 'INPUT');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].value, '', '输入框不预填任何内容');
  assert.equal(inputs[0].type, 'password', '密码型输入：肩窥也看不到');

  await btn(h.root, '清除 Key').click();
  assert.match(text(h.root), /未配置/, '清除后状态当场可见');
});

test('保存：合法的合成 Key 存进注入的 keyring，之后按拍照能正常走链路', async () => {
  const storage = fakeLocalStorage();
  const h = await harness({ keyring: createKeyring({ storage }) });
  await gotoLearn(h.root);
  await btn(h.root, '设置（API Key）').click();
  byTag(h.root, 'INPUT')[0].value = 'sk-test-newly-saved-key';
  await btn(h.root, '保存').click();
  assert.equal(storage.getItem(API_KEY_STORAGE_KEY), 'sk-test-newly-saved-key', 'Key 落进存储');
  assert.equal(h.machine.state, 'ready', '保存成功后回到原屏');
  assert.equal(errorText(h.root), '', '成功路径不留报错');

  // 存好 Key 之后主流程就通了（直连识物需要它）：挂一份新应用、共用同一个存储
  const h2 = await harness({ keyring: createKeyring({ storage }) });
  await gotoLearn(h2.root);
  await btn(h2.root, '拍照').click();
  assert.equal(h2.machine.state, 'capturing', '配好 Key 后拍照放行');
});

test('保存：粘贴不全的 Key（无 sk- 前缀 / 空白）被拦下，错误说人话，且不写存储', async () => {
  const storage = fakeLocalStorage();
  const h = await harness({ keyring: createKeyring({ storage }) });
  await btn(h.root, '设置（API Key）').click();
  for (const bad of ['not-a-key', '   ']) {
    byTag(h.root, 'INPUT')[0].value = bad;
    await btn(h.root, '保存').click();
    assert.match(errorText(h.root), /sk-|空/, '错误区要给出能行动的解释');
    assert.equal(storage.getItem(API_KEY_STORAGE_KEY), null, '校验不过一个字节都不写');
    assert.match(text(h.root), /设置 · API Key/, '留在设置屏让用户改');
  }
});

test('清除：清掉的 Key 从存储里消失，主流程随之被拦下（引导回来）', async () => {
  const h = await harness(); // 默认已配置
  await gotoLearn(h.root);
  await btn(h.root, '设置（API Key）').click();
  await btn(h.root, '清除 Key').click();
  await btn(h.root, '返回').click();
  assert.match(text(h.root), /还没有配置 API Key/, 'ready 屏出现引导文案');
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'ready', '没有 Key 不进拍摄');
  assert.match(errorText(h.root), /设置（API Key）/, '拦下时把出路再指一次');
});

test('无 Key：ready 屏给引导文案（怎么拿 / 为什么需要 / 存哪 / 只存本机），不是死路', async () => {
  const h = await harness({ keyring: emptyKeyring() });
  await gotoLearn(h.root);
  const ready = text(h.root);
  assert.match(ready, /还没有配置 API Key/, '说清现状');
  assert.match(ready, /platform\.deepseek\.com/, '说清去哪拿');
  assert.match(ready, /按用量计费|调用/, '说清为什么需要');
  assert.match(ready, /只保存在这台手机|本机/, '说清存在哪、只存本机');
  assert.ok(btn(h.root, '设置（API Key）'), '出路（设置入口）就在同一屏');
});

test('无 Key 点「拍照」：不开相机、不进 capturing、不落事件，错误区指到设置', async () => {
  const h = await harness({ keyring: emptyKeyring() });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'ready');
  assert.equal(h.calls.openCamera.length, 0, '没有 Key 就不该开相机（反正也发不了请求）');
  assert.equal(h.events.length, 0, '什么都没发生就不落事件（缺 Key 不是一次识物失败）');
  assert.match(errorText(h.root), /设置（API Key）/);
});

test('auth_failed 的反馈降级文案指向设置入口（用户自己能修的一档要说清去哪修）', async () => {
  const compose = {
    submitSentence: async () => ({
      status: 'pending', reason: 'auth_failed', error: 'http_401',
      detail: '模型服务说这个 API Key 无效或没有权限（HTTP 401）。请到「设置（API Key）」检查或重新粘贴。',
      sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
    }),
  };
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback, compose });
  await openCameraAndShoot(h);
  await btn(h.root, '我会读了（开始跟读）').click();
  await btn(h.root, '跳过跟读').click();
  byTag(h.root, 'textarea')[0].value = 'I use a cup.';
  await btn(h.root, '提交造句').click();
  await settleFeedback(h);
  assert.match(text(h.root), /API Key 无效|设置（API Key）/, 'auth_failed 的提示要指回设置');
  h.restoreFetch();
});

test('mount 返回识物链路需要的注入点：machine / sessionId / store / grab', async () => {
  const h = await harness();
  const { machine, sessionId, store, grab } = h.mounted;
  assert.equal(machine.state, 'ready');
  assert.equal(typeof sessionId, 'string');
  assert.ok(sessionId.length > 0);
  assert.equal(store, h.store);
  assert.equal(typeof grab, 'function');
  // 相机还没开时 grab 要响亮拒绝，而不是返回一个空帧
  await assert.rejects(() => grab(), /相机/);
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  const shot = await grab();
  assert.equal(shot.blob.size, 9);
  assert.equal(h.calls.grabFrame.length, 1);
});
