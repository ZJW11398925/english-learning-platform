// tests/album-mount.test.mjs
//
// Task 12B 的**相册导入接线**测试：ready 屏的「从相册选图」入口接进 `mount()` 之后，
// 界面与事件对不对。
//
// 任务书的硬要求是"选中的图片解码后走**同一条**帧质检（judgeFrame）→ 识物链路，
// 事件口径不变（不新增事件类型，roundIndex 连续性照旧）"。所以这一份测试的核心不是
// "相册能用"（那是 tests/album.test.mjs 的单元契约），而是：
//   · ready 屏上「拍照」与「从相册选图」**并列**（拍照按钮保留）；
//   · 选图 → 解码 → 质检 → 识物走的是**真链路**（`realRecognizeWithFallback` +
//     真 judgeFrame），事件与快门那一条完全同形（`recognize_ok` / `frame_rejected`，
//     带 roundIndex）；
//   · 质检**退回**路径：太暗/太糊的相册图同样落 `frame_rejected` 并退回 ready；
//   · 守卫与「拍照」同一条：无 Key 不解码、不落事件；存储写满不派发；
//   · 解码失败（`IMAGE_NOT_READABLE`）是用户情形：如实提示、不抛、不落事件。
//
// 注入 `album`（fakeAlbum）把真解码挡在门外；要跑"真链路"的用例传
// `recognize: realRecognizeWithFallback` 并接管全局 fetch（与 app-mount 同一打法）。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  harness, withFetch, okFetch, realRecognizeWithFallback,
  fakeAlbum, gotoLearn, disposeAllHarnesses,
} from './helpers/mount-harness.mjs';
import { createKeyring } from '../web/units/keyring.mjs';
import { fakeLocalStorage } from './helpers/fakes.mjs';

// 每条用例之后拆掉 mount 挂的定时器（待补反馈的自动重试会挂 10 秒的 setTimeout，
// 而 node --test 会等事件循环空掉才退出——不清的话每个挂载测试文件都白等 10 秒起）。
afterEach(disposeAllHarnesses);
import { btn, byTag, text, errorText } from './helpers/dom.mjs';

/** 空存储的 keyring（未配置 Key——与 app-mount 的 emptyKeyring 同款）。 */
const emptyKeyring = () => createKeyring({ storage: fakeLocalStorage() });

/** ready 屏上那个文件选择器（`input[type=file][accept=image/*]`）。 */
function albumInputOf(h) {
  return byTag(h.root, 'INPUT').find((i) => i.type === 'file' && i.accept === 'image/*');
}

/** 模拟"从相册选中一张图"：塞进 files 并触发 change（浏览器里由文件选择器触发）。 */
function pickImage(h, file) {
  const input = albumInputOf(h);
  assert.ok(input, 'ready 屏必须有相册选图的文件选择器');
  input.files = [file];
  return input.fire('change');
}

/** files 为空（用户取消选择）的 change。 */
function pickImageNoFile(h) {
  const input = albumInputOf(h);
  input.files = [];
  return input.fire('change');
}

/** 被选中的文件（真 File——真链路里 recognize 要读 blob 的形状）。 */
const makeFile = (size = 40_000) => new File([new Uint8Array(size)], 'photo.jpg', { type: 'image/jpeg' });

// ─────────────────────────── 入口与守卫 ───────────────────────────

test('ready 屏：「拍照」与「从相册选图」并列，文件选择器限定 image/*', async () => {
  const h = await harness();
  await gotoLearn(h.root);   // 阶段 A：相册入口长在**学习页的 ready 屏**上（默认页是首页）
  assert.ok(btn(h.root, '拍照'), '拍照按钮保留');
  assert.ok(btn(h.root, '从相册选图'), '并列的相册入口');
  const input = albumInputOf(h);
  assert.ok(input, '入口背后必须是 input[type=file]');
  assert.equal(input.accept, 'image/*');
});

