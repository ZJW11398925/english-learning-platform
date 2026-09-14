// web/app.mjs
//
// 单页入口：状态机（纯逻辑，`./units/state-machine.mjs`）+ 页面装配（`mount()`）。
//
// **本模块没有任何顶层副作用**：DOM 代码全在 `mount()` 里，浏览器专属的依赖
// （store / event-log / camera / recognize）也只在 `mount()` 内部**动态 import**。
// 于是 `import '../web/app.mjs'` 在 Node 里完全安全（`tests/state-machine.test.mjs` 正是这么做的），
// 而浏览器侧由 `web/index.html` 里那段内联 module 脚本调 `mount()`——**只有浏览器路径会调它**。
//
// 为什么拆两个模块：brief 规定测试从 `web/app.mjs` 导入 `createMachine`（契约入口在此），
// shared-context 又要求状态机本身"不得 import 任何浏览器 API"。两者的交集就是本文件只做
// 转出与装配，状态机独立成 `web/units/state-machine.mjs`。
//
// ── 本层的判断责任（Task 7 收口后）──────────────────────────────────────────────
//
// **`recognizeWithFallback` 是"这一帧能不能用"的唯一起源**（控制器追加要求 1）。此前
// `mount()` 里另有一条 `judgeFrame` 前置闸，Task 7 接上识物后它成了第二套判定：
// 两处判同一帧、两处都可能落 `frame_rejected`，将来各自漂移就会出现"界面说太暗、
// 记录里写太糊"这种自相矛盾的数据。所以那条闸**已删除**——判帧、拒帧理由、`attempts`
// 全部改由 `units/recognize.mjs` 一处产出。本层只做四件事：
//   · 把结果落到正确的状态与事件上；
//   · `RangeError`（帧统计契约违约）**绝不 catch 成一次"这张照片不行"**——那是编程错误；
//   · 取不到词时**绝不显示任何英文单词**，改为明确告知"没认出来"并给手选词（追加要求 4）；
//   · 给每次**真正产出结论**的快门开一个轮次号 `roundIndex`（一次快门 = 一轮，与这一轮发了
//     几次模型请求无关），并写进 `frame_rejected`/`recognize_ok`/`recognize_failed` 三类事件。
//     判据 B（`retry_rate`）只能从事件流里算，而原先的 `attempts` 分不清"一帧两次请求"与
//     "用户按了两次"——口径与公式见 `units/rounds.mjs` 的文件头（Task 7 修复轮 Critical 1）。
import { createMachine, STATES } from './units/state-machine.mjs';
import { createRoundCounter } from './units/rounds.mjs';

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
 * 可接受词集（`pickWord` 的输入）：**本轮场景允许学哪些词**。
 *
 * 首版按设计文档 §3.1 的"场景取词"先固定几张常见桌面/厨房物件；真正的场景词表属于词库建设，
 * 不在本切片范围（与 `units/recognize.mjs` 里手选词包的说明同一条口径）。
 * 判定权在 `pickWord`：模型给的 `score` 与这里无关，**只认这张表**。
 */
const ACCEPTABLE_SETS = {
  mug: ['mug', 'cup'],
  kettle: ['kettle'],
  bottle: ['bottle'],
  bowl: ['bowl'],
  book: ['book'],
  pen: ['pen'],
  phone: ['phone', 'smartphone'],
  laptop: ['laptop', 'notebook computer'],
  keys: ['key', 'keys'],
  chair: ['chair'],
  lamp: ['lamp'],
  bag: ['bag', 'backpack'],
  shoe: ['shoe'],
  umbrella: ['umbrella'],
};

/** 取词候选里该词的场景标签（模型没给就退回"未知"——不编一个）。 */
function sceneOf(word, candidates) {
  return candidates.find((c) => c.label === word)?.scene ?? '未知';
}

/**
 * 手选词包的兜底副本：只在**测试注入了假的 `recognizeWithFallback`** 时用到
 * （真实路径一律从 `units/recognize.mjs` 取，见 `mount()` 里的 `sceneWords`）。
 * 生产者与消费者正常情况下同源，这份副本只是让"注入式测试"仍然能渲染出界面。
 */
const FALLBACK_SCENE_WORDS = Object.freeze(['mug', 'cup', 'book', 'pen', 'bottle']);

