// web/units/frame-qc.mjs
// 初值来自设计文档 §5.1，首周用真实数据校准；改动必须记入变更记录。
export const DARK_THRESHOLD = 40;

// 量纲绑定（未标定风险，见设计文档 §5.1 的注）：80 这个数**只对**"4 邻域拉普拉斯
// 响应的方差（E[L²] − E[L]²，灰度平方量纲）"这一尺度有意义。设计文档 §5.1 把 40 与
// 80 一并列为**首轮设定值**（首轮设定值 = 不是定论、尚未用真实帧标定过；校准在第一周
// 用真实数据完成并记入变更记录）。故本行只是"这个数绑在哪个尺度上"，**不代表它已经
// 被标定过**——读到这里不要据此跳过首周校准。
// laplacianVar 一旦改用别的纹理度量（例如平均绝对拉普拉斯 mean(|L|)、平方和、
// 最大绝对值），阈值 80 的含义就会静默变成另一个东西，进而污染 frame_rejected
// 计数与下游 retry_rate 判据（共享上下文判据 B）。故：改度量必须**同时**用真实
// 帧重新标定阈值，不得只改公式。测试见 tests/frame-qc.test.mjs 的独立 oracle。
export const BLUR_THRESHOLD = 80;

/**
 * 帧统计：从**灰度**缓冲算出亮度均值与拉普拉斯方差，供 `judgeFrame` 判定。
 * 纯函数：零 import、零浏览器 API，可在 Node 中直接测。
 *
 * **入参契约（灰度缓冲，绑定要求）**：
 *   - `pixels` 是**每像素 1 字节的灰度**缓冲，取值 0–255（`Uint8Array` /
 *     `Uint8ClampedArray` / 普通数组皆可，按索引读取）；
 *   - 长度必须**恰好**等于 `width * height`，不多不少；
 *   - **`width` / `height` 必须是 `pixels` 所来自的那张图本身的像素尺寸**，不能是为了
 *     让长度校验通过而另选的一对数。长度校验只证明两者算术自洽
 *     （`length === width * height`），既不证明它们描述同一个像素阵列，也不检查格式。
 *     残余漏洞（真实调用路径**不可达**，故以条款而非代码表达）：256 字节的全不透明黑
 *     RGBA 缓冲（64 像素）配 `(16, 16)`——`256 === 16 × 16` 恰好通过长度校验——之后按
 *     灰度读到的其实是 G/A 通道，全黑帧算出 `brightness = 63.75` 并被 `judgeFrame` 报为
 *     `{ ok: true }`。真实路径上 `width`/`height` 与缓冲同源于一个 `ImageData`，RGBA
 *     缓冲长度必为像素数的 4 倍，会在长度校验处响亮抛错——这个前提（真实路径天然满足）
 *     才是本函数安全所依赖的东西。格式/通道检测不在本模块职责内，刻意不做。
 *   - **不接受 RGBA**：`ctx.getImageData(...).data`（计划 Task 6 的 `grabFrame`
 *     返回的就是它）是每像素 4 字节的 RGBA，**必须由调用方先转灰度再传入**。
 *     本模块不做这个转换——转换是调用方的职责，这条分工是刻意的；
 *     RGBA 缓冲直接传进来会因长度不符被拒。
 *   - 长度不符一律抛 `RangeError`，即**响亮失败（loud）**，绝不把缓冲按别的
 *     解释**静默重解释**（例如只读前 `width*height` 个字节、把 RGBA 当灰度用）。
 *     后者会让一张实际很暗的帧算出偏高的亮度而被判为可用（实测全黑 8×8 RGBA
 *     得 `brightness = 63.75` 而非 `0`，足以越过 `DARK_THRESHOLD`），使
 *     `frame_rejected` 永不落、`retry_rate` 失真——正是共享上下文 Global
 *     Constraint 3 禁止的静默降级。为什么不许静默，见 `judgeFrame` 的 JSDoc
 *     （本模块对这一理由的**唯一权威说明处**）。
 *
 * `width` / `height` 必须是正整数（非整数、`NaN`、≤ 0 一律抛 `RangeError`）。
 *
 * 返回 `{ brightness, laplacianVar }`：`brightness` 是整块缓冲的算术均值（0–255）；
 * `laplacianVar` 是 4 邻域拉普拉斯响应在**内部像素**上的总体方差 `E[L²] − E[L]²`
 * （最外一圈跳过；`width` 或 `height` < 3 时没有内部像素，返回哨兵值 0，
 * 避免 0/0 得 NaN）。量纲与 `BLUR_THRESHOLD` 的绑定见该常量上方注释。
 *
 * @param {ArrayLike<number>} pixels 灰度缓冲：长度恰好 `width * height`，取值 0–255
 * @param {number} width 正整数
 * @param {number} height 正整数
 * @returns {{ brightness: number, laplacianVar: number }}
 * @throws {RangeError} 尺寸非正整数；`pixels` 为 `null`/`undefined`；或长度 ≠ `width * height`
 */
export function computeStats(pixels, width, height) {
  // 输入校验：契约被违反就快速失败（抛 RangeError），既不外流 NaN，也不静默重解释输入。
  // 尺寸一律经 String(...) 插值：Symbol 直接进模板串会抛 TypeError，把"契约违约"
  // 报成另一种错误类型，调用方按 RangeError 捕获就会漏（与 judgeFrame 的处理一致）。
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new RangeError(`computeStats: width/height 必须是整数，收到 ${String(width)}×${String(height)}`);
  }
  if (width <= 0 || height <= 0) {
    throw new RangeError(`computeStats: width/height 必须为正整数，收到 ${String(width)}×${String(height)}`);
  }
  const n = width * height;
  // null/undefined 与"长度不符"是两种不同的违约，消息各自准确（空值没有"长度"可言）。
  if (pixels == null) {
    throw new RangeError(
      `computeStats: pixels 不能是 ${pixels === null ? 'null' : 'undefined'}，需要一个长度为 ${n}`
      + `（= ${String(width)}×${String(height)}）的灰度缓冲（每像素 1 字节，取值 0–255）`,
    );
  }
  // 长度**恰好**相等，不是 `>=`：多出来的字节只能是另一种像素格式（最常见的是
  // getImageData().data 的 RGBA，每像素 4 字节），按灰度读前 n 个字节是静默重解释。
  if (pixels.length !== n) {
    throw new RangeError(
      `computeStats: pixels.length 必须恰好等于 width*height = ${n}（= ${String(width)}×${String(height)}），`
      + `收到 ${String(pixels.length)}；本函数只接受灰度缓冲（每像素 1 字节，取值 0–255）——`
      + '若这是 getImageData().data 的 RGBA 缓冲（每像素 4 字节），请先由调用方转灰度再传入',
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

// 非有限 / 非数值的统计量一律抛 RangeError（快速失败策略与 computeStats 一致，
// 理由见下方 judgeFrame 的 JSDoc——本模块不复述）。不写 `Number(value)` 之类
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
 * 为什么必须抛而不是返回判定——**本模块对这一理由的唯一权威说明处**，其它注释与
 * 测试注释只引用此处、不再复述：`NaN < DARK_THRESHOLD` 与 `NaN < BLUR_THRESHOLD`
 * 都是 false，一张完全不可用的帧会被报成 `{ ok: true }`；下游据此走 recognize_ok
 * 路径，`frame_rejected` 计数（`retry_rate` 判据依赖的信号）永不触发——正是共享
 * 上下文 Global Constraint 3 禁止的"失败静默降级为成功"。
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
