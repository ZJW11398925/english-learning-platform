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
