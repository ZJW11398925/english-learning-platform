// tests/helpers/mount-harness.mjs
//
// `mount()` 的测试夹具：假 DOM + 假相机 + 假 store，把浏览器路径整条在 Node 里跑起来。
//
// 为什么抽成共享文件（Task 7）：`tests/app-mount.test.mjs`（骨架与装配）与
// `tests/recognize-mount.test.mjs`（识物接线）驱动的是同一条"按拍照 → 按快门 → 看界面"的链。
// 各写一份夹具的话，两边会各自漂移——同一个 mount() 在两份夹具有两种行为，
// 正是这些测试要防的事。夹具的参数取"值或函数"：函数每次调用求值一次，
// 于是"第一次失败、第二次成功"这类序列写得出来。
//
// **默认注入一个"识别成功"的假识物器**：这样骨架测试断言的仍然是骨架，
// 而不必依赖 `units/recognize.mjs` 的真实网络路径（那条路径由 tests/recognize.test.mjs
// 与 tests/recognize-mount.test.mjs 用真模块覆盖）。
import { mount } from '../../web/app.mjs';
import assert from 'node:assert/strict';
import { recognizeWithFallback as realRecognizeWithFallback } from '../../web/units/recognize.mjs';
import { makeEl, btn, byTag, text } from './dom.mjs';

export const OK_STATS = { brightness: 128, laplacianVar: 200 };

/**
 * 造一帧"像真的一样的"载荷：**必须是真的 Blob**。
 *
 * 夹具原先用 `{ size: 9 }` 这种朴素对象冒充 blob，在只有假识物器时看不出问题；一接上
 * `recognize()` 就炸了——`FormData.append` 要求真 Blob/File，于是整条真链路报
 * `request_failed`，看起来像"识物服务挂了"。真相机（`camera.grabFrame`）产出的就是 Blob，
 * 所以夹具也必须给 Blob，否则测的不是真形状（这条教训已写进 task-7 报告）。
 */
export const makeBlob = (size = 9, type = 'image/jpeg') => new Blob([new Uint8Array(size)], { type });

/** 默认的假识物器：一次命中 `mug`。形状与 `recognizeWithFallback` 的返回一致。 */
export const okRecognize = (over = {}) => async () => ({
  mode: 'ok',
  word: 'mug',
  candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }],
  attempts: 1,
  ...over,
});

/** 手选档的假识物器（两轮都落空）。 */
export const manualRecognize = (over = {}) => async () => ({
  mode: 'manual',
  word: null,
  candidates: [{ label: 'container', score: 0.95, scene: 'kitchen' }],
  attempts: 2,
  reason: 'not_in_acceptable_set',
  detail: '模型候选 container 无一命中可接受集',
  ...over,
});

/**
 * 夹具参数可以是**值**也可以是**函数**：函数每次调用时求值一次。
 */
const knob = (v) => (typeof v === 'function' ? v() : v);

/** 识物路径：字段名与路径是客户端/服务端的契约，夹具顺手钉一下。 */
const RECOGNIZE_PATH = '/api/recognize';

/**
 * 把识物请求的目标补成绝对地址（顺便断言打的就是那条路径）。
 *
 * 为什么需要它：**浏览器里 `fetch('/api/recognize')` 合法，Node 里会被 fetch 直接拒**
 * （`Failed to parse URL from /api/recognize`）。夹具在 Node 里跑，所以要把相对路径补成绝对地址
 * ——这是"Node 与浏览器行为不同"的地方，补在夹具里而不是改被测代码。
 */
export const resolveUrl = (url) => {
  const p = String(url);
  if (!p.endsWith(RECOGNIZE_PATH)) throw new Error(`夹具收到的不是识物请求：${p}`);
  return p.startsWith('http') ? p : `http://localhost${p}`;
};

export const okFetch = async (url) => {
  resolveUrl(url);
  return {
    ok: true,
    json: async () => ({ ok: true, candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }] }),
  };
};

/** 造一个"HTTP 失败"的假响应（不去碰网络）。 */
export const failingFetch = (status = 502) => async (url) => {
  resolveUrl(url);
  return { ok: false, status, json: async () => ({ ok: false, error: 'upstream_failed' }) };
};

