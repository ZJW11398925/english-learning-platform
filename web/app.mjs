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
// ── 本层的判断责任（Task 9 收口后）──────────────────────────────────────────────
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
//
// Task 9 又给本层加了四件**记录责任**（都是"能测量"层面的事：再好的算法，测量它的数据没被
// 记下来，整条验证链就是空的）：
//   · **跟读判定**（§4.3）：转写可用 → `checkSpeech` 判"有没有说出目标词"；不可用 → 如实落
//     `speech_unsupported` 并给手动打勾，**绝不把降级伪装成"读对了"**（不落 `reading_done`）。
//   · **学完即入队**（§4.5）：`feedback` 态**拿到结论**那一刻就把词写进复现队列（不是 done 态
//     ——用户可能不点「下一个词」就关页面），落盘**幂等**（回环不许把排期推回原点）。
//     此前 `nextState`/`dueWords`/`putWord`/`readWords` 在 `web/` 下**没有任何调用点**。
//   · **到期复现**（§3.4）：`ready` 态提示到期的词；取到时按**两种模式分列**落
//     `recurrence_scene`（识物命中）/ `recurrence_manual`（用户手选）并推进排期。
//   · **造句落盘**（§3.4）：提交成功那一刻落 `compose_submitted`，带
//     `submitCount`/`revisions`/`dwellMs`——`rewriteCount` 这个既有的名字含义是**提交次数**，
//     带着它落盘就是把一个错的字段名交到下游（progress 必办 1）。
import { createMachine, STATES } from './units/state-machine.mjs';
import { createRoundCounter } from './units/rounds.mjs';
import { nextState, dueWords } from './units/scheduler.mjs';
import { isTtsAvailable, playWord } from './units/speak.mjs';
import { submitSentence as realSubmitSentence, feedbackEventFor } from './units/compose.mjs';
// Task 12A（项目转向 DEC-…23/26）：模型调用改浏览器直连，Key 由访问者在「设置」里填。
// keyring 是纯逻辑模块（存储注入），静态 import 在 Node 里安全；本层是 Key 的**读取方**，
// 存取/校验的职责都在 units/keyring.mjs。
import { createKeyring } from './units/keyring.mjs';
import {
  PENDING_ENTRY_LABEL,
  manualRetryCandidate,
  pendingFeedbackQueue,
  retryEventFor,
  scheduledRetryAt,
  withPendingId,
} from './units/pending.mjs';

export { createMachine, TRANSITIONS, STATES, REJECT_REASONS } from './units/state-machine.mjs';

/** 拒帧理由 → 给用户看的一句话（设计文档 §5.1：当场拦下并提示重拍）。 */
const REJECT_HINT = {
  too_dark: '刚才那张太暗：换个亮一点的位置，或者把灯打开，再来一次。',
  too_blurry: '刚才那张有点糊：拿稳手机、让物体占满画面，再来一次。',
};

/** 错误类型 → 给用户看的一档（**不堆术语**：设计文档 §4.2 要求 note 面向学习者）。 */
const ERROR_TYPE_LABEL = {
  word_choice: '用词不准',
  collocation: '搭配不地道',
  grammar: '语法问题',
  none: '',
};

/** 落空的档位 → 给用户看的一句话：说清"这次为什么没拿到反馈"，但不把技术细节摊给他。 */
const PENDING_HINT = {
  timeout: '等模型回话等太久了',
  request_failed: '这次请求没能发出去（可能是网络断了）',
  http_error: '模型服务这次没能返回结果',
  response_invalid: '模型服务这次返回的内容不能用',
  empty_sentence: '这句话是空的',
  // 12A（直连 + 访问者自带 Key）：这两档用户自己能修/能等，文案必须把方向指对。
  auth_failed: 'API Key 无效或还没有配置：到「设置（API Key）」检查或重新粘贴',
  rate_limited: '模型服务说请求太频繁：稍等一会儿再交一次',
};

/**
 * 跟读这一格在 12B（转向 DEC-…23/26）换成「听示范 → 自己念 → 自评」：
 * SpeechRecognition 自动判定整条退役（真机实测该设备自动跟读判定不可用且网页侧无法修复，
 * `DEC-…21`），`reading_done` / `reading_missed` / `speech_unsupported` 三个事件类型
 * 保留在 schema 里（历史数据要在诊断页继续渲染），但新流程不再产生它们。
 * 示范音与播放收口的实现在 `units/speak.mjs`。
 */

/**
 * 场景未知时的两种占位值：`recognize` 给不出场景时的 `'未知'`，与手选档界面上写的 `'手动选择'`。
 * 它们**不参与"换了场景"的判定**——系统并不知道用户实际站在哪儿，拿不准就不许声称他换了地方。
 * 也不写进词记录的 `lastScene`（否则下次提示会说一句"上次是在「手动选择」场景学的"）。
 */
const UNKNOWN_SCENES = Object.freeze(['未知', '手动选择']);

/** "换个地方拍"的例子（与 `DEC-…19` 的生活化场景词包同源，**不参与任何逻辑判定**）。 */
const RECURRENCE_SCENE_EXAMPLES = '居家 / 通勤 / 职场 / 餐饮';

/** 会话号：安全上下文里有 randomUUID，没有就退到一个够用的随机串（不参与任何安全判断）。 */
function newSessionId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 存储写满时要落在界面上的一句话——**这一档的主出口是提示，不是标签**（brief §2.2）。 */
const STORAGE_FULL_NOTICE = '这台手机的存储写满了，新的记录写不进去。'
  + '请先打开「查看诊断页」把记录导出/抄下来，再清理浏览器存储；'
  + '在腾出空间之前，新的练习任务先停一停（已经记下来的历史不会被覆盖）。';

/** 写不进去时给动作按钮的一句短提示（比上面的通知短，用在按钮所在的屏上）。 */
const STORAGE_FULL_SHORT = '存储写满，先别开新任务：请到诊断页把记录导出后清理空间。';

/**
 * 12A：还没有配置 API Key 时，ready 屏的引导文案（设计原则：给出路，不给死路）。
 * 四个必须回答的问题：为什么需要、怎么拿、存在哪、安不安全（只存本机）。
 * 文案里不写 markdown 强调符（`hint()` 走 textContent，`**` 会一字不差地显示出来）。
 */
const NO_KEY_GUIDANCE = '还没有配置 API Key：识物和造句都要调用 DeepSeek 的模型服务（按用量计费），'
  + '所以需要你自己的 Key——注册 platform.deepseek.com 后在 API Keys 页面创建一串以 sk- 开头的密钥，'
  + '点下面的「设置（API Key）」粘贴保存。Key 只保存在这台手机的浏览器里（本机存储），'
  + '不会上传给任何人；清掉浏览器数据会连同 Key 一起删掉。';

/** 设置抽屉里"未配置"时重复用的短句（与 ready 屏的引导同源，只短一点）。 */
const SETTINGS_HINT = '在 platform.deepseek.com 创建 API Key（以 sk- 开头），粘贴到下面保存。'
  + '它只存在这台手机的浏览器里，只随你的识物/造句请求发给模型服务。';

