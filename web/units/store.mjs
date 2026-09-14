const EVENTS_KEY = 'elp.events';
const WORDS_KEY = 'elp.words';
const META_KEY = 'elp.meta';
const DB_NAME = 'elp-images';
const STORE_NAME = 'images';

export function createStore({ localStorage, indexedDB }) {
  const readJson = (k, fallback) => {
    const raw = localStorage.getItem(k);
    return raw === null ? fallback : JSON.parse(raw);
  };
  const writeJson = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  let dbPromise = null;
  const openDb = () => {
    // 失败不得被永久缓存：拒绝时清空 dbPromise，让下一次调用重新 open。
    // 否则一次瞬时失败（或一次被别的标签页阻塞的开库）会让本页所有图片操作在页面生命周期内全废。
    if (dbPromise === null) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`IndexedDB 打开失败: ${DB_NAME}`));
        // 版本升级被其他标签页的旧连接挡住时，open 既不 success 也不 error：
        // 不处理就会让所有图片操作永久 pending（挂起而不是失败）。这里显式转为拒绝。
        req.onblocked = () => reject(new Error(
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
      t.onerror = () => reject(t.error);
    });
  };

  /**
   * 写入/覆盖一个词。契约：
   * - `w.id` 必填，作为归并键
   * - `w.createdAt` 可选；缺省时补 `Date.now()`，它是 `pruneImages` 的淘汰排序依据，
   *   缺失会让排序比较器拿到 NaN（顺序实现相关，可能淘汰掉最新的图）
   * - 词记录不被任何图片淘汰逻辑删除（「词与事件记录永久保留」）
   */
  const putWord = (w) => {
    const all = readJson(WORDS_KEY, {});
    all[w.id] = { ...w, createdAt: w.createdAt ?? Date.now() };
    writeJson(WORDS_KEY, all);
  };

  return {
    appendEvent: (e) => {
      const all = readJson(EVENTS_KEY, []);
      all.push(e);
      writeJson(EVENTS_KEY, all);
    },
    readEvents: () => readJson(EVENTS_KEY, []),
    putWord,
    readWords: () => readJson(WORDS_KEY, {}),
    putMeta: (k, v) => {
      const all = readJson(META_KEY, {});
      all[k] = v;
      writeJson(META_KEY, all);
    },
    getMeta: (k) => readJson(META_KEY, {})[k] ?? null,
    putImage: (wordId, blob) => tx('readwrite', (s) => s.put(blob, wordId)),
    getImage: (wordId) => tx('readonly', (s) => s.get(wordId)),
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
