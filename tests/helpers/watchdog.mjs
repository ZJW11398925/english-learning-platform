// tests/helpers/watchdog.mjs
//
// "必须在上限内收口"这类断言的看门狗（Task 7 修复轮 · Critical 2）。
//
// 为什么需要它：这些用例测的正是"某个超时闸在岗"。把闸拆掉之后，被测的 Promise
// **永远不会 settle** —— 若用例直接 `await` 它，测试会**挂住**而不是失败。
// 挂在 `node --test` 里是"无穷等待"（默认超时 Infinity），在变异探针里会被记成
// `TIMEOUT`（与 MISSED 分开的那一类，且会让整轮 FAIL）：两种结果都读不出
// "这条断言没被满足"这个事实。看门狗把它变回一次**干净的失败**。
//
// 用法：`await assert.rejects(() => settlesWithin(call(), 2000, '识物请求'), ...)`。
// 注意它**不**取消被包裹的 Promise（那是被测代码的职责，也正是这些用例要测的东西），
// 只是替测试自己在有限时间内收口。

/**
 * @template T
 * @param {Promise<T>} promise 被测的 Promise（**必须**在一个上限内 settle）
 * @param {number} ms 看门狗时限（比被测上限大一个数量级即可，别把生产上限搬进来）
 * @param {string} label 失败信息里的名字（说清是谁没在上限内收口）
 * @returns {Promise<T>} `promise` 的结果；超时则**拒绝**并说明"没有收口"
 */
export function settlesWithin(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} 在 ${ms}ms 内没有收口（超时闸没生效？）`)),
      ms,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
