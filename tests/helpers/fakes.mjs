/**
 * 测试替身：假 localStorage + 假 indexedDB。
 * 只在 tests/ 下使用；生产代码（web/units/*.mjs）一律通过参数注入，
 * 因此测试里 globalThis.localStorage / globalThis.indexedDB 保持 undefined。
 *
 * 假 IDB 只实现 store.mjs 用到的子集（open / transaction / objectStore / put·get·delete），
 * 并保留真 IDB 的两条关键语义：
 *   1. open 的 onsuccess/onupgradeneeded/onblocked、以及事务完成事件，都在**当前同步代码跑完之后**异步派发
 *   2. 同一事务内入队的请求按顺序执行，结果写回各自的 request.result
 *
 * 复盘（Task 1 首次实现时踩过）：事务对象必须与返回给调用方的对象**同体**，
 * 否则 t.oncomplete 赋值退化为普通属性、事务永不完成 → node --test 零输出挂死。
 *
 * 三个供测试用的观测/注入点：
 *   - calls：记录 open() 的库名·版本、transaction() 的 (storeName, mode)、objectStore() 的店名
 *   - failNextTransaction()：让下一笔事务失败（request.error + t.onerror 派发），用于错误路径注入
 *   - openBlocked / failNextOpen() / blockNextOpenThenSucceed()：让 open 派发 onblocked、
 *     onerror，或"先 onblocked 再迟到 onsuccess"，用于开库失败路径注入
 *   - closedDbs：记录被 close() 掉的连接，用于断言"迟到的成功连接没有被泄漏"
 */

/**
 * 真 IDB 写入是**结构化克隆**（拷值语义），不是存引用。
 * Uint8Array → 拷字节；Blob 不可变，直接留引用即可（见下方 put 的注释）。
 */
const cloneForStore = (v) => {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
};

export function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

export function fakeIndexedDB({ openBlocked = false } = {}) {
  const data = new Map();

  // 下一次 open 的行为：正常 / 被别的连接阻塞（onblocked）/ 开库出错（onerror）
  let nextOpen = openBlocked ? 'blocked' : 'ok';
  let nextOpenError = null;
  // 阻塞之后是否还会迟到地成功（真 IDB 在挡住升级的旧连接关掉后会补派发 onsuccess）
  let nextOpenSucceedsAfterBlock = false;
  // 下一笔事务的失败注入
  let pendingFailure = null;

  // 调用记录：断言 store.mjs 真的用对了库、店名与事务模式
  const calls = { opens: [], transactions: [], objectStores: [] };
  // 被关闭的连接：迟到的成功连接若没被 close，就会一直挂在这里没人管
  const closedDbs = [];

  return {
    calls,
    closedDbs,
    failNextTransaction(error = new Error('注入的事务失败')) {
      pendingFailure = error;
    },
    failNextOpen(error = new Error('注入的开库失败')) {
      nextOpen = 'error';
      nextOpenError = error;
    },
    blockNextOpen() {
      nextOpen = 'blocked';
      nextOpenSucceedsAfterBlock = false;
    },
    blockNextOpenThenSucceed() {
      nextOpen = 'blocked';
      nextOpenSucceedsAfterBlock = true;
    },

    open(name, version) {
      const behavior = nextOpen;
      const openError = nextOpenError;
      const blockedThenSucceeds = nextOpenSucceedsAfterBlock;
      nextOpen = 'ok';
      nextOpenError = null;
      nextOpenSucceedsAfterBlock = false;
      calls.opens.push({ name, version });

      const req = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      setTimeout(() => {
        if (behavior === 'blocked') {
          if (req.onblocked) req.onblocked();
          if (!blockedThenSucceeds) return;
          // 迟到的成功：阻塞解除后真 IDB 会补派发 onsuccess（调用方可能已经 reject 了）
          setTimeout(() => {
            const db = makeDb();
            req.result = db;
            if (req.onupgradeneeded) req.onupgradeneeded();
            if (req.onsuccess) req.onsuccess();
          }, 0);
          return;
        }
        if (behavior === 'error') {
          req.error = openError;
          if (req.onerror) req.onerror();
          return;
        }
        const db = makeDb();
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;

      function makeDb() {
        return {
          name,
          closed: false,
          objectStoreNames: { contains: () => false },
          createObjectStore: () => {},
          close() {
            this.closed = true;
            closedDbs.push(this);
          },
          transaction(storeName, mode) {
            calls.transactions.push({ storeName, mode });
            const ops = [];
            let scheduled = false;
            let finished = false;
            let completeHandler = null;
            let errorHandler = null;

            // 事务对象本身就是返回给调用方的那个对象（访问器挂在它上面）
            const t = {
              objectStore(name) {
                calls.objectStores.push({ name });
                return {
                  // 真 IDB 的语义：put 把值**结构化克隆**后存入并 resolve 到 key；
                  // delete resolve 到 undefined。（不是替身自己 Map.set/Map.delete 的返回值）
                  put: (v, k) => push(() => { data.set(k, cloneForStore(v)); return k; }),
                  get: (k) => push(() => data.get(k)),
                  delete: (k) => push(() => { data.delete(k); return undefined; }),
                };
              },
              get oncomplete() {
                return completeHandler;
              },
              set oncomplete(fn) {
                // 真 IDB 里监听总是先挂后触发：事件在同步入队之后的宏任务里才派发
                completeHandler = fn;
              },
              get onerror() {
                return errorHandler;
              },
              set onerror(fn) {
                errorHandler = fn;
              },
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
              const injected = pendingFailure;
              pendingFailure = null;
              const first = ops[0];
              if (injected !== null && first !== undefined) {
                // 注入失败：请求带上错误，事务以 error 事件收尾（不再派发 complete）
                first.request.error = injected;
                t.error = injected;
                if (errorHandler !== null) errorHandler();
                return;
              }
              for (const { request, op } of ops) request.result = op();
              if (completeHandler !== null) completeHandler();
            };

            return t;
          },
        };
      }
    },
  };
}