/**
 * 把应用挂到一个容器元素上（浏览器路径）。
 *
 * @param {HTMLElement} root 容器（`web/index.html` 里的 `#app`）
 * @param {object} [deps] 注入点（测试与 Task 8/9 用；全部有默认值，浏览器里不传即可）
 *   - `doc` DOM 工厂，默认 `globalThis.document`
 *   - `urlApi` 默认 `globalThis.URL`（冻结画面用 `createObjectURL`）
 *   - `camera` / `store` / `recordEvent` / `recognizeWithFallback` 覆盖懒加载的浏览器依赖
 *   - `sessionId`、`clock`（时间戳函数）、`cameraOptions`、`onCompose`（造句原文的接线点）
 * @returns {Promise<{ machine: object, sessionId: string, store: object, grab: () => Promise<{blob: object, stats: object}> }>}
 *   `grab` 就是传给 `recognizeWithFallback({ grab })` 的取帧函数
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
    recognizeWithFallback: givenRecognize = null,
    manualSceneWords: givenSceneWords = null,
    sessionId: givenSessionId = null,
    clock = Date.now,
    cameraOptions = {},
    onCompose = null,
  } = deps;

  // 懒加载浏览器专属依赖：注入了什么就不 import 什么（Node 测试里全都注入，于是不碰这些模块）。
  const camera = givenCamera ?? await import('./units/camera.mjs');
  const frameQC = givenQC ?? await import('./units/frame-qc.mjs');
  const record = givenRecord ?? (await import('./units/event-log.mjs')).recordEvent;
  const recognizeModule = givenRecognize === null ? await import('./units/recognize.mjs') : null;
  // `recognizeWithFallback` 与手选词包同源：两者必须来自**同一份**声明，否则界面上的手选词
  // 与识别链路口径会各自漂移（改了词包却忘了改界面）。
  const runRecognize = givenRecognize ?? recognizeModule.recognizeWithFallback;
  const sceneWords = givenSceneWords ?? recognizeModule?.MANUAL_PICK_SCENE_WORDS ?? FALLBACK_SCENE_WORDS;
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
  let lastShotBlob = null;     // 最近一次 `grab()` 拿到的帧（识别链走后，freeze 用的是它）
  // 最近一次取词的结果（`recognizeWithFallback` 的返回）。**界面上的词只能来自这里或用户手选**：
  // 它同时决定 word 态显示"识别结果"还是"没认出来 + 手选词"。
  let lastPick = null;
  // 当前显示的词。`source` 是**诚实性字段**：'recognized' 是我们从模型候选里选中的，
  // 'manual' 是用户自己挑的——两者在界面上必须长得不一样（追加要求 4）。
  let shownWord = null;        // { word, scene, source: 'recognized'|'manual' }
  // 两轮都落空、等用户手选。**这是一个独立的界面态，不是状态机的状态**：
  // 状态机已经在 word（"词已取到"之前的最后一格），而这一格此时还没有词。
  // 由它（而不是 `machine.state`）决定渲染手选词包，状态机的语义才不会被撑歪。
  let awaitingManualPick = false;
  // 轮次计数器：**一次快门 = 一轮**，会话内从 1 开始单调递增，与 `sessionId` 同寿命
  // （换会话就换实例 → 新会话又从 1 开始）。它与 `payload.attempts`（这一轮真的问过模型几次）
  // 是两个不同的数：同一帧发两次请求仍只算一轮。判据 B（retry_rate）的公式写在
  // `units/rounds.mjs` 的文件头——**别在别处另立一套**。
  const rounds = createRoundCounter();

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

  // ── 取词结果的展示口径（追加要求 4 的落点）──────────────────────────────────
  //
  // 三条硬规则：
  //   1. `mode: 'ok'` 才有一个"识别出来的词"；
  //   2. `mode: 'manual'` 时界面**不出现任何英文单词**，只给手选词包（那是用户挑的，不是识别结果）；
  //   3. 手选之后的词由 `shownWord.source === 'manual'` 标着，界面上明说是自己挑的——
  //      下游统计（Task 9 的 recurrence_manual / Task 10 的 manualRecurrence）靠的就是这个区分。

  /** 是否该展示手选词包：两轮都落空、且用户还没挑过词。 */
  const manualPickNeeded = () => awaitingManualPick && shownWord === null;

  /** 手选词包（`units/recognize.mjs` 里的预声明场景词，**不是**模型候选的兜底）。 */
  const manualWords = () => sceneWords;

  /** 落空的说明：把手选的必要性讲清楚，并且**不假装**认出来了什么。 */
  function pickFailureHint() {
    const why = lastPick?.reason === 'request_failed' || lastPick?.reason === 'response_invalid'
      ? '识物服务这次没能返回结果'
      : '识物没能从这张照片里认出一个可用的词';
    return `${why}（${lastPick?.attempts ?? 0} 次尝试）。下面这些词请你**自己挑一个**——`
      + '挑出来的词会记成"手选"，不会算作识别成功。也可以重拍一张再试。';
  }

  /** 识别成功的说明：词来自哪一次尝试、还有哪些候选（如实摊开，不夸大置信度）。 */
  function recognizedHint() {
    const others = (lastPick?.candidates ?? []).filter((c) => c.label !== shownWord?.word);
    const tail = others.length > 0
      ? `；模型另外给了 ${others.map((c) => c.label).join(' / ')}（按可接受集判定后未选用）`
      : '';
    return `场景：${shownWord?.scene ?? '未知'}；第 ${lastPick?.attempts ?? 1} 次尝试取到${tail}`;
  }

  function onManualPick(word) {
    // 手选：来源标成 manual，界面据此明说"这是你自己挑的"。
    shownWord = { word, scene: lastPick?.scene ?? '手动选择', source: 'manual' };
    awaitingManualPick = false;
    // 取到词了 = 这一格走完（capturing → word）。**重绘由本行负责**：手选界面与"取到的词"
    // 分别是 capturing / word 两格，`send` 触发的那次渲染发生在 `shownWord` 赋值之后，
    // 但 `send` 返回 false（状态没变）时不会触发渲染——所以这里显式再渲染一次，两种情形都对。
    // 见 tests/recognize-mount.test.mjs「手选之后…」。
    machine.send('frameOk');
    render(machine.state);
  }

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
        if (manualPickNeeded()) {
          // 两轮都落空 → 手选场景词。**这一屏不许出现任何"识别出来的词"**：
          // 模型给过候选但没有一个可用（见 units/recognize.mjs 的失败原因枚举），
          // 把它当成识别结果展示就是伪造（追加要求 4）。
          //
          // 为什么留在 capturing 而不是 word：手选与重拍是**同一格里的两个选择**
          // （"系统没认出来，你自己挑，或者再拍一张"）。word 态没有回 capturing 的转移，
          // 把手选摆在那里会让"重拍一张"变成一个按不动的按钮——状态机拒绝了它，
          // 而用户只看到没反应（已实测到：`send('capture')` 在 word 下恒为 false）。
          view.push(title('没能自动认出这个词'));
          view.push(hint(pickFailureHint()));
          const list = doc.createElement('div');
          list.className = 'choices';
          for (const w of manualWords()) {
            const b = doc.createElement('button');
            b.textContent = w;
            b.addEventListener('click', () => onManualPick(w));
            list.append(b);
          }
          view.push(list);
          // 这一格的两个选择：手挑（上面的词），或者**立刻**再拍一张。
          // 用 onShutter 而不是 onCapture：相机还开着、画面还在，"再拍一张"就该真的再拍，
          // 而不是让用户回到 ready 再点一次拍照（那多两步点击，也更容易被误当成"卡住了"）。
          action('再拍一张', onShutter);
          break;
        }
        view.push(title('对准物体，按「快门」'));
        if (videoEl !== null) view.push(videoEl);
        view.push(hint('这一帧先在端侧做质检（太暗 / 太糊当场退回），再送去识物。'));
        action('快门', onShutter);
        break;
      }
      case 'word': {
        // 冻结的那一帧：证明"按快门"确实拍下了东西
        if (frozen?.url != null) {
          const img = doc.createElement('img');
          img.src = frozen.url;
          img.alt = '刚拍到的画面';
          view.push(img);
        }
        view.push(title(shownWord?.word ?? ''));
        if (shownWord?.source === 'manual') {
          view.push(hint(`这是你自己挑的词，不是识别出来的。场景：${shownWord.scene}`));
        } else {
          view.push(hint(recognizedHint()));
        }
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
    // 新一次拍照：上一轮的取词结果与手选态都作废（否则"重拍一张"之后界面还挂着旧的手选词包）。
    lastPick = null;
    shownWord = null;
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

  /** 取一帧 + 记住它（`freeze()` 要的就是"刚送出去那一帧"，不是"最后一次取到的那一帧"）。 */
  const grab = async () => {
    if (videoEl === null || canvasEl === null) {
      throw new Error('mount: 相机还没打开，没有可取帧的 video/canvas');
    }
    const shot = await camera.grabFrame(videoEl, canvasEl);
    lastShotBlob = shot.blob;
    return shot;
  };

  async function onShutter() {
    setError('');
    // 上一轮的结果清掉：手选词包只在"这一轮真的两轮都落空"时才该出现。
    lastPick = null;
    shownWord = null;
    awaitingManualPick = false;

    let picked;
    try {
      // 取帧 → 端侧质检 → 最多两次识物请求，全在 `recognizeWithFallback` 里。
      // **本层不再自己判帧**（追加要求 1）：判帧只有一处起源，`frame_rejected` 与它的 reason
      // 都来自这个返回值，不存在"界面说太暗、记录说太糊"的可能。
      // 这里**不传 fetchImpl**：让 `recognize()` 用它自己的缺省（全局 `fetch`），
      // 于是"谁是网络出口"只有一个决定点，注入式测试也能接管它。
      picked = await runRecognize({
        grab, frameQC, acceptableSets: ACCEPTABLE_SETS, exclude: [],
      });
    } catch (err) {
      // `grab()` 的错：只把"用户按快门太早"（VIDEO_NOT_READY）当成可预期的用户情形。
      if (err?.code === camera.VIDEO_NOT_READY) {
        setError('画面还没准备好，请稍等一秒再按快门。');
        return;
      }
      // `judgeFrame` 的 RangeError（契约违约）= 编程错误：显示出来是为了不让用户面对
      // "按了没反应"，**同时原样重抛**，让它带着栈冒到控制台——绝不落 frame_rejected、绝不改状态。
      // 其余错误（取帧炸了等）同样原样重抛，绝不静默变成一次"这张照片不行"。
      if (err?.name === 'RangeError') {
        setError(`质检失败（这是程序缺陷，不是你的照片问题）：${err?.message ?? err}`);
      } else {
        setError(`取帧失败：${err?.message ?? err}`);
      }
      throw err;
    }

    lastPick = picked;

    // 走到这里说明这一按**真的产出了一轮结论** → 开一轮。
    // 上面那个 `catch` 里的三种情形（按太早、RangeError、其它取帧错误）都到不了这里：
    // 它们要么 return、要么原样重抛，一条事件都不落——所以事件流里的 roundIndex 是连续的
    // 1、2、3…，没有空洞（"按了但没产出结论"不是一轮，见 units/rounds.mjs 的定义）。
    const roundIndex = rounds.next();

    if (picked.mode === 'frame_rejected') {
      // 如实记录这一档（设计文档 §5.1）：先落事件再退状态，两件事都不许省。
      // 这一帧没送到模型，所以 attempts 是 0（见 units/recognize.mjs 的口径说明）。
      // 但它**同样是一次快门**，故同样带 roundIndex——端侧拦下的重拍也是重拍（判据 B 的主要来源）。
      record(store, 'frame_rejected', { sessionId, roundIndex, reason: picked.reason }, clock);
      machine.send('frameBad', { reason: picked.reason });
      return;
    }

    // 走到这里说明帧已经取到并冻结（哪怕是手选档，也让用户看见刚拍的那一帧）。
    freeze(lastShotBlob);

    if (picked.mode === 'ok') {
      // 一轮只落**一条**结论事件（三选一，不是"成功与失败都记"）：
      //   · `recognize_ok`     —— 这一轮取到词了；`attempts` 是"第几次尝试取到的"
      //   · `recognize_failed` —— 这一轮最终没取到词（降级到手选），带 reason/detail
      //   · `frame_rejected`   —— 这一帧被端侧质检拦下，一轮到此为止（attempts = 0）
      // 因此 mount 里是 if/else：**同一个 roundIndex 只会出现一条**，绝不双记。
      // （Task 7 报告 §7.3 曾写成"降级时两条都记"，与代码不符，已在修复轮改正——
      //  两条都记会让"识物调用成功次数"与"取到词的轮数"混成一个数。）
      // 数轮数**不要**把这三类事件相加或只取其一：用 `units/rounds.mjs` 的
      // `roundCountOfSession`（按 roundIndex 去重、三类都算），判据 B 的公式在那个文件头部。
      record(store, 'recognize_ok', {
        sessionId,
        roundIndex,
        word: picked.word,
        attempts: picked.attempts,
        candidates: (picked.candidates ?? []).map((c) => c.label),
      }, clock);
      shownWord = { word: picked.word, scene: sceneOf(picked.word, picked.candidates ?? []), source: 'recognized' };
    } else {
      // 手选档：**不设 shownWord**，渲染的是手选词包，界面上一个英文词都不出现。
      // 模型这一轮到底答了什么，从下面 payload 的 `candidates` 读（如实带出，不另记一条 recognize_ok）。
      record(store, 'recognize_failed', {
        sessionId,
        roundIndex,
        reason: picked.reason ?? 'unknown',
        detail: picked.detail ?? null,
        attempts: picked.attempts,
        candidates: (picked.candidates ?? []).map((c) => c.label),
      }, clock);
      awaitingManualPick = true;
    }

    // 手选档**不**推进状态：那一格还没走完（还没词），推进去会让"重拍一张"变成一个
    // 状态机拒绝的动作。取到词的那一刻（onManualPick）才推进，见那里。
    // 但**界面必须重绘**：`awaitingManualPick` 刚变成 true，不重绘就会停在"按快门"那一屏，
    // 用户看到的是"按了没反应"。`send` 成功时它自己会触发 onEnter→render，故只在没推进时补一次。
    if (awaitingManualPick) render(machine.state);
    else machine.send('frameOk');
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
