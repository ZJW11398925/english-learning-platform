// web/app.mjs
//
// 单页入口：状态机（纯逻辑，`./units/state-machine.mjs`）+ 页面装配（`mount()`）。
//
// **本模块没有任何顶层副作用**：DOM 代码全在 `mount()` 里，浏览器专属的依赖
// （store / event-log / camera / frame-qc）也只在 `mount()` 内部**动态 import**。
// 于是 `import '../web/app.mjs'` 在 Node 里完全安全（`tests/state-machine.test.mjs` 正是这么做的），
// 而浏览器侧由 `web/index.html` 里那段内联 module 脚本调 `mount()`——**只有浏览器路径会调它**。
//
// 为什么拆两个模块：brief 规定测试从 `web/app.mjs` 导入 `createMachine`（契约入口在此），
// shared-context 又要求状态机本身"不得 import 任何浏览器 API"。两者的交集就是本文件只做
// 转出与装配，状态机独立成 `web/units/state-machine.mjs`。
//
// 本层唯一的判断责任：**这一帧能不能送识别**。两条红线（全局约束 3）：
//   · 质检给出 `{ ok: false, reason }` → 必须落一条 `frame_rejected`（带 reason）再退回重拍；
//   · `judgeFrame` / `computeStats` 抛的 `RangeError` 是**编程错误**，绝不 catch 成"这张照片不行"。
import { createMachine, STATES } from './units/state-machine.mjs';

export { createMachine, TRANSITIONS, STATES, REJECT_REASONS } from './units/state-machine.mjs';

/** 拒帧理由 → 给用户看的一句话（设计文档 §5.1：当场拦下并提示重拍）。 */
const REJECT_HINT = {
  too_dark: '刚才那张太暗：换个亮一点的位置，或者把灯打开，再来一次。',
  too_blurry: '刚才那张有点糊：拿稳手机、让物体占满画面，再来一次。',
};

/** 会话号：安全上下文里有 randomUUID，没有就退到一个够用的随机串（不参与任何安全判断）。 */
function newSessionId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把应用挂到一个容器元素上（浏览器路径）。
 *
 * @param {HTMLElement} root 容器（`web/index.html` 里的 `#app`）
 * @param {object} [deps] 注入点（测试与 Task 7/8/9 用；全部有默认值，浏览器里不传即可）
 *   - `doc` DOM 工厂，默认 `globalThis.document`
 *   - `urlApi` 默认 `globalThis.URL`（冻结画面用 `createObjectURL`）
 *   - `camera` / `frameQC` / `store` / `recordEvent` 覆盖懒加载的浏览器依赖
 *   - `sessionId`、`clock`（时间戳函数）、`cameraOptions`、`onCompose`（造句原文的接线点）
 * @returns {Promise<{ machine: object, sessionId: string, store: object, grab: () => Promise<{blob: object, stats: object}> }>}
 *   `grab` 就是 Task 7 要的取帧注入点（`recognizeWithFallback({ grab })`）
 * @throws {TypeError} `root` 不是元素
 */