/** 真实的 `recognizeWithFallback`：想要"整条真链路（含 grab / judgeFrame / pickWord）"时用它。 */
export { realRecognizeWithFallback };

/**
 * 造一个假的 `SpeechRecognition` 构造器（Task 9 的跟读接线要用）。
 *
 * 形状照浏览器给的那一个：`start()` 之后由引擎回调 `onresult`（转写）与 `onend`（收口），
 * 出错时回调 `onerror`。测试用 `say()` / `fail()` 驱动它——**不在夹具里替应用做判定**，
 * 夹具只负责"把引擎会发生的事按顺序发生一遍"。
 *
 * @returns {{ FakeRecognition: Function, calls: object, instances: object[] }}
 */
export function fakeRecognition() {
  const calls = { constructed: 0, started: 0, stopped: 0, aborted: 0 };
  const instances = [];
  class FakeRecognition {
    constructor() {
      calls.constructed += 1;
      instances.push(this);
    }

    start() { calls.started += 1; }

    stop() { calls.stopped += 1; }

    abort() { calls.aborted += 1; }

    /** 引擎识别完成：先给结果，再收口（顺序与真实引擎一致）。 */
    say(transcript) {
      this.onresult?.({ results: [[{ transcript }]] });
      this.onend?.({});
    }

    /** 引擎报错（no-speech / not-allowed / network…），随后同样收口。 */
    fail(error = 'no-speech') {
      this.onerror?.({ error });
      this.onend?.({});
    }
  }
  return { FakeRecognition, calls, instances };
}

/**
 * 挂一份应用。
 *
 * @param {object} [options]
 *   - `grabResult` / `grabError` / `openError`：相机注入（值或函数）
 *   - `recognize`：识物器（`recognizeWithFallback` 的形状）；缺省为"识别成功"的假识物器。
 *     要跑**真**识物链路就传 `realRecognizeWithFallback`，并用 `withFetch()` 接管全局 fetch。
 *   - `sceneWords`：手选词包（只在与假识物器搭配时用得到）
 *   - `compose`：造句链路的注入点（`{ submitSentence }`，形状同 `units/compose.mjs`）。
 *     缺省不注入 = 走真模块；`tests/compose-mount.test.mjs` 用它把网络那一层换掉，
 *     于是"界面与事件对不对"能单独测。
 *   - `speechWin`：转写可用性的来源（`mount` 的注入点）。缺省不注入 = `mount` 取 `globalThis`，
 *     而 Node 里没有 `SpeechRecognition`，于是跟读走**降级路径**（`speech_unsupported`）。
 *     要测判定那条路就传 `{ SpeechRecognition: fakeRecognition().FakeRecognition }`。
 *   - `speechTimeoutMs`：单次转写的墙钟上限（默认是生产常量；测试用小值驱动"引擎不回调"那条路）
 *   - `words`：预置的词记录（模拟"上一次会话学完、现在到期了"）
 *   - `clock` / `onCompose` / `cameraOptions`：透传给 mount()
 * @returns {Promise<object>} `{ root, calls, stream, store, mounted, events, sessionId, machine }`
 */
