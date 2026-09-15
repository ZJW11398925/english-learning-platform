// web/units/store.mjs
//
// 存储层：`localStorage`（事件与词状态）+ `IndexedDB`（图片）。
//
// ── 配额满（`QuotaExceededError`）怎么处理（Task 9B）──────────────────────────
//
// 设计 §5.1 与 Global Constraint 3 要求：**存储写满 → 停止新任务并提示导出，不丢历史**，
// 落 `storage_full`。而在本任务之前，`writeJson` / `appendEvent` 是让配额异常**直接冒泡**的
// （Task 1 留档的缺口）：于是"存储写满"这件事既没有标签、也没有统一的处置，
// 调用点各自决定（有的 catch 成一句界面文案，有的干脆没有 catch）。
//
// 现在收敛到本模块一处：
//   1. **能力探测式判定**（`isStoreFullError`）：不同浏览器给的形状不同（见那里的说明），
//      只认一种就是"在别的浏览器上这个档位永远不可达"；
//   2. 判定成立 → `markStoreFull()`（**幂等，只写一次**，见那里的自反悖论说明），
//      然后**原样重抛**——本层绝不把"写失败"静默变成"写成功"（Global Constraint 3）。
//
// ⚠️ **不覆盖历史**是 `setItem` 的语义天然给的：本模块的写一律是"读出全量 → 序列化新值 →
// 一次 `setItem`"，`setItem` 要么整体成功、要么整体失败，**不存在写了一半的中间态**。
// 所以写失败时存储里留下的仍是写之前那份完整历史（有测试钉住这条）。

/** 事件、词、元数据三把键（诊断页也读它们，改名要同步改 web/diagnostics.html）。 */
const EVENTS_KEY = 'elp.events';
const WORDS_KEY = 'elp.words';
const META_KEY = 'elp.meta';
/**
 * `markStoreFull` 落标签用的元数据键：**幂等标记**（见 `markStoreFull`）。
 *
 * 它只活在 `localStorage` 里（写不进去就写不进去），是"这个浏览器上标签已经尽力试过一次"
 * 的记录，不是"存储满了"这件事的判定依据——判定依据永远是 `isFull()`。
 */
export const STORAGE_FULL_MARK_KEY = 'storage_full_marked_at';
/** 事件、词、元数据三把键的只读副本（诊断页/导出脚本要用同一份定义时读它，别各写一套）。 */
export const STORAGE_KEYS = Object.freeze({ EVENTS_KEY, WORDS_KEY, META_KEY });
const DB_NAME = 'elp-images';
const STORE_NAME = 'images';

/**
 * 这个异常是不是"存储写满了"——**能力探测，不是只认一种形状**。
 *
 * 三种证据任一成立即判定（都来自真实浏览器行为，不是猜的）：
 *   · `name` 是 `QuotaExceededError`（Chromium / Firefox / Safari 的现代版本都这么报）；
 *   · `name` 是 `NS_ERROR_DOM_QUOTA_REACHED`（老 Firefox 的 DOMException 名字）；
 *   · `code` 是 `22`（`DOMException.QUOTA_EXCEEDED_ERR` 的旧式数字码）或 `1014`
 *     （Firefox 私密模式下配额用尽时给的码）。
 *
 * **为什么要三种**：只认 `name === 'QuotaExceededError'` 的话，Safari 与老 Firefox 上
 * `storage_full` 这个档位永远不会被触发——而 Global Constraint 3 明确要求失败不得静默。
 * 反过来，**不许把任何异常都当配额满**：判定过宽会把一次普通写失败（例如键名非法）
 * 记成"存储写满"，用户被引去导出数据，而真凶根本不是存储。
 *
 * 无参也不抛错（`err` 可能是 `null`/字符串/数字）：判定函数不该成为新的崩溃点。
 */
export function isStoreFullError(err) {
  if (err === null || err === undefined) return false;
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  const code = typeof err.code === 'number' ? err.code : NaN;
  return code === 22 || code === 1014;
}

