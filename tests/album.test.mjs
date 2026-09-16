// tests/album.test.mjs
//
// 相册导入单元（`web/units/album.mjs`，Task 12B）的测试。
//
// 这一个单元只做一件事：把用户从相册选的一张图，变成与 `camera.grabFrame` **同形状**的一帧
// `{ blob, stats }`——`stats` 直接可喂 `judgeFrame`，`blob` 直接可进 `recognize`。
// 于是"从相册选图"与"按快门"在帧质检与识物链路眼里是**同一种东西**：两条输入源，
// 一条链路（Task 12B 的任务书原文）。事件口径不变（不新增事件类型）的保证就落在这里：
// 装配层拿到的帧与相机帧无法区分，后续代码完全共用。
//
// 浏览器 API（createImageBitmap / canvas / toBlob）全部通过**注入**或**假元素**替换，
// 整份能在 Node 里跑；与 tests/camera.test.mjs 同一套打法。灰度转换**复用** camera 的
// `toGrayscale`（转换只有一个起源），所以 RGBA 直传 computeStats 会抛的那组断言
// 在 tests/camera.test.mjs 里已有，这里钉的是 album 自己的三件事：
//   1. 解码失败必须带 `IMAGE_NOT_READABLE` 码响亮失败（装配层据此与"程序缺陷"分档）；
//   2. 缩放口径与相机同一条（只缩不放、长边 512、JPEG q0.8）——这样 32 MiB 的
//      data URL 上限（recognize.mjs 里的最后一道闸）对相册帧同样自动成立；
//   3. 位图用完即关（手机内存里一张 12MP 的解码图占几十 MB，不关就是泄漏）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameFromImageFile, IMAGE_NOT_READABLE } from '../web/units/album.mjs';

// ───────────────────────────── 假元素（只实现被测代码用到的那一小片）─────────────────────────────

/** 假位图：真 createImageBitmap 返回的那种形状（width/height/close）。 */
function fakeBitmap({ width = 640, height = 480, closeThrows = false } = {}) {
  let closed = false;
  return {
    width,
    height,
    get closed() { return closed; },
    close() {
      if (closeThrows) throw new Error('close 不该把主流程带崩');
      closed = true;
    },
  };
}

/**
 * 假 canvas + 2D 上下文（与 tests/camera.test.mjs 同构）：`getImageData` 按**请求的尺寸**
 * 生成缓冲——若被测代码把位图的原始尺寸当成缩后图的尺寸传下去，长度校验会当场抛 RangeError。
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

/** 被选中的文件：真 File（浏览器 file input 给的就是它），测试里用真 Blob 兜底也可。 */
const makeFile = (size = 40_000, type = 'image/jpeg') => new File([new Uint8Array(size)], 'photo.jpg', { type });

// ───────────────────────────────────── 正常路径 ─────────────────────────────────────

test('选一张图 → 产出与 grabFrame 同形状的 { blob, stats }：stats 直接能喂 judgeFrame', async () => {
  const bmp = fakeBitmap({ width: 640, height: 480 });
  const canvas = fakeCanvas();
  const file = makeFile();
  const shot = await frameFromImageFile(file, canvas, {
    createBitmap: async () => bmp,
  });

  assert.ok(shot.blob, '要产出一张可上传的 blob');
  // 与 judgeFrame 的契约对上：两个字段都必须是有限数值（灰度过 128 的假 canvas → brightness=128）
  assert.equal(shot.stats.brightness, 128);
  assert.equal(Number.isFinite(shot.stats.laplacianVar), true,
    'NaN 会伪装成合法读数；judgeFrame 见 NaN 会响亮抛 RangeError');
});

test('缩放口径与相机同一条：只缩不放、长边默认 512、JPEG 质量 0.8', async () => {
  // 12MP 的照片（4000×3000）→ 缩到 512 长边；小图（200×100）保持原尺寸不放大
  const big = fakeBitmap({ width: 4000, height: 3000 });
  const bigCanvas = fakeCanvas();
  await frameFromImageFile(makeFile(), bigCanvas, { createBitmap: async () => big });
  assert.deepEqual(
    { w: bigCanvas.width, h: bigCanvas.height },
    { w: 512, h: 384 },
    '大图必须缩到长边 512（与 camera.grabFrame 同一默认）',
  );
  assert.equal(bigCanvas.lastBlobArgs.type, 'image/jpeg');
  assert.equal(bigCanvas.lastBlobArgs.quality, 0.8);

  const small = fakeBitmap({ width: 200, height: 100 });
  const smallCanvas = fakeCanvas();
  await frameFromImageFile(makeFile(), smallCanvas, { createBitmap: async () => small });
  assert.deepEqual(
    { w: smallCanvas.width, h: smallCanvas.height },
    { w: 200, h: 100 },
    '小图不许被放大（放大不增加信息，只多花钱）',
  );
});

