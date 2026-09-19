// web/units/lexicon.mjs
//
// 词库查词（**纯逻辑 + 注入 `fetch` / `storage`**，能在 Node 里直接测）。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 数据来源与许可
// ═══════════════════════════════════════════════════════════════════════════════
//   词库 = `web/data/lexicon/`，由 `scripts/build-lexicon.mjs` 从 **ECDICT** 离线构建。
//   ECDICT：https://github.com/skywind3000/ECDICT · **MIT** · Copyright (c) 2025 Linwei
//   许可全文在同目录 `LICENSE-ECDICT.txt`；来源与源 CSV 的 sha256 在 `index.json`。
//   ⚠️ ECDICT 的 `detail`（例句）与 `audio`（发音）在源数据里是空的 ⇒ **本词库没有例句、
//      也没有搭配**。界面那两栏如实写「暂缺」——**不许编**。发音走浏览器自带 `speechSynthesis`。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 三条硬约束（每一条都有单测钉着）
// ═══════════════════════════════════════════════════════════════════════════════
//   ① **只拉该词那一片**。查一个词最多两次请求：它自己那片（同首字母的片全算"它那片"，
//      因为首字母桶被切成多片，词落在哪一片只有打开才知道），以及——**只在它确实是变形时**——
//      原形所在的那一片。`inflect.json` 是**路由表不是片**，且只在需要还原时才拉。
//   ② **运行时零外部请求**：本模块只从 `dataDir`（同源）取片。数据目录由
//      `import.meta.url` 推出来（`web/units/lexicon.mjs` → `web/data/lexicon/`），
//      没有硬编码域名，也没有 CDN。
//   ③ **缺词如实返回 `null`**（不编释义、不返回空壳对象）。界面据此说「词典里没查到」。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 变形 → 原形 的两条路（`gave` → `give`）
// ═══════════════════════════════════════════════════════════════════════════════
//   ① **权威那一份**：构建期从 ECDICT 的 `exchange` 列生成的路由表 `inflect.json`
//      （变形 → 原形）。实测 28,774 键。命中时把"他是从哪个变形还原过来的"如实写进
//      `lemmaForm`，界面据此说「give 的过去式」。
//   ② **保守的构词法回退**：实测 `had` / `thought` / `studies` 这类在 ECDICT 的 exchange
//      里**没有 `0:` 也没有对应的键**，光靠路由表查不到。所以再试几条**只减不增**的规则
//      （`-s` / `-ies` / `-es` / `-ed` / `-ing` / `-ly`，含辅音双写回退），
//      **并且只在该片里真能查到这个词头时才认**。查不到就不认 —— 宁可不还原，不还原错。
//      还原成功时 `lemmaVia` 标出是规则干的（`'rule'`）还是路由表干的（`'exchange'`）。

/** 词库目录（相对本模块）：`web/units/lexicon.mjs` 的上一级 + `data/lexicon/`。 */
export const DATA_DIR = new URL('../data/lexicon/', import.meta.url);

/**
 * 浏览器里已经在跑的那个 `fetch` —— **只取同源的片**。
 * 单独导出是为了让 `createLexicon()` 的缺省值在这一个地方定义（不散落）。
 */
export function sameOriginFetch(url) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('这个运行时没有 fetch：请注入 deps.fetch');
  }
  return globalThis.fetch(url);
}

/**
 * **只在 Node 里用**的取数口：认 `file:` URL，直接读盘。
 *
 * 为什么需要它：单测与门要在 Node 里跑**同一份** `createLexicon`，而 Node 的 `fetch`
 * 不认 `file:`。它**不是给浏览器用的**（`write.html` 永远走真实 http 同源），
 * 所以这里不做任何缓存与降级——读不到就抛，绝不把"读不到"说成"没这个词"。
 */
export async function nodeFileFetch(url) {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  try {
    const text = await readFile(fileURLToPath(url), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, status: 404, json: async () => null };
    throw err;
  }
}

/** 词条对象的字段含义（与 `index.json` 的 `fields` 同源；改一处必须改两处会被门 G9 抓到）。 */
export const ENTRY_FIELDS = Object.freeze({
  w: '词头（原样大小写）',
  phonetic: '音标',
  pos: '词性（带占比，如 n:46/v:54）',
  zh: '中文释义',
  en: '英文释义',
  collins: '柯林斯星级 1–5',
  oxford: '1 = 牛津3000',
  tag: '考纲标签（空格分隔）',
  bnc: 'BNC 词频序',
  frq: '当代语料库词频序',
  exchange: '变形（p:过去式 d:过去分词 i:现在分词 3:三单 r:比较级 t:最高级 s:复数 0:lemma）',
});

