// web/units/chat/meter.mjs
//
// 透明仪表的纯逻辑层：token 明细的**读、算、存**。
//
// ── 三层可见（任务书第三节）───────────────────────────────────────────────────
//   ① 每条 AI 消息下的微标（`formatUsageLine`：↑入 ↓出 ·缓存命中）
//   ② 会话头累计（本通 = 这次挂载以来的会话账；今日 = 账本里今天那一格）
//   ③ 设置页总量（账本 `totalsOf`：跨天累计）
//   ①②由装配层在渲染时调本模块；③直接读账本。
//
// ── 缺键不是零（红线 4，本模块是它在对话形态的落点）────────────────────────────
//   · `usage` 整个缺失（有的端点不给 usage）→ 微标印「—」，账本只记调用次数，
//     **不**给 token 补 0——0 是「合法且极好」的读数，补了会把「没量到」伪装成「没花钱」。
//   · `prompt_cache_hit_tokens` 缺失（OpenAI 形状的端点给的是
//     `prompt_tokens_details.cached_tokens`，两边都认）→ 微标印「·缓存—」。
//   · 汇总时只有**真的量到过**的条目才进 token 和；一条都没量到 ⇒ 汇总是 `null`
//     （界面据此印「—」），不是 0。
//
// ── 账本（`elp.chat.usage.v1`）────────────────────────────────────────────────
//   `{version:1, days:{"2026-09-19":{calls,up,down,cacheHit,measured}}}`。
//   只追加当天那一格，不删别的天（清数据是装配层「数据清除」按钮的显式职责）。
//   存不进（隐私模式/配额满）不拦流程——仪表少一格，聊天照常。
//
// 纯逻辑模块：零 import、零浏览器 API（storage 是注入参数）。

/** 账本键（`.v1` = 形状版本；将来形状变了换键，不静默迁移）。 */
export const USAGE_LEDGER_KEY = 'elp.chat.usage.v1';

/** 空账本（每次新建，免得调用方改到共享引用）。 */
export function emptyLedger() {
  return { version: 1, days: {} };
}

/**
 * 从 usage 里读缓存命中 token（DeepSeek 形状与 OpenAI 形状都认）。
 * @returns {number|null} `null` = 这个端点没给这个字段（≠ 0）。
 */
export function cacheHitOf(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  if (Number.isFinite(usage.prompt_cache_hit_tokens)) return usage.prompt_cache_hit_tokens;
  const nested = usage.prompt_tokens_details?.cached_tokens;
  if (Number.isFinite(nested)) return nested;
  return null;
}

/** token 数的显示：≥1000 印 `1.2k`；没量到印 `—`（绝不印 0 冒充量到了）。 */
export function formatTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * 每条 AI 消息下的微标。`usage` 缺失 → 整行就是「—」。
 * 例：`↑118 ↓326 ·缓存命中` / `↑118 ↓— ·缓存—` / `—`。
 */
export function formatUsageLine(usage) {
  if (usage === null || typeof usage !== 'object') return '—';
  const up = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const down = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
  const hit = cacheHitOf(usage);
  const cachePart = hit === null ? '缓存—' : (hit > 0 ? '缓存命中' : '缓存0');
  return `↑${formatTokens(up)} ↓${formatTokens(down)} ·${cachePart}`;
}

/**
 * 本地时区的日期键（`YYYY-MM-DD`）。「今日」按学习者自己的日历算，不按 UTC。
 */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 读账本（坏 JSON / 形状不对 / 存储不可用 ⇒ 空账本，不抛错）。 */
export function loadLedger(storage = null) {
  if (storage === null || storage === undefined || typeof storage.getItem !== 'function') {
    return emptyLedger();
  }
  let raw;
  try {
    raw = storage.getItem(USAGE_LEDGER_KEY);
  } catch {
    return emptyLedger();
  }
  if (typeof raw !== 'string' || raw.trim() === '') return emptyLedger();
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyLedger();
    if (parsed.version !== 1 || parsed.days === null || typeof parsed.days !== 'object'
      || Array.isArray(parsed.days)) return emptyLedger();
    return { version: 1, days: parsed.days };
  } catch {
    return emptyLedger();
  }
}

