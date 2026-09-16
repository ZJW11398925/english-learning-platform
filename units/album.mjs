// web/units/album.mjs
//
// 相册导入单元（Task 12B，转向 DEC-…23/26 的第三项形态）：把用户从相册选的一张图，
// 变成与 `camera.grabFrame` **同形状**的一帧 `{ blob, stats }`——`stats` 直接可喂
// `judgeFrame`，`blob` 直接可进 `recognize`。于是"从相册选图"与"按快门"在帧质检与
// 识物链路眼里是**同一种东西**：两条输入源，一条链路（事件口径不变、轮次连续性照旧
// 的保证就落在这里——装配层拿到的帧与相机帧无法区分，后续代码完全共用）。
//
// 分工（与 camera.mjs / frame-qc.mjs 的注释一致）：
//   · 灰度转换**复用** `camera.mjs` 的 `toGrayscale`（RGBA → 灰度只有一个起源，
//     "每像素 4 字节"这件事的教训只在那一处修一次）；
//   · `computeStats` 只收灰度——RGBA 直传会响亮抛 RangeError（tests/camera.test.mjs 钉着）。
//
// ── 图片过大的口径（与相机同一条，任务书要求"保持一致"）──────────────────────────
// 相机路径的口径是"先缩再编码"：长边缩到 512、JPEG 质量 0.8，产出的帧只有几十 KB。
// 相册路径**走同一条**缩放管道——原始文件哪怕是一张 12MP 的照片，解码后画布上已经
// 缩好了，编码出来的仍是小帧。因此 `recognize.mjs` 里那道 32 MiB data URL 上限对两条
// 输入源是**同一道闸**：它照旧留在传输层不动（12B 红线：直连传输层只读不改），
// 相册帧因为同样先缩后编码，正常情况下远够不到它——它仍是最后一道防线。
//
// 浏览器 API（createImageBitmap / canvas / toBlob）全部通过参数或假元素**可注入**，
// 这份实现在 Node 里可被完整测掉（tests/album.test.mjs）；真机行为（EXIF 方向、
// 巨图的内存峰值）留给真机走查。

import { toGrayscale } from './camera.mjs';
import { computeStats } from './frame-qc.mjs';

/**
 * `frameFromImageFile` 在"这张图处理不了"时挂到 Error 上的 `code`。
 *
 * 覆盖三种成因：解码器抛错（图片损坏/格式不支持）、解码结果的尺寸不合法、
 * 这个浏览器根本没有 `createImageBitmap`。装配层按它分流——这是**用户情形**
 *（提示换一张图），不是"这张照片太暗"（质检档），更不是编程错误（RangeError，
 * 必须响亮重抛）。用常量而不是匹配文案，文案才可以随便改。
 */
export const IMAGE_NOT_READABLE = 'IMAGE_NOT_READABLE';

/**
 * 把相册选中的一张图变成一帧。
 *
 * @param {Blob|File} file 文件选择器给出的那个文件（真 Blob）
 * @param {HTMLCanvasElement} canvasEl 临时画布（会被改写尺寸）
 * @param {object} [options]
 *   - `maxEdge` / `quality`：与 `camera.grabFrame` 同名同默认（512 / 0.8）——同一条缩放口径
 *   - `createBitmap`：解码注入点，默认 `(input) => globalThis.createImageBitmap(input)`；
 *     测试注入一个返回 `{ width, height, close }` 的假位图即可
 * @returns {Promise<{ blob: Blob, stats: { brightness: number, laplacianVar: number } }>}
 *   `stats` 可直接喂 `judgeFrame`
 * @throws {Error} `code === IMAGE_NOT_READABLE`：图片打不开（用户情形，装配层给换一张图的提示）
 * @throws {Error} 画布编码失败（`toBlob` 以 `null` 回调）——绝不返回空 blob 冒充成功
 * @throws {RangeError} `maxEdge` 非正整数（编程错误，与 camera 同一把尺）；或 `file` 缺失
 */
export async function frameFromImageFile(file, canvasEl, {
  maxEdge = 512,
  quality = 0.8,
  createBitmap = (input) => globalThis.createImageBitmap(input),
} = {}) {
  if (!Number.isInteger(maxEdge) || maxEdge <= 0) {
    throw new RangeError(`frameFromImageFile: maxEdge 必须是正整数，收到 ${String(maxEdge)}`);
  }
  if (file === null || file === undefined) {
    throw new RangeError(`frameFromImageFile: 需要一个图片文件，收到 ${String(file)}`);
  }

  // 解码。三种失败（解码器缺失 / 解码抛错）都在这里收口成同一个档：
  // "这张图处理不了"是用户情形，装配层按 code 分流，不该让它以
  // "undefined is not a function"或裸的引擎错误面目出现。
  let bitmap;
  try {
    if (typeof createBitmap !== 'function') {
      throw new Error('这个浏览器缺少 createImageBitmap，无法从相册导入图片解码');
    }
    bitmap = await createBitmap(file);
  } catch (err) {
    const wrapped = new Error(`这张图片打不开（解码失败）：${String(err?.message ?? err)}`);
    wrapped.code = IMAGE_NOT_READABLE;
    throw wrapped;
  }

  // 位图尺寸是解码产物自己报告的：0 / 负数 / 非整数说明拿到的不是一张可用的图
  //（按它画布只会画出空或抛 IndexSizeError）。同样归"打不开"。
  const bw = bitmap?.width;
  const bh = bitmap?.height;
  if (!Number.isInteger(bw) || !Number.isInteger(bh) || bw <= 0 || bh <= 0) {
    try { bitmap?.close?.(); } catch { /* 关不掉也得先把错误抛出去 */ }
    const err = new Error(`这张图片打不开（解码结果的尺寸不合法：${String(bw)}×${String(bh)}）`);
    err.code = IMAGE_NOT_READABLE;
    throw err;
  }

  // 只缩不放：与 camera.grabFrame 同一条口径。小图放大不增加信息，只多花钱。
  const scale = Math.min(1, maxEdge / Math.max(bw, bh));
  // 极端长宽比下四舍五入可能得 0，下限 1 让"合法输入"永远落在一个能出帧的尺寸上
  //（真的只有 1 像素高时会被判 too_blurry，如实——与相机路径同一条兜底）。
  const w = Math.max(1, Math.round(bw * scale));
  const h = Math.max(1, Math.round(bh * scale));

  canvasEl.width = w;
  canvasEl.height = h;
  const ctx2d = canvasEl.getContext('2d');
  ctx2d.drawImage(bitmap, 0, 0, w, h);

  const img = ctx2d.getImageData(0, 0, w, h);
  // 画完立刻放掉解码图（12MP 解码图在手机内存里占几十 MB，不能等 GC）。
  // close 是清理，不该把主流程带崩。
  try { bitmap.close?.(); } catch { /* 关不掉也无妨 */ }

  const blob = await new Promise((resolve) => canvasEl.toBlob(resolve, 'image/jpeg', quality));
  if (blob === null || blob === undefined) {
    // 与 camera.grabFrame 同一条纪律：照常返回的话，装配层会拿空 blob 去走识物
    //——"编码失败"被静默降级成"发出去过"。
    throw new Error('frameFromImageFile: 画布编码失败（toBlob 回调收到 null），本帧不可用');
  }

  // 尺寸取自 ImageData 自己（与 camera 同源写法）：computeStats 的长度校验才有意义。
  return {
    blob,
    stats: computeStats(toGrayscale(img.data, img.width, img.height), img.width, img.height),
  };
}
