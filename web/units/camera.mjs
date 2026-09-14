// web/units/camera.mjs
//
// 相机单元：`getUserMedia` 开流 + 从 video 取一帧。
//
// 分工（与 frame-qc.mjs 的注释一致，**不要**把转换搬进 frame-qc）：
//   · 本模块负责 **RGBA → 灰度**（`toGrayscale`），因为"每像素 4 字节"这件事只在拉帧这一侧成立；
//   · `computeStats` 只收**每像素 1 字节**的灰度缓冲，长度必须恰为 `width * height`，
//     收到 RGBA 会**响亮抛 RangeError**（`tests/camera.test.mjs` 里有一对专门的回归断言）。
//
// 为什么 grabFrame 返回 `{ blob, stats }` 而不是把 ImageData 裸递出去（brief 那版）：
// Task 7 的注入点就是 `const { blob, stats } = await grab()`。返回裸 RGBA 缓冲时，
// 下游唯一的用法是再自己转灰度——而计划里没有任何一处做这件事，于是"把 RGBA 当灰度用"
// 会一路静默到质检给出假的亮度（全黑帧算出 63.75，越过 DARK_THRESHOLD）。
// 转换放在这里，grabFrame 的返回值就是能直接喂 `judgeFrame` 的形状。
//
// 浏览器 API（getUserMedia / canvas / toBlob）全部通过参数或假元素**可注入**，
// 于是这份实现在 Node 里可以被完整测掉；真机行为见报告「待人工真机验证」。

import { computeStats } from './frame-qc.mjs';

/**
 * `grabFrame` 在"视频还没出画"（videoWidth/videoHeight 为 0）时抛出的错误上挂的 `code`。
 *
 * 为什么不用错误信息做判据：调用方要按它分流——"用户按快门太早"是**用户情形**，
 * 应提示稍等且**不落** `frame_rejected`；而 `RangeError`（比如缓冲长度不符）是**编程错误**，
 * 必须继续往上抛，绝不能被当成一次"这张照片不行"（那会把 bug 说成用户的问题，
 * 并污染 `retry_rate` 的口径）。用常量而不是匹配文案，文案才可以随便改。
 */
export const VIDEO_NOT_READY = 'VIDEO_NOT_READY';

/**
 * 打开摄像头并把画面接到 `videoEl` 上。
 *
 * @param {HTMLVideoElement} videoEl 目标 video 元素
 * @param {{ facingMode?: string, mediaDevices?: object }} [options]
 *   `mediaDevices` 是注入点，默认取 `globalThis.navigator?.mediaDevices`（浏览器里就是它）。
 * @returns {Promise<MediaStream>} 已接上并在播放的流
 * @throws {Error} 环境没有 `mediaDevices`（见下）或 `getUserMedia` 被拒
 */
export async function openCamera(videoEl, {
  facingMode = 'environment',
  mediaDevices = globalThis.navigator?.mediaDevices,
} = {}) {
  // 显式守卫而不是直接 `navigator.mediaDevices.getUserMedia(...)`：后者在
  // `http://` + 局域网 IP 下抛的是 "Cannot read properties of undefined (reading 'getUserMedia')"，
  // 读的人根本看不出这是"安全上下文"问题。全局约束 2：HTTPS 是硬要求。
  if (mediaDevices === undefined || mediaDevices === null
    || typeof mediaDevices.getUserMedia !== 'function') {
    throw new Error(
      'openCamera: 这个环境没有可用的摄像头接口（navigator.mediaDevices 缺失）。'
      + 'getUserMedia 只在安全上下文可用：https:// 域名或 localhost；'
      + '用 http:// + 局域网 IP 打开时必然失败，请走内网穿透的 HTTPS 地址。',
    );
  }

  const stream = await mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 } },
  });

  try {
    videoEl.srcObject = stream;
    await videoEl.play();
  } catch (err) {
    // 接流或起播失败时**主动关掉摄像头**：否则轨迹还活着（指示灯亮着、耗电），
    // 而界面上没有任何画面，用户只能刷新页面。失败照原样往上抛，不吞。
    for (const track of stream.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* 停不掉也只能继续抛原始错误 */ }
    }
    throw err;
  }

  return stream;
}

/**
 * RGBA → 灰度（ITU-R BT.601 亮度权重 `0.299R + 0.587G + 0.114B`，四舍五入到整数，**忽略 alpha**）。
 *
 * 纯函数：零 import、零浏览器 API，可在 Node 中逐值断言（`tests/camera.test.mjs` 的手算用例）。
 * 之所以单独导出，就是为了让这段算术**离开浏览器可测**——它是 RGBA/灰度这处事故的唯一修复点。
 *
 * 入参契约：`rgba.length` 必须**恰好**等于 `width * height * 4`（`getImageData().data` 的形状）。
 * 长度不符一律抛 `RangeError`：静默按灰度读前 `width*height` 个字节，正是本项目
 * Global Constraint 3 禁止的那种静默降级。
 * 通道值假定 0–255（`Uint8ClampedArray` 天然满足）；超出时结果**夹紧**到 0/255，
 * 不让它回绕成一个看着合理的错值（回绕的 400 → 144 会伪装成一次正常的灰度采样）。
 *
 * @param {ArrayLike<number>} rgba 每像素 4 字节的 RGBA 缓冲
 * @param {number} width 正整数
 * @param {number} height 正整数
 * @returns {Uint8Array} 长度 `width * height` 的灰度缓冲
 * @throws {RangeError} 尺寸非正整数、`rgba` 为空值、或长度 ≠ `width * height * 4`
 */
