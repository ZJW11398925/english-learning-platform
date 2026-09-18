// web/units/write/store.mjs
//
// 这一条链路的**本地持久化**。只有一件事：把 `./flow.mjs` 导出的那份纯数据存进
// 浏览器存储、再读回来。**没有后端、没有账号**——所以"积累"这件事的物理载体就是它。
//
// ── 一个键，一个定义处 ────────────────────────────────────────────────────────
// `WRITE_STORAGE_KEY = 'elp.write.v1'`。`.v1` 是刻意的：形状将来会变，而**变更时该丢弃旧数据
// 还是迁移**是一个要单独决策的问题；把版本写进键名，届时"旧的那份还在原地"（不静默覆盖，
// 也不静默迁移）。`loadState` 只认 `version === 1`，其余一律当"没有"。
//
// ── 绝不越界（这条有断言）────────────────────────────────────────────────────
// 本模块**只**读写自己那一把键。同一个 localStorage 里还住着：
//   · `elp.apiKey`        —— 访问者自己粘贴的 API Key（`../keyring.mjs`）
//   · `elp.words`         —— 老形态的词表（`../store.mjs`）
//   · `elp.events`        —— 老形态的事件流（`../store.mjs`）
//   · `elp.teach.profile` —— 教学引擎形态的学习者画像
// 任何一次 `saveState` 都不许碰它们。做法是**结构性**的：`saveState` 里只有一次 `setItem`，
// 键是本模块的常量——没有第二条写路径可走。测试里用"记账假存储"逐键断言（`.` 与 `-A` 一族
// 的教训：**"工具报的成功"不等于"事情发生了"**，所以要数它到底写了几把键）。
//
// ── 读路径安全回退（与 `../work.mjs` 同一条纪律）──────────────────────────────
// 盘上的东西坏了（不是 JSON / 形状不对 / 版本不对）⇒ **返回空状态、不抛错**。
// 学习者不该因为一份坏数据被锁在门外；而"坏在哪"由调用方如实显示（本模块不猜、不修）。
//
// 纯逻辑模块：零 import、零浏览器 API（storage 是参数）——可在 Node 中直接测。
// 注意：本模块**不导入** `flow.mjs`，也就不承担任何流程语义——它只搬数据。

/** 本链路在 localStorage 里的键。`.v1` = 形状版本（见文件头）。 */
export const WRITE_STORAGE_KEY = 'elp.write.v1';

/** 本模块**只许**碰的键（诊断与测试据此断言"不越界"）。 */
export const WRITE_OWNED_KEYS = Object.freeze([WRITE_STORAGE_KEY]);

/** 同一个 localStorage 里别家的键——本模块一个都不许写（名字记在这里是为了可断言）。 */
export const FOREIGN_STORAGE_KEYS = Object.freeze([
  'elp.apiKey',
  'elp.words',
  'elp.events',
  'elp.teach.profile',
]);

/** 空状态（读不到 / 读坏了时的**唯一**答案）。每次都新建一份，免得调用方改到共享引用。 */
export function emptyState() {
  return {
    version: 1, sentences: [], words: [], rewriteQueue: [],
  };
}

/** 纯数组：不是数组时给空数组（读路径的宽容只到这里——条目本身的坏由下面逐条丢）。 */
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * 从存储里读回状态。
 *
 * @param {{getItem: (k: string) => string|null}|null} storage 注入的存储（测试用假的）
 * @returns {{version: 1, sentences: object[], words: object[], rewriteQueue: object[]}}
 *   任何读不到 / 解析不了 / 形状不对的情形都返回**空状态**（不抛错、不修数据）。
 *   顶层形状对了但个别条目坏了：**好条目留下、坏条目丢掉**（与 `../work.mjs` 的读宽同口径）。
 */
export function loadState(storage) {
  if (storage === null || storage === undefined || typeof storage.getItem !== 'function') {
    return emptyState();
  }

  let raw;
  try {
    raw = storage.getItem(WRITE_STORAGE_KEY);
  } catch {
    return emptyState(); // 隐私模式下**访问**存储这一步就会抛——与"没有"同等对待
  }
  if (typeof raw !== 'string' || raw.trim() === '') return emptyState();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState(); // 盘上是坏 JSON：如实当"没有"，绝不猜它想说什么
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
  if (parsed.version !== 1) return emptyState(); // 只认这一版形状

  return {
    version: 1,
    sentences: arr(parsed.sentences).filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)),
    words: arr(parsed.words).filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)),
    rewriteQueue: arr(parsed.rewriteQueue).filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)),
  };
}

/**
 * 把状态写回存储。
 *
 * @param {{setItem: (k: string, v: string) => void}|null} storage
 * @param {unknown} state 一般是 `./flow.mjs` 的 `exportState()` 产物
 * @returns {boolean} 真的写下去了吗。
 *   **写不进去不抛错**（配额满 / 隐私模式 / 存储不可用）——本回合照常走完，代价如实由返回值表达。
 *   非对象的状态**不写**并返回 `false`（写一份 `null` 进去等于把盘上已有的东西弄坏）。
 */
export function saveState(storage, state) {
  if (storage === null || storage === undefined || typeof storage.setItem !== 'function') {
    return false;
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;

  try {
    storage.setItem(WRITE_STORAGE_KEY, JSON.stringify({ ...state, version: 1 }));
    return true;
  } catch {
    return false; // 配额满 / 隐私模式：学习者不该因为存不下而卡住（代价见文件头）
  }
}
