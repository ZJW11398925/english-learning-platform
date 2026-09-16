// web/units/speak.mjs
//
// 跟读示范音单元（Task 12B，转向 DEC-…23/26 第二项形态）。
//
// **本模块只做一件事：把目标词用浏览器本地的 speechSynthesis 念出来（示范音）。**
//
// 跟读那一格从「念出这个词（SpeechRecognition 自动判定）」改成「听示范 → 自己念 → 自评」：
// 原来的识别/判定（`checkSpeech` 的 token 规则、`isSpeechAvailable` 的转写可用性）随
// SpeechRecognition 一并**退役**——`reading_done` / `reading_missed` / `speech_unsupported`
// 三个事件类型保留在 schema 里（历史数据要在诊断页继续渲染），但新流程不再产生它们。
// "有没有念出这个词"由学习者自己确认：手动打勾只是"我读了"，不是"系统听到我说出了
// 目标词"——这条既有裁决原样沿用，所以自评打勾与跳过**都不落判定事件**。
//
// ── 架构纪律（与旧版同一条）───────────────────────────────────────────────────
//
// **零 import、零浏览器全局、零顶层副作用**：`speechSynthesis` /
// `SpeechSynthesisUtterance` 全部经参数注入（`mount()` 的 deps 缺省才给 `globalThis`），
// 于是本模块在 Node 里可被完整测掉（`tests/speak.test.mjs`）。
//
// ── 语音选择的口径 ────────────────────────────────────────────────────────────
//
// 优先 en-US；没有就用**任何**英文声（`en-GB` / 裸 `en` / `en_US` 下划线写法都算——
// 真实平台三种都有）；一个英文声都没有时**不拒绝播放**：voice 不设、`u.lang` 兜底
// `en-US`，让引擎按语言自己挑（选不到合适音色与"播不了"是两回事）。
//
// ── 收口纪律（本项目反复吃过"挂住而不是失败"的亏）────────────────────────────
//
// `playWord` 返回 Promise：`onend`（正常播完）与 `onerror`（引擎报错）两条路都从
// 这里出去；`speak()` 当场抛错、Utterance 构造器抛错、空词、环境缺 API——同样当场
// 拒绝。绝不留下一个永远 pending 的 Promise（界面会永远停在"正在播放…"）。
//
// 但 onend/onerror **谁都不来**（引擎半死、voice 加载卡死、页面被系统限流）是第三种情形：
// 12B 上线时它还是个遗留风险，Task 12C 给 `playWord` 装上**墙钟上限**（`PLAY_WORD_TIMEOUT_MS`，
// 循 `recognize.mjs` 请求上限的同一课：挂住 ≠ 干净失败）。到点先 `synth.cancel()` 让引擎闭嘴
// （abort），再拒绝收口——错误消息带上限毫秒数，界面能如实转述"等了多久、已中止"。
// 迟到的 onend/onerror 被 settled 守卫拦下，不会二次收口。时钟是注入点
// （`timers.setTimer` / `timers.clearTimer`，缺省 setTimeout/clearTimeout），Node 里可测。

/**
 * 从语音列表里挑一个念英文的：优先 `preferredLang`（默认 `en-US`），退任何英文声。
 *
 * 纯函数：`voices` 是 `{ lang }` 形状的列表（真引擎的 `getVoices()` 就是它），
 * 大小写与下划线写法归一后匹配（`EN-us` / `en_US` / `en` 都认）。坏输入（非数组、
 * 条目缺 lang）安全跳过，永不抛错。返回 `null` 表示"没有英文声"——调用方照播。
 *
 * @param {unknown} voices 语音列表（`speechSynthesis.getVoices()` 的返回）
 * @param {string} [preferredLang] 首选语言（默认 `en-US`）
 * @returns {object|null} 选中的 voice 对象（列表里那个，不是副本）；没有则 `null`
 */
export function pickVoice(voices, preferredLang = 'en-US') {
  if (!Array.isArray(voices)) return null;
  const norm = (v) => String(v?.lang ?? '').toLowerCase().replace('_', '-');
  const want = String(preferredLang ?? '').toLowerCase().replace('_', '-');
  if (want === '') return null;
  const exact = voices.find((v) => norm(v) === want);
  if (exact !== undefined) return exact;
  const base = want.split('-')[0];
  const anySameLanguage = voices.find((v) => {
    const l = norm(v);
    return l === base || l.startsWith(`${base}-`);
  });
  return anySameLanguage ?? null;
}

/**
 * `playWord` 的墙钟上限（毫秒）——**首轮设定值**，不是定论：待真机数据标定。
 *
 * 为什么必须有它：真实引擎存在"onend 与 onerror 谁都不来"的半死状态（voice 加载卡死、
 * 后台标签被限流、系统语音服务挂起），Promise 会永久 pending——界面卡在"正在播放…"，
 * 自评按钮永远出不来。循 `recognize.mjs` 请求上限的同一课：到点先 `synth.cancel()`
 * （abort），再拒绝收口，绝不把"挂住"留给用户。
 * 一个词的示范音正常远小于 1s，取 15s 是给慢设备 / 慢音色下载的充裕余量（≥ recognize
 * 这条腿的 12s：播一个词不该比问一次模型更容易超时）。
 */
