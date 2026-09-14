/**
 * 测试替身：假 localStorage + 假 indexedDB。
 * 只在 tests/ 下使用；生产代码（web/units/*.mjs）一律通过参数注入，
 * 因此测试里 globalThis.localStorage / globalThis.indexedDB 保持 undefined。
 *
 * 假 IDB 只实现 store.mjs 用到的子集（open / transaction / objectStore / put·get·delete），
 * 并保留真 IDB 的两条关键语义：
 *   1. open 的 onsuccess/onupgradeneeded、以及事务完成事件，都在**当前同步代码跑完之后**异步派发
 *   2. 同一事务内入队的请求按顺序执行，结果写回各自的 request.result
 */

export function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

export function fakeIndexedDB() {
  const data = new Map();

  return {
    open() {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: () => false },
          createObjectStore: () => {},
          close: () => {},
          transaction() {
            const ops = [];
            let scheduled = false;
            let finished = false;
            let completeHandler = null;

            // 事务对象本身就是返回给调用方的那个对象（访问器挂在它上面）
            const t = {
              objectStore: () => ({
                put: (v, k) => push(() => (data.set(k, v), undefined)),
                get: (k) => push(() => data.get(k)),
                delete: (k) => push(() => (data.delete(k), undefined)),
              }),
              get oncomplete() {
                return completeHandler;
              },
              set oncomplete(fn) {
                // 真 IDB 里监听总是先挂后触发：事件在同步入队之后的宏任务里才派发
                completeHandler = fn;
              },
              onerror: null,
              error: null,
            };

            const push = (op) => {
              const request = { result: undefined, error: null };
              ops.push({ request, op });
              if (finished) {
                request.result = op(); // 事务已结束，退化为立即执行
              } else if (!scheduled) {
                scheduled = true;
                // 同步入队跑完才可能完成事务
                setTimeout(finish, 0);
              }
              return request;
            };

            const finish = () => {
              if (finished) return;
              finished = true;
              for (const { request, op } of ops) request.result = op();
              if (completeHandler !== null) completeHandler();
            };

            return t;
          },
        };
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}
