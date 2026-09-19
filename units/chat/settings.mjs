// web/units/chat/settings.mjs
//
// 对话客厅的**本机设置**：provider 三件套（baseURL / API Key / 模型名）+ AI 回复语言。
//
// ── BYOK 零预置（契约口径，本模块是它的唯一落点）───────────────────────────────
// 这里**没有**任何厂商的缺省值——不含 DeepSeek、不含任何示例 Key。设置页的占位符
// 只给**格式示例**（「https://…/v1」「你的 Key」「模型名」），不是可用值。
// 校验只做两件事：① 协议必须是 http/https（拒绝 ftp:、file: 等一切别的协议）；
// ② 三件都非空才算「配好了」。**localhost / 内网地址是合法特性**（BYOK 本地模型，
// 任务书明示的裁量）：浏览器直连自己机器上的 OpenAI 兼容服务（LM Studio / Ollama /
// vLLM 一类）不需要拦——拦了就把「本地免费模型」这条产品路堵死了。
//
// ── Key 的形状 ────────────────────────────────────────────────────────────────
// 不沿用 `../keyring.mjs` 的 `sk-` 前缀尺子：那是 DeepSeek 专属形状，BYOK 下
// 本地端点的 Key（甚至占位 Key）不一定长这样。这里的尺子只有「非空白字符串」。
// 同理 Key 存自己的键（`elp.chat.key`），不与旧形态的 `elp.apiKey` 混住——
// 旧页照常用它的，互不踩脚（`./store.mjs` 同一条纪律：一个模块只碰自己的键）。
//
// ── 回复语言 ─────────────────────────────────────────────────────────────────
// `en`（缺省，英语回复）| `zh`（中文回复）。值域就这两个，别的值读出来一律回落 `en`
// （存坏不该炸界面），写入侧拒绝收第三个值。
//
// 纯逻辑模块：零 import、零浏览器 API（storage 是注入参数）——Node 里用假存储直接测。

/** 本模块**只许**碰的键（诊断与测试据此断言"不越界"）。 */
export const CHAT_SETTINGS_KEYS = Object.freeze([
  'elp.chat.base',
  'elp.chat.key',
  'elp.chat.model',
  'elp.chat.lang',
]);

/** 回复语言的值域（冻结：提示词按这两个值分岔，多一个值就多一条没裁过的路）。 */
export const REPLY_LANGUAGES = Object.freeze(['en', 'zh']);

/** 设置的形状：全部字段恒在（没配就是空串），调用方不用判 undefined。 */
export function emptySettings() {
  return { apiBase: '', apiKey: '', model: '', replyLanguage: 'en' };
}

/** 存储的唯手解析点：注入了用注入的；没注入在调用时看一眼全局（没有就当没有）。 */
const ls = (storage) => {
  if (storage !== null && storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // 隐私模式下访问这一步就会抛——与"没有"同等对待
  }
};