export async function harness({
  grabResult = { blob: makeBlob(9), stats: OK_STATS },
  grabError = null,
  openError = null,
  clock = Date.now,
  onCompose = null,
  cameraOptions = undefined,
  recognize = null,
  sceneWords = null,
  compose = null,
  speechWin = null,
  speechTimeoutMs = undefined,
  words = null,
} = {}) {
  const root = makeEl('div');
  const calls = { openCamera: [], grabFrame: [], recognize: [] };
  const stream = {
    tracks: [{ stopped: false, stop() { this.stopped = true; } },
      { stopped: false, stop() { this.stopped = true; } }],
    getTracks() { return this.tracks; },
  };
  const camera = {
    VIDEO_NOT_READY: 'VIDEO_NOT_READY',
    async openCamera(video, opts) {
      calls.openCamera.push({ video, opts });
      const err = knob(openError);
      if (err !== null && err !== undefined) throw err;
      video.srcObject = stream;
      await video.play();
      return stream;
    },
    async grabFrame(video, canvas, opts) {
      calls.grabFrame.push({ video, canvas, opts });
      const err = knob(grabError);
      if (err !== null && err !== undefined) throw err;
      return knob(grabResult);
    },
  };
  /**
   * 假 store：**只多给清单里真有的那几个方法**（Task 9 起 `mount` 会读词表、写词记录，
   * 于是夹具也必须像真 `units/store.mjs` 一样有 `readWords` / `putWord`）。
   *
   * `putWord` 照抄真实现的归并语义：按 `id` 覆盖、**已存在的记录保留原 `createdAt`**
   * （那个字段是 `pruneImages` 的淘汰依据，写错会淘汰错图——真实现有专门用例）。
   * `readWords` 返回新对象（真实现是 JSON 往返，拿到的一定是新副本，不是内部引用）。
   */
  const wordMap = { ...(words ?? {}) };
  const store = {
    appended: [],
    words: wordMap,
    appendEvent(e) { store.appended.push(e); },
    readWords: () => ({ ...wordMap }),
    putWord(w) {
      wordMap[w.id] = { ...w, createdAt: w.createdAt ?? wordMap[w.id]?.createdAt ?? Date.now() };
    },
  };
  let urls = 0;
  const urlApi = { createObjectURL: () => `blob:fake-${urls += 1}`, revokeObjectURL: () => {} };

  const base = recognize ?? okRecognize();
  const recognizeWithFallback = async (args) => {
    calls.recognize.push(args);
    return base(args);
  };

  const mounted = await mount(root, {
    doc: { createElement: makeEl },
    camera,
    store,
    urlApi,
    clock,
    onCompose,
    cameraOptions,
    recognizeWithFallback,
    ...(compose === null ? {} : { compose }),
    ...(sceneWords === null ? {} : { manualSceneWords: sceneWords }),
    ...(speechWin === null ? {} : { speechWin }),
    ...(speechTimeoutMs === undefined ? {} : { speechTimeoutMs }),
  });
  return {
    root, calls, stream, store, mounted, events: store.appended,
    sessionId: mounted.sessionId, machine: mounted.machine,
  };
}

/**
 * 走到 `reading` 态（拍照 → 快门 → 我会读了）。
 *
 * 与 `openCameraAndShoot` 一样放进夹具：Task 9 的跟读、复现两条链都要从这里起步，
 * 各写一份的话"怎么走到跟读屏"这件事会在两个文件里各自漂移。
 */
export async function reachReading(over = {}) {
  const h = await harness(over);
  await openCameraAndShoot(h);
  await btn(h.root, '我会读了（开始跟读）').click();
  assert.equal(h.machine.state, 'reading', '夹具必须停在跟读这一格');
  return h;
}

/**
 * 走到 `composing` 态（跟读那一格之后）。
 *
 * `skipReading: false` 时改点「我读过了」——那个按钮只在**转写不可用**的降级屏上出现，
 * 所以它要求不注入 `speechWin`（Node 里没有转写引擎，正是那条降级路径）。
 */
export async function reachComposing(over = {}, { skipReading = true } = {}) {
  const h = await reachReading(over);
  const label = skipReading ? '跳过跟读' : '我读过了';
  const button = btn(h.root, label);
  assert.ok(button, `跟读屏上必须有「${label}」`);
  await button.click();
  assert.equal(h.machine.state, 'composing', '夹具必须停在造句这一格');
  return h;
}

/** 在 composing 里写下 `sentence` 并提交（返回 click 的 Promise）。 */
export async function submitCompose(h, sentence) {
  const box = byTag(h.root, 'TEXTAREA')[0];
  assert.ok(box, 'composing 态必须有输入框');
  box.value = sentence;
  return btn(h.root, '提交造句').click();
}

/** 按「拍照」→「快门」走一步（绝大多数用例的开头）。 */
export const openCameraAndShoot = async (h) => {
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
};