test('无 Key 选图：不开解码、不落事件、留在 ready，错误区指到设置（与「拍照」同一条守卫）', async () => {
  const { module: albumModule, calls } = fakeAlbum();
  const h = await harness({ album: albumModule, keyring: emptyKeyring() });
  await gotoLearn(h.root);
  await pickImage(h, makeFile());

  assert.equal(h.machine.state, 'ready');
  assert.equal(calls.length, 0, '没有 Key 就不该解码（解码出来也发不了）');
  assert.equal(h.events.length, 0, '什么都没发生就不落事件（缺 Key 不是一次识物失败）');
  assert.match(errorText(h.root), /API Key|设置（API Key）/);
});

test('存储写满：选图不派发新任务（与「拍照」同一条闸）', async () => {
  const { module: albumModule, calls } = fakeAlbum();
  const h = await harness({ album: albumModule });
  await gotoLearn(h.root);
  h.store.markStoreFull();                    // 直接置起"写满"现场（幂等，不抛）
  await pickImage(h, makeFile());

  assert.equal(calls.length, 0, '写满时不解码、不派发');
  assert.match(errorText(h.root), /存储写满|先别开新任务/);
});

test('用户取消选择（没有文件）→ 什么都不发生：不解码、不落事件、无报错', async () => {
  const { module: albumModule, calls } = fakeAlbum();
  const h = await harness({ album: albumModule });
  await gotoLearn(h.root);
  await pickImageNoFile(h);

  assert.equal(calls.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(errorText(h.root), '');
});

// ─────────────────────────── 同一条链路：识别成功 ───────────────────────────

test('选图（质检过 + 识物命中）→ 进 word、落 recognize_ok（带 roundIndex），不碰相机', async () => {
  const { module: albumModule, calls } = fakeAlbum();
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    album: albumModule,
  });
  await gotoLearn(h.root);
  await pickImage(h, makeFile());

  assert.equal(h.machine.state, 'word');
  assert.equal(calls.length, 1, '选中的文件要真的交给解码单元');
  assert.equal(h.calls.openCamera.length, 0, '相册路径不开相机');
  assert.equal(byTag(h.root, 'h2')[0].textContent, 'mug', '取到的词照常显示');

  const okEvents = h.events.filter((e) => e.type === 'recognize_ok');
  assert.equal(okEvents.length, 1, '走的就是识物链路的事件口径');
  assert.equal(okEvents[0].roundIndex, 1, '轮次照旧：一次"取词动作" = 一轮');
  assert.equal(okEvents[0].payload.word, 'mug');
  assert.equal(Number.isFinite(okEvents[0].payload.latencyMs), true, '耗时口径与快门同一条（实测值）');
  h.restoreFetch();
});

test('相册选图与拍照在同一条轮次序列里：拒帧第 1 轮 → 选图成功第 2 轮（roundIndex 连续）', async () => {
  // 第一张太暗（frame_rejected，roundIndex 1，退回 ready）→ 第二张通过（recognize_ok，roundIndex 2）。
  // 事件流里同一会话的轮次 1、2 连续——"两条输入源、一条链路、轮次照旧"就是这一条。
  const dark = fakeAlbum({ stats: { brightness: 10, laplacianVar: 10 } });
  const fine = fakeAlbum();
  let pick = 0;
  const albumModule = {
    IMAGE_NOT_READABLE: 'IMAGE_NOT_READABLE',
    async frameFromImageFile(file, canvas, opts) {
      pick += 1;
      return (pick === 1 ? dark : fine).module.frameFromImageFile(file, canvas, opts);
    },
  };
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    album: albumModule,
  });

  await gotoLearn(h.root);
  await pickImage(h, makeFile());              // 第 1 轮：太暗 → 退回 ready
  assert.equal(h.machine.state, 'ready');
  await pickImage(h, makeFile());              // 第 2 轮：通过 → word
  assert.equal(h.machine.state, 'word');

  const rejected = h.events.filter((e) => e.type === 'frame_rejected');
  const okEvents = h.events.filter((e) => e.type === 'recognize_ok');
  assert.equal(rejected.length, 1);
  assert.equal(okEvents.length, 1);
  assert.deepEqual(
    [rejected[0].roundIndex, okEvents[0].roundIndex],
    [1, 2],
    '两类结论事件共用一个轮次序列，1、2 连续不跳号',
  );
  h.restoreFetch();
});

