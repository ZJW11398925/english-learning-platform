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
  // 修复轮 2 起 judgeFrame 自身也加了同样的守卫（见其 JSDoc），两道防线各自独立成立：
  // 本函数负责"不产出 NaN"，judgeFrame 负责"不把 NaN 当合格帧"。
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

// 非有限 / 非数值的统计量一律抛 RangeError（与 computeStats 的输入校验同一策略：
// 契约被违反就快速失败，不外流一个"看起来合理"的判定）。不写 `Number(value)` 之类
// 的隐式转换——字符串 '100' 必须报错，而不是被悄悄当成 100 放行。
// 消息点名字段、类型与实际收到的值，便于调用方定位是哪个统计量出了问题。
function requireFiniteNumber(field, value) {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `judgeFrame: ${field} 必须是有限数值，收到 ${typeof value}：${String(value)}`,
    );
  }
}

/**
 * 帧可用性判定——端侧质检闸门，决定这帧能不能送去识物（那一步真实花钱）。
 * 纯函数：零 import、零浏览器 API，可在 Node 中直接测。
 *
 * 入参：`{ brightness, laplacianVar }`，两个字段都必须是**有限数值**
 * （`typeof === 'number'` 且 `Number.isFinite` 为 true，不接受可转成数字的字符串），
 * 量纲与 `computeStats` 的返回一致：`brightness` 是灰度均值（0–255），
 * `laplacianVar` 是 4 邻域拉普拉斯响应的方差 E[L²] − E[L]²（量纲说明见 BLUR_THRESHOLD 上方）。
 *
 * 抛 `RangeError`（两种情况都是契约被违反，不静默放行）：
 *   - 整个入参缺失或不是对象：`judgeFrame()`、`judgeFrame(undefined)`、`judgeFrame(null)`；
 *   - `brightness` 或 `laplacianVar` 不是有限数值：NaN、±Infinity、`'100'`、undefined……
 * 为什么必须抛而不是返回判定：`NaN < DARK_THRESHOLD` 与 `NaN < BLUR_THRESHOLD` 都是
 * false，一张完全不可用的帧会被报成 `{ ok: true }`；下游据此走 recognize_ok 路径，
 * `frame_rejected` 计数（`retry_rate` 判据依赖的信号）永不触发——正是共享上下文
 * Global Constraint 3 禁止的"失败静默降级为成功"。
 *
 * 返回 `{ ok, reason }`。`ok` 与 `reason === 'ok'` 恒等价。`reason` 三种取值：
 *   - `'too_dark'`   —— `brightness < DARK_THRESHOLD`。**优先于模糊报告**：太暗是
 *                       用户一眼能看懂、也最容易修的问题（开灯／对准亮处）。
 *   - `'too_blurry'` —— 亮度达标，但 `laplacianVar < BLUR_THRESHOLD`。
 *   - `'ok'`         —— 两项都达标，帧可用，可以送去识物。
 * `ok: false` 时调用方须落 `frame_rejected` 事件（不得只提示用户而不计数）。
 *
 * @param {{ brightness: number, laplacianVar: number }} frame computeStats 的输出（或同量纲同契约的值）
 * @returns {{ ok: boolean, reason: 'ok'|'too_dark'|'too_blurry' }}
 * @throws {RangeError} 入参缺失/非对象，或任一字段不是有限数值
 */
export function judgeFrame(frame) {
  if (frame === null || typeof frame !== 'object') {
    // 显式检查而非依赖参数位解构：解构 `undefined` 抛的是 TypeError，属于"碰巧报错"，
    // 既不在 JSDoc 契约里、消息也读不出是我们约定的入参形状。此处把它变成有意的 RangeError。
    const received = frame === null ? 'null' : `${typeof frame}：${String(frame)}`;
    throw new RangeError(`judgeFrame: 入参必须是对象 { brightness, laplacianVar }，收到 ${received}`);
  }
  const { brightness, laplacianVar } = frame;
  requireFiniteNumber('brightness', brightness);
  requireFiniteNumber('laplacianVar', laplacianVar);

  if (brightness < DARK_THRESHOLD) return { ok: false, reason: 'too_dark' };
  if (laplacianVar < BLUR_THRESHOLD) return { ok: false, reason: 'too_blurry' };
  return { ok: true, reason: 'ok' };
}