export function toGrayscale(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new RangeError(`toGrayscale: width/height 必须是整数，收到 ${String(width)}×${String(height)}`);
  }
  if (width <= 0 || height <= 0) {
    throw new RangeError(`toGrayscale: width/height 必须为正整数，收到 ${String(width)}×${String(height)}`);
  }
  const n = width * height;
  if (rgba == null) {
    throw new RangeError(
      `toGrayscale: rgba 不能是 ${rgba === null ? 'null' : 'undefined'}，需要一个长度为 ${n * 4}`
      + `（= ${String(width)}×${String(height)}×4）的 RGBA 缓冲`,
    );
  }
  if (rgba.length !== n * 4) {
    throw new RangeError(
      `toGrayscale: rgba.length 必须恰好等于 width*height*4 = ${n * 4}（= ${String(width)}×${String(height)}×4），`
      + `收到 ${String(rgba.length)}`,
    );
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    // alpha（o+3）有意不参与：设计文档只要求"看不看得清"，不做透明合成。
    const v = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
    out[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
  }
  return out;
}

/**
 * 从 video 取一帧：缩小绘制到 canvas → 编码成 JPEG blob → 顺带算出质检用的 `stats`。
 *
 * @param {HTMLVideoElement} videoEl 正在播放的 video 元素
 * @param {HTMLCanvasElement} canvasEl 临时画布（会被改写尺寸）
 * @param {{ maxEdge?: number, quality?: number }} [options] 长边上限（默认 512，设计文档 §4.6）与 JPEG 质量
 * @returns {Promise<{ blob: Blob, stats: { brightness: number, laplacianVar: number } }>}
 *   `stats` 可直接喂 `judgeFrame`
 * @throws {Error} `code === VIDEO_NOT_READY`：视频还没出画（用户按快门太早）
 * @throws {Error} 画布编码失败（`toBlob` 以 `null` 回调）——绝不返回空 blob 冒充成功
 * @throws {RangeError} `maxEdge` 非正整数；或缓冲尺寸与图像尺寸不符（编程错误，不得当成拒帧）
 */
export async function grabFrame(videoEl, canvasEl, { maxEdge = 512, quality = 0.8 } = {}) {
  if (!Number.isInteger(maxEdge) || maxEdge <= 0) {
    throw new RangeError(`grabFrame: maxEdge 必须是正整数，收到 ${String(maxEdge)}`);
  }

  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!Number.isInteger(vw) || !Number.isInteger(vh) || vw <= 0 || vh <= 0) {
    // 这是**用户情形**（按快门比相机出画早），所以是一个可识别的普通 Error，
    // 而不是下游 computeStats 会抛的那种 RangeError——两者的处置完全不同。
    const err = new Error(
      `grabFrame: 视频还没出画（videoWidth=${String(vw)}, videoHeight=${String(vh)}），请稍候再按快门`,
    );
    err.code = VIDEO_NOT_READY;
    throw err;
  }

  // 只缩不放：`Math.min(1, …)` 保证小图不被放大（放大不会增加信息，只多花钱）。
  const scale = Math.min(1, maxEdge / Math.max(vw, vh));
  // 极端长宽比下四舍五入可能得 0，而 0 尺寸的 canvas/getImageData 会抛 IndexSizeError；
  // 下限 1 让"合法输入"永远落在一个能出帧的尺寸上（真的只有 1 像素高时会被判 too_blurry，如实）。
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  canvasEl.width = w;
  canvasEl.height = h;
  const ctx2d = canvasEl.getContext('2d');
  ctx2d.drawImage(videoEl, 0, 0, w, h);

  const img = ctx2d.getImageData(0, 0, w, h);
  const blob = await new Promise((resolve) => canvasEl.toBlob(resolve, 'image/jpeg', quality));
  if (blob === null || blob === undefined) {
    // 真 toBlob 在画布被污染（跨域图）或尺寸为 0 时会以 null 回调。照常返回的话，
    // Task 7 会拿 null 去 POST 一趟识物——失败被静默降级成"发出去过"。
    throw new Error('grabFrame: 画布编码失败（toBlob 回调收到 null），本帧不可用');
  }

  // 尺寸取自 ImageData 自己（`img.width`/`img.height`）：这样"缓冲"与"宽高"在源头上同源，
  // computeStats 的长度校验才有意义。传视频的 videoWidth/videoHeight 是错的（那是**原图**
  // 尺寸，不是这张缩过的图），长度一比对就抛 RangeError。
  return {
    blob,
    stats: computeStats(toGrayscale(img.data, img.width, img.height), img.width, img.height),
  };
}
