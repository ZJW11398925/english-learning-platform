// tests/camera.test.mjs
//
// 相机单元（`web/units/camera.mjs`）的测试。浏览器 API 全部通过**注入**或**假元素**替换，
// 因此这一整份都能在 Node 里跑：真实路径（真摄像头）留给真机走查，见 task-6-report.md。
//
// 最要紧的一组是「RGBA 直传 computeStats 会抛 / 转灰度后能算」——它正是 task-6 的
// 修正 1/2 存在的理由：brief 的 grabFrame 把 `getImageData().data`（每像素 4 字节）原样
// 交出去，而 computeStats 只收灰度（每像素 1 字节），两者一接就抛 RangeError。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, judgeFrame } from '../web/units/frame-qc.mjs';
import {
  toGrayscale, openCamera, grabFrame, VIDEO_NOT_READY,
} from '../web/units/camera.mjs';

// ───────────────────────────── 假元素（只实现被测代码用到的那一小片）─────────────────────────────

/** 假 video：只有被测代码真正读的几个字段。 */
function fakeVideo({ videoWidth = 0, videoHeight = 0, playError = null } = {}) {
  return {
    videoWidth,
    videoHeight,
    srcObject: null,
    playsInline: false,
    muted: false,
    play() {
      return playError === null ? Promise.resolve() : Promise.reject(playError);
    },
  };
}

/**
 * 假 canvas + 2D 上下文。`getImageData` 按**请求的尺寸**生成缓冲，与真 ImageData 一致
 * （真实现里 width/height 就是请求的那两个数）——所以若被测代码把视频的尺寸当成图像尺寸
 * 传给 computeStats，长度校验会当场抛 RangeError，测试就能看见。
 */
function fakeCanvas({ fill = 128, pixel = null, toBlobResult = 'blob' } = {}) {
  const drawn = [];
  let lastBlobArgs = null;
  const canvas = {
    width: 0,
    height: 0,
    drawn,
    get lastBlobArgs() { return lastBlobArgs; },
    getContext: () => ctx2d,
    toBlob(cb, type, quality) {
      lastBlobArgs = { type, quality };
      cb(toBlobResult === 'blob' ? { size: 1234, type } : toBlobResult);
    },
  };
  const ctx2d = {
    drawImage(src, x, y, w, h) { drawn.push({ src, x, y, w, h }); },
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i += 1) {
        const [r, g, b, a] = pixel === null ? [fill, fill, fill, 255] : pixel(i % w, Math.floor(i / w));
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
      }
      return { data, width: w, height: h };
    },
  };
  return canvas;
}

/** 假 MediaStream：只需能数出轨迹有没有被停掉（摄像头灯有没有关）。 */
function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } },
    { stopped: false, stop() { this.stopped = true; } }];
  return { tracks, getTracks: () => tracks };
}

// ───────────────────────────────────── toGrayscale ─────────────────────────────────────

test('toGrayscale 手算用例：BT.601 权重 + 四舍五入，逐值精确', () => {
  // 6 个像素，通道值手挑：纯红/纯绿/纯蓝/黑/白/混色。期望值在下面手算写死，
  // 不调用被测函数、也不复用它的任何辅助函数（否则这条测试会自己证明自己）。
  //   红 (255,0,0)     → 0.299×255 = 76.245          → 76
  //   绿 (0,255,0)     → 0.587×255 = 149.685         → 150
  //   蓝 (0,0,255)     → 0.114×255 = 29.07           → 29
  //   黑 (0,0,0)       → 0                            → 0
  //   白 (255,255,255) → 255.0                        → 255
  //   混 (100,150,200) → 29.9 + 88.05 + 22.8 = 140.75 → 141（四舍五入，截断会给 140）
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    0, 0, 0, 255,
    255, 255, 255, 255,
    100, 150, 200, 255,
  ]);
  assert.deepEqual([...toGrayscale(rgba, 6, 1)], [76, 150, 29, 0, 255, 141]);
});

test('toGrayscale 忽略 alpha（同一 RGB，alpha 0 与 255 结果相同）', () => {
  const opaque = new Uint8ClampedArray([200, 100, 50, 255]);
  const transparent = new Uint8ClampedArray([200, 100, 50, 0]);
  // 手算：0.299×200 + 0.587×100 + 0.114×50 = 59.8 + 58.7 + 5.7 = 124.2 → 124
  assert.deepEqual([...toGrayscale(opaque, 1, 1)], [124]);
  assert.deepEqual([...toGrayscale(transparent, 1, 1)], [124]);
});

test('toGrayscale 返回 Uint8Array，长度恰为 width*height（不是 RGBA 的 4 倍）', () => {
  const out = toGrayscale(new Uint8ClampedArray(4 * 3 * 4), 4, 3);
  assert.equal(out.constructor, Uint8Array);
  assert.equal(out.length, 12);
});

