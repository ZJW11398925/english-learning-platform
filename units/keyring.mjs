// web/units/keyring.mjs
//
// Task 12A（项目转向 DEC-…23/26）：服务端代理退役后，模型调用改**浏览器直连**
// `https://api.deepseek.com`，Key 由访问者在页面「设置」里自己填、存 localStorage。
// 本单元就是那把 Key 的唯一存取口：读、写、清除，加一道写入前的**轻校验**。
//
// ── 为什么单独一个单元 ─────────────────────────────────────────────────────────
// Key 是"访问者自带"形态里唯一一件敏感数据。散在各处 `localStorage.getItem('elp.apiKey')`
// 的话，键名会漂移、校验会各写一套、"算不算已配置"会有好几种答案。收在这里之后：
// 键名（`elp.apiKey`）、形状尺子（非空 + `sk-` 前缀）、"读出来的形状不对算不算配置过"
// （不算，但也不删）都只有一个定义处。
//
// ── 三条线 ─────────────────────────────────────────────────────────────────────
// 1. **轻校验是服务，不是安全边界**：写入前检查"非空 + `sk-` 前缀"是为了当场拦住"复制不全"
//    的粘贴，省得用户等到 401 才知道。真正的判定权在模型服务——Key 对不对，它说了算，
//    而那类失败的降级路径（引导回设置页）在 `units/recognize.mjs` / `units/compose.mjs`。
// 2. **存储必须注入**（与 `units/store.mjs` 同一条纪律）：本模块不 import 任何东西、不在模块
//    顶层摸全局；storage 缺省在**调用时**解析 `globalThis.localStorage`，且解析不到/读写出错
//    都按"未配置 / 存不了"如实报告，绝不炸。于是 Node 里 `globalThis.localStorage` 保持
//    undefined，全单元可离线测（tests/keyring.test.mjs 用假存储）。
// 3. **不发明、不越权**：读到一个形状不对的值（历史上被别的工具写过、或手动改过）时，
//    如实回答"未配置"，但**不自动删除**它——删除是 `clearKey()` 的显式职责，读路径
//    不该带副作用（用户可能只是想看看是什么状态，一读把数据读没了是惊吓）。
//
// 隐私口径（Task 12C 的 README 会写公开版）：Key 只存在访问者本机的浏览器里，
// 只随请求头发给 `api.deepseek.com`，不进任何我们的服务器（转向之后也没有"我们的服务器"）。

/** localStorage 的键名——跨模块契约（app.mjs 的设置界面与本单元都认它），不许悄悄改。 */
export const API_KEY_STORAGE_KEY = 'elp.apiKey';

/**
 * 一把 Key 的**形状尺子**：非空白字符串 + `sk-` 前缀。
 * saveKey（写入前）与 loadKey（读回时）用同一把——"能不能算一把 Key"只有这一个定义。
 * 首尾空白算形状对（写入时会剪掉）：粘贴进来的 Key 带空格太常见了，不值得为此拦人。
 */
export function isValidKeyShape(key) {
  return typeof key === 'string' && key.trim() !== '' && key.trim().startsWith('sk-');
}

/**
 * 造一个 Key 环。生产路径 `createKeyring()`（浏览器里缺省落到真 localStorage）；
 * 测试 `createKeyring({ storage: fakeLocalStorage() })`。
 *
 * @param {{ storage?: { getItem: (k: string) => string|null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void } | null }} [options]
 * @returns {{ loadKey: () => string|null, hasKey: () => boolean, saveKey: (raw: unknown) => {ok: true, key: string} | {ok: false, error: string}, clearKey: () => boolean }}
 */
export function createKeyring({ storage = null } = {}) {
  /** 存储的**唯一**解析点：注入了用注入的，没注入在调用时看一眼全局（没有就算了）。 */
  const ls = () => {
    if (storage !== null) return storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      // 某些隐私模式下**访问** localStorage 这一步就会抛——与"没有"同等对待。
      return null;
    }
  };

  return {
    /**
     * 读当前配置的 Key。返回**剪过空白**的 Key 字符串；没配置 / 存的值形状不对 / 存储读不到时
     * 是 `null`。**不做任何写操作**（包括不删形状不对的旧值，见文件头第 3 条）。
     */
    loadKey() {
      const s = ls();
      if (s === null || typeof s.getItem !== 'function') return null;
      let raw;
      try {
        raw = s.getItem(API_KEY_STORAGE_KEY);
      } catch {
        return null; // 读不到就是未配置——如实报告，不许让一次存储异常变成界面崩溃
      }
      return isValidKeyShape(raw) ? raw.trim() : null;
    },

    /** "配置过了吗"只有一个来源：loadKey 拿不拿得到形状合法的 Key。 */
    hasKey() {
      return this.loadKey() !== null;
    },

    /**
     * 存一把 Key。先过形状尺子再落盘，校验不过**一个字节都不写**。
     *
     * 返回结构而不是抛错：粘贴错的 Key 是**预期内的用户输入状况**（对比：存储抛错我们包成
     * `ok:false` 也是同一立场——这类失败要有出口，不是异常）。
     *   - `{ ok: true, key }` —— key 是实际存进去的（剪过空白）那个值；
     *   - `{ ok: false, error }` —— error 是一句**给用户看**的话（设置界面原样显示）。
     */
    saveKey(raw) {
      const s = ls();
      if (s === null || typeof s.setItem !== 'function') {
        return { ok: false, error: '这个环境没有可用的浏览器存储（localStorage），Key 存不了。' };
      }
      const key = typeof raw === 'string' ? raw.trim() : '';
      if (key === '') {
        return { ok: false, error: 'Key 是空的：请到 platform.deepseek.com 创建并复制以 sk- 开头的 API Key。' };
      }
      if (!key.startsWith('sk-')) {
        return { ok: false, error: 'Key 的形状不对：DeepSeek 的 API Key 以 sk- 开头，请检查有没有复制完整。' };
      }
      try {
        s.setItem(API_KEY_STORAGE_KEY, key);
      } catch (err) {
        return { ok: false, error: `Key 没能写进本机存储：${String(err?.message ?? err)}` };
      }
      return { ok: true, key };
    },

    /**
     * 清除已存的 Key。返回是否真的执行了删除；本来就没配、或存储不可用时是 `false`
     * ——**幂等的退出路径**，重复点「清除」不许炸。
     */
    clearKey() {
      const s = ls();
      if (s === null || typeof s.removeItem !== 'function') return false;
      try {
        s.removeItem(API_KEY_STORAGE_KEY);
        return true;
      } catch {
        return false; // 删不掉也不把界面带崩：下一次 loadKey 反正还是读不到
      }
    },
  };
}