export async function mount(root, deps = {}) {
  if (root === null || root === undefined || typeof root.replaceChildren !== 'function') {
    throw new TypeError('mount: 需要传入一个容器元素（web/index.html 里的 #app）');
  }

  const {
    doc = globalThis.document,
    urlApi = globalThis.URL,
    camera: givenCamera = null,
    frameQC: givenQC = null,
    store: givenStore = null,
    recordEvent: givenRecord = null,
    sessionId: givenSessionId = null,
    clock = Date.now,
    cameraOptions = {},
    onCompose = null,
  } = deps;

  // 懒加载浏览器专属依赖：注入了什么就不 import 什么（Node 测试里全都注入，于是不碰这些模块）。
  const camera = givenCamera ?? await import('./units/camera.mjs');
  const qc = givenQC ?? await import('./units/frame-qc.mjs');
  const record = givenRecord ?? (await import('./units/event-log.mjs')).recordEvent;
  let store = givenStore;
  if (store === null) {
    const { createStore } = await import('./units/store.mjs');
    store = createStore({ localStorage: globalThis.localStorage, indexedDB: globalThis.indexedDB });
  }
  const sessionId = givenSessionId ?? newSessionId();

  // ── 视图骨架 ────────────────────────────────────────────────────────────────
  const statusEl = doc.createElement('p');
  statusEl.className = 'muted';
  const errorEl = doc.createElement('p');
  errorEl.className = 'error';
  const bodyEl = doc.createElement('div');
  root.replaceChildren(statusEl, errorEl, bodyEl);

  const setError = (msg) => { errorEl.textContent = msg; };

  // ── 运行时状态（都只活在本页内存里）────────────────────────────────────────
  let videoEl = null;
  let canvasEl = null;
  let activeStream = null;
  let frozen = null;           // { blob, url }：快门冻结的那一帧
  let composeEl = null;        // 当前 composing 态的输入框
  let lastComposeText = '';    // 上一版造句原文（回改时带出来，别让用户重打一遍）
  let opening = false;         // 正在开相机（挡住双击：否则会开出两路流，多出来的那路没人关）

  function stopStream() {
    if (activeStream === null) return;
    for (const track of activeStream.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* 停不掉也要继续，清理不该把主流程带崩 */ }
    }
    activeStream = null;
  }

  // 先声明再赋值：`createMachine` 会在构造时立刻以 'ready' 调一次 onEnter → render → viewFor，
  // 那一刻 machine 还没赋上值。任何要在**首次渲染**里读快照的地方都必须写 `machine?.`（见 ready 分支）。
  let machine = null;

  // ── 页面装配 ────────────────────────────────────────────────────────────────
  function render(state) {
    // 离开拍摄态就关掉摄像头（灯一直亮着既费电又吓人）
    if (state !== 'capturing') stopStream();
    statusEl.textContent = `状态：${state}`;
    bodyEl.replaceChildren(...viewFor(state));
  }

  function viewFor(state) {
    const view = [];
    const row = doc.createElement('div');
    row.className = 'row';
    const title = (t) => { const n = doc.createElement('h2'); n.textContent = t; return n; };
    const hint = (t) => { const n = doc.createElement('p'); n.className = 'muted'; n.textContent = t; return n; };
    const action = (label, onClick, disabled = false) => {
      const b = doc.createElement('button');
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', onClick);
      row.append(b);
      return b;
    };

    switch (state) {
      case 'ready': {
        view.push(title('拍一件你身边的东西'));
        view.push(hint('对准物体按「拍照」；画面太暗或太糊会当场退回重拍，不消耗识物调用。'));
        const reason = machine?.snapshot().lastRejectReason ?? null;
        if (reason !== null) view.push(hint(REJECT_HINT[reason] ?? '刚才那张没能用，重拍一张。'));
        action('拍照', onCapture);
        break;
      }
      case 'capturing': {
        view.push(title('对准物体，按「快门」'));
        if (videoEl !== null) view.push(videoEl);
        view.push(hint('这一帧先在端侧做质检（太暗 / 太糊当场退回）。'));
        action('快门', onShutter);
        break;
      }
      case 'word': {
        view.push(title('取到的词'));
        // 冻结的那一帧：证明"按快门"确实拍下了东西（识物还没接）
        if (frozen?.url != null) {
          const img = doc.createElement('img');
          img.src = frozen.url;
          img.alt = '刚拍到的画面';
          view.push(img);
        }
        view.push(hint('识物尚未接入（Task 7）：这里是占位，界面不会显示任何未真实取得的词。'));
        action('我会读了（开始跟读）', () => machine.send('wordReady'));
        break;
      }
      case 'reading': {
        view.push(title('跟读一遍'));
        view.push(hint('转写与判定在 Task 8/9 接入；现在可以手动标记读完，或跳过（会记 skipped_reading）。'));
        action('我读完了', () => machine.send('readDone'));
        action('跳过跟读', () => machine.send('skipReading'));
        break;
      }
      case 'composing': {
        view.push(title('用这个词写一句你自己的话'));
        composeEl = doc.createElement('textarea');
        composeEl.rows = 3;
        composeEl.placeholder = '例如：I put the mug on the desk.';
        composeEl.value = lastComposeText;
        view.push(composeEl);
        view.push(hint('这一段停留时长与改写次数会进记录（用于事后筛出敷衍样本）；首版不做内容校验。'));
        action('提交造句', onSubmit);
        break;
      }
      case 'feedback': {
        view.push(title('反馈'));
        view.push(hint('结构化反馈在 Task 8 接入；现在可以再写一版（会累加改写次数），或进入下一个词。'));
        action('再写一次', () => machine.send('rewrite'));
        action('下一个词', () => machine.send('next'));
        break;
      }
      case 'done': {
        view.push(title('这一个词走完了'));
        view.push(hint(summary()));
        break;
      }
      default:
        view.push(title(`未知状态：${state}`));
    }

    view.push(row);
    return view;
  }

  /**
   * 完成页把关键指标摊出来（设计文档 §3.2：停留时长 + 改写次数用来筛敷衍样本）。
   *
   * `rewriteCount` 的口径是**提交次数**（状态机里每次 `submit` 自增，见 `units/state-machine.mjs`），
   * 所以第一版就提交、一次都没回改的会话读到的是 1。**改写次数 = 提交次数 - 1**：这里显示的是
   * 派生出来的改写次数，否则"没改过"的人会看到"改写 1 次"——界面上的一句假话。
   * 快照里的字段本身不改名、不改口径（下游怎么持久化由 Task 9 定，见 task-6-report 修复轮）。
   */
  function summary() {
    const s = machine.snapshot();
    const secs = (k) => `${k} ${(s.dwellMs[k] / 1000).toFixed(1)}s`;
    return [
      `改写 ${s.rewriteCount - 1} 次`,
      `跳过跟读：${s.skippedReading ? '是' : '否'}`,
      `被退回的帧：${s.frameRejections}`,
      `各态停留：${STATES.map(secs).join(' / ')}`,
    ].join(' · ');
  }

  // ── 动作 ────────────────────────────────────────────────────────────────────
  machine = createMachine({ onEnter: render, now: clock });

  async function onCapture() {
    setError('');
    // 双击/连点：第二次点击时状态还是 ready（第一次的 await 还没回来），按钮仍在页面上。
    // 不挡就会开出两路 camera stream，其中一路永远不会被 stop（灯亮着、耗电）。
    if (opening) return;
    opening = true;
    const video = doc.createElement('video');
    video.playsInline = true;   // iOS：不加会被拉去全屏播放器
    video.muted = true;         // 静音才允许自动播放
    const canvas = doc.createElement('canvas');
    videoEl = video;
    canvasEl = canvas;
    try {
      activeStream = await camera.openCamera(video, { facingMode: 'environment', ...cameraOptions });
    } catch (err) {
      videoEl = null;
      canvasEl = null;
      activeStream = null;
      // 设计文档 §5.1「相机未授权」档：说明原因 + 指路，**不给"随便看看"的假入口**（状态机不动）
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      const reason = denied ? 'denied' : 'unavailable';
      record(store, 'blocked_permission', {
        sessionId, reason, message: String(err?.message ?? err),
      }, clock);
      setError(denied
        ? `相机没有授权：${err?.message ?? err}。请在浏览器地址栏的站点设置里允许摄像头，然后点「拍照」重试。`
        : `相机打不开：${err?.message ?? err}`);
      return;
    } finally {
      opening = false;
    }
    machine.send('capture');
  }

  /** Task 7 的注入点：`recognizeWithFallback({ grab })` 就是拿它取帧。 */
  const grab = async () => {
    if (videoEl === null || canvasEl === null) {
      throw new Error('mount: 相机还没打开，没有可取帧的 video/canvas');
    }
    return camera.grabFrame(videoEl, canvasEl);
  };

  async function onShutter() {
    setError('');
    let shot;
    try {
      shot = await grab();
    } catch (err) {
      // 只把"用户按快门太早"当成可预期的用户情形；其余（含 RangeError）原样重抛，
      // 绝不静默变成一次"这张照片不行"——那是把缺陷记到用户头上。
      if (err?.code !== camera.VIDEO_NOT_READY) {
        setError(`取帧失败：${err?.message ?? err}`);
        throw err;
      }
      setError('画面还没准备好，请稍等一秒再按快门。');
      return;
    }

    let verdict;
    try {
      verdict = qc.judgeFrame(shot.stats);
    } catch (err) {
      // RangeError（契约违约）= 编程错误：显示出来是为了不让用户面对"按了没反应"，
      // **同时原样重抛**，让它带着栈冒到控制台——绝不落 frame_rejected、绝不改状态。
      setError(`质检失败（这是程序缺陷，不是你的照片问题）：${err?.message ?? err}`);
      throw err;
    }

    if (verdict.ok) {
      freeze(shot.blob);
      machine.send('frameOk');
      return;
    }

    // 如实记录这一档（设计文档 §5.1）：先落事件再退状态，两件事都不许省。
    record(store, 'frame_rejected', { sessionId, reason: verdict.reason }, clock);
    machine.send('frameBad', { reason: verdict.reason });
  }

  function freeze(blob) {
    if (frozen?.url != null) urlApi?.revokeObjectURL?.(frozen.url);
    const url = typeof urlApi?.createObjectURL === 'function' ? urlApi.createObjectURL(blob) : null;
    frozen = { blob, url };
  }

  function onSubmit() {
    // 先取出原文：send('submit') 会触发渲染，输入框当场就被换掉了。
    const text = composeEl?.value ?? '';
    if (!machine.send('submit')) return;
    lastComposeText = text;
    // 落盘（原句、轮次）交给 Task 8/9 的钩子：事件表里的 compose_submitted 口径归 Task 9，
    // 本任务不抢着记一遍（记重了会让 compose 相关计数翻倍）。
    if (typeof onCompose === 'function') {
      const s = machine.snapshot();
      onCompose({ text, rewriteCount: s.rewriteCount, skippedReading: s.skippedReading });
    }
  }

  return { machine, sessionId, store, grab };
}