test('toGrayscale 尺寸契约：非正整数 / 长度不是 width*height*4 / 空值一律抛 RangeError', () => {
  const ok = new Uint8ClampedArray(2 * 2 * 4);
  assert.throws(() => toGrayscale(ok, 0, 2), RangeError);
  assert.throws(() => toGrayscale(ok, 2, -1), RangeError);
  assert.throws(() => toGrayscale(ok, 2.5, 2), RangeError);
  assert.throws(() => toGrayscale(ok, NaN, 2), RangeError);
  // 长度不符必须响亮失败：静默按灰度读前 n 个字节，正是"把 RGBA 当灰度"那类事故的入口
  assert.throws(() => toGrayscale(new Uint8ClampedArray(2 * 2), 2, 2), RangeError);
  assert.throws(() => toGrayscale(ok, 3, 3), RangeError);
  assert.throws(() => toGrayscale(null, 2, 2), RangeError);
  assert.throws(() => toGrayscale(undefined, 2, 2), RangeError);
});

test('超出 0–255 的通道值被夹到 255，不回绕成一个看起来合理的错值', () => {
  // 契约要求通道值 0–255（Uint8ClampedArray 天然满足）；给普通数组时不许静默回绕：
  // 400 会回绕成 144（400 & 0xFF）——一个"看着像真的"的灰度值。夹紧成 255 更诚实。
  assert.deepEqual([...toGrayscale([400, 400, 400, 255], 1, 1)], [255]);
  assert.deepEqual([...toGrayscale([-50, -50, -50, 255], 1, 1)], [0]);
});

// ─────────────────── 回归闸：这一对就是修正 1/2 要防的那个 bug ───────────────────

test('RGBA 直传 computeStats 仍抛 RangeError；先转灰度则返回有限统计量', () => {
  const W = 4;
  const H = 4;
  const rgba = new Uint8ClampedArray(W * H * 4).fill(200);

  // ① 直传 RGBA（brief 的 grabFrame 原先就是把它原样交出去的）→ 响亮抛错
  assert.throws(() => computeStats(rgba, W, H), RangeError,
    '每像素 4 字节的缓冲绝不能被当成灰度读');

  // ② 转灰度之后 → 能算出有限统计量，且亮度等于灰度均值
  const gray = toGrayscale(rgba, W, H);
  assert.equal(gray.length, W * H);
  const stats = computeStats(gray, W, H);
  assert.ok(Number.isFinite(stats.brightness));
  assert.ok(Number.isFinite(stats.laplacianVar));
  assert.equal(stats.brightness, 200);
  assert.equal(stats.laplacianVar, 0);
});

test('全黑 RGBA 帧转灰度后亮度为 0，judgeFrame 如实报 too_dark（不是静默放行）', () => {
  // 直传时那 63.75 的假亮度是 frame-qc 注释里点名的静默降级：全黑帧会被判为可用。
  const rgba = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 8 * 8; i += 1) rgba[i * 4 + 3] = 255; // 纯黑不透明
  const stats = computeStats(toGrayscale(rgba, 8, 8), 8, 8);
  assert.equal(stats.brightness, 0);
  assert.deepEqual(judgeFrame(stats), { ok: false, reason: 'too_dark' });
});

// ───────────────────────────────────── openCamera ─────────────────────────────────────

test('openCamera 用后置相机、理想宽度 1280，并真的把流接到 video 上、等 play()', async () => {
  const calls = [];
  const stream = fakeStream();
  const video = fakeVideo();
  const mediaDevices = {
    async getUserMedia(constraints) { calls.push(constraints); return stream; },
  };
  const returned = await openCamera(video, { mediaDevices });
  assert.equal(returned, stream);
  assert.deepEqual(calls, [{ video: { facingMode: 'environment', width: { ideal: 1280 } } }]);
  assert.equal(video.srcObject, stream);
});

test('openCamera 没有摄像头接口时抛出点明 HTTPS 的错误（http:// + 局域网 IP 的典型症状）', async () => {
  // 这不是"用户拍得不好"，而是配置问题：getUserMedia 只在安全上下文存在。
  // 若直接 `navigator.mediaDevices.getUserMedia(...)`，这里得到的是
  // "Cannot read properties of undefined" —— 谁读谁懵。
  await assert.rejects(() => openCamera(fakeVideo(), { mediaDevices: undefined }),
    (err) => err instanceof Error
      && /mediaDevices/.test(err.message)
      && /HTTPS|https/.test(err.message)
      && !(err instanceof RangeError));
});

test('openCamera 不把 getUserMedia 的拒绝吞掉（不返回一个没有画面的"成功"）', async () => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const mediaDevices = { getUserMedia: async () => { throw denied; } };
  const video = fakeVideo();
  await assert.rejects(() => openCamera(video, { mediaDevices }), /Permission denied/);
  assert.equal(video.srcObject, null);
});

test('play() 失败时停掉所有轨迹再抛（别把摄像头灯留在没人管的状态）', async () => {
  const stream = fakeStream();
  const video = fakeVideo({ playError: new Error('autoplay blocked') });
  await assert.rejects(() => openCamera(video, { mediaDevices: { getUserMedia: async () => stream } }),
    /autoplay blocked/);
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [true, true]);
});

