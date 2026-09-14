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
    if (dbPromise === null) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
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

  return {
    appendEvent: (e) => {
      const all = readJson(EVENTS_KEY, []);
      all.push(e);
      writeJson(EVENTS_KEY, all);
    },
    readEvents: () => readJson(EVENTS_KEY, []),
    putWord: (w) => {
      const all = readJson(WORDS_KEY, {});
      all[w.id] = w;
      writeJson(WORDS_KEY, all);
    },
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
      const words = readJson(WORDS_KEY, {});
      const ids = Object.values(words)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((w) => w.id);
      const stale = ids.slice(keep);
      for (const id of stale) await tx('readwrite', (s) => s.delete(id));
      return stale.length;
    },
  };
}