/** 待补界面上"这条已经补上了"的标记（占位显示用的名字，测试与清单认它）。 */
const PENDING_RESOLVED_LABEL = '已补交';

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
 *   - `camera` / `store` / `recordEvent` / `recognizeWithFallback` 覆盖懒加载的浏览器依赖。
 *     ⚠️ `store` 必须提供 `readWords()` 与 `putWord()`（Task 9 起本层要读写复现队列；
 *     真的 `units/store.mjs` 两个都有）。缺了会**响亮**报错，不会静默跳过入队。
 *   - `sessionId`、`clock`（时间戳函数）、`cameraOptions`、`onCompose`（造句原文的接线点）
 *   - `compose`：造句链路的注入点，形状 `{ submitSentence }`（缺省用 `units/compose.mjs` 的真实现）。
 *     注入它是为了让"界面与事件对不对"能脱离网络单独测（网络路径由 tests/compose.test.mjs 覆盖），
 *     与 `recognizeWithFallback` 的注入点是同一个理由。
 *   - `ttsWin`：示范音可用性（`isTtsAvailable`）与播放（`playWord`）的来源，缺省 `globalThis`。
 *     测试注入 `{ speechSynthesis, SpeechSynthesisUtterance }` 假环境即可驱动"听示范"；
 *     **不注入**时 Node/不支持的浏览器走无示范音那一档（如实提示，只剩跳过）。
 *     （12B 前这里是 `speechWin`——SpeechRecognition 判定路径随转向退役。）
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
    compose: givenCompose = null,
    sessionId: givenSessionId = null,
    clock = Date.now,
    cameraOptions = {},
    onCompose = null,
    ttsWin = globalThis,
    setTimeoutImpl = null,
    clearTimeoutImpl = null,
    keyring: givenKeyring = null,
  } = deps;

  // 定时器注入点（与 `clock` 同一个理由：**测试要能驱动时间**）。
  // 待补重试的三档间隔是 10s / 30s / 90s，用真 `setTimeout` 的测试要么睡 130 秒、
  // 要么把设定值改小成另一个数——后者会让"设定值就是 10/30/90"这条断言失去意义。
  const setTimer = setTimeoutImpl ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = clearTimeoutImpl ?? ((t) => globalThis.clearTimeout(t));

  // 懒加载浏览器专属依赖：注入了什么就不 import 什么（Node 测试里全都注入，于是不碰这些模块）。
  const camera = givenCamera ?? await import('./units/camera.mjs');
  const frameQC = givenQC ?? await import('./units/frame-qc.mjs');
  const record = givenRecord ?? (await import('./units/event-log.mjs')).recordEvent;
  const recognizeModule = givenRecognize === null ? await import('./units/recognize.mjs') : null;
  // `recognizeWithFallback` 与手选词包同源：两者必须来自**同一份**声明，否则界面上的手选词
  // 与识别链路口径会各自漂移（改了词包却忘了改界面）。
  const runRecognize = givenRecognize ?? recognizeModule.recognizeWithFallback;
  const sceneWords = givenSceneWords ?? recognizeModule?.MANUAL_PICK_SCENE_WORDS ?? FALLBACK_SCENE_WORDS;
  // 造句链路的只调一次 `submitSentence`；`feedbackEventFor`（事件映射）**不注入**——
  // 它必须与链路本身同源，两处各写一套映射的话，事件流里的字段名会悄悄漂移。
  const runSubmitSentence = givenCompose?.submitSentence ?? realSubmitSentence;
  let store = givenStore;
  if (store === null) {
    const { createStore } = await import('./units/store.mjs');
    store = createStore({ localStorage: globalThis.localStorage, indexedDB: globalThis.indexedDB });
  }
  const sessionId = givenSessionId ?? newSessionId();

  // ── Task 12A：访问者的 API Key（浏览器直连形态的"配置现场"）────────────────────
  //
  // Key 的存取/校验/清除都在 units/keyring.mjs；本层只在**发请求的那一刻**读它、在
  // 设置界面里显示"配置过没有"。读写都可能碰真存储，包一层：存储异常时按"未配置"处理
  // （装配层不因一次存储异常白屏），错误细节由 keyring 自己在保存路径上给。
  const keyring = givenKeyring ?? createKeyring();
  const apiKeyNow = () => {
    try {
      return keyring.loadKey();
    } catch {
      return null;
    }
  };
  const hasKey = () => apiKeyNow() !== null;

  // ── Task 9B：待补反馈队列与存储写满的现场 ────────────────────────────────────
  //
  // **队列本身没有任何状态**：它是 `store.readEvents()` 每次现算出来的视图
  // （`units/pending.mjs` 的文件头写了"权威是事件流"这条裁决）。
  // 这里的三个变量全是**界面与调度**的现场，不是真相：
  let viewingPending = false;      // 正在看"待补反馈"那一屏
  let viewingSettings = false;     // 正在看"设置（API Key）"那一屏（12A：Key 的填/清/看状态）
  let retryPendingId = null;       // 这一次提交是不是在补某一条待补条目（补交时的 pendingId）
  let retrying = null;             // `{ pendingId, busy }`：手动补交进行中的界面状态
  let retryTimer = null;           // 自动重试的定时器句柄（同一时刻只挂一个）

  /**
   * 拆掉这一份应用挂的定时器（**给测试用**：`node --test` 会等事件循环空掉才退出，
   * 一个挂着的自动重试定时器会让整轮测试白等 10 秒）。
   *
   * 为什么不让浏览器也靠它收尾：页面卸载时定时器本来就会随页面一起消失；
   * 这里只需要一个**确定性的出口**，让"这份 mount 实例挂了什么"可以被显式清掉。
   */
  function dispose() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  /**
   * 看当前这一刻的待补队列（**每次现算**：事件流是权威，页面上不缓存它的副本）。
   *
   * ⚠️ 这里有个**很容易踩的形状陷阱**（首版真踩了，见 `tests/pending-mount.test.mjs`）：
   * `units/pending.mjs` 里所有导出的入参都是**原始事件数组**（`store.readEvents()` 的结果），
   * 不是本函数返回的派生队列。把派生队列再喂给 `manualRetryCandidate` 只会得到 `null`
   * ——"当前没有待补的反馈了"，而界面上明明列着一条。
   * 需要"从队列里挑一条"时用 `openPending()`，需要"按事件算"时用 `readEvents()`。
   */
  const pendingList = () => {
    if (typeof store.readEvents !== 'function') return [];
    try {
      return pendingFeedbackQueue(store.readEvents());
    } catch {
      // 事件读回来是坏数据（JSON 坏了等）不该白屏：读不到就当没有待补条目。
      // ⚠️ 代价：那种情况下用户看不到自己的待补句子，诊断页会如实报"读不到记录"。
      return [];
    }
  };

  /** 原始事件流（`units/pending.mjs` 那几个函数的入参形状）。读不到就给空数组。 */
  const allEvents = () => {
    if (typeof store.readEvents !== 'function') return [];
    try {
      return store.readEvents();
    } catch {
      return [];
    }
  };

  /**
   * 还没补上的待补条目（界面上的入口数它，自动重试轮转也数它）。
   *
   * **不需要在这里去重**：`units/pending.mjs` 的 `pendingFeedbackArchive` 按 `pendingId`
   * 归并，一条欠账不管重试失败几次都只产出一个条目——那里是"一条 = 一句"的唯一起源，
   * 且由 `tests/pending.test.mjs` 钉住。这里再写一层 `Set` 就是"两处机制产出同一结果"：
   * 变异体 `Q6` 证明了删掉那一层之后全仓测试照样全绿，也就是说**它没有任何证据**。
   * 与其留一行没人验证的冗余，不如把这条不变式写在这儿。
   */
  const openPending = () => pendingList().filter((it) => !it.resolved);

  /** 存储写满了没有（界面的"停止派发新任务"就是它）。 */
  const storageFull = () => store.isFull?.() === true;

  /** 写不进去时把话说清楚（并**不**吞掉：调用方该怎么处置还怎么处置）。 */
  function noteWriteFailure(what) {
    if (storageFull()) setError(`${what}：${STORAGE_FULL_NOTICE}`);
    return null;
  }

  /** 一句话说清"什么时候再试"。 */
  function retryTimingText(item) {
    const at = scheduledRetryAt(item);
    if (at === null) return '自动重试已用完，可以点「手动补交」再试一次。';
    const waitSec = Math.max(0, Math.ceil((at - clock()) / 1000));
    return waitSec <= 0 ? '马上会自动再试一次。' : `约 ${waitSec} 秒后会自动再试一次（也可以现在手动补交）。`;
  }

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
  // 反馈屏的状态：`{ busy }` 表示"正在等服务端/模型"；`{ result }` 是 `submitSentence` 的返回值。
  // **原句只从 `lastComposeText` 与 `result.sentence` 两处来**，界面不另存一份（免得两处不一致）。
  let feedback = null;
  let opening = false;         // 正在开相机（挡住双击：否则会开出两路流，多出来的那路没人关）
  let lastShotBlob = null;     // 最近一次 `grab()` 拿到的帧（识别链走后，freeze 用的是它）
  // 跟读这一格的现场只剩"示范音正在播"一个标志（12B：判定已退役，没有转写现场了）。
  // **它只在同一格里活着**，离开 reading 就随重渲染作废（按钮重新可点）。
  let demoBusy = false;
  // 示范音能不能播（speechSynthesis 可用性）。**判定来源是注入的那个对象**（`ttsWin`，
  // 浏览器里默认 `globalThis`），本层与 `units/speak.mjs` 都不自己去读浏览器全局
  // ——那样就没法在 Node 里测。
  const ttsOk = isTtsAvailable(ttsWin);
  // 刚发生的这次取词是不是一次"到期复现"（是则记下现场，用于在词卡上如实说明）。
  // `null` = 这一次不是复现（或还没取到词）。
  let recurrenceNote = null;
  // 进入 composing 的时刻：`compose_submitted` 的 `dwellMs` 要的是"进入这一格到提交"这一段，
  // 而快照里的 `dwellMs.composing` 是**整个会话累计**（回环几轮就累几轮，第二次提交会读到两轮之和）。
  let composingEnteredAt = null;
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

  /**
   * 手选词包（`units/recognize.mjs` 里的预声明场景词，**不是**模型候选的兜底）。
   *
   * 存储写满时给空包：手选出来的词要立刻写词记录与复现事件，写不进去就等于让用户
   * 白做一轮（§5.1 的"停止派发新任务"）。**这一屏仍有「再拍一张」**，所以不是死路。
   */
  const manualWords = () => (storageFull() ? [] : sceneWords);

  /** 落空的说明：把手选的必要性讲清楚，并且**不假装**认出来了什么。 */
  function pickFailureHint() {
    // 12A：auth_failed（Key 无效/未配置）与 rate_limited（限频）是访问者自己能修/能等的一档，
    // 文案必须把"去哪儿修/该等多久"指出来；其余档照旧。
    const why = lastPick?.reason === 'auth_failed'
      ? '还没有配置可用的 API Key（或 Key 已失效）：识物是浏览器直连模型服务，需要你自己的 Key。请点「设置（API Key）」检查或重新粘贴'
      : lastPick?.reason === 'rate_limited'
        ? '模型服务说请求太频繁（限流）：稍等一两分钟再试'
        : (lastPick?.reason === 'request_failed' || lastPick?.reason === 'response_invalid')
          ? '识物服务这次没能返回结果'
          : '识物没能从这张照片里认出一个可用的词';
    // 文案里**不写 markdown 的强调符**：`hint()` 走 `textContent`，`**` 会一字不差地显示给
    // 学习者（progress 必办 0）——这一屏正是真机清单第 19 项要看的那一屏。
    return `${why}（${lastPick?.attempts ?? 0} 次尝试）。下面这些词请你自己挑一个——`
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

  /** 落最近一次取词那一轮的轮次号：反馈事件挂在它上面（一次快门 = 一轮，反馈不是新的快门）。 */
  let lastRoundIndex = null;

  // ── Task 9：复现队列（入队 / 到期 / 复现）与跟读判定 ──────────────────────────

  /** 词记录的 id：**词本身的小写形式**（裁决）：同一个词多次学是同一条记录，复现才能推进它的 stage。 */
  const wordIdOf = (word) => String(word).toLowerCase();

  /** 当前到期的词（按到期时间排序；"有没有到期"只有这一个起源，界面上不另算一套）。 */
  const dueList = () => dueWords(store.readWords(), clock());

  /** 场景是不是一个**可比较**的真实场景（未知/手选占位值不算，见 `UNKNOWN_SCENES`）。 */
  const isRealScene = (scene) => typeof scene === 'string' && scene !== '' && !UNKNOWN_SCENES.includes(scene);

  /**
   * 这次取到的场景能否算作"换了个地方"。
   * 只要有一边是未知的（识别没给场景、或用户手选那一档）就返回 `false`——
   * 系统并不知道用户实际站在哪儿，拿不准就不许声称他换了场景（brief §3.3.3）。
   */
  const sceneChangedOf = (scene, expectedScene) => (
    isRealScene(scene) && isRealScene(expectedScene) && scene !== expectedScene
  );

  /**
   * 学完即入队（设计文档 §4.5）：把词写进复现队列并定出首个 `dueAt`。返回是否真的新增了记录。
   *
   * 三条硬约束（brief §3.3.1），每一条都有用例钉住：
   *   1. **幂等**：已存在该 id 就什么都不做（保持既有 `stage`/`dueAt`）。回环
   *      `feedback → rewrite → composing → feedback` 每次都会走到这里；不幂等的话每次回写都把
   *      排期推回原点，`dueAt` **永远到不了期——复现永远不会发生**，而单次提交的用例照样全绿。
   *   2. `dueAt` 只由 `nextState` 产出：`scheduler.mjs` 的模块头写明"写词记录的一方必须这么做"
   *      ——手写或缺失会让这条记录掉进"既不算已维护、又永远不到期"的无声夹缝（`dueWords` 静默略过它）。
   *   3. **不手写 `createdAt`**：`store.putWord` 会保留既有值；在这里重新盖时间戳会让
   *      `pruneImages` 把老词的图误判成最新，淘汰掉真正该留的那张。
   */
  function enqueueWord(word, scene, now) {
    const id = wordIdOf(word);
    if (store.readWords()[id] !== undefined) return false;
    store.putWord(nextState({ id, word, stage: 0, lastScene: scene }, now));
    return true;
  }

  /**
   * 学完即入队 + 存储写失败时的**响亮**处理。
   *
   * 时机是 `feedback` 态**拿到结论**那一刻，不是 `done` 态：用户可能不点「下一个词」就关掉页面，
   * 而那一刻这个词已经学完了。挂在 done 上等于"必须走到最后一步才作数"，样本会系统性偏向
   * 愿意走完的人。
   *
   * Task 9B 把"存储写满"这一档补成了可达路径：配额异常由 `store.mjs` 收敛成
   * **置起 `isFull()` + 原样重抛**，所以这里能分辨出它并给出设计 §5.1 要求的那句话
   * （停止派发新任务 + 提示导出），而不是一句笼统的"存储写入失败"。
   * 非配额错误照旧原样重抛（未知故障不许被静默吞掉）。
   */
  function registerLearnedWord() {
    const word = shownWord?.word ?? null;
    // 没有词就没有可入队的东西。正常流程到不了这里（composing 的前置是 word），
    // 所以这里不落任何"失败标签"——它不是一个用户情形。
    if (word === null) return;
    try {
      enqueueWord(word, shownWord.scene ?? null, clock());
    } catch (err) {
      if (storageFull()) {
        setError(`这个词没能记进复现队列。${STORAGE_FULL_NOTICE}`);
        return;
      }
      setError(`这个词没能记进复现队列（存储写入失败，属于程序/存储问题）：${err?.message ?? err}`);
      throw err;
    }
  }

  /**
   * 这次取到的词正好是**当前到期**的词 → 落一条复现事件并推进它的排期。
   *
   * 三条口径（brief §3.3.3）：
   *   · **两种取词模式分列**（`recurrence_scene` 识物命中 / `recurrence_manual` 用户手选），
   *     绝不合并成一个总数——手选占比高说明"跨场景"主张没被兑现，那是必须看见的信号（§3.4）。
   *   · payload 带实际 `scene`、上次的 `expectedScene` 与 `sceneChanged`；**即便为 false，
   *     复现照记**（重新取词确实发生了），但界面与数据都不声称"换了场景"。
   *   · 到期词**没被取到**（拍了别的、或手选了别的）→ 什么都不落、排期不动：没复现就是没复现。
   *
   * 命中的判定是"取到的词 ∈ 当前到期集合"。提示只展示最先到期的那一个（用户看不到词名，
   * 只被要求换个地方重拍），但若他恰好取到了另一个**同样到期**的词，那也是一次真实的复现
   * ——把它丢掉等于用户白跑一趟，而且排期不动会让他下次再被催一遍同一个词。
   *
   * @param {'recognized'|'manual'} source 取词模式（决定落哪个事件类型）
   * @returns {boolean} 这次是不是一次复现
   */
  function noteRecurrence(source) {
    const word = shownWord?.word ?? null;
    if (word === null) return false;
    const id = wordIdOf(word);
    const now = clock();
    const target = dueList().find((w) => w.id === id);
    if (target === undefined) return false;   // 没到期 / 取到的不是到期词
    const scene = shownWord.scene ?? null;
    const expectedScene = target.lastScene ?? null;
    const sceneChanged = sceneChangedOf(scene, expectedScene);
    record(store, source === 'manual' ? 'recurrence_manual' : 'recurrence_scene', {
      sessionId,
      roundIndex: lastRoundIndex,
      wordId: id,
      word,
      scene,
      expectedScene,
      sceneChanged,
      source,
    }, clock);
    // 写回**同一个 id**，并复用 nextState 定档（stage 是"已完成档数"，返回值才是刚排上那一档）。
    // lastScene 只在这次场景是**真实场景**时更新：未知时保留上一次的真实场景，
    // 否则下次提示会说"上次是在「手动选择」场景学的"——一句没有信息量的话。
    store.putWord({ ...nextState(target, now), lastScene: isRealScene(scene) ? scene : expectedScene });
    recurrenceNote = { word, scene, expectedScene, sceneChanged, source };
    return true;
  }

  /**
   * 「听示范」（Task 12B）：用浏览器本地的 speechSynthesis 把目标词念一遍。
   *
   * 播放期间按钮置灰成「正在播放…」（`onPlayDemo` 开头的重渲染负责这一点）；
   * 播放失败在错误区如实说明（**不假装播过**），按钮恢复可点。播放这一腿的收口
   * （播完 resolve / 引擎报错 reject，绝不挂住）全在 `units/speak.mjs` 的 `playWord`。
   *
   * 判定已经退役：播没播、念没念，都与任何事件无关——这一格的出口只有
   * 自评打勾（`readDone`）与跳过（`skipReading`），两者**都不落判定事件**。
   */
  async function onPlayDemo() {
    if (demoBusy) return;                     // 播放中再点无效（按钮已是禁用态，这是脚本层的同款防线）
    demoBusy = true;
    render(machine.state);
    try {
      await playWord(shownWord?.word ?? '', { win: ttsWin });
    } catch (err) {
      setError(`示范音没能播出来：${String(err?.message ?? err)}`);
    } finally {
      demoBusy = false;
      render(machine.state);
    }
  }

  /**
   * 「我会读了（开始跟读）」：进跟读那一格（12B 起这一格是「听示范 → 自己念 → 自评」）。
   *
   * 旧版在这里落 `speech_unsupported`（转写不可用的降级标签）——那条判定路径已随
   * SpeechRecognition 退役，本函数只剩状态推进。两个出口的语义与旧降级路径完全一致：
   * 自评打勾只表示"我读了"，不是"系统听到我说出了目标词"，**不落 `reading_done`**。
   */
  function onWordReady() {
    if (!machine.send('wordReady')) return;   // 按钮只长在 word 那一屏；返回 false 时什么都不做
  }

  function onManualPick(word) {
    // 手选：来源标成 manual，界面据此明说"这是你自己挑的"。
    shownWord = { word, scene: lastPick?.scene ?? '手动选择', source: 'manual' };
    awaitingManualPick = false;
    // 复现的第二种模式（§3.3.3）：用户自己挑中了到期词 → `recurrence_manual`。
    // 与识物命中**分列**统计（"手选占比高"是必须看见的信号）。
    noteRecurrence('manual');
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

  /**
   * 保存设置里填的 Key（12A）。校验与落盘全在 keyring（本层只路由它的结论）：
   * 失败 → 错误区显示它给的、**给用户看**的那句话；成功 → 回到原屏（statusEl 上看得到）。
   */
  function onSaveSettings(inputEl) {
    const r = keyring.saveKey(inputEl?.value);
    if (!r.ok) {
      setError(r.error);
      render(machine.state);
      return;
    }
    setError('');
    viewingSettings = false;
    render(machine.state);
  }

  /** 清除已存的 Key（幂等）：留在设置屏，让"未配置"的状态当场可见。 */
  function onClearKey() {
    keyring.clearKey();
    setError('');
    render(machine.state);
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

    // ── 设置（API Key）那一屏（12A）──────────────────────────────────────────────
    //
    // 与待补反馈同一个抽屉模式：任一屏都能打开（ready/word 屏必须可达是底线，入口按钮
    // 每屏都挂着）。**不回显明文**：已配置只说"已配置"，输入框永远从空白开始。
    if (viewingSettings) {
      view.push(title('设置 · API Key'));
      view.push(hint(hasKey()
        ? '已配置：Key 已保存在这台手机的浏览器里（出于安全，这里不显示它的内容）。'
        : '未配置：还没有保存任何 Key。'));
      view.push(hint(SETTINGS_HINT));
      const keyInput = doc.createElement('input');
      keyInput.type = 'password';
      keyInput.placeholder = '粘贴以 sk- 开头的 API Key';
      keyInput.value = '';                      // 永远从空白开始：配置状态靠上面那句话，不靠回显
      view.push(keyInput);
      action('保存', () => onSaveSettings(keyInput));
      action('清除 Key', onClearKey);
      action(`返回（${machine?.state ?? ''}）`, () => { viewingSettings = false; render(machine.state); });
      view.push(row);
      return view;
    }

    // ── 待补反馈那一屏（Task 9B §5.1）────────────────────────────────────────────
    //
    // **它先于状态机那一屏**：待补界面是"任一屏都能打开的一个抽屉"，不是某个状态的分支。
    // （首版把它嵌在 `case 'ready'` 里，于是从反馈屏点入口时什么都不会发生——
    //  入口按钮每屏都挂着，界面却只在首页认它。`tests/pending-mount.test.mjs` 抓到了这一处。）
    if (viewingPending) {
      view.push(title(PENDING_ENTRY_LABEL));
      view.push(hint('这些句子当时没拿到判定。原句一直留在这儿，一条都不会丢；'
        + '下面可以手动再交一次（自动重试也会照常进行）。'));
      const items = pendingList();
      if (items.length === 0) {
        view.push(hint('当前没有待补的句子。'));
      } else {
        // 同一条欠账的重试记录只显示一次（失败了几次在下面那句里说，不重复铺句子）。
        const seenIds = new Set();
        const shown = items.filter((it) => {
          if (seenIds.has(it.pendingId)) return false;
          seenIds.add(it.pendingId);
          return true;
        });
        const list = doc.createElement('div');
        list.className = 'pending-list';
        for (const it of shown) {
          const card = doc.createElement('div');
          card.className = 'pending-item';
          const line = doc.createElement('p');
          // 原句**逐字**显示（不 trim、不截断）：它是用户写下的东西，也是这一切的意义所在。
          line.textContent = String(it.sentence ?? '（没有记到句子）');
          card.append(line);
          const meta = doc.createElement('p');
          meta.className = 'muted';
          const tries = it.autoAttempts > 0 ? `已自动重试 ${it.autoAttempts} 次；` : '';
          const state = it.resolved
            ? `${PENDING_RESOLVED_LABEL}（判定已补上）`
            : `还没补上——${tries}${retryTimingText(it)}`;
          meta.textContent = `目标词：${it.word ?? '（没记到）'} · ${state}`;
          card.append(meta);
          list.append(card);
        }
        view.push(list);
      }
      action('手动补交', onManualRetry, storageFull() || openPending().length === 0);
      action(`返回（${machine?.state ?? ''}）`, () => { viewingPending = false; render(machine.state); });
      if (storageFull()) view.push(hint(STORAGE_FULL_NOTICE));
      view.push(row);
      return view;
    }

    switch (state) {
      case 'ready': {
        view.push(title('拍一件你身边的东西'));
        view.push(hint('对准物体按「拍照」；画面太暗或太糊会当场退回重拍，不消耗识物调用。'));
        // 12A：无 Key 给**引导**而不是死路——为什么需要、怎么拿、存哪、只存本机，
        // 以及出路（下面的「设置（API Key）」按钮）。拍照按钮照旧在：点它会被拦下并再指一次路。
        if (!hasKey()) view.push(hint(NO_KEY_GUIDANCE));
        // 存储写满（§5.1 那一档）：**停止派发新任务**并把出路说清楚（导出 + 清理空间）。
        // 这是这一档的**主出口**——`storage_full` 标签是尽力而为（见 store.mjs 的自反悖论说明）。
        if (storageFull()) view.push(hint(STORAGE_FULL_NOTICE));
        const reason = machine?.snapshot().lastRejectReason ?? null;
        if (reason !== null) view.push(hint(REJECT_HINT[reason] ?? '刚才那张没能用，重拍一张。'));
        // 到期复现（§3.3.2 / §3.4）：有到期词就催一次，并说明"换个地方"——复现走的是**同一条**
        // 识物链路（不新增"复现专用"通路），所以这里只多一句提示。
        // 一次只提示最先到期的那一个（`dueWords` 已按到期时间排序），其余只报个数。
        const due = dueList();
        if (due.length > 0) {
          const others = due.length - 1;
          // 「居家 / 通勤 / 职场 / 餐饮」只是**例子**：系统不知道用户实际站在哪儿，
          // 所以这句话是建议，不是判定——它不参与任何逻辑。
          view.push(hint(`该复习了：这个词上次是在「${due[0].lastScene ?? '未知'}」场景学的。`
            + `请换一个地方重新拍一张（例如 ${RECURRENCE_SCENE_EXAMPLES}）。`
            + (others > 0 ? `另有 ${others} 个词也到期了，先取这一个就行。` : '')));
        }
        action('拍照', onCapture, storageFull());
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
        // 这次取词是一次到期复现 → 如实说明（**换没换场景都要说清**，不许含糊、更不许谎报）。
        if (recurrenceNote !== null) {
          view.push(hint(recurrenceNote.sceneChanged
            ? `这个词到期了，这次是在「${recurrenceNote.scene}」重新取到的（上次在「${recurrenceNote.expectedScene}」）。`
            : '这个词到期了，这次又取到了一次；场景没能确认与上次不同，所以只记"又一次取到"。'));
        }
        action('我会读了（开始跟读）', onWordReady);
        break;
      }
      case 'reading': {
        view.push(title('跟读一遍'));
        if (ttsOk) {
          // 12B（转向 DEC-…26）：示范音替代自动判定。界面把三步说清楚：听示范 → 自己念 → 自评。
          // 两个出口的语义与旧降级路径完全一致——**都不落判定事件**：手动打勾只是"我读了"，
          // 不是"系统听到我说出了目标词"（既有裁决原样沿用），跳过是用户的选择。
          view.push(hint(`先点「听示范」听 ${shownWord?.word ?? '这个词'} 怎么读；然后自己出声念一遍，念完自己打勾。`));
          view.push(hint('系统不判断你念得准不准（自动判定已退役）；念没念由你自己确认。'));
          action(demoBusy ? '正在播放…' : '听示范', onPlayDemo, demoBusy);
          action('我读过了（自评打勾）', () => machine.send('readDone'));
          action('跳过跟读', () => machine.send('skipReading'));
          break;
        }
        // 浏览器没有 speechSynthesis：如实说播不了示范音，这一格只剩跳过（12B 转向裁决）。
        // 不假装存在"听示范"，也不给一个按下去必然失败的按钮。
        view.push(hint(`这个浏览器没有语音合成（speechSynthesis），播不了示范音。`
          + `请对照 ${shownWord?.word ?? '这个词'} 自己出声念一遍；这一步只能先跳过。`));
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
        // 口径按实情写：落盘的是**提交次数**（`rewriteCount` 那个字段名在下游是错的，
        // 见 progress 必办 1）；改了几版从提交次数看得出来（改写次数 = 提交次数 - 1）。
        view.push(hint('这一段停留时长与提交次数会进记录（改了几版从提交次数看得出来），'
          + '用于事后筛出敷衍样本；首版不做内容校验。'));
        action('提交造句', onSubmit);
        break;
      }
      case 'feedback': {
        // 设计文档 §4.2/§5.1 的三档在界面上的样子（**一句都不许美化**）：
        //   · 拿到判定 → 摊开四个字段（判定 / 错误类型 / 改写建议 / 说明）+ 自己写的那句；
        //   · 模型判 uncertain → 明说"拿不准"，不伪装成对/错（全局约束 4）；
        //   · 没拿到（pending）→ 明说没拿到、**原句仍在这儿**、可以再交一次，绝不编一个好评。
        if (feedback === null || feedback.busy === true) {
          view.push(title('正在看你这句…'));
          view.push(hint('结果回来之前这一屏不会有别的动作（弱网下可能要等十几秒）。'));
          if (lastComposeText.trim() !== '') view.push(hint(`你写的是：${lastComposeText}`));
          // 等待期间**也要留住出口**：这条腿最坏会等到客户端上限（24s），
          // 把「再写一次」「下一个词」藏起来就等于让用户在这段时间里无路可走。
          // 点它们不会取消那次请求——结论回来时会发现状态已经变了，于是不再重绘。
          action('再写一次', () => machine.send('rewrite'));
          action('下一个词', () => machine.send('next'));
          break;
        }
        const r = feedback.result;
        // 不管哪一档，都先把**学习者自己写的那句**摊出来：反馈是给这句话的，
        // 不把原句放在眼前，"哪里错了"就只能靠记忆对照（而上一屏已经被换掉了）。
        view.push(hint(`你写的是：${r.sentence}`));
        if (r.status === 'ok' && r.uncertain === true) {
          view.push(title('这句我拿不准'));
          // 文案里**不写 markdown 的强调符**（Task 8 复审 Item 3）：`hint()` 走 `textContent`，
          // 写进去的 `**` 会一字不差地显示给学习者。强调靠标题与分句，不靠星号。
          view.push(hint('模型没法确定它对不对——这不是判定，我们不会把它算成"通过"。'));
          if (r.feedback.rewrite !== null && r.feedback.rewrite !== undefined) {
            view.push(hint(`可以参考这样写：${r.feedback.rewrite}`));
          }
          view.push(hint(r.feedback.note));
        } else if (r.status === 'ok') {
          view.push(title(r.feedback.verdict === 'correct' ? '这句没问题' : '这句可以更好'));
          const problem = ERROR_TYPE_LABEL[r.feedback.error_type] ?? r.feedback.error_type;
          if (problem !== '') view.push(hint(`问题在：${problem}`));
          if (r.feedback.rewrite !== null && r.feedback.rewrite !== undefined) {
            view.push(hint(`可以这样改：${r.feedback.rewrite}`));
          }
          view.push(hint(r.feedback.note));
        } else {
          view.push(title('这次没拿到反馈'));
          // 同上：`hint()` 是 `textContent`，`**` 会原样显示给学习者（这句正是真机清单第 35 项
          // 要人读的那一屏）。
          view.push(hint(`${PENDING_HINT[r.reason] ?? '反馈服务这次没能返回结果'}——`
            + '你的句子没有丢，它还在这儿，可以再交一次。'));
        }
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
    // 「待补反馈」入口（§5.1 明文要求的那一屏）：与下面那个诊断页链接一样**每屏都挂着**。
    // 为什么不能只挂在首页：自动重试失败可能发生在任意一屏（用户正在造句、正在看反馈），
    // 只在首页给入口的话，用户当场没有任何地方能知道"刚才那次补交又没成"。
    // **只在真有待补/有归档时出现**：一个永远挂着"待补反馈（0 条）"的按钮只会让人以为出了事。
    const openCount = openPending().length;
    const archivedTotal = pendingList().length;
    if (!viewingPending && (openCount > 0 || archivedTotal > 0)) {
      const pendingBtn = doc.createElement('button');
      pendingBtn.textContent = `${PENDING_ENTRY_LABEL}（${openCount} 条）`;
      pendingBtn.addEventListener('click', () => { viewingPending = true; render(machine.state); });
      const pendingRow = doc.createElement('p');
      pendingRow.className = 'row';
      pendingRow.append(pendingBtn);
      view.push(pendingRow);
    }
    // 诊断页入口（真机走查用）：把记录翻译成人话，省掉"开开发者工具读 JSON"那一步。
    // 每屏都挂着，因为走查时需要在任意时刻查看记录（例如第 25 步数快门次数）。
    const diag = doc.createElement('p');
    diag.className = 'muted';
    const diagLink = doc.createElement('a');
    diagLink.href = './diagnostics.html';
    diagLink.textContent = '查看诊断页（把学习记录翻译成人话）';
    diag.append(diagLink);
    view.push(diag);
    // 12A：设置（API Key）入口——ready/word 屏必须可达，索性与诊断页同款每屏都挂着
    //（Key 可能在任何一屏用完/失效，用户不该为了换 Key 而丢掉当前进度）。
    const settingsBtn = doc.createElement('button');
    settingsBtn.textContent = '设置（API Key）';
    settingsBtn.addEventListener('click', () => { viewingSettings = true; render(machine.state); });
    const settingsRow = doc.createElement('p');
    settingsRow.className = 'row';
    settingsRow.append(settingsBtn);
    view.push(settingsRow);
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
  //
  // `onEnter` 是**唯一"每个状态恰好一次"**的时机，所以"进入 composing 的时刻"记在这里：
  // `compose_submitted` 的 `dwellMs` 要的是"进入这一格到提交"这一段，而快照里的
  // `dwellMs.composing` 是整个会话累计（回环两轮时读到的是两轮之和）。
  function onEnterState(state) {
    if (state === 'composing') composingEnteredAt = clock();
    render(state);
  }

  machine = createMachine({ onEnter: onEnterState, now: clock });

  async function onCapture() {
    setError('');
    // 12A：没有 Key 就不打开相机、不进 capturing——直连识物必须有自己的 Key，
    // 而 ready 屏上方已有完整引导；这里把出路再指一次（错误区是全色文本，弱光下也看得见）。
    // 不落事件、不动状态机：什么都没发生，就没有什么可记（"缺 Key"不是一次识物失败）。
    if (!hasKey()) {
      setError('先配置 API Key 再开始：点下面的「设置（API Key）」粘贴保存（platform.deepseek.com 可以创建）。');
      render(machine.state);
      return;
    }
    // 上一轮的取词结果作废（否则"重拍一张"之后界面还挂着旧的手选词包）。
    // 这里只清 `lastPick` / `shownWord`——**手选态 `awaitingManualPick` 不在这一处清**，
    // 它在 `onShutter` 开头清（见那里的 `awaitingManualPick = false`）。这样写是够的：
    // 回到 `ready` 的唯一路径是 `capturing --frameBad--> ready`，而 `frameBad` 只在
    // `onShutter` 里发出——也就是说"能再点拍照"这件事本身，已经蕴含着手选态刚被清过
    // （state-machine.mjs 的 TRANSITIONS：`word` 没有回 `ready` 的转移）。
    // 复审 Minor 4 记的就是这一点：原先这句注释写着"手选态也作废"，而代码并没有在这里清它；
    // 选的是**把注释改成实情**（而不是加一行清 `awaitingManualPick`）——那样加出来的行在
    // 当前状态机下永远不可达，没有任何用例能钉住它，属于注释之外又添一处不可验证的声明。
    lastPick = null;
    shownWord = null;
    // 上一次取词若是一次复现，它的说明不该留到这一轮（`recurrenceNote` 属于"某一次取词"）。
    recurrenceNote = null;
    // 双击/连点：第二次点击时状态还是 ready（第一次的 await 还没回来），按钮仍在页面上。
    // 不挡就会开出两路 camera stream，其中一路永远不会被 stop（灯亮着、耗电）。
    if (opening) return;
    // 存储写满 → 停止派发新任务（§5.1）。放在这里而不是只把按钮置灰：
    // 按钮的 `disabled` 只挡鼠标，键盘/脚本触发的点击照样进得来。
    if (storageFull()) {
      setError(STORAGE_FULL_SHORT);
      render(machine.state);
      return;
    }
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
    // 存储写满 → 停止派发新任务（§5.1）：这一按不该再产生任何新的判定与调用。
    if (storageFull()) {
      setError(STORAGE_FULL_SHORT);
      render(machine.state);
      return;
    }
    // 上一轮的结果清掉：手选词包只在"这一轮真的两轮都落空"时才该出现。
    lastPick = null;
    shownWord = null;
    awaitingManualPick = false;
    recurrenceNote = null;

    let picked;
    try {
      // 取帧 → 端侧质检 → 最多两次识物请求，全在 `recognizeWithFallback` 里。
      // **本层不再自己判帧**（追加要求 1）：判帧只有一处起源，`frame_rejected` 与它的 reason
      // 都来自这个返回值，不存在"界面说太暗、记录说太糊"的可能。
      // 这里**不传 fetchImpl**：让 `recognize()` 用它自己的缺省（全局 `fetch`），
      // 于是"谁是网络出口"只有一个决定点，注入式测试也能接管它。
      // 12A：直连模型服务的 Key 在发请求那一刻从 keyring 读——设置里存好/清掉，下一拍就生效。
      picked = await runRecognize({
        grab, frameQC, acceptableSets: ACCEPTABLE_SETS, exclude: [], apiKey: apiKeyNow(),
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
    // 反馈事件（Task 8）沿用这一轮的编号：造句发生在取词的**同一轮**里，
    // 它不是一次新的快门——给反馈单开一个轮次号会让判据 B 的轮数虚增。
    lastRoundIndex = roundIndex;

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
        // 取到词那一次的耗时（判据 A 的 `latency_p95` 的**唯一**数据来源）。
        // **口径在 12A 变化**（units/recognize.mjs 文件头有全文）：旧口径是服务端自报的
        // 处理耗时；直连后是**客户端 performance.now() 实测**"发请求到解出候选"的耗时
        // （含网络往返）。它与判据 B 的 `attempts` 仍是两个数：`attempts` = 这一轮问过模型几次；
        // 本字段 = 取到词的那一次等了多久（attempts=2 时也不把两次相加）。
        //
        // **只在实测值真的是有限数时才写这个键**：缺字段时写 0 会让 p95 看起来完美，
        // 而真凶（时钟异常）被一个漂亮数字盖住——"缺一个数"远好过"一个假数"。
        // 判据统计那侧（`scripts/export.mjs`）只在事件里**真的没有**这个字段时报缺口，
        // 所以两边对"缺"的表达必须一致：**这里省略键，那边 `null` + `gaps`**。
        ...(Number.isFinite(picked.latencyMs) ? { latencyMs: picked.latencyMs } : {}),
      }, clock);
      shownWord = { word: picked.word, scene: sceneOf(picked.word, picked.candidates ?? []), source: 'recognized' };
      // 复现的第一种模式（§3.3.3）：识物取到的正是到期词 → `recurrence_scene` 并推进排期。
      noteRecurrence('recognized');
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
    // 空句（或读不到输入框）**在提交之前**就说清楚，并把用户留在造句屏：
    // 一次反馈调用要花钱，而空句换来的一定是一份无用的判定；推进到反馈屏还会让他
    // 面对一个没有"回去改"入口的界面（feedback 只有 rewrite/next 两个出口）。
    if (text.trim() === '') {
      setError('先写一句你自己的话再提交（这一句是这次练习的重点）。');
      return;
    }
    setError('');
    // ⚠️ 这一句是**当前不可达**的死防御（progress 必办 3），保留而**不是**删掉，理由是
    // fail-closed：按钮只长在 `composing` 那一屏，而 `send` 是同步的（这中间没有 await），
    // 所以点下去的那一刻状态必然是 composing。万一将来按钮被摆到别处（例如给反馈屏加一个
    // "再交一次"），这一句会让那次点击**什么都不做**；删掉它的话，同样的情形会走到下面的
    // `lastComposeText`/`submitForFeedback`，把一次状态机不知道的提交算进数据里，
    // 而且界面会停在造句屏、结论回来时发现状态不是 feedback 而不重绘（用户看到"点了没反应"）。
    // 不可达性由 tests/app-mount.test.mjs 的"「提交造句」按钮只在 composing 态存在"钉住。
    if (!machine.send('submit')) return;
    lastComposeText = text;
    // 落盘（§3.4）：**提交成功那一刻**（已过空句拦截、已推进状态）落 `compose_submitted`。
    // 它是"成人愿为造句付多少成本"这批数据的载体——Task 6 曾刻意延后到本任务，免得与
    // Task 8 的反馈事件重复计数。
    //
    // 返回值在这里的用途只有一个：**写不进去时把出路说清楚**（存储写满 → 提示导出），
    // 而不是让用户以为"提交过了"其实什么都没记下（§5.1 / Global Constraint 3）。
    if (recordComposeSubmitted(text) === null) setError(`这句话没能记下来：${STORAGE_FULL_NOTICE}`);
    submitForFeedback(text);
  }

  /**
   * 落一条 `compose_submitted`（设计文档 §3.4 / progress 必办 1+2）。
   *
   * **重复计数防线（写给 Task 10 的统计指引）**：同一句话会同时出现在这条事件与
   * `feedback_ok`/`uncertain`/`feedback_pending` 的 `payload.sentence` 里。这是**同一句的两次
   * 不同用途记录**——前者记"产出成本"（一句一份），后者记"判定结果"（一次提交一份判定），
   * **不是两次产出**。统计造句总数时**只数 `compose_submitted`**，不要与反馈事件相加。
   *
   * 字段口径（progress 必办 1：`rewriteCount` 这个名字的含义其实是"提交次数"，带着它落盘就是
   * 把一个错的字段名交到下游）：
   *   · `submitCount` = 会话内**提交次数**（零改写会话为 1），取自快照的 `rewriteCount`；
   *   · `revisions`   = `submitCount - 1`（真的回改了几版）；
   *   · `dwellMs`     = **进入 composing 到这次提交**的毫秒数（§3.2 筛敷衍样本要用它，
   *     此前没有任何地方记它）。读不到进入时刻时是 `null`——宁可缺这个数，
   *     也不要写一个 0 冒充"零停留"（那正好是"敷衍样本"的判定值）。
   */
  function recordComposeSubmitted(text) {
    const s = machine.snapshot();
    return record(store, 'compose_submitted', {
      sessionId,
      roundIndex: lastRoundIndex,   // 造句属于取词那一轮（它不是一次新的快门）
      wordId: null,
      sentence: text,
      word: shownWord?.word ?? null,
      scene: shownWord?.scene ?? null,
      submitCount: s.rewriteCount,
      revisions: s.rewriteCount - 1,
      dwellMs: composingEnteredAt === null ? null : clock() - composingEnteredAt,
      skippedReading: s.skippedReading,
    }, clock);
  }

  /**
   * 记一条判定事件（`submitForFeedback` 与补交共用；**判定本体与字段顺序只有这一处**）。
   *
   * 三条不变量：
   *   1. `...ev.payload` 放最前、`sessionId`/`roundIndex` 写在后面 → 服务端身份字段永远权威
   *      （Task 8 复审 Important 1）；
   *   2. 补交时带上 `retriedPendingId` 指针，让队列知道这条欠账被勾掉了
   *      （`units/pending.mjs` 的 `retryEventFor` 已经把它放进 payload，这里只透传）；
   *   3. **落盘失败（存储满）不抛**，交给调用方按"写不进去"处置（停止派发 + 提示导出）。
   *
   * @returns {object|null} 落下去的事件；`null` = 写不进去（配额满）
   */
  function recordVerdict(ev) {
    try {
      return record(store, ev.type, {
        ...ev.payload,
        sessionId,
        roundIndex: lastRoundIndex,
        wordId: null,
      }, clock);
    } catch (err) {
      if (!storageFull()) throw err;
      return null;
    }
  }

  /**
   * 补交一次：**复用同一个提交器与同一条判定记录路径**（不另写一条网络/落盘通路）。
   *
   * 两条口径：
   *   · `retryPendingId` 让"这条判定是补交来的"在事件流里可区分（§5.1 与 Task 10 的分组依据）；
   *   · **不落 `compose_submitted`**：补交不是一次新的产出，产出成本只在用户提交那一刻记一次。
   *
   * @param {{ pendingId: string, sentence: unknown, word: unknown, scene: unknown, autoAttempts: number }} item
   * @param {number} attempt 这是第几次补交（1 起）
   */
  async function runPendingRetry(item, attempt) {
    retryPendingId = item.pendingId;
    let result;
    try {
      // 12A：补交同样带上此刻的 Key——用户若在设置里修好了 Key，欠账的自动/手动补交就能救回来。
      result = await runSubmitSentence({
        sentence: item.sentence,
        word: item.word ?? '',
        scene: item.scene ?? '未知',
      }, { apiKey: apiKeyNow() });
    } finally {
      retryPendingId = null;
    }
    const ev = retryEventFor(item, result, attempt, clock());
    // 落盘的两种坏结局都不该把补交本身弄崩：
    //   · 存储写满 → 判定没落下来，界面会如实说明并停止派发；
    //   · 事件类型不合法（编程错误）→ 照旧响亮抛错，但先让调用方知道这次补交白做了。
    if (ev.type === 'feedback_pending') {
      let written;
      try {
        written = recordVerdict(ev);
      } catch (err) {
        setError(`补交结果没能记下来（这是程序缺陷）：${err?.message ?? err}`);
        render(machine.state);
        return result;
      }
      // 写不进去 → 这条欠账不会因为这次补交而减少，也不该继续排重试
      // （再试一次还是写不进去，而"写不进去"有自己的档位）。
      if (written === null) {
        setError(`补交结果没能记下来：${STORAGE_FULL_NOTICE}`);
      } else {
        setError('这次补交还是没拿到反馈（记录里仍是"待补"，可以稍后再试）。');
      }
    } else {
      try {
        recordVerdict(ev);
      } catch (err) {
        setError(`补交结果没能记下来（这是程序缺陷）：${err?.message ?? err}`);
      }
    }
    if (viewingPending) render(machine.state);
    return result;
  }

  /**
   * 排下一次自动重试（**同一时刻只挂一个定时器**）。
   *
   * 与 `units/pending.mjs` 的 `nextPendingRetry`（只回答"现在到点了没有"）分工不同：
   * 这里排的是**将来**那一刻，所以取"所有还没补上的条目里最早的那个排定时刻"，
   * 按它挂一个定时器。
   *
   * 三条停止条件，每一条都有理由：
   *   · 存储写满 → 停（再试也只是让同一个写失败再发生一次，"写不进去"有自己的档位）；
   *   · 一条都没排上（全补上了 / 自动次数都用完了）→ 停，剩下的交给手动补交；
   *   · 已经挂着一个 → 不重复挂（同一时刻只挂一个，否则并发补交会互相打架）。
   */
  function scheduleAutoRetry() {
    if (retryTimer !== null) return;
    if (storageFull()) return;
    let next = null;
    for (const item of openPending()) {
      const at = scheduledRetryAt(item);
      if (at === null) continue;                     // 这条的自动重试已用完
      if (next === null || at < next.at) next = { at, item };
    }
    if (next === null) return;
    const delay = Math.max(0, next.at - clock());
    retryTimer = setTimer(async () => {
      retryTimer = null;
      await retryFeedback(next.item);
      // 这一次失败会在事件流里多出一条同 id 的 pending，于是"排定时刻"自然推到下一档；
      // 成功则这条不再进轮转。两种情形都由同一句重排收口。
      scheduleAutoRetry();
    }, delay);
  }

  /**
   * 补交一条（自动与手动共用同一条路）。
   *
   * 为什么自动重试**不占用一个界面状态**：用户可能正在写别的句子。补交结果是往事件流里
   * 补一笔，界面只在"用户正看着待补那一屏"时才重绘（`viewingPending`）。
   */
  async function retryFeedback(item) {
    const fresh = pendingList().find((it) => it.pendingId === item.pendingId) ?? item;
    if (fresh.resolved) return;
    retrying = { pendingId: fresh.pendingId, busy: true };
    if (viewingPending) render(machine.state);
    try {
      await runPendingRetry(fresh, fresh.autoAttempts + 1);
    } catch (err) {
      // 提交器自己不抛错（契约），抛出来就是编程错误：显示 + 原样重抛（与控制台里的栈对上）。
      setError(`补交时出错（这是程序缺陷，不是那条句子的问题）：${err?.message ?? err}`);
      if (viewingPending) render(machine.state);
      throw err;
    } finally {
      retrying = null;
    }
  }

  /** 用户点了「手动补交」：补**最早那条还没补上的**（§5.1 的"用户可手动重试"）。 */
  async function onManualRetry() {
    if (storageFull()) {
      setError(STORAGE_FULL_SHORT);
      render(machine.state);
      return;
    }
    const item = manualRetryCandidate(allEvents());
    if (item === null) {
      setError('当前没有待补的反馈了。');
      render(machine.state);
      return;
    }
    setError('');
    await retryFeedback(item);
    render(machine.state);
  }

  /**
   * 打开页面时接管上次留下的欠账（**"重开页面后待补条目仍在"的落点**）。
   *
   * 队列不是内存里的东西，所以这里不需要"恢复"任何数据——只需要把定时器重新挂起来。
   * 测试用一整套注入的定时器驱动它（见 `tests/pending-mount.test.mjs`）。
   */
  function resumePendingRetries() {
    scheduleAutoRetry();
  }

  /**
   * 提交造句 → 拿反馈（Task 8）。**原句先留住**（`lastComposeText` + `result.sentence`），
   * 无论成功还是失败都不丢——这是设计文档 §5.1「反馈接口失败：保留原句不丢」的落点。
   *
   * 三件事的顺序不能颠倒：
   *   ① 先把"正在看"渲染出来（弱网下这一屏会停十几秒，不能让它看起来像卡死）；
   *   ② 调 `runSubmitSentence`（**它自己不抛错**：一切外界失败都是一条 pending）；
   *   ③ 把结论落到事件与界面（事件映射用 `units/compose.mjs` 的 `feedbackEventFor`，
   *      不在这里另写一套——两套映射迟早漂移）。
   */
  async function submitForFeedback(text) {
    feedback = { busy: true, result: null };
    render(machine.state);
    // 造句原文先交给注入的钩子（Task 8/9 的接线点）：**提交即回调**，不等反馈。
    // 这样"钩子收到了这句话"与"模型那边多久回话"是两件互不牵连的事——
    // 钩子挂掉、反馈超时，都不该让"用户提交过这句话"这件事消失。
    if (typeof onCompose === 'function') {
      const s = machine.snapshot();
      onCompose({ text, rewriteCount: s.rewriteCount, skippedReading: s.skippedReading });
    }
    let result;
    try {
      // 12A：直连模型服务的 Key 在提交那一刻从 keyring 读（设置里存好/清掉，下一次提交就生效）。
      result = await runSubmitSentence(
        { sentence: text, word: shownWord?.word ?? '', scene: shownWord?.scene ?? '未知' },
        { apiKey: apiKeyNow() },
      );
      // 落事件：一条，且必定带原句（A4：句子就是语料，Task 9 的持久化与验证三都从这里读）。
      const ev = feedbackEventFor(result);
      // **顺序就是契约**（Task 8 复审 Important 1 的同形状）：`...ev.payload` 放在最前面，
      // `sessionId` / `roundIndex` 写在它后面 → 服务端的身份字段永远权威。
      // 原先 `...ev.payload` 在最后：payload 里若出现同名键（`recordEvent` 会把 `sessionId`/
      // `wordId`/`roundIndex` 提到事件顶层，见它的第三个参数形状），它就会盖掉真实的会话号与轮次
      // ——判据 B（`retry_rate`）按 `roundIndex` 分组，被盖掉就等于把这一轮记到别处去。
      //
      // 当前**够不到**（已核实）：`feedbackEventFor` 的 payload 是把固定几个键逐个写出来的
      // **白名单**（`base` + verdict/error_type/note/rewrite，或 base + reason/error/detail），
      // 模型多给的键连 `result.feedback` 都不出、更进不了 payload，所以那三个名字永远不会撞上。
      // 之所以照样改（一行）：把这条不变式从"远处那个函数一直记得别加错键"挪到**这里写死**——
      // `feedbackEventFor` 将来要加一个键时，风险面就只剩它自己。
      //
      // Task 9B 追加：**待补条目要有 id**（`withPendingId`），补交成功时靠它把这条勾掉。
      // id 由事件本身派生（**sessionId + ts**），于是重开页面后派生出的 id 与当时那条一致。
      //
      // ⚠️ 顺序有讲究：**先把完整的字段拼齐（含 sessionId / roundIndex / wordId），再算 id**。
      // 首版写成 `withPendingId({ payload: ev.payload })`——那个对象里没有 sessionId 与 ts，
      // 于是 id 退化成 `p_nosession_0`，**同一会话里所有待补条目撞成同一个 id**：
      // 补交一条就会把别的条目一起勾掉，而队列看起来"工作正常"。
      const fields = {
        ...ev.payload,
        sessionId,
        roundIndex: lastRoundIndex,
        wordId: null,
      };
      const withId = ev.type === 'feedback_pending'
        ? { ...fields, ...withPendingId({ sessionId, ts: clock(), payload: ev.payload }) }
        : fields;
      try {
        record(store, ev.type, withId, clock);
      } catch (err) {
        // 存储写满不该把"我已经写下的这句话"变成一次崩溃：如实说 + 停止派发新任务。
        // 非配额错误照旧重抛（那是未知故障，吞掉就变成"记了其实没记"）。
        if (!storageFull()) throw err;
        setError(`这次的判定没能记下来：${STORAGE_FULL_NOTICE}`);
      }
    } catch (err) {
      // `submitSentence` 的契约是"不抛错"，抛出来就是编程错误：**原样重抛**（与控制台里的栈对上），
      // 但界面必须给一句话，不让用户面对"点了没反应"。
      feedback = null;
      setError(`提交造句时出错（这是程序缺陷，不是你的句子的问题）：${err?.message ?? err}`);
      render(machine.state);
      throw err;
    }
    feedback = { busy: false, result };
    // 用户可能已经点了「再写一次」——那就不再重绘（否则会把他刚回到的输入框换掉）。
    if (machine.state === 'feedback') render(machine.state);
    // 学完即入队（§4.5）：**拿到结论那一刻**就把这个词放进复现队列。放在最后一行是刻意的
    // ——存储写失败时（`registerLearnedWord` 会原样重抛）上面那份反馈已经渲染出来了，
    // 不会因为一次写入失败把刚拿到的反馈弄丢。
    registerLearnedWord();
    // 待补反馈（§5.1）：这次没拿到判定就排自动重试（10s / 30s / 90s）。
    // **排在最后一行**与入队同一个理由：重试调度失败不该影响"用户已经看到结论"这件事。
    scheduleAutoRetry();
  }

  resumePendingRetries();

  return {
    machine, sessionId, store, grab,
    /**
     * 拆掉这一份应用挂的定时器（**给测试用**：`node --test` 会等事件循环空掉才退出，
     * 一个挂着的自动重试定时器会让整轮测试白等 10 秒）。
     * 浏览器里不需要它：页面卸载时定时器本来就会随页面一起消失。
     */
    dispose,
    /**
     * 重新评估"要不要排自动重试"（`scheduleAutoRetry` 的出口）。
     *
     * 生产路径上它由三处触发：mount 时接管上次欠账、每次提交拿到结论之后、每次重试跑完之后。
     * 暴露出来是为了让测试能**确定性地**问一句"此刻该不该排重试"——
     * 否则"存储满 → 不排重试"这条判断就只能靠推时间间接观察（那种测法分不清
     * "被守卫挡住"与"本来就没排上"）。
     */
    resumePendingRetries,
  };
}