/**
 * 查词键：小写、只留字母与撇号。
 * ⚠️ 与视图层 `web/write.view.mjs` 的 `wordKey()` / 引擎 `./write/flow.mjs` 的归一**同一口径**
 * （小写 + 去除非字母非撇号）。三处必须一致，否则"屏上点的那个词"与"查的那个词"会错位。
 */
export function normalizeWord(surface) {
  return String(surface ?? '').toLowerCase().replace(/[^a-z']/g, '');
}

/** 一个词头归到哪个首字母桶（与 `scripts/build-lexicon.mjs` 的 `bucketOf` 逐字一致）。 */
export function bucketOf(word) {
  const w = String(word ?? '').toLowerCase();
  return /^[a-z]/.test(w) ? w[0] : '_';
}

/**
 * 片名里一个字符位的**标记**（与 `scripts/build-lexicon.mjs` 的 `nameChar` 逐字一致）。
 * 两边必须一起改：片名是构建期定的，运行时按同一套规则反推"该取哪一片"。
 * 非 `[a-z0-9]` 的字符（`'`、`-`、`.`…）编成 `_x<hex>`，于是文件名永远安全。
 */
export function nameChar(c) {
  const ch = String(c ?? '');
  if (ch === '') return '_';
  return /^[a-z0-9]$/.test(ch) ? ch : `_x${ch.codePointAt(0).toString(16)}`;
}

/**
 * 保守的构词法回退：给出**可能的原形**（按可信度排序，去重、去空）。
 * 只做"减字符"与三条固定改写，不做任何猜测性替换。
 * @returns {string[]}
 */
export function stripCandidates(word) {
  const w = String(word ?? '').toLowerCase();
  const out = [];
  const push = (x) => { if (typeof x === 'string' && x.length >= 2 && x !== w && !out.includes(x)) out.push(x); };

  if (w.endsWith('ies') && w.length > 4) out.push(`${w.slice(0, -3)}y`);   // studies → study
  if (w.endsWith('es') && w.length > 3) out.push(w.slice(0, -2));         // classes → class / goes → go(不中，go 另路)
  if (w.endsWith('s') && w.length > 2 && !w.endsWith('ss') && !w.endsWith('us')) out.push(w.slice(0, -1));
  if (w.endsWith('ed') && w.length > 3) {
    out.push(w.slice(0, -2));                                             // worked → work
    out.push(w.slice(0, -1));                                             // liked → like
    const stem = w.slice(0, -2);
    const last = stem[stem.length - 1];
    if (last !== undefined && stem.length > 2 && stem[stem.length - 2] === last) out.push(stem.slice(0, -1)); // stopped → stop
  }
  if (w.endsWith('ing') && w.length > 4) {
    out.push(w.slice(0, -3));                                             // working → work
    out.push(`${w.slice(0, -3)}e`);                                       // making → make
    const stem = w.slice(0, -3);
    const last = stem[stem.length - 1];
    if (last !== undefined && stem.length > 2 && stem[stem.length - 2] === last) out.push(stem.slice(0, -1)); // running → run
  }
  if (w.endsWith('ly') && w.length > 4) out.push(w.slice(0, -2));         // usually → usual（**只在真查得到时**才认）

  return out.filter((x, i) => out.indexOf(x) === i);
}

/**
 * `exchange` 列 → 人话的变形清单（词卡上"变形"那一栏）。
 * @returns {Array<{kind: string, label: string, form: string}>}
 */
export const EXCHANGE_LABELS = Object.freeze({
  p: '过去式', d: '过去分词', i: '现在分词', 3: '三单', r: '比较级', t: '最高级', s: '复数', 0: '原形',
});

export function parseExchange(exchange) {
  const out = [];
  for (const part of String(exchange ?? '').split('/')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const kind = part.slice(0, i).trim();
    const form = part.slice(i + 1).trim();
    if (form === '') continue;
    const label = EXCHANGE_LABELS[kind];
    out.push({ kind, label: label ?? kind, form });
  }
  return out;
}

/**
 * 词频序 → **档位**（人话）。不印原始序号（那是给人看的吗？不是），只给一个粗档。
 * 档位名刻意朴素：极高/高/中/较低 —— 不是分数、不是百分比（纪律 ④ 同族）。
 */
export function frequencyBand(entry) {
  const frq = Number.isFinite(entry?.frq) ? entry.frq : 0;
  const bnc = Number.isFinite(entry?.bnc) ? entry.bnc : 0;
  const rank = Math.min(...[frq, bnc].filter((n) => n > 0));
  if (!Number.isFinite(rank)) return null;
  if (rank <= 1000) return { rank, label: '极高' };
  if (rank <= 3000) return { rank, label: '高' };
  if (rank <= 10000) return { rank, label: '中' };
  return { rank, label: '较低' };
}

/** 柯林斯星级 → `'★★★★★'`（1–5）。0 或缺失 ⇒ `null`。 */
export function collinsStars(collins) {
  const n = Number.isFinite(collins) ? collins : 0;
  return n >= 1 && n <= 5 ? '★'.repeat(n) : null;
}

/** 考纲标签 → 人话（ECDICT 的八个标签）。**认识的才翻**，不认识的原样留着。 */
export const TAG_LABELS = Object.freeze({
  zk: '中考', gk: '高考', ky: '考研', cet4: '四级', cet6: '六级',
  toefl: '托福', ielts: '雅思', gre: 'GRE',
});
export const tagLabels = (tag) => String(tag ?? '').split(/\s+/).filter((t) => t !== '').map((t) => TAG_LABELS[t] ?? t);

/**
 * 一条词条 → 词卡要的那份"规范词条"。
 * **只做搬运与翻译，不做任何判断**（有没有查到由调用方看 `null`）。
 */
export function shapeEntry(entry, { lemma = null, lemmaForm = null, lemmaVia = null } = {}) {
  const e = entry ?? {};
  const ex = parseExchange(e.exchange);
  return Object.freeze({
    word: String(e.w ?? ''),
    key: normalizeWord(e.w),
    phonetic: typeof e.phonetic === 'string' && e.phonetic !== '' ? e.phonetic : null,
    pos: typeof e.pos === 'string' && e.pos !== '' ? e.pos : null,
    zh: typeof e.zh === 'string' && e.zh !== '' ? e.zh : null,
    en: typeof e.en === 'string' && e.en !== '' ? e.en : null,
    collins: Number.isFinite(e.collins) && e.collins > 0 ? e.collins : null,
    collinsStars: collinsStars(e.collins),
    oxford: e.oxford === 1,
    tag: typeof e.tag === 'string' && e.tag !== '' ? e.tag : null,
    tagLabels: tagLabels(e.tag),
    bnc: Number.isFinite(e.bnc) && e.bnc > 0 ? e.bnc : null,
    frq: Number.isFinite(e.frq) && e.frq > 0 ? e.frq : null,
    frequency: frequencyBand(e),
    exchange: ex,
    /** 这个词是从哪个变形还原过来的（没还原就是 `null`）。界面据此说「give 的过去式」。 */
    lemma,
    lemmaForm,
    /** `'exchange'` = 构建期路由表；`'rule'` = 运行时构词法规则（只在真查得到时认）。 */
    lemmaVia,
    /** ⚠️ **源数据没有这两栏**（ECDICT 的 detail 列是空的）⇒ 恒为 `null`，界面如实写「暂缺」。 */
    examples: null,
    collocations: null,
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   工厂
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * 造一个查词器。
 *
 * @param {object} [deps]
 *   - `fetch`   注入的取数口（缺省 `globalThis.fetch`）。**只用来取同源的片**。
 *   - `storage` 可选的本机存储（`getItem`/`setItem`/`removeItem`）——只做"片已取过"的缓存，
 *               写不进去（隐私模式 / 配额满）**不拦流程**，只是下次还得再取一遍。
 *   - `dataDir` 词库目录（缺省 `DATA_DIR`）；测试可指向别处。
 *   - `cacheKey` 存储键前缀（缺省 `'elp.lexicon.v1.'`）。
 * @returns {{lookup: (word: string) => Promise<object|null>, stats: () => object, clear: () => void}}
 */
export function createLexicon(deps = {}) {
  // ⚠️ `deps.fetch` **显式给了 null 也要当场拒**（`??` 会把 null 当成"没给"而退回缺省，
  //    于是"注入点写错了"会静默变成"用了全局 fetch"——那是本项目最怕的那种假绿）。
  const fetchImpl = deps.fetch === undefined ? sameOriginFetch : deps.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createLexicon: 需要一个 fetch（缺省取同源的 globalThis.fetch；Node 里请注入 deps.fetch）');
  }
  const dataDir = deps.dataDir ?? DATA_DIR;
  const storage = deps.storage ?? null;
  const cacheKey = deps.cacheKey ?? 'elp.lexicon.v1.';

  /** 进程内缓存：URL → 已解析的 JSON（或 `null` = 取过但取不到）。 */
  const mem = new Map();
  /** 路由表（变形 → 原形）。**只在需要还原时才拉**，拉到就一直留着。 */
  let inflect = null;
  const stats = { requests: [], inflectLoaded: false, hits: 0, misses: 0, lemmas: 0 };

  const urlOf = (name) => new URL(`${name}.json`, dataDir).href;

  const readCache = (key) => {
    if (storage === null) return null;
    try {
      const raw = storage.getItem(`${cacheKey}${key}`);
      return raw === null ? null : JSON.parse(raw);
    } catch { return null; }
  };
  const writeCache = (key, value) => {
    if (storage === null) return;
    try { storage.setItem(`${cacheKey}${key}`, JSON.stringify(value)); } catch { /* 配额满/隐私模式：不拦流程 */ }
  };

  /**
   * 取一份 JSON 文件（片 / 路由表）。**所有请求都记进 `stats.requests`**（门 G8 读它）。
   *
   * ⚠️ **404 与网络失败是两件事**：404 = 这个桶没有这一片（正常，`route` 里列了才对），
   * 网络失败 = 这一次查不成。两者都回 `null`，但会分别标出来，绝不会把"没取到"说成"没这个词"。
   */
  async function load(name) {
    if (mem.has(name)) return mem.get(name);
    const cached = readCache(name);
    if (cached !== null) { mem.set(name, cached); return cached; }
    const url = urlOf(name);
    stats.requests.push(url);
    let res;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      const e = new Error(`取词库分片失败：${url}（${String(err?.message ?? err)}）`);
      e.kind = 'network';
      throw e;
    }
    if (res !== null && res !== undefined && res.ok === false) {
      if (res.status === 404) { mem.set(name, null); return null; }
      const e = new Error(`取词库分片失败：${url}（HTTP ${String(res.status)}）`);
      e.kind = 'http';
      throw e;
    }
    const data = await res.json();
    mem.set(name, data);
    writeCache(name, data);
    return data;
  }

  /** 某个首字母桶的片清单（`route` 是唯一的来源；取不到就当"只有同名那一片"）。 */
  async function shardsFor(letter) {
    const r = await routeIndex();
    const list = r?.[letter];
    if (Array.isArray(list) && list.length > 0) return list;
    return [letter];
  }

  /** `route` 与 `prefixes` 的本地缓存：拉一次 `index.json`，之后零 IO（**首屏不拉**：只在真要查词时才走这里）。 */
  let routeCache = null;
  let prefixCache = null;
  async function routeIndex() {
    if (routeCache === null || prefixCache === null) {
      const idx = (await load('index')) ?? {};
      routeCache = idx.route ?? {};
      prefixCache = idx.prefixes ?? {};
    }
    return routeCache;
  }

  /**
   * **这个词该取哪一片**。
   *
   * `index.json` 的 `prefixes` 是**前缀 → 片名**的表（构建期算好的），所以这里只做
   * 「取一个**是这个词前缀**、且**最长**的前缀」——纯字符串比较，零 IO，零推断。
   *
   * ⚠️ 为什么不能按片名反推（本文件踩过两次，两次都是"看起来对"）：
   *   ① 片名不是词头的前缀 —— `c__l` 这一片覆盖的前缀是 `cl`（词头里 `c`、`l` 是紧挨着的，
   *      没有那两条下划线）⇒ 拿 `"class".startsWith('c__l')` 永远为假；
   *   ② 切开时**一个字符位可能不够分**（`s` 桶里第二位几乎全是 `t`），构建期会跳过这一位
   *      往下切 ⇒ 段数与字符位数**对不上**。
   *   两条加起来：只有构建期真正算出来的前缀表才靠得住。
   *
   * @returns {string|null} 片名；`null` = 表里没有能覆盖这个键的片
   */
  function shardFor(letter, key) {
    const table = prefixCache ?? {};
    let best = null;
    let bestLen = -1;
    for (let i = 1; i <= key.length; i += 1) {
      const p = key.slice(0, i);
      const name = table[p];
      if (typeof name === 'string' && i > bestLen) { bestLen = i; best = name; }
    }
    // 表里连一条能覆盖这个键的前缀都没有（老数据 / 表缺 / 短词只落在"杂项片"里）
    // ⇒ 回 `null`，让调用方走兜底逐片扫 —— **不要**在这里猜一个片名。
    return best;
  }

  /**
   * 在一个桶里找一个词头（**大小写不敏感**）。
   *
   * **先取"该取的那一片"**（`shardFor`，一次请求）；只有在那一轮没中、或者要**还原变形**
   * （原形的前缀可能与变形不同，如 `went` → `go`）时，才退到逐片扫。
   * 这个顺序是"只拉该词那一片"这条硬约束的落点。
   */
  async function findInBucket(letter, key, { routedOnly = true } = {}) {
    await routeIndex();
    const routed = shardFor(letter, key);
    if (routed !== null) {
      const arr = await load(routed);
      if (Array.isArray(arr)) {
        const hit = arr.find((e) => normalizeWord(e?.w) === key);
        if (hit !== undefined) return hit;
      }
      if (routedOnly) return null;
    } else if (routedOnly) {
      return null;
    }
    // 退路：逐片扫（只在没有该取的片、或调用方明确要扫全桶时走）。
    for (const n of await shardsFor(letter)) {
      if (n === routed) continue;
      const arr = await load(n);
      if (!Array.isArray(arr)) continue;
      const hit = arr.find((e) => normalizeWord(e?.w) === key);
      if (hit !== undefined) return hit;
    }
    return null;
  }

  /** 取路由表（懒加载，只拉一次）。 */
  async function loadInflect() {
    if (inflect !== null) return inflect;
    const data = await load('inflect');
    inflect = data?.map !== null && typeof data?.map === 'object' ? data.map : {};
    stats.inflectLoaded = true;
    return inflect;
  }

  /**
   * 查一个词。
   *
   * 顺序（每一步都只在**前一步没中**时才多花一次请求或一次规则试探）：
   *   ① 归一 → **该取的那一片**（`shardFor` 按最长前缀定）精确查（大小写不敏感）；
   *   ② 那一片没中、而这一桶**还有别的片** ⇒ 退到桶内逐片扫一次
   *      （给"没 `route` 的老数据"与"词头写法与片名覆盖范围不一致"兜底）；
   *   ③ 还没中 ⇒ 拉变形路由表，拿"权威的变形 → 原形"，去**原形该取的那一片**查；
   *   ④ 还没中 ⇒ 试构词法回退的候选，**同样只认在真查得到的**；
   *   ⑤ 都没有 ⇒ **`null`**（不编）。
   *
   * @returns {Promise<object|null>} 规范词条；缺词 = `null`。
   */
  async function lookup(word) {
    const key = normalizeWord(word);
    if (key === '') return null;

    const ownBucket = bucketOf(key);
    // ① 该取的那一片（一次请求，命中即返回 —— 这是绝大多数情况）
    let direct = await findInBucket(ownBucket, key);
    // ② 兜底：桶内逐片扫（只在"该取的那一片"没中时才发生）
    if (direct === null) direct = await findInBucket(ownBucket, key, { routedOnly: false });
    if (direct !== null) { stats.hits += 1; return shapeEntry(direct); }

    // ③ 权威路由表
    const map = await loadInflect();
    const lemma = typeof map[key] === 'string' ? map[key] : null;
    const tries = [];
    if (lemma !== null) tries.push({ lemma, via: 'exchange' });
    // ④ 构词法回退
    for (const cand of stripCandidates(key)) {
      if (cand !== lemma) tries.push({ lemma: cand, via: 'rule' });
    }

    for (const t of tries) {
      const found = await findInBucket(bucketOf(t.lemma), t.lemma);
      if (found !== null) {
        stats.hits += 1;
        stats.lemmas += 1;
        return shapeEntry(found, { lemma: t.lemma, lemmaForm: key, lemmaVia: t.via });
      }
    }

    stats.misses += 1;
    return null;
  }

  return {
    lookup,
    /** 机械读数（门 G8 用）：取过哪些 URL、路由表拉没拉、命中与缺词各几次。 */
    stats: () => ({ requests: [...stats.requests], inflectLoaded: stats.inflectLoaded, hits: stats.hits, misses: stats.misses, lemmas: stats.lemmas, cached: mem.size }),
    /** 清进程内缓存（**清存储不在这里**：存储是注入进来的，谁的存储谁清）。 */
    clear: () => { mem.clear(); inflect = null; routeCache = null; prefixCache = null; stats.inflectLoaded = false; },
    /** 路由表（测试用）。 */
    route: async () => (await load('index'))?.route ?? null,
    /**
     * 「这个词该取哪一片」的对外读数（测试与探针用；**会拉一次 `index.json`**，因为
     * 答案就在它里面 —— 不先 await 路由表，`shardFor` 会恒回 `null`，那是假的读数）。
     */
    shardFor: async (word) => {
      await routeIndex();
      const k = normalizeWord(word);
      return shardFor(bucketOf(k), k);
    },
  };
}
