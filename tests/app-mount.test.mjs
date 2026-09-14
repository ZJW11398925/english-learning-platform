// tests/app-mount.test.mjs
//
// `mount()`（web/app.mjs 的浏览器装配层）的测试。用**假 DOM** 跑，所以整份都能在 Node 里跑。
//
// 为什么值得测这一层（而不是"骨架而已，等 Task 7 再说"）：这一层是**唯一**判断
// "这帧能不能送识别"的地方，而它最容易犯的错正是全局约束 3 禁止的那两种：
//   ① 质检说 { ok: false } 却不落 frame_rejected（用户看到重拍提示，但计数里没有——retry_rate 失真）；
//   ② judgeFrame 抛的 RangeError 被 catch 成"这张照片不行"（编程缺陷被伪装成用户问题）。
// 两条都有专门用例。
//
// 注入的是 store / camera / urlApi / 时钟；**不注入** recordEvent 与 judgeFrame——
// 用真实的 event-log（顺带验证 mount 落的事件类型都是登记过的）与真实的 frame-qc 判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../web/app.mjs';

// ───────────────────────────── 假 DOM（只实现 mount 用到的那一小片）─────────────────────────────

function makeEl(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    attributes: {},
    setAttribute(k, v) { el.attributes[k] = v; },
    append(...nodes) { el.children.push(...nodes); },
    replaceChildren(...nodes) { el.children = nodes; },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    /** 返回回调的返回值：mount 的 click 回调是 async，测试要能 await 到它的拒绝。 */
    click() {
      const fns = listeners.get('click') ?? [];
      const results = fns.map((fn) => fn({ type: 'click' }));
      return results.length === 1 ? results[0] : Promise.all(results);
    },
  };
  if (el.tagName === 'VIDEO') {
    el.videoWidth = 640;
    el.videoHeight = 480;
    el.srcObject = null;
    el.playCalls = 0;
    el.play = async () => { el.playCalls += 1; };
  }
  return el;
}

const walk = (el) => [el, ...el.children.flatMap(walk)];
const byTag = (root, tag) => walk(root).filter((e) => e.tagName === tag.toUpperCase());
const btn = (root, text) => byTag(root, 'button').find((b) => b.textContent.includes(text));
const text = (root) => walk(root).map((e) => `${e.textContent}${e.value}`).join(' ');
const errorText = (root) => walk(root).filter((e) => e.className === 'error').map((e) => e.textContent).join(' ');

// ───────────────────────────────────── 测试夹具 ─────────────────────────────────────

const OK_STATS = { brightness: 128, laplacianVar: 200 };

function harness({
  grabResult = { blob: { size: 9, type: 'image/jpeg' }, stats: OK_STATS },
  grabError = null,
  openError = null,
  clock = Date.now,
  onCompose = null,
} = {}) {
  const root = makeEl('div');
  const calls = { openCamera: [], grabFrame: [] };
  const stream = {
    tracks: [{ stopped: false, stop() { this.stopped = true; } },
      { stopped: false, stop() { this.stopped = true; } }],
    getTracks() { return this.tracks; },
  };
  const camera = {
    VIDEO_NOT_READY: 'VIDEO_NOT_READY',
    async openCamera(video, opts) {
      calls.openCamera.push({ video, opts });
      if (openError !== null) throw openError;
      video.srcObject = stream;
      await video.play();
      return stream;
    },
    async grabFrame(video, canvas, opts) {
      calls.grabFrame.push({ video, canvas, opts });
      if (grabError !== null) throw grabError;
      return grabResult;
    },
  };
  const store = { appended: [], appendEvent(e) { store.appended.push(e); } };
  let urls = 0;
  const urlApi = { createObjectURL: () => `blob:fake-${urls += 1}`, revokeObjectURL: () => {} };

  return mount(root, { doc: { createElement: makeEl }, camera, store, urlApi, clock, onCompose })
    .then((mounted) => ({
      root, calls, stream, store, mounted, events: store.appended, sessionId: mounted.sessionId,
      machine: mounted.machine,
    }));
}

const openCameraAndShoot = async (h) => {
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
};

// ───────────────────────────────────── 用例 ─────────────────────────────────────

test('首屏停在 ready：只有「拍照」一个主动作，没有任何假入口', async () => {
  const h = await harness();
  assert.equal(h.machine.state, 'ready');
  assert.ok(btn(h.root, '拍照'), 'ready 态必须有拍照按钮');
  assert.equal(btn(h.root, '开始跟读'), undefined, '没取到词之前不许出现"进入跟读"');
  assert.equal(btn(h.root, '提交造句'), undefined, '没取到词之前不许出现造句框');
  assert.match(text(h.root), /状态：ready/);
});