// ───────────────────────────────────── grabFrame ─────────────────────────────────────

test('grabFrame 返回 { blob, stats }：blob 来自 toBlob，stats 供 judgeFrame 直接用', async () => {
  const canvas = fakeCanvas({ fill: 128 });
  const { blob, stats } = await grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), canvas);
  assert.deepEqual(blob, { size: 1234, type: 'image/jpeg' });
  assert.deepEqual(canvas.lastBlobArgs, { type: 'image/jpeg', quality: 0.8 });
  // 纯色帧：亮度等于灰度值，拉普拉斯方差为 0（没有内部纹理）→ 如实被判太糊
  // （合成纯色帧本来就不该通过质检；这条同时证明 stats 真的被 judgeFrame 吃进去了）
  assert.deepEqual(stats, { brightness: 128, laplacianVar: 0 });
  assert.deepEqual(judgeFrame(stats), { ok: false, reason: 'too_blurry' });
  // 返回值里**没有** pixels/width/height：brief 那版把 RGBA 裸缓冲递出去，
  // 下游（Task 7 的 grab 注入点）只声明要 blob 与 stats。
  assert.deepEqual(Object.keys(await grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), canvas)).sort(),
    ['blob', 'stats']);
});

test('grabFrame 的 stats 是灰度统计：明暗相间的帧能通过 judgeFrame（不是恒判太糊）', async () => {
  const canvas = fakeCanvas({ pixel: (x) => (x % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]) });
  const { stats } = await grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), canvas);
  assert.equal(stats.brightness, 127.5);
  assert.ok(stats.laplacianVar > 80, `拉普拉斯方差应显著大于阈值，实测 ${stats.laplacianVar}`);
  assert.deepEqual(judgeFrame(stats), { ok: true, reason: 'ok' });
});

test('grabFrame 按 maxEdge 缩到 512 长边（不放大、不变形）', async () => {
  const canvas = fakeCanvas();
  await grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), canvas);
  assert.equal(canvas.width, 512);
  assert.equal(canvas.height, 384);
  assert.deepEqual(canvas.drawn, [{ src: canvas.drawn[0].src, x: 0, y: 0, w: 512, h: 384 }]);
});

test('grabFrame 拿到小图不放大（320×240 原样取）', async () => {
  const canvas = fakeCanvas();
  await grabFrame(fakeVideo({ videoWidth: 320, videoHeight: 240 }), canvas);
  assert.equal(canvas.width, 320);
  assert.equal(canvas.height, 240);
});

test('grabFrame 传给 computeStats 的尺寸必须与像素缓冲同源（用图像的尺寸，不是视频的）', async () => {
  // 640×480 的视频取 200 长边的帧：若把 videoWidth/videoHeight 当成图像尺寸传下去，
  // 缓冲长度（200×150×4）与 640×480 不符 → computeStats 抛 RangeError。这条钉住那个前提。
  const canvas = fakeCanvas({ fill: 90 });
  const { stats } = await grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), canvas,
    { maxEdge: 200 });
  assert.equal(canvas.width, 200);
  assert.equal(canvas.height, 150);
  assert.deepEqual(stats, { brightness: 90, laplacianVar: 0 });
});

test('grabFrame 视频还没出画时报一条可识别的错，而不是 0×0 的垃圾帧', async () => {
  // 用户在相机还没出画面时就按快门——这是**用户情形**，不是编程错误：错误对象带
  // code = VIDEO_NOT_READY，调用方据此提示"稍等一秒"，不必靠匹配文案。
  await assert.rejects(() => grabFrame(fakeVideo({ videoWidth: 0, videoHeight: 0 }), fakeCanvas()),
    (err) => err instanceof Error && err.code === VIDEO_NOT_READY && !(err instanceof RangeError));
  assert.equal(VIDEO_NOT_READY, 'VIDEO_NOT_READY');
});

test('maxEdge 非正整数时抛 RangeError（不许悄悄拍出一张 1×1 的帧）', async () => {
  const canvas = fakeCanvas();
  // grabFrame 是 async：违约走的是 rejected promise，不是同步 throw。
  await assert.rejects(
    () => grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), canvas, { maxEdge: 0 }), RangeError);
  await assert.rejects(
    () => grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), canvas, { maxEdge: 512.5 }), RangeError);
});

test('toBlob 给回 null（画布编码失败）时抛错，绝不返回一个空 blob 冒充取帧成功', async () => {
  // 真 toBlob 在画布被污染/尺寸为 0 时会以 null 回调；此时若照常返回，
  // Task 7 就会拿 null 去 POST 一趟——失败被静默降级成"发出去了一次识物请求"。
  await assert.rejects(
    () => grabFrame(fakeVideo({ videoWidth: 640, videoHeight: 480 }), fakeCanvas({ toBlobResult: null })),
    /toBlob|null|编码/,
  );
});
