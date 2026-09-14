// web/units/frame-qc.mjs
// 初值来自设计文档 §5.1，首周用真实数据校准；改动必须记入变更记录。
export const DARK_THRESHOLD = 40;

// 量纲绑定（标定风险，见计划 §5.1 的注）：80 这个数是**专门**对
// "4 邻域拉普拉斯响应的方差（E[L²] − E[L]²，灰度平方量纲）"标定出来的。
// laplacianVar 一旦改用别的纹理度量（例如平均绝对拉普拉斯 mean(|L|)、平方和、
// 最大绝对值），阈值 80 的含义就会静默变成另一个东西，进而污染 frame_rejected
// 计数与下游 retry_rate 判据（共享上下文判据 B）。故：改度量必须**同时**用真实
// 帧重新标定阈值，不得只改公式。测试见 tests/frame-qc.test.mjs 的独立 oracle。
export const BLUR_THRESHOLD = 80;

export function computeStats(pixels, width, height) {
  // 输入校验（review 轮补充）：退化输入以前会算出 NaN 亮度，而 judgeFrame 里
  // `NaN < DARK_THRESHOLD` 与 `NaN < BLUR_THRESHOLD` 都是 false，于是一张完全
  // 不可用的帧被报成 { ok: true }——静默降级为成功，正是 Global Constraint 3
  // 禁止的那类失真。这里改为快速失败：宁可抛错，也不外流 NaN。
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new RangeError(`computeStats: width/height 必须是整数，收到 ${width}×${height}`);
  }
  if (width <= 0 || height <= 0) {
    throw new RangeError(`computeStats: width/height 必须为正整数，收到 ${width}×${height}`);
  }
  const n = width * height;
  if (pixels == null || pixels.length < n) {
    throw new RangeError(
      `computeStats: pixels 长度不足，需要 ${n}（= ${width}×${height}），收到 ${pixels == null ? pixels : pixels.length}`,
    );
  }

  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += pixels[i];
  const brightness = sum / n;

  // 4 邻域拉普拉斯，边缘像素跳过
  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const lap = 4 * pixels[i] - pixels[i - 1] - pixels[i + 1] - pixels[i - width] - pixels[i + width];
      lapSum += lap;
      lapSqSum += lap * lap;
      count += 1;
    }
  }
  // count === 0：长或宽 < 3，内部像素为空（校验之后只剩这一条合法路径）。
  // 返回哨兵值 0，避免 0/0 得 NaN。守卫保留，勿删。
  if (count === 0) return { brightness, laplacianVar: 0 };
  const mean = lapSum / count;
  // 返回值是**样本总体的方差** E[L²] − E[L]²，不是平均绝对值等其他纹理度量；
  // BLUR_THRESHOLD 的量纲正绑在这个方差上（见上方常数注释）。
  return { brightness, laplacianVar: lapSqSum / count - mean * mean };
}

export function judgeFrame({ brightness, laplacianVar }) {
  if (brightness < DARK_THRESHOLD) return { ok: false, reason: 'too_dark' };
  if (laplacianVar < BLUR_THRESHOLD) return { ok: false, reason: 'too_blurry' };
  return { ok: true, reason: 'ok' };
}