test('点「拍照」：开后置相机、把流接上 video，进 capturing 并出现「快门」', async () => {
  const h = await harness();
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

test('快门：质检通过 → 冻结这一帧进 word，并明说识物未接入（不伪造词）', async () => {
  const h = await harness();
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'word');
  assert.equal(h.calls.grabFrame.length, 1, '快门必须真的取一帧');
  assert.equal(h.events.filter((e) => e.type === 'frame_rejected').length, 0, '通过的帧不该落拒帧事件');

  const img = byTag(h.root, 'img')[0];
  assert.ok(img, 'word 态要显示冻结的那一帧');
  assert.equal(img.src, 'blob:fake-1');

  assert.match(text(h.root), /Task 7/, '占位必须点明识物尚未接入');
  // 镜头必须关掉：摄像头灯亮着整个会话既费电又吓人
  assert.deepEqual(h.stream.tracks.map((t) => t.stopped), [true, true]);
});

test('快门：质检不通过 → 如实落一条 frame_rejected（带 reason），退回 ready 并提示重拍', async () => {
  const h = await harness({ grabResult: { blob: { size: 9 }, stats: { brightness: 10, laplacianVar: 10 } } });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'ready', '被拒的帧要退回拍摄态重拍');
  assert.equal(h.machine.snapshot().frameRejections, 1);

  const rejected = h.events.filter((e) => e.type === 'frame_rejected');
  assert.equal(rejected.length, 1, '拒帧必须落事件，否则 retry_rate 失真');
  assert.deepEqual(rejected[0].payload, { reason: 'too_dark' });
  assert.equal(rejected[0].sessionId, h.sessionId);
  assert.equal(rejected[0].wordId, null);
  assert.ok(Number.isFinite(rejected[0].ts));
  assert.match(text(h.root), /太暗/, '要告诉用户为什么被退回');
  assert.ok(btn(h.root, '拍照'), '退回后还能重拍');
});

test('快门：模糊帧同样退回并落 too_blurry（不是一律报太暗）', async () => {
  const h = await harness({ grabResult: { blob: { size: 9 }, stats: { brightness: 128, laplacianVar: 1 } } });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'ready');
  assert.deepEqual(h.events.filter((e) => e.type === 'frame_rejected')[0].payload, { reason: 'too_blurry' });
  assert.match(text(h.root), /糊/);
});

test('快门：judgeFrame 抛 RangeError 时绝不改判成"这张照片不行"（显示 + 原样重抛）', async () => {
  // stats 里放 NaN：judgeFrame 按契约抛 RangeError（编程错误）。它必须是**刺眼的**，
  // 不许被 catch 成一次用户可见的拒帧——那会把 bug 记到用户头上，并污染 retry_rate。
  const h = await harness({ grabResult: { blob: { size: 9 }, stats: { brightness: NaN, laplacianVar: 10 } } });
  await btn(h.root, '拍照').click();
  await assert.rejects(() => btn(h.root, '快门').click(), RangeError, 'RangeError 必须继续往上冒');
  assert.equal(h.machine.state, 'capturing', '状态不许被这次异常推动');
  assert.equal(h.machine.snapshot().frameRejections, 0);
  assert.equal(h.events.length, 0, '一条 frame_rejected 都不许落');
  assert.match(errorText(h.root), /程序缺陷/, '界面上也要说清这是程序问题，不是照片问题');
});

test('快门：视频还没出画（按太早）→ 只提示稍候，不落事件、不改状态', async () => {
  const notReady = Object.assign(new Error('grabFrame: 视频还没出画'), { code: 'VIDEO_NOT_READY' });
  const h = await harness({ grabError: notReady });
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
  assert.equal(h.machine.state, 'capturing', '还在取景，等下一按');
  assert.equal(h.events.length, 0, '这不是一次"照片被拒"，不该落 frame_rejected');
  assert.equal(h.machine.snapshot().frameRejections, 0);
  assert.match(text(h.root), /稍等|准备好/);
});

test('快门：其它取帧错误原样重抛（不静默变成功、也不变成拒帧）', async () => {
  const boom = new Error('取帧时炸了');
  const h = await harness({ grabError: boom });
  await btn(h.root, '拍照').click();
  await assert.rejects(() => btn(h.root, '快门').click(), /取帧时炸了/);
  assert.equal(h.machine.state, 'capturing');
  assert.equal(h.events.length, 0);
  assert.match(errorText(h.root), /取帧失败/);
});

