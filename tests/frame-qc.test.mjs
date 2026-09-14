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

// 以下为 review 轮补充（finding 2）：computeStats 遇到退化输入必须抛 RangeError。
// 为什么不能外流 NaN，见 web/units/frame-qc.mjs 的 judgeFrame JSDoc（唯一权威说明处）。
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

// 以下为修复轮 2 补充：judgeFrame 对非有限输入抛 RangeError（与 computeStats 同一策略）。
// 历史与理由见 web/units/frame-qc.mjs 的 judgeFrame JSDoc（唯一权威说明处），此处不再复述。
//
// 小工具：捕获同步抛出的错误；若函数根本没抛错，立即断言失败（否则测试会因
// “没有错误对象可查”而以更难读的方式崩掉）。
function thrownBy(fn) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== undefined, 'judgeFrame 应当抛错，但它没抛（静默放行）');
  return caught;
}

test('brightness 为 NaN 时抛 RangeError，消息点名字段与收到的值', () => {
  const err = thrownBy(() => judgeFrame({ brightness: NaN, laplacianVar: 500 }));
  assert.ok(err instanceof RangeError, `应为 RangeError，实际 ${err.name}: ${err.message}`);
  assert.match(err.message, /brightness/);
  assert.match(err.message, /NaN/);
});

test('laplacianVar 为 NaN 时抛 RangeError，消息点名字段与收到的值', () => {
  const err = thrownBy(() => judgeFrame({ brightness: 100, laplacianVar: NaN }));
  assert.ok(err instanceof RangeError, `应为 RangeError，实际 ${err.name}: ${err.message}`);
  assert.match(err.message, /laplacianVar/);
  assert.match(err.message, /NaN/);
});

test('字符串 "100" 不被隐式转成数字，抛 RangeError', () => {
  const err = thrownBy(() => judgeFrame({ brightness: '100', laplacianVar: 500 }));
  assert.ok(err instanceof RangeError, `应为 RangeError，实际 ${err.name}: ${err.message}`);
  assert.match(err.message, /brightness/);
  assert.match(err.message, /100/);
});

test('±Infinity 也是非有限数，抛 RangeError（契约是“有限数”，不只是“非 NaN”）', () => {
  assert.ok(thrownBy(() => judgeFrame({ brightness: Infinity, laplacianVar: 500 })) instanceof RangeError);
  assert.ok(thrownBy(() => judgeFrame({ brightness: 100, laplacianVar: -Infinity })) instanceof RangeError);
});

test('缺少入参（judgeFrame(undefined)）抛 RangeError——契约是显式的，不靠解构碰巧报错', () => {
  const err = thrownBy(() => judgeFrame(undefined));
  assert.ok(err instanceof RangeError, `应为 RangeError，实际 ${err.name}: ${err.message}`);
  assert.match(err.message, /undefined/);
});

test('合法调用判定不变：{ brightness: 128, laplacianVar: 200 } 仍为 { ok: true, reason: "ok" }', () => {
  assert.deepEqual(judgeFrame({ brightness: 128, laplacianVar: 200 }), { ok: true, reason: 'ok' });
  // 阈值边界语义不变：恰好等于阈值的帧仍然可用（新守卫只拒绝非有限数，不动 "<" 的取等）
  assert.deepEqual(judgeFrame({ brightness: DARK_THRESHOLD, laplacianVar: BLUR_THRESHOLD }),
    { ok: true, reason: 'ok' });
});

// ————————————————————————————————————————————————————————————————
// 以下为修复轮 3 补充（review finding 1）：computeStats 的入参是**灰度**缓冲
// （每像素 1 字节，长度**恰好** width*height），RGBA 缓冲必须由调用方先转灰度。
// 旧实现只查 `pixels.length >= width*height`，于是一个与 ctx.getImageData().data
// 同形的 RGBA 缓冲会被静默当成灰度：只读前 width*height 个字节（每 4 字节取 1 个，
// 而且取到的是 G、A 通道），全黑帧因此算出偏高的亮度被判可用。长度不符必须抛错，
// 不做任何静默重解释——理由见模块内 judgeFrame 的 JSDoc（Global Constraint 3）。
// ————————————————————————————————————————————————————————————————