const readStr = (storage, key) => {
  try {
    const raw = storage.getItem(key);
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
};

/**
 * 读设置。任何读不到 / 读坏的情形都返回**空设置**（不抛错）：没配就是没配，
 * 界面据此引导去设置页。`replyLanguage` 不在值域内 → 回落 `en`。
 */
export function loadSettings(storage = null) {
  const s = ls(storage);
  if (s === null || typeof s.getItem !== 'function') return emptySettings();
  const out = emptySettings();
  out.apiBase = readStr(s, 'elp.chat.base');
  out.apiKey = readStr(s, 'elp.chat.key');
  out.model = readStr(s, 'elp.chat.model');
  const lang = readStr(s, 'elp.chat.lang');
  out.replyLanguage = REPLY_LANGUAGES.includes(lang) ? lang : 'en';
  return out;
}

/** 「三件套都配齐了吗」只有一个答案处（缺哪件由调用方问 loadSettings 拿明细）。 */
export function isConfigured(settings) {
  const c = settings ?? {};
  return typeof c.apiBase === 'string' && c.apiBase.trim() !== ''
    && typeof c.apiKey === 'string' && c.apiKey.trim() !== ''
    && typeof c.model === 'string' && c.model.trim() !== '';
}

/** base 的协议尺子：只认 http/https（别的协议是用户输入姿势问题，当场说清）。 */
export function isHttpUrl(text) {
  let u;
  try {
    u = new URL(String(text ?? '').trim());
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

/**
 * 存 provider 三件套。校验不过**一个字节都不写**（与 keyring 同一纪律）。
 * @returns {{ok: true, settings: object} | {ok: false, error: string}}
 *   `error` 是给用户看的一句话（设置页原样显示）。
 */
export function saveProvider(storage, { apiBase, apiKey, model } = {}) {
  const s = ls(storage);
  if (s === null || typeof s.setItem !== 'function') {
    return { ok: false, error: '这个环境没有可用的浏览器存储（localStorage），设置存不了。' };
  }
  const base = typeof apiBase === 'string' ? apiBase.trim() : '';
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const m = typeof model === 'string' ? model.trim() : '';
  if (base === '') return { ok: false, error: 'baseURL 是空的：填你的 OpenAI 兼容端点，例如 https://主机名/v1。' };
  if (!isHttpUrl(base)) {
    return { ok: false, error: `baseURL 的形状不对（${base.slice(0, 60)}）：必须以 http:// 或 https:// 开头。` };
  }
  if (key === '') return { ok: false, error: 'API Key 是空的：粘贴你的 Key（本地模型没有 Key 就随便填一个非空的）。' };
  if (m === '') return { ok: false, error: '模型名是空的：填端点认的那个名字（在服务方文档里查）。' };
  try {
    s.setItem('elp.chat.base', base);
    s.setItem('elp.chat.key', key);
    s.setItem('elp.chat.model', m);
  } catch (err) {
    return { ok: false, error: `设置没能写进本机存储：${String(err?.message ?? err)}` };
  }
  return { ok: true, settings: { ...emptySettings(), apiBase: base, apiKey: key, model: m } };
}

/**
 * 存回复语言。只收 `en` / `zh`，别的值当场拒（不静默回落——回落是读路径的宽容，
 * 写路径要拦住"第三个值"进来）。
 * @returns {{ok: true, replyLanguage: string} | {ok: false, error: string}}
 */
export function saveReplyLanguage(storage, lang) {
  const s = ls(storage);
  if (s === null || typeof s.setItem !== 'function') {
    return { ok: false, error: '这个环境没有可用的浏览器存储（localStorage），设置存不了。' };
  }
  if (!REPLY_LANGUAGES.includes(lang)) {
    return { ok: false, error: `回复语言只认 英语(en) / 中文(zh)，收到 ${String(lang)}。` };
  }
  try {
    s.setItem('elp.chat.lang', lang);
  } catch (err) {
    return { ok: false, error: `设置没能写进本机存储：${String(err?.message ?? err)}` };
  }
  return { ok: true, replyLanguage: lang };
}

/**
 * 清掉本模块管的全部设置键（含 Key）。**只删自己那四把**——`elp.apiKey`（旧形态）、
 * `elp.words`、`elp.write.v1` 这些别家的键一个都不碰（测试用记账假存储逐键断言）。
 * @returns {string[]} 真的删掉的键名（诊断与测试用；幂等：没有就返回空表）。
 */
export function clearSettings(storage = null) {
  const s = ls(storage);
  if (s === null || typeof s.removeItem !== 'function') return [];
  const removed = [];
  for (const key of CHAT_SETTINGS_KEYS) {
    try {
      if (s.getItem(key) !== null) {
        s.removeItem(key);
        removed.push(key);
      }
    } catch {
      // 删不掉也不把界面带崩：下一次 loadSettings 反正还是读得到/读不到的真实状态
    }
  }
  return removed;
}