test('解码出的位图用完即关（12MP 解码图占几十 MB，不关就是泄漏）', async () => {
  const bmp = fakeBitmap();
  const canvas = fakeCanvas();
  await frameFromImageFile(makeFile(), canvas, { createBitmap: async () => bmp });
  assert.equal(bmp.closed, true, '画完就该 close，不能等 GC');
});

test('toBlob 给回 null 时响亮失败（与 camera.grabFrame 同一条纪律：绝不拿空 blob 冒充成功）', async () => {
  const canvas = fakeCanvas({ toBlobResult: null });
  await assert.rejects(
    () => frameFromImageFile(makeFile(), canvas, { createBitmap: async () => fakeBitmap() }),
    /编码失败/,
  );
});

// ───────────────────────────────────── 解码失败 ─────────────────────────────────────

test('解码失败（图片损坏/格式不支持）→ 抛带 IMAGE_NOT_READABLE 码的错误（装配层据此给用户情形的文案）', async () => {
  const canvas = fakeCanvas();
  await assert.rejects(
    () => frameFromImageFile(makeFile(), canvas, {
      createBitmap: async () => { throw new Error('broken image'); },
    }),
    (err) => {
      assert.equal(err.code, IMAGE_NOT_READABLE, '必须带可识别的 code，不许让装配层猜');
      assert.match(err.message, /打不开|解码/);
      return true;
    },
  );
});

test('位图尺寸不合法（0 / 负数 / 非整数）同样按"打不开"处理，不进画布', async () => {
  for (const dims of [{ width: 0, height: 100 }, { width: 100, height: -1 }, { width: 2.5, height: 10 }]) {
    const canvas = fakeCanvas();
    await assert.rejects(
      () => frameFromImageFile(makeFile(), canvas, {
        createBitmap: async () => fakeBitmap(dims),
      }),
      (err) => {
        assert.equal(err.code, IMAGE_NOT_READABLE);
        assert.equal(canvas.drawn.length, 0, '没画过东西就不该走到编码');
        return true;
      },
    );
  }
});

test('close 抛错不影响主流程（清理不该把取帧带崩）', async () => {
  const bmp = fakeBitmap({ closeThrows: true });
  const canvas = fakeCanvas();
  const shot = await frameFromImageFile(makeFile(), canvas, { createBitmap: async () => bmp });
  assert.ok(shot.blob);
});

// ───────────────────────────────────── 参数契约 ─────────────────────────────────────

test('maxEdge 必须是正整数（与 camera.grabFrame 同一把尺），0 / 非整数抛 RangeError', async () => {
  const canvas = fakeCanvas();
  for (const bad of [0, -1, 2.5, NaN]) {
    await assert.rejects(
      () => frameFromImageFile(makeFile(), canvas, { maxEdge: bad, createBitmap: async () => fakeBitmap() }),
      RangeError,
    );
  }
});

test('没给 createBitmap 时用全局的（缺了给出带原因的失败，不是 undefined is not a function）', async () => {
  const canvas = fakeCanvas();
  const original = globalThis.createImageBitmap;
  delete globalThis.createImageBitmap;
  try {
    await assert.rejects(
      () => frameFromImageFile(makeFile(), canvas),
      (err) => {
        assert.equal(err.code, IMAGE_NOT_READABLE, '缺解码器也是"这张图处理不了"这一档');
        assert.match(err.message, /createImageBitmap|解码|打不开/);
        return true;
      },
    );
  } finally {
    if (original === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = original;
  }
});

test('缺文件（null / undefined）响亮失败：装配层的"用户取消"分支不该走到这里', async () => {
  const canvas = fakeCanvas();
  await assert.rejects(() => frameFromImageFile(null, canvas, { createBitmap: async () => fakeBitmap() }), /文件|图/);
  await assert.rejects(() => frameFromImageFile(undefined, canvas, { createBitmap: async () => fakeBitmap() }), /文件|图/);
});

test('stats 与质检的真实对接：一张全黑图（fill 0）会被 judgeFrame 判 too_dark（全链路口径一致）', async () => {
  // 这一条把"同一条帧质检链路"从形状对齐到**数值**对齐：假 canvas 出全黑 RGBA，
  // album 出 stats，judgeFrame 的判定必须与相机路径对同一张图的判定一致。
  const { judgeFrame } = await import('../web/units/frame-qc.mjs');
  const canvas = fakeCanvas({ fill: 0 });
  const shot = await frameFromImageFile(
    makeFile(),
    canvas,
    { createBitmap: async () => fakeBitmap({ width: 16, height: 16 }) },
  );
  const verdict = judgeFrame(shot.stats);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too_dark');
});