/**
 * 挂一份应用，并让**全局 `fetch`**（识物链路真实的网络出口）在整个用例期间都是 `fetchImpl`。
 *
 * 为什么替换全局而不是加一个注入参数：`mount()` 有意不传 `fetchImpl`——"谁是网络出口"
 * 只有一个决定点，就是 `recognize()` 的缺省值（全局 `fetch`）。测试照着真路径接管它，
 * 测到的正是浏览器里会被跑的那条链。
 *
 * ⚠️ 两条都踩过（见 task-7 报告）：
 *   1. 窗口必须罩住**整个用例**，不只是 `harness()`——真识物请求发生在"按快门"那一刻，
 *      而 `harness()` 在 `mount()` 返回时就 resolve 了。所以这里**不还原**，而是把还原函数
 *      挂在返回值上（`restoreFetch()`），由用例在 `finally` 里调；每个用例开头也会兜底还原一次
 *      （`restoreStaleFetch()`），于是某个用例中途炸掉也不会把替身漏给下一个用例。
 *   2. 恢复的那份全局 fetch 必须是**用完即弃**的，不能跨用例共享同一个替身对象。
 *
 * @param {object} options 与 `harness()` 相同（`recognize` 传 `realRecognizeWithFallback` 即跑真链路）
 * @param {Function|null} [options.fetchImpl] 全局 fetch 的替身；`null` 表示不替换
 * @returns {Promise<object>} `harness()` 的结果，外加 `restoreFetch()`
 */
export async function withFetch(options) {
  restoreStaleFetch();
  const { fetchImpl = okFetch, ...rest } = options;
  const original = globalThis.fetch;
  // 直接装，**不要**过 `knob()`：fetch 替身本身就是函数，`knob()` 会把它当"取值函数"调用一次，
  // 于是装到全局上的是它返回的 Promise —— 症状是 `doFetch is not a function` 与
  // "夹具收到的不是识物请求：undefined" 两条看似无关的报错（已踩过一次）。
  if (fetchImpl !== null) globalThis.fetch = fetchImpl;
  const restoreFetch = () => {
    globalThis.fetch = original;
    pendingRestore = null;
  };
  pendingRestore = restoreFetch;
  const h = await harness(rest);
  return { ...h, restoreFetch };
}

/** 上一个用例留下的替身（用例中途抛错时靠它兜底还原）。 */
let pendingRestore = null;

/** 兜底：上一个用例没还原就把它还原掉。每个 `withFetch()` 开头调一次。 */
export function restoreStaleFetch() {
  if (pendingRestore !== null) pendingRestore();
}

/**
 * 等待态的那句话（`web/app.mjs` 的 feedback 分支里）。
 *
 * 它是**测试与界面之间的一个约定**：这段话改文案时，这个常量要跟着改。
 * 之所以认文案而不是认内部状态：`mount()` 有意不暴露"反馈拿到没有"的内部标志——
 * 那属于实现细节；界面上的字才是用户（与测试）能看到的东西。
 */
const FEEDBACK_BUSY_MARK = '正在看你这句';

/**
 * 等**反馈结论落到界面**（Task 8）。
 *
 * 为什么需要它：`onSubmit` 是同步的（状态当场推进到 feedback），而拿反馈是**异步**的
 * （`submitForFeedback` 里的 await，弱网下可能十几秒）。所以"提交造句"的 click 回调 resolve 时，
 * 界面还停在"正在看你这句…"——这时候去点什么「再写一次」是点不到的。
 *
 * **不用固定 sleep**：那会让测试变成"睡够久就过"，而且把一个真实的时序（结论落地）隐掉了。
 * 这里轮询到界面真的不再是等待态为止，超时即响亮失败。
 *
 * @param {object} h `harness()` 的返回值
 * @param {number} [timeoutMs] 上限（默认 1s：夹具里的假提交器都是立刻返回的）
 * @throws {Error} 超时（界面一直停在等待态）
 */
export async function settleFeedback(h, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!text(h.root).includes(FEEDBACK_BUSY_MARK)) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`等到超时：反馈结论没有落到界面（还停在"${FEEDBACK_BUSY_MARK}"）`);
}


