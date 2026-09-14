import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeFrame, computeStats, DARK_THRESHOLD, BLUR_THRESHOLD } from '../web/units/frame-qc.mjs';

test('亮度低于阈值判太暗', () => {
  assert.deepEqual(judgeFrame({ brightness: DARK_THRESHOLD - 1, laplacianVar: 500 }),
    { ok: false, reason: 'too_dark' });
});

test('清晰度低于阈值判模糊', () => {
  assert.deepEqual(judgeFrame({ brightness: 128, laplacianVar: BLUR_THRESHOLD - 1 }),
    { ok: false, reason: 'too_blurry' });
});

test('太暗优先于模糊报告（先解决能一眼看出的问题）', () => {
  assert.equal(judgeFrame({ brightness: 10, laplacianVar: 10 }).reason, 'too_dark');
});

test('两者都达标则通过', () => {
  assert.deepEqual(judgeFrame({ brightness: 128, laplacianVar: 200 }), { ok: true, reason: 'ok' });
});

test('全黑纯灰度图的亮度采样接近 0', () => {
  const px = new Uint8Array(4 * 4).fill(0);
  const { brightness } = computeStats(px, 4, 4);
  assert.ok(brightness < 1);
});

test('纯噪声图的拉普拉斯方差显著高于纯色图', () => {
  const flat = new Uint8Array(8 * 8).fill(120);
  const noisy = new Uint8Array(8 * 8);
  for (let i = 0; i < noisy.length; i += 1) noisy[i] = i % 2 === 0 ? 0 : 255;
  assert.ok(computeStats(noisy, 8, 8).laplacianVar > computeStats(flat, 8, 8).laplacianVar);
});

// 以下 1 条为 brief 6 条之外的补充：brief 的边界说明要求"内部像素为 0 的图"
// 必须返回 laplacianVar 0 而不是除零得到 NaN。缺这条测试时，实现里 count === 0
// 的守卫被整段删掉也不会有任何测试变红。
test('内部像素为 0 的极小图返回拉普拉斯方差 0 而非 NaN', () => {
  const px = new Uint8Array(2 * 2).fill(200);
  assert.deepEqual(computeStats(px, 2, 2), { brightness: 200, laplacianVar: 0 });
});

// 以下为 review 轮补充：给拉普拉斯方差这一具体算法加独立 oracle。
//
// 为什么需要：brief 的 6 条 + 上面 1 条全是**比较型**断言（噪声图 > 纯色图），
// 任何"噪声图得分更高"的纹理度量都能满足，因此 BLUR_THRESHOLD = 80 到底量度
// 的是哪个量并没有被钉住。实测把实现换成"平均绝对拉普拉斯"（mean(|lap|)），
// 此前 7 条全绿——而 80 只对"方差"这一尺度有意义，换了度量阈值就悄悄变了意思，
// 会污染 frame_rejected 计数与下游 retry_rate。
//
// 本测试用**独立 oracle** 钉住算法：期望值在下面临时算出，不 import、不复用
// frame-qc.mjs 的任何辅助函数，也不调用 computeStats 自己算期望——只把输入交给
// 被测函数、把输出与手算结果比对。两边若共享代码，这个测试就会失去意义。
test('拉普拉斯方差与独立 oracle（E[L²] − E[L]²）逐值一致，亮度等于缓冲算术均值', () => {
  const SIDE = 5;
  const px = new Uint8Array([
    30, 200, 45, 190, 60,
    170, 25, 215, 40, 185,
    55, 205, 35, 195, 50,
    180, 20, 210, 30, 220,
    65, 175, 75, 165, 85,
  ]);

  // —— 独立 oracle：在测试内重算，只依赖上面的字面量 ——
  // 亮度：整个缓冲区的算术均值（25 个像素之和 = 2925）。
  let total = 0;
  for (let i = 0; i < px.length; i += 1) total += px[i];
  const expectedBrightness = total / (SIDE * SIDE);

  // 拉普拉斯响应：4 邻域模板 4*p[i] − 左 − 右 − 上 − 下，仅内部像素（跳过最外圈）。
  const lap = [];
  for (let y = 1; y < SIDE - 1; y += 1) {
    for (let x = 1; x < SIDE - 1; x += 1) {
      const i = y * SIDE + x;
      lap.push(4 * px[i] - px[i - 1] - px[i + 1] - px[i - SIDE] - px[i + SIDE]);
    }
  }
  let lapSum = 0;
  let lapSqSum = 0;
  let lapAbsSum = 0;
  for (let i = 0; i < lap.length; i += 1) {
    lapSum += lap[i];
    lapSqSum += lap[i] * lap[i];
    lapAbsSum += lap[i] < 0 ? -lap[i] : lap[i];
  }
  const lapMean = lapSum / lap.length;
  const expectedVar = lapSqSum / lap.length - lapMean * lapMean;   // 总体方差 E[L²] − E[L]²
  const meanAbsLap = lapAbsSum / lap.length;                        // 变异体用的另一个度量

  assert.equal(lap.length, 9, 'oracle 自检：5×5 的内部像素应为 9 个');
  // 非空洞性自检：这组数据必须让"方差"与"平均绝对拉普拉斯"显著可分
  // （本组约 4.5e5 对约 6.7e2，相差三个数量级）。若有人把字面量改成让两式
  // 趋同的数值，这条先红，提示 oracle 已失去分辨力。
  assert.ok(Math.abs(expectedVar - meanAbsLap) > 1,
    `oracle 必须能区分方差与平均绝对拉普拉斯：${expectedVar} vs ${meanAbsLap}`);

  const { brightness, laplacianVar } = computeStats(px, SIDE, SIDE);

  assert.ok(Math.abs(brightness - expectedBrightness) < 1e-9,
    `亮度应等于缓冲区算术均值 ${expectedBrightness}，实际 ${brightness}`);
  assert.ok(Math.abs(laplacianVar - expectedVar) < 1e-9,
    `laplacianVar 应等于 E[L²]−E[L]² = ${expectedVar}，实际 ${laplacianVar}`);
});

// 以下为 review 轮补充（finding 2）：computeStats 遇到退化输入必须抛 RangeError，
// 而不是算出 NaN。NaN 会让 judgeFrame 的两次 `<` 比较都为 false，于是一张完全
// 不可用的帧被报成 { ok: true }——正是共享上下文 Global Constraint 3
// （"失败不得静默降级为成功"）禁止的那类静默失真。
test('pixels 短于 width*height 时抛出 RangeError', () => {
  assert.throws(() => computeStats(new Uint8Array(15), 4, 4), RangeError);
});

test('width 为 0 时抛出 RangeError', () => {
  assert.throws(() => computeStats(new Uint8Array(0), 0, 4), RangeError);
});

test('height 为 0 时抛出 RangeError', () => {
  assert.throws(() => computeStats(new Uint8Array(0), 4, 0), RangeError);
});

test('合法输入不得抛错，且返回值形状不变', () => {
  const stats = computeStats(new Uint8Array(4 * 4).fill(120), 4, 4);
  assert.deepEqual(Object.keys(stats).sort(), ['brightness', 'laplacianVar']);
  assert.equal(typeof stats.brightness, 'number');
  assert.equal(typeof stats.laplacianVar, 'number');
  assert.equal(Number.isNaN(stats.brightness), false);
  assert.equal(Number.isNaN(stats.laplacianVar), false);
});