/** 只把有限数加进去（`null` 起步且**保持 null**：一条都没量到就还是 null，不变成 0）。 */
const addFinite = (acc, v) => (Number.isFinite(v) ? (acc ?? 0) + v : acc);

/**
 * 把一次调用的 usage 记进账本当天那一格（不删别的天），并尽力写回存储。
 *
 * @param {object} storage 注入的存储（可 null：只算不存——探针/测试用）。
 * @param {string} key `dayKey()` 产物。
 * @param {object|null} usage 这次调用的 usage（null = 端点没给）。
 * @returns {object} 记完之后的**新**账本（原账本不动）。
 */
export function addUsage(storage, key, usage) {
  const ledger = loadLedger(storage);
  const day = { calls: 0, up: null, down: null, cacheHit: null, measured: 0 };
  const old = ledger.days[key];
  if (old !== null && typeof old === 'object' && !Array.isArray(old)) {
    day.calls = Number.isFinite(old.calls) ? old.calls : 0;
    day.up = Number.isFinite(old.up) ? old.up : null;
    day.down = Number.isFinite(old.down) ? old.down : null;
    day.cacheHit = Number.isFinite(old.cacheHit) ? old.cacheHit : null;
    day.measured = Number.isFinite(old.measured) ? old.measured : 0;
  }
  day.calls += 1;
  if (usage !== null && typeof usage === 'object') {
    // 只有真的量到的字段才进和（measured 记「这几条里有 usage 的条数」，
    // 供界面对「↑—」这种汇总行给出诚实解释）。
    if (Number.isFinite(usage.prompt_tokens)) {
      day.up = addFinite(day.up ?? 0, usage.prompt_tokens);
    }
    if (Number.isFinite(usage.completion_tokens)) {
      day.down = addFinite(day.down ?? 0, usage.completion_tokens);
    }
    const hit = cacheHitOf(usage);
    if (hit !== null) day.cacheHit = addFinite(day.cacheHit ?? 0, hit);
    day.measured += 1;
  }
  const next = { version: 1, days: { ...ledger.days, [key]: day } };
  if (storage !== null && storage !== undefined && typeof storage.setItem === 'function') {
    try {
      storage.setItem(USAGE_LEDGER_KEY, JSON.stringify(next));
    } catch {
      // 存不进不拦流程：聊天照常，仪表下次从盘上读到什么算什么
    }
  }
  return next;
}

/**
 * 跨天总量（设置页那一层）。
 * @returns {{calls:number, up:number|null, down:number|null, cacheHit:number|null, measured:number, days:number}}
 */
export function totalsOf(ledger) {
  const days = (ledger !== null && typeof ledger === 'object' && ledger.days !== null
    && typeof ledger.days === 'object' && !Array.isArray(ledger.days)) ? ledger.days : {};
  const out = { calls: 0, up: null, down: null, cacheHit: null, measured: 0, days: 0 };
  for (const day of Object.values(days)) {
    if (day === null || typeof day !== 'object' || Array.isArray(day)) continue;
    out.days += 1;
    out.calls += Number.isFinite(day.calls) ? day.calls : 0;
    out.up = addFinite(out.up, day.up);
    out.down = addFinite(out.down, day.down);
    out.cacheHit = addFinite(out.cacheHit, day.cacheHit);
    out.measured += Number.isFinite(day.measured) ? day.measured : 0;
  }
  return out;
}

/** 某一天的格子（没有就是全空——调用方据此印「今日 —」而不是 0）。 */
export function dayOf(ledger, key) {
  const day = ledger?.days?.[key];
  if (day === null || day === undefined || typeof day !== 'object' || Array.isArray(day)) {
    return { calls: 0, up: null, down: null, cacheHit: null, measured: 0 };
  }
  return day;
}