export function createStore({ localStorage, indexedDB }) {
  const readJson = (k, fallback) => {
    const raw = localStorage.getItem(k);
    return raw === null ? fallback : JSON.parse(raw);
  };
  const writeJson = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  /**
   * 存储写满之后**只置一次**的标记（`markStoreFull` 第一句就兜住）。
   *
   * 为什么必须幂等：落 `storage_full` 这个标签本身**也要写存储**，而存储已经满了
   * ——这是一处自反悖论（brief §2.2 点名要求正面处理）。处置见 `markStoreFull`。
   */
  let fullMarked = false;

  /**
   * 存储写满的**判定依据**（界面上"停止派发新任务"的开关就是它）。
   *
   * 只活在本次页面生命周期里：刷新之后由下一次写失败重新置起来。
   * 之所以不持久化：它要在存储**写不进去**的时候仍然可用——任何"存起来"的方案
   * 在那个时刻都存不下去。
   */
  const isFull = () => fullMarked;

  /**
   * 标记"存储写满了"，并**尽力**给用户留下一句"曾经满过"的话。
   *
   * ── 自反悖论（brief §2.2）：存储已经写满，而落 `storage_full` 标签本身还要写存储 ──
   *
   * 处置（**两条出口各写清**）：
   *   1. **界面提示是主出口**：`isFull()` 一旦为真，界面就停止派发新任务、提示导出、
   *      并如实说明"记录写不进去了"。这条出口**不依赖任何写入**，所以它在存储满的时候
   *      一定生效（真正的用户可见行为见 `web/app.mjs` 的 `STORAGE_FULL_NOTICE`）。
   *   2. **`storage_full` 标签是"尽力而为"**：写一次，失败就不再重试
   *      （`fullMarked` 挡住第二次）。于是 **`storage_full` 事件可能不存在**，
   *      数据里留下的最好情况是元数据里的 `storage_full_marked_at` 时间戳，
   *      最坏情况是只有事件流/词表**没有继续增长**这一条间接证据。
   *      **这一点必须如实写在报告里，不许把"尽力而为"说成"已记录"。**
   *
   * 为什么"失败也不重试"：重试只会让同一个配额异常反复发生，而每次重试本身
   * 又要在满的存储上写一次——那是把"写满"变成一处会自激的循环。
   *
   * 顺序是刻意的：**先置内存标记，再试着落标签**。反过来的话，落标签那次写入自己抛出的
   * 配额异常会从 `markStoreFull` 里冒出去，让"标记已完成"这件事取决于那次写入的运气。
   *
   * @returns {boolean} 这次调用是不是**第一次**标记（`false` = 之前已经标过了）
   */
  function markStoreFull() {
    if (fullMarked) return false;
    fullMarked = true;
    try {
      // 直写 `setItem`（不经 `writeJson`）：这条路径本身失败时不许再递归触发标记逻辑。
      const all = readJson(META_KEY, {}) ?? {};
      all[STORAGE_FULL_MARK_KEY] = Date.now();
      localStorage.setItem(META_KEY, JSON.stringify(all));
    } catch {
      // 写不进去是**预期之内**的（存储就是满的），不是新故障：不再重试、不改变返回值。
    }
    return true;
  }

  /**
   * 把一次写操作按"配额满 → 标记 + 原样重抛，其它错误 → 原样重抛"处理。
   *
   * **两种都重抛**：本层不吞任何写失败（吞掉就等于把"没记下来"伪装成"记下来了"）。
   * 区别只在"配额满"这一种会**额外**置起 `isFull()`，让界面能停止派发新任务。
   * 不做 `catch (err) { if (!quota) throw err; }` 那种"配额满就静默"的写法——
   * 那正是 Global Constraint 3 禁止的静默降级。
   */
  const guarded = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (isStoreFullError(err)) markStoreFull();
      throw err;
    }
  };

  let dbPromise = null;
  const openDb = () => {
    // 失败不得被永久缓存：拒绝时清空 dbPromise，让下一次调用重新 open。
    // 否则一次瞬时失败（或一次被别的标签页阻塞的开库）会让本页所有图片操作在页面生命周期内全废。
    if (dbPromise === null) {
      dbPromise = new Promise((resolve, reject) => {
        // onblocked / onerror 会让 promise 提前 settle，但请求本身仍然活着：
        // 真 IDB 在阻塞解除后还会派发一次 onsuccess。若那时再 resolve，就会留下一个
        // 没有任何人 close 的活连接（连接一直不关，后续标签页的版本升级还会被它挡住）。
        let settled = false;
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => {
          if (settled) {
            // 迟到的成功：promise 已拒绝，没人会再拿这个连接，就地关掉
            req.result.close();
            return;
          }
          settle(resolve, req.result);
        };
        req.onerror = () => settle(reject, req.error ?? new Error(`IndexedDB 打开失败: ${DB_NAME}`));
        // 版本升级被其他标签页的旧连接挡住时，open 既不 success 也不 error：
        // 不处理就会让所有图片操作永久 pending（挂起而不是失败）。这里显式转为拒绝。
        req.onblocked = () => settle(reject, new Error(
          `IndexedDB 打开被阻塞（${DB_NAME} v1）：请关闭本站点的其他标签页后重试`,
        ));
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  };

  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE_NAME, mode);
      const req = fn(t.objectStore(STORE_NAME));
      t.oncomplete = () => resolve(req?.result);
      // 图片走 IndexedDB（配额是另一套）。这里同样"配额满 → 标记"：设计 §5.1 那一档
      // 说的是"存储写满"，不该只覆盖 localStorage 那一半。
      t.onerror = () => {
        if (isStoreFullError(t.error)) markStoreFull();
        reject(t.error);
      };
    });
  };

  /**
   * 写入/覆盖一个词。契约：
   * - `w.id` 必填，作为归并键
   * - `w.createdAt` 可选；缺省时补 `Date.now()`，它是 `pruneImages` 的淘汰排序依据，
   *   缺失会让排序比较器拿到 NaN（顺序实现相关，可能淘汰掉最新的图）
   * - **已存在的记录按 id 覆盖时，其 `createdAt` 一律保留**（`w.createdAt` > 已有记录的
   *   `createdAt` > `Date.now()`）：复现流程（设计文档 §4.5）只更新 `stage`/`dueAt` 且不带
   *   `createdAt`，若在这里重新盖时间戳，该词会被当成"最新"，`pruneImages` 就会淘汰掉
   *   真正更老的词的图——写错图片比写错词更贵
   * - 词记录不被任何图片淘汰逻辑删除（「词与事件记录永久保留」）
   * - **写失败一律原样抛出**（配额满时额外置起 `isFull()`，见文件头）
   */
  const putWord = (w) => guarded(() => {
    const all = readJson(WORDS_KEY, {});
    all[w.id] = { ...w, createdAt: w.createdAt ?? all[w.id]?.createdAt ?? Date.now() };
    writeJson(WORDS_KEY, all);
  });

  return {
    appendEvent: (e) => guarded(() => {
      const all = readJson(EVENTS_KEY, []);
      all.push(e);
      writeJson(EVENTS_KEY, all);
    }),
    readEvents: () => readJson(EVENTS_KEY, []),
    putWord,
    readWords: () => readJson(WORDS_KEY, {}),
    putMeta: (k, v) => guarded(() => {
      const all = readJson(META_KEY, {});
      all[k] = v;
      writeJson(META_KEY, all);
    }),
    getMeta: (k) => readJson(META_KEY, {})[k] ?? null,
    putImage: (wordId, blob) => tx('readwrite', (s) => s.put(blob, wordId)),
    getImage: (wordId) => tx('readonly', (s) => s.get(wordId)),
    /** 存储写满的判定依据（界面据此停止派发新任务）。 */
    isFull,
    /** 标记存储写满（幂等）；返回是否第一次标记。调用方一般不需要直接调它。 */
    markStoreFull,
    /** 只保留最近 keep 个词的图；词与事件记录不受影响 */
    pruneImages: async (keep = 20) => {
      // createdAt 缺失/非法一律当 0（最旧）——否则比较器返回 NaN，淘汰顺序变成实现相关，
      // 极端情况下会把最新的图删掉。putWord 已保证新写入的词带上 createdAt，这里只兜底历史数据。
      const at = (w) => (Number.isFinite(w?.createdAt) ? w.createdAt : 0);
      const words = readJson(WORDS_KEY, {});
      const ids = Object.values(words)
        .sort((a, b) => at(b) - at(a))
        .map((w) => w.id);
      const stale = ids.slice(keep);
      for (const id of stale) await tx('readwrite', (s) => s.delete(id));
      return stale.length;
    },
  };
}
