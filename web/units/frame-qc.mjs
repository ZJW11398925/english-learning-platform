// web/units/frame-qc.mjs
// 初值来自设计文档 §5.1，首周用真实数据校准；改动必须记入变更记录。
export const DARK_THRESHOLD = 40;
export const BLUR_THRESHOLD = 80;

export function computeStats(pixels, width, height) {
  const n = width * height;
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
  if (count === 0) return { brightness, laplacianVar: 0 };
  const mean = lapSum / count;
  return { brightness, laplacianVar: lapSqSum / count - mean * mean };
}

export function judgeFrame({ brightness, laplacianVar }) {
  if (brightness < DARK_THRESHOLD) return { ok: false, reason: 'too_dark' };
  if (laplacianVar < BLUR_THRESHOLD) return { ok: false, reason: 'too_blurry' };
  return { ok: true, reason: 'ok' };
}