// 与 ctx.getImageData(...).data 同形：每像素 4 字节 RGBA。
// "全黑"= RGB 通道为 0；不透明 = A 通道为 255，故每 4 字节为 [0, 0, 0, 255]。
function blackOpaqueRgba(width, height) {
  const px = new Uint8Array(width * height * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return px;
}

test('RGBA 形状的黑帧缓冲被拒：computeStats 抛 RangeError，绝不按灰度静默重解释', () => {
  const rgba = blackOpaqueRgba(8, 8);
  assert.equal(rgba.length, 8 * 8 * 4, '前置条件：RGBA 缓冲长度应为 width*height*4');
  // 旧实现（`>=`）对这个缓冲返回 { brightness: 63.75, laplacianVar: 74056.25 }，
  // judgeFrame 据此判 { ok: true, reason: 'ok' }——暗帧被放行，白花一次识物调用。
  assert.throws(() => computeStats(rgba, 8, 8), RangeError);
});

test('同一张全黑图的正确灰度缓冲不抛错，且被判 too_dark（与 RGBA 结果对照）', () => {
  const gray = new Uint8Array(8 * 8).fill(0);
  const stats = computeStats(gray, 8, 8);           // 长度恰好 width*height：不得抛错
  assert.deepEqual(judgeFrame(stats), { ok: false, reason: 'too_dark' });
});

test('长度不符的错误消息同时点出期望长度、实际长度与灰度契约', () => {
  const err = thrownBy(() => computeStats(new Uint8Array(15), 4, 4));
  assert.ok(err instanceof RangeError, `应为 RangeError，实际 ${err.name}: ${err.message}`);
  assert.match(err.message, /16/);                  // 期望长度 width*height
  assert.match(err.message, /15/);                  // 实际长度
  assert.match(err.message, /灰度/);                // 说明这是灰度契约，不是随便一个缓冲
  assert.match(err.message, /RGBA/);                // 点名最常见的违反方式：getImageData().data
});

// ————————————————————————————————————————————————————————————————
// 以下为修复轮 3 补充（review finding 2）：把两条此前无测试覆盖的校验分支钉住
// （整数校验与 null/undefined 分支——删掉任一条，此前 18 条测试全绿）。
// 每条只做一个断言，保持聚焦。
// ————————————————————————————————————————————————————————————————

test('width 为小数（4.5）时抛 RangeError', () => {
  // 缓冲长度取 18 = 4.5 × 4，恰好通过长度校验，只有"必须是整数"这一条能拦住它。
  assert.throws(() => computeStats(new Uint8Array(18), 4.5, 4), RangeError);
});

test('width 为 NaN 时抛 RangeError', () => {
  // 既有断言（保留）：NaN 尺寸抛 RangeError。
  assert.throws(() => computeStats(new Uint8Array(16), NaN, 4), RangeError);
  // 上面的断言**不能**隔离整数校验：NaN 尺寸下长度校验 `pixels.length !== NaN` 恒真，
  // 整数校验整条删掉本测试依旧全绿（NaN 会被长度校验顺带拦下）。
  // 故再钉住"抛出来的是哪条分支"——整数校验的消息是 `width/height 必须是整数，收到 NaN×4`，
  // 含「整数」；长度分支的消息是 `pixels.length 必须恰好等于 width*height = NaN…`，不含该词。
  // 于是删掉整数校验后本条立即变红（该变异实验已做，见报告）。
  const err = thrownBy(() => computeStats(new Uint8Array(16), NaN, 4));
  assert.ok(err instanceof RangeError, `应为 RangeError，实际 ${err.name}: ${err.message}`);
  assert.match(err.message, /整数/);
});

test('width/height 为负数（-4）时抛 RangeError', () => {
  // 取 (-4, -4)：n = (-4) × (-4) = 16，长度校验恰好放行，
  // 只有"必须为正整数"这一条能拦住它（若写成 (-4, 4)，n = -16，会被长度校验顺带拦下，钉不住这条分支）。
  assert.throws(() => computeStats(new Uint8Array(16), -4, -4), RangeError);
});

test('pixels 为 null 时抛 RangeError', () => {
  assert.throws(() => computeStats(null, 4, 4), RangeError);
});

// ————————————————————————————————————————————————————————————————
// 以下为修复轮 3 补充（review finding 3）：错误消息本身也要准。
// ————————————————————————————————————————————————————————————————

test('pixels 为 null 的错误消息点名 null，不再谎称"长度不足"', () => {
  const err = thrownBy(() => computeStats(null, 4, 4));
  assert.ok(err instanceof RangeError, `应为 RangeError，实际 ${err.name}: ${err.message}`);
  assert.match(err.message, /null/);
  assert.doesNotMatch(err.message, /长度不足/);      // null 没有"长度"可言，消息须分支出准确说法
});

test('宽度为 Symbol 时抛 RangeError（而非插值出 TypeError）', () => {
  // 消息里 width/height 一律经 String(...) 插值：直接 `${width}` 遇 Symbol 会抛 TypeError，
  // 把"契约被违反"报成了另一种错误类型，调用方按 RangeError 捕获就会漏。
  assert.throws(() => computeStats(new Uint8Array(16), Symbol('w'), 4), RangeError);
});