// ─────────────────────────── 同一条链路：质检退回 ───────────────────────────

test('相册图太暗 → 真质检退回：落 frame_rejected（带 reason）、退回 ready、提示重拍，模型没被问', async () => {
  const { module: albumModule } = fakeAlbum({ stats: { brightness: 10, laplacianVar: 10 } });
  let fetched = false;
  const h = await withFetch({
    fetchImpl: async (url) => { fetched = true; return okFetch(url); },
    recognize: realRecognizeWithFallback,
    album: albumModule,
  });
  await gotoLearn(h.root);
  await pickImage(h, makeFile());

  assert.equal(h.machine.state, 'ready', '被拒的帧要退回重拍（与快门同一格语义）');
  const rejected = h.events.filter((e) => e.type === 'frame_rejected');
  assert.equal(rejected.length, 1, '拒帧必须落事件（判据 B 的输入，两条输入源一个口径）');
  assert.deepEqual(rejected[0].payload, { reason: 'too_dark' });
  assert.equal(rejected[0].roundIndex, 1, '端侧拦下的重拍也是一轮');
  assert.equal(fetched, false, '没送到模型（attempts 0 的口径在链路里，这里钉住的是"没发请求"）');
  assert.match(text(h.root), /刚才那张太暗/, '拒帧提示与快门路径同一份文案');
  h.restoreFetch();
});

test('相册图太糊 → 落 too_blurry（理由不许串档）', async () => {
  const { module: albumModule } = fakeAlbum({ stats: { brightness: 128, laplacianVar: 1 } });
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    album: albumModule,
  });
  await gotoLearn(h.root);
  await pickImage(h, makeFile());
  assert.equal(h.machine.state, 'ready');
  assert.deepEqual(h.events.filter((e) => e.type === 'frame_rejected')[0].payload, { reason: 'too_blurry' });
  assert.match(text(h.root), /刚才那张有点糊/);
  h.restoreFetch();
});

test('拒帧退回后「拍照」与「从相册选图」都还在（两条输入源都是完整的出路）', async () => {
  const { module: albumModule } = fakeAlbum({ stats: { brightness: 10, laplacianVar: 10 } });
  const h = await withFetch({
    fetchImpl: okFetch,
    recognize: realRecognizeWithFallback,
    album: albumModule,
  });
  await gotoLearn(h.root);
  await pickImage(h, makeFile());
  assert.equal(h.machine.state, 'ready');
  assert.ok(btn(h.root, '拍照'), '退回后相机入口照旧');
  assert.ok(albumInputOf(h), '退回后相册入口也照旧');
  h.restoreFetch();
});

// ─────────────────────────── 解码失败（用户情形）───────────────────────────

test('图片打不开（IMAGE_NOT_READABLE）→ 如实提示、不抛、不落事件、留在 ready', async () => {
  const boom = Object.assign(new Error('这张图片打不开（解码失败）：broken'), { code: 'IMAGE_NOT_READABLE' });
  const { module: albumModule, calls } = fakeAlbum({ error: boom });
  const h = await harness({ album: albumModule });
  await gotoLearn(h.root);
  await pickImage(h, makeFile());

  assert.equal(h.machine.state, 'ready', '这不是一次识物，状态机不许动');
  assert.equal(h.events.length, 0, '没有产出结论就不落事件（roundIndex 连续性照旧）');
  assert.match(errorText(h.root), /打不开|换一张/, '给用户情形的提示，不是程序缺陷的措辞');
  assert.doesNotMatch(errorText(h.root), /程序缺陷/);
  assert.equal(calls.length, 1, '解码单元确实被调过（错误是它如实报上来的）');
});

test('解码单元抛出的其它错误（未知故障）照旧响亮重抛，绝不静默变成一次拒帧', async () => {
  const boom = new Error('编码失败：toBlob 收到 null');
  const { module: albumModule } = fakeAlbum({ error: boom });
  const h = await harness({ album: albumModule });
  await gotoLearn(h.root);
  await assert.rejects(() => pickImage(h, makeFile()), /编码失败/);
  assert.equal(h.events.length, 0, '没有 frame_rejected、没有任何事件——未知错误不许被记成用户情形');
});