test('连点两次「拍照」只开一路相机（手机上双击不该开出两路流）', async () => {
  const h = await harness();
  const first = btn(h.root, '拍照').click();
  const second = btn(h.root, '拍照').click();   // 状态还没变，按钮还在，第二次点击真的会发生
  await Promise.all([first, second]);
  assert.equal(h.machine.state, 'capturing');
  assert.equal(h.calls.openCamera.length, 1, '第二次点击必须被"正在开相机"挡住，否则多一路流没人关');
});

test('相机授权被拒：落 blocked_permission(denied)、留在 ready、按钮留着让用户改完设置再试', async () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const h = await harness({ openError: denied });
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
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'ready');
  assert.equal(h.events.filter((e) => e.type === 'blocked_permission')[0].payload.reason, 'unavailable');
  assert.match(errorText(h.root), /https/i, '要直接告诉用户换 HTTPS 地址，而不是让他去翻浏览器设置');
});

test('走完一整轮：rewrite 回环、跳过跟读、各态停留时长都进得了快照', async () => {
  let t = 10_000;
  const h = await harness({ clock: () => t });
  await btn(h.root, '拍照').click();
  t += 3000;                                   // capturing 停留 3s
  await btn(h.root, '快门').click();
  await btn(h.root, '我会读了（开始跟读）').click();
  t += 1000;
  await btn(h.root, '跳过跟读').click();
  t += 4000;                                   // 第一轮 composing 停留 4s
  await btn(h.root, '提交造句').click();
  t += 500;
  await btn(h.root, '再写一次').click();
  t += 9000;                                   // 第二轮 composing 停留 9s
  await btn(h.root, '提交造句').click();
  await btn(h.root, '下一个词').click();

  assert.equal(h.machine.state, 'done');
  const snap = h.machine.snapshot();
  assert.equal(snap.rewriteCount, 2, '改写过一版 → 2');
  assert.equal(snap.skippedReading, true);
  assert.equal(snap.dwellMs.composing >= 13_000, true, `composing 停留应 ≥13s，实测 ${snap.dwellMs.composing}`);
  assert.equal(snap.dwellMs.capturing, 3000);
  assert.match(text(h.root), /改写 2 次/, '完成页要把这两个指标摊出来，别只写"完成"');
});

test('造句原文交给注入的钩子（Task 8/9 的接线点），不自己落盘', async () => {
  const seen = [];
  const h = await harness({ onCompose: (x) => seen.push(x) });
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
  await btn(h.root, '我会读了（开始跟读）').click();
  await btn(h.root, '跳过跟读').click();
  const ta = byTag(h.root, 'textarea')[0];
  assert.ok(ta, 'composing 态必须有输入框');
  ta.value = 'I put the mug on the desk.';
  await btn(h.root, '提交造句').click();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'I put the mug on the desk.');
  assert.equal(seen[0].rewriteCount, 1);
  assert.equal(seen[0].skippedReading, true);
  // 事件表里没有 compose_submitted —— 那是 Task 9 的口径，本任务不抢着记一遍（免得重复计数）
  assert.equal(h.events.filter((e) => e.type === 'compose_submitted').length, 0);
  // 回改时带出上一版原文：改写回环的意义就是"改"，不该让人重打一遍
  await btn(h.root, '再写一次').click();
  assert.equal(byTag(h.root, 'textarea')[0].value, 'I put the mug on the desk.');
  await btn(h.root, '提交造句').click();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].rewriteCount, 2, '第二轮提交时轮次应为 2');
});

test('mount 的入参契约：容器不是元素时抛 TypeError（而不是挂到一半白屏）', async () => {
  const deps = { doc: { createElement: makeEl }, camera: {}, store: { appendEvent() {} } };
  await assert.rejects(() => mount(null, deps), TypeError);
  await assert.rejects(() => mount(undefined, deps), TypeError);
  await assert.rejects(() => mount({}, deps), TypeError);
});

test('mount 返回 Task 7 需要的注入点：machine / sessionId / store / grab', async () => {
  const h = await harness();
  const { machine, sessionId, store, grab } = h.mounted;
  assert.equal(machine.state, 'ready');
  assert.equal(typeof sessionId, 'string');
  assert.ok(sessionId.length > 0);
  assert.equal(store, h.store);
  assert.equal(typeof grab, 'function');
  // 相机还没开时 grab 要响亮拒绝，而不是返回一个空帧
  await assert.rejects(() => grab(), /相机/);
  await btn(h.root, '拍照').click();
  const shot = await grab();
  assert.equal(shot.blob.size, 9);
  assert.equal(h.calls.grabFrame.length, 1);
});