export const PLAY_WORD_TIMEOUT_MS = 15000;

/**
 * 这个环境能不能播示范音。
 *
 * @param {unknown} win 浏览器里传 `globalThis`（或注入的替身）；**两个零件都必须是函数**：
 *   `speechSynthesis.speak`（播）与 `SpeechSynthesisUtterance`（构造 utterance，
 *   调用方会 `new` 它）——同名字段是个占位对象时判"可用"，等于把一次"点击即崩"留给用户。
 * @returns {boolean}
 */
export function isTtsAvailable(win) {
  return typeof win?.speechSynthesis?.speak === 'function'
    && typeof win?.SpeechSynthesisUtterance === 'function';
}

/**
 * 播一个词的示范音。**这是播放这条腿唯一的收口点**：`onend`（播完）、`onerror`
 * （引擎报错）与**墙钟到点**（谁都不来）三条路都从这里出去，`speak()` 抛错同样当场
 * 拒绝——绝不留下挂住的 Promise（"正在播放…"绝不久挂）。
 *
 * @param {unknown} word 目标词（空 / 纯空白 / 非字符串当场拒绝，不碰引擎）
 * @param {object} deps 注入点
 *   - `win`：提供 `speechSynthesis` 与 `SpeechSynthesisUtterance` 的对象（生产由
 *     `mount()` 的 deps 缺省给 `globalThis`；测试注入假环境）
 *   - `timeoutMs`：墙钟上限（默认 `PLAY_WORD_TIMEOUT_MS`）；到点先 `synth.cancel()`
 *     再拒绝。非正的有限数当场拒绝（编程错误，不碰引擎）
 *   - `timers`：时钟注入点 `{ setTimer(fn, ms) → handle, clearTimer(handle) }`，
 *     缺省 `setTimeout` / `clearTimeout`（测试用手动时钟，不真等）
 * @returns {Promise<void>} 播完（`onend`）resolve；引擎报错（`onerror`）、墙钟到点
 *   或任何当场失败 reject（错误消息带引擎原样错误码 / 上限毫秒数，供界面如实转述）
 */
export function playWord(word, { win, timeoutMs = PLAY_WORD_TIMEOUT_MS, timers = null } = {}) {
  const synth = win?.speechSynthesis ?? null;
  const Ctor = win?.SpeechSynthesisUtterance ?? null;
  if (typeof synth?.speak !== 'function' || typeof Ctor !== 'function') {
    return Promise.reject(new Error('这个浏览器没有语音合成（speechSynthesis），播不了示范音'));
  }
  const text = typeof word === 'string' ? word.trim() : '';
  if (text === '') {
    return Promise.reject(new Error(`playWord: 目标词不是可播的词（收到 ${String(word)}），不播空示范音`));
  }
  // 墙钟上限的形状在这里判（参数写错是编程错误，不是用户情形）：不给"播出去才发现
  // 钟是坏的"的机会。消息点名"上限"——它是"正在播放…"绝不久挂的保证。
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError(
      `playWord: timeoutMs 必须是正的有限数（收到 ${String(timeoutMs)}）——墙钟上限缺了或坏了都不播`,
    ));
  }
  const doSetTimeout = timers?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const doClearTimeout = timers?.clearTimer ?? ((h) => clearTimeout(h));

  return new Promise((resolve, reject) => {
    let utterance;
    try {
      utterance = new Ctor(text);
    } catch (err) {
      reject(err);
      return;
    }
    const voice = pickVoice(typeof synth.getVoices === 'function' ? synth.getVoices() : []);
    utterance.lang = voice?.lang ?? 'en-US';
    if (voice !== null) {
      try { utterance.voice = voice; } catch { /* 某些替身上赋值失败就只靠 lang */ }
    }
    let settled = false;
    let timer = null;
    const stopTimer = () => {
      if (timer !== null) {
        doClearTimeout(timer);
        timer = null;
      }
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      stopTimer();
      fn(value);
    };
    utterance.onend = () => finish(resolve);
    utterance.onerror = (ev) => finish(reject, new Error(`示范音播放失败：${String(ev?.error ?? ev ?? 'unknown')}`));
    try {
      synth.speak(utterance);
    } catch (err) {
      finish(reject, err);
      return;
    }
    // 墙钟在 speak 成功后才装（speak 抛错走上面的当场拒绝，不需要钟）。
    // 到点：先 cancel 让引擎闭嘴（abort），再收口——时序红线，tests/speak.test.mjs 钉住。
    timer = doSetTimeout(() => {
      try {
        synth.cancel?.();
      } catch { /* 引擎连 cancel 都不给时也要收口：收口不依赖引擎配合 */ }
      finish(reject, new Error(`示范音播放超时（${timeoutMs}ms 未收到播放结束事件，已让引擎 cancel 并收口）`));
    }, timeoutMs);
  });
}
