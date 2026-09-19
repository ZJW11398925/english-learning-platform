// web/units/chat/seeds.mjs
//
// 内置挑战与今日活动的种子（VS1 的「双层供给」里**零模型**的那一层：
// 内置精品种子；「用户模型生成更多」随 VS3，本切片没有）。
//
// ── 数据在 `web/data/chat-seeds.json`，逻辑在这里 ──────────────────────────────
// 两个池子：
//   · `activities`（今日活动）：按**日期**轮换，占开场信末尾的 P.S. 附笔位；
//   · `challenges`（挑战）：「换个挑战」小签随机抽一个（排除当前这条）。
// 内容是**演示资产，由执行者撰写、无审校**——这条声明同时写在 JSON 的
// `meta.note` 里（数据自己说明自己，不靠仓库外的人转述）。
//
// ── 轮换与随机都可测 ─────────────────────────────────────────────────────────
// `activityForDay` 纯字符串算（YYYY-MM-DD → 当年积日 % 池长），不碰 Date、
// 不碰时区——同一份种子在任何机器上算出同一个答案。「随机」的骰子（`rng`）
// 是注入点：测试钉死序列，生产传 `Math.random`。
//
// 纯逻辑模块：数据经参数进来（`loadSeeds` 的 `fetch` 也是注入点），零浏览器 API。

/**
 * 把一份原始 JSON 归一成种子表。**噪声容忍、形状从严**（与 `../write/parse.mjs`
 * 同一条纪律）：字段缺 / 空 / id 重复 ⇒ `null`（整份不可用——种子是供给的地基，
 * 部分接受会让「今日活动」静默变成空白）。
 * @returns {{activities: Array<{id:string,title:string,text:string}>, challenges: Array<{id:string,text:string}>, meta: object} | null}
 */
export function normalizeSeeds(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const normList = (list, shape) => {
    if (!Array.isArray(list) || list.length === 0) return null;
    const out = [];
    const seen = new Set();
    for (const item of list) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const id = typeof item.id === 'string' && item.id.trim() !== '' ? item.id.trim() : null;
      if (id === null || seen.has(id)) return null;
      seen.add(id);
      if (shape === 'activity') {
        const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : null;
        const text = typeof item.text === 'string' && item.text.trim() !== '' ? item.text.trim() : null;
        if (title === null || text === null) return null;
        out.push({ id, title, text });
      } else {
        const text = typeof item.text === 'string' && item.text.trim() !== '' ? item.text.trim() : null;
        if (text === null) return null;
        out.push({ id, text });
      }
    }
    return out;
  };
  const activities = normList(raw.activities, 'activity');
  const challenges = normList(raw.challenges, 'challenge');
  if (activities === null || challenges === null) return null;
  return { activities, challenges, meta: raw.meta ?? {} };
}

/**
 * `YYYY-MM-DD` → 当年积日（1 起）。纯字符串算：`new Date('YYYY-MM-DD')` 会按
 * **UTC** 零点解析，跨时区会差一天——种子的轮换不该依赖机器时区。
 */
export function dayOfYear(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? '').trim());
  if (m === null) return null;
  const [, yS, moS, dS] = m;
  const y = Number(yS);
  const mo = Number(moS);
  const d = Number(dS);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const cum = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (leap && mo === 2 && d > 29) return null;
  let n = d;
  for (let i = 0; i < mo - 1; i += 1) n += cum[i];
  if (leap && mo > 2) n += 1; // 闰年的 2 月 29 日只影响 3 月起的积日
  return n;
}

/**
 * 今天的那条「今日活动」（按日期轮换，确定性：同一天任何机器算同一条）。
 * @param {object} seeds `normalizeSeeds` 产物。
 * @param {string} dateKey `dayKey()` 产物（`YYYY-MM-DD`）。
 * @returns {object|null} 池子空 / 日期键坏 ⇒ `null`（界面如实不印 P.S.，不编）。
 */
export function activityForDay(seeds, dateKey) {
  const pool = seeds?.activities;
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const n = dayOfYear(dateKey);
  if (n === null) return null;
  return pool[(n - 1) % pool.length];
}

/**
 * 「换个挑战」：随机抽一条，**排除当前这条**（换就是要换一条；池子只剩一条时
 * 只能原样返回——如实，不强行换成一个不存在的）。
 * @param {object} seeds
 * @param {object} [opts] `{currentId?: string|null, rng?: () => number}`。
 */
export function drawChallenge(seeds, { currentId = null, rng = Math.random } = {}) {
  const pool = seeds?.challenges;
  if (!Array.isArray(pool) || pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const others = pool.filter((c) => c.id !== currentId);
  const list = others.length > 0 ? others : pool;
  const pick = list[Math.floor((typeof rng === 'function' ? rng() : Math.random()) * list.length)];
  return pick ?? list[0];
}

/**
 * 取种子文件（装配层用；测试直接传数据进 `normalizeSeeds`）。
 * @param {object} deps `{url: string|URL, fetch: (url) => Promise}`——fetch 必传
 *   （浏览器同源 / Node 读盘各走各的注入，本模块不猜运行时）。
 */
export async function loadSeeds({ url, fetch: fetchImpl }) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('loadSeeds: 需要注入 fetch（浏览器同源 / Node 读盘）');
  }
  const res = await fetchImpl(url);
  if (res === null || res === undefined || res.ok !== true) {
    throw new Error(`取种子文件失败：${String(url)}（HTTP ${String(res?.status)}）`);
  }
  const raw = await res.json();
  const seeds = normalizeSeeds(raw);
  if (seeds === null) {
    throw new Error('种子文件形状不对（activities / challenges 有缺项、空项或 id 重复）');
  }
  return seeds;
}
