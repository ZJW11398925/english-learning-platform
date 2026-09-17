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
// 阶段 B：进度面除了 `nextState` / `dueWords`，还要读"这个词是不是已经维护了"。
// `isMaintained` 是 `units/scheduler.mjs` 里**唯一**认这件事的地方（`maintained` 标志与
// `dueAt === null` 两种写法由它统一判定）——界面不自己写 `word.maintained === true`：
// 那就是同一件事的第二个出处，而这两种写法一旦哪天只有一个被更新，界面就会把
// "不再催"的词说成"该复习"（或反过来）。
import { nextState, dueWords, isMaintained } from './units/scheduler.mjs';
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
 * 首页「已学词概览」最多铺几个词。再多就只是一面墙——剩下的用一句话交代（见 `homeView`）。
 * 12 是"一屏能扫完"的量级（390×844 下三行左右），不是从别处抄来的阈值。
 */
const LEARNED_PREVIEW_MAX = 12;

/**
 * 一条词记录在列表里的两句话：**排期档位**与**下次复习时间**。两条读数各自的来源是死的：
 *
 * 1. **档位直接读 `stage` 原值，不平移、不重算。** 这个字段的含义在 `units/scheduler.mjs`
 *    的文件头里写着"进出含义不同"，而记录里存的那一份是 `nextState` **返回**值透传下来的
 *    （`enqueueWord` → `store.putWord`），也就是"已排上的那一档序号"，取值为 1 / 2 / 3，
 *    4 是 `maintained` 哨兵。界面只说「第 N 档」——**不**把它归约成"已完成 N 档"或
 *    "N/3"：`units/scheduler.mjs` 是为这一屏提供读数的权威单元，在界面里再算一遍它的语义
 *    （+1 或 -1）等于给同一件事造第二个出处，而这两处一旦哪天不一致，界面就会**静默地**
 *    谎报学习进度。诊断页（`web/diagnostics.html` 的 `wordTable`）用同一个口径显示原始档位，
 *    两屏对得上。
 * 2. **下次复习时间直接读 `word.dueAt`，绝不拿 `stage` 去推算日期。** `dueAt` 是权威值
 *    （`nextState` 产出、`units/scheduler.mjs` 的模块头把它定为写记录的契约）；手算一遍
 *    `now + INTERVALS_DAYS[stage - 1]` 就多一个能算错的地方，而"下次什么时候复习"正是本屏
 *    最核心的那个读数。
 * 3. **`dueAt` 不是有限数、也不是 `null`**（缺失 / `NaN` / 字符串）时说着实情：这种记录
 *    正是 `units/scheduler.mjs` 里那个"既不算已维护、又永远不到期"的无声夹缝，`dueWords`
 *    会**静默略过**它。界面**不补一个默认值**（红线 4：缺键不写 0——0 是"合法且极好"的读数，
 *    会盖住真凶），只把"这条记录缺下次复习时间"照实说出来。
 *    ⚠️ 它读 `dueAt` 而**不看** `Number.isFinite(word.dueAt) === false` 之外的东西：
 *    这一档在界面上是三档里颜色最重的一档（`.word-meta-gap` 走 `--danger`），
 *    因为"你自己的词表里有一条记坏了"是**需要处理**的一件事，而不只是"还没到期"。
 *    亮色下 `--danger` 对 `--surface` 的对比度实测 ≈6.4:1（达 AA），见 `docs/ui-redesign/after/phase-b-*.png`
 *    那一轮的走查读数。
 * 4. **词记录一个都不隐藏**：列表铺的是 `store.readWords()` 的全集，包括上面那种夹缝记录。
 *    只铺到期的词、把其余藏起来，等于让用户永远看不见自己学过的词里有一条坏了。
 */
function stageLabelOf(word) {
  if (isMaintained(word)) return '已维护';
  const stage = word?.stage;
  // `Number.isInteger` 而不是 `?? 0`：缺失不是 0。缺键时写着实情，不冒充一个档位。
  return Number.isInteger(stage) ? `第 ${stage} 档` : '档位未知';
}

/** 天数：按 24 小时算，与 `units/scheduler.mjs` 的间隔口径（`INTERVALS_DAYS[i] * DAY_MS`）同源。 */
const DAY_MS = 86400000;

/**
 * 相对当前时刻的人话（"3 天前"/"今天"/"5 天后"）。
 *
 * 口径：**少于整整一天一律说"今天"**——两侧对称、都向下取整。所以"5 小时后"是"今天"
 * （它确实就在今天），"25 小时后"才是"1 天后"；同理"5 小时前"是"今天"，"25 小时前"是
 * "1 天前"。既不许把话说得比数据更满（23 小时不说成"1 天"），也不许说反方向。
 *
 * ⚠️ 这条是本轮**实测踩过两次**的地方，两种错法都不会让别的断言变红，只有专门盯"今天"
 * 那一档的用例才发现：
 *   ① 先写成"对差值直接 `Math.floor`，按符号给前/后"——`now - at` 是负数时，
 *      `Math.floor(-0.2) = -1` ⇒ 界面把"还差 5 小时"报成「1 天后」（用**负偏移**
 *      造夹具时刻时最容易遇到）；
 *   ② 修的时候又想成"未来那一侧向上取整"——那同样把"5 小时后"报成「1 天后」。
 * 现在的写法是 `Math.trunc` + 一侧取绝对值：两侧都是"整整几天"，方向由符号单独给。
 *
 * @param {number} at 目标时刻（ms）
 * @param {number} now 当前时刻（ms）
 * @returns {string} '3 天前' / '今天' / '5 天后'
 */
function daysRelationText(at, now) {
  const sign = at > now ? 1 : -1;
  const days = Math.trunc(Math.abs(at - now) / DAY_MS);
  if (days === 0) return '今天';
  return sign > 0 ? `${days} 天后` : `${days} 天前`;
}

/**
 * 一条词记录"该不该催、什么时候"的一句话（**只读 `dueAt` 与 `isMaintained`**，见上面第 2/3 条）。
 *
 * 到期那一档的话是"到期 2 天"（**不作前缀**）：调用方把它拼进一整行里（
 * `… · 上次「厨房」场景 · 到期 2 天`），所以这里给的是一个能直接嵌进去的片段，
 * 而不是自带"已到期（…）"外壳的一整句。
 */
function reviewTimingText(word, now) {
  if (isMaintained(word)) {
    // `maintained` 标志与 `dueAt === null` 是同一件事的两种写法（`units/scheduler.mjs` 明文）。
    return '不再催复习';
  }
  const dueAt = word?.dueAt;
  if (!Number.isFinite(dueAt)) return '缺下次复习时间';
  const rel = daysRelationText(dueAt, now);
  return dueAt <= now ? `到期 ${rel}` : `下次复习：${rel}`;
}

/**
 * id 的**码位序**比较（同刻兜底用）。
 * 与 `units/scheduler.mjs` 里那个同名函数同一个理由：不用 `localeCompare`
 * ——那取决于 ICU 与运行环境语言，会让"同样一份词表"在不同机器上排出不同顺序。
 */
function compareIds(x, y) {
  const a = String(x);
  const b = String(y);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 把应用挂到一个容器元素上（浏览器路径）。
 *
 * @param {HTMLElement} root 容器（`web/index.html` 里的 `#app`）
 * @param {object} [deps] 注入点（测试与 Task 8/9 用；全部有默认值，浏览器里不传即可）
 *   - `doc` DOM 工厂，默认 `globalThis.document`
 *   - `urlApi` 默认 `globalThis.URL`（冻结画面用 `createObjectURL`）
 *   - `camera` / `album` / `store` / `recordEvent` / `recognizeWithFallback` 覆盖懒加载的浏览器依赖。
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
    album: givenAlbum = null,
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
  // 12B：相册导入单元——产出与 grabFrame 同形状的帧，识物链路眼里与相机帧无法区分。
  const album = givenAlbum ?? await import('./units/album.mjs');
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
  let viewingPending = false;      // 正在看"待补反馈"那一屏（抽屉：任一屏都能开）
  let retryPendingId = null;       // 这一次提交是不是在补某一条待补条目（补交时的 pendingId）
  let retrying = null;             // `{ pendingId, busy }`：手动补交进行中的界面状态
  let retryTimer = null;           // 自动重试的定时器句柄（同一时刻只挂一个）

  // ── 阶段 A：应用骨架（应用栏 + 底部页签）──────────────────────────────────────
  //
  // `tab` 是**唯一**决定 `bodyEl` 里渲染哪一个视图的变量。四条口径（每条都有一条红线垫底）：
  //   1. **默认落在「首页」**（人裁决；接受为此改 mount 类测试——它们原先一挂载就找「拍照」，
  //      现在要先导航到「学习」页）；
  //   2. **只渲染当前视图**：切页签时非活动视图由 `bodyEl.replaceChildren` **从 DOM 卸载**，
  //      **不许**用 `display:none` 藏——藏着会让 `btn(root,'拍照')` 在首页也找得到，
  //      测试会以最令人困惑的方式变红，而且屏幕阅读器会把四份内容都念出来；
  //   3. 页签与状态机**正交**：切页签只换视图，不动 `machine`（学到第几步就停在第几步）。
  //      **唯一例外是 `capturing` 这一格**（下面的 ⚠️）；
  //   4. 「设置」既是**页签**也是**抽屉**：入口按钮在任何一屏都能开它（12A 的底线：
  //      Key 可能在任何一屏失效），点了就切到这个页签；`tabBeforeSettings` 记住来处，
  //      好让那两屏的「返回」回到用户原来待着的那一页。
  //
  // ⚠️ `capturing` 是"这一屏**在显示**才成立"的一格，因此它随屏走（人裁决，2026-09-17）：
  // 取景屏一旦不再显示（切走页签、或待补抽屉把它顶掉），这一次取词就**结束**——
  // 关掉摄像头流，并由 `abandonCapture()` 把状态送回 `ready`。三条理由：
  //   · 硬件跟着屏走：灯一直亮着既费电又吓人，而人已经不在取景那一屏了；
  //   · 回到学习页必须是**可操作**的一屏：留在 `capturing` 会让用户面对一块死画面
  //     （`videoEl` 还在、流已经关了），全屏只有「快门」与「再拍一张」；
  //   · 所以取词屏自己也得有出路：「返回」= 用户主动放弃这次取词（`cancelCapture`，
  //     **不落任何事件**，见 `abandonCapture` 的说明）。
  // 上一轮的口径（"切走页签不关流"，理由是当时 `capturing` 没有回 `ready` 的用户入口）
  // 就此作废——出路补上之后，"留在 capturing"不再是唯一不让用户走进死路的办法。
  // 代价如实登记：切走页签会**丢掉**这一次取景（回来后要重新点「拍照」），
  // 而不是"回来时画面原样还在"。
  let tab = 'home';
  let tabBeforeSettings = 'home';

  /** 四枚页签。**顺序就是界面上的顺序**，`label` 是用户可见的页签名（文案改动会弄红测试）。 */
  const TABS = Object.freeze([
    { id: 'home', label: '首页' },
    { id: 'learn', label: '学习' },
    { id: 'review', label: '复习' },
    { id: 'settings', label: '设置' },
  ]);

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
  // `site` = "这里渲染的是页签自己那一屏"（首页 / 学习 / 复习 / 设置四个视图函数的产物都进它，
  // 待补抽屉也进它）。它存在的理由是**样式侧的一条作用域**：`.word-list` 是一列词，
  // 在首页/复习页上它该是"一行一个词、带进度"，而这条外观不该外溢到别处去
  // （`.chip` 那套流式小药丸在别的地方仍然是对的）。不给 bodyEl 加类名的话，
  // 样式侧只能靠 `#app > div > .word-list` 这种位次判据，而本仓在位次判据上踩过四次
  // （见 `button.primary` 那一大段注释、`tests/styles.test.mjs` 明文禁止回流）。
  bodyEl.className = 'site';
  // 应用栏与底部页签是**壳**：它们不属于任何一个视图，所以放在 `bodyEl` **之外**
  // ——`bodyEl.replaceChildren(...)` 换视图时不会连它们一起换掉（页签上的高亮由 `renderNav` 现算）。
  const appBarEl = doc.createElement('header');
  appBarEl.className = 'appbar';
  const navEl = doc.createElement('nav');
  navEl.className = 'tabbar';
  navEl.setAttribute('aria-label', '主导航');
  root.replaceChildren(appBarEl, statusEl, errorEl, bodyEl, navEl);

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
  let albumBusy = false;       // 正在处理一次相册选图（挡住连选：一次选图还没走完，忽略下一次）
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

  // ── 壳：应用栏 + 底部页签 + 只渲染当前视图 ────────────────────────────────────

  /**
   * 应用栏（顶部）：品牌 + 一行状态。**壳的一部分**，每一屏都在。
   *
   * 状态行取"今天到期几个词"：这是全应用最该被一眼看见的一个数，而且**只有一处起源**
   * （`dueList()` = `store.readWords()` + `units/scheduler.mjs` 的 `dueWords`）。
   * 没有到期词时如实说「今天没有到期的词」，**不写"0 个词"**——0 在那个位置不是"极好"，
   * 而是一句"今天没有待办"，两者在中文里不是同一句话（红线 4：没给的数不发明）。
   */
  function renderAppBar() {
    const due = dueList();
    const brand = doc.createElement('span');
    brand.className = 'brand';
    brand.textContent = '场景取词';
    const state = doc.createElement('span');
    state.className = 'appstatus';
    state.textContent = due.length > 0 ? `今天该复习 ${due.length} 个词` : '今天没有到期的词';
    appBarEl.replaceChildren(brand, state);
  }

  /**
   * 底部页签（四枚）。三条口径：
   *   · 点击**只切 `tab`**（`goTab`），不动状态机、不动任何学习现场；
   *   · 当前页签用 `aria-current="page"` 标出来：它既是给屏幕阅读器的，也是样式侧**唯一**
   *     的高亮判据——不靠 `:nth-child` 之类的位次判据（本仓在这一类判据上踩过四次，
   *     `tests/styles.test.mjs` 明文禁止回流）；
   *   · 触控目标 ≥44px 由基础 `button` 规则保证，`.tabbar > button` 里再显式重申一次
   *     （页签是这一屏最常点的东西，不能靠继承来的保证）。
   */
  function renderNav() {
    navEl.replaceChildren(...TABS.map((t) => {
      const b = doc.createElement('button');
      b.textContent = t.label;
      if (t.id === tab) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => goTab(t.id));
      return b;
    }));
  }

  /**
   * 切页签（**唯一**的页签入口：底部四枚按钮与首页的「开始学习」都走这里）。
   * 它基本不做别的：不动状态机、不清任何现场——**唯独离开取景那一格是例外**
   * （`abandonCapture`：取景屏不再显示 = 这次取词结束，见 `tab` 声明处的 ⚠️）。
   */
  function goTab(id) {
    if (id === tab) return;
    if (id === 'settings') tabBeforeSettings = tab;
    const leavingLearn = tab === 'learn' && id !== 'learn';
    tab = id;
    // 待补抽屉被页签顶掉：页签是更强的导航意图（抽屉是"浮在某一屏上"的东西，
    // 页签是"换一屏"，两者同时成立会让用户看不出自己在哪儿）。
    viewingPending = false;
    // 离开学习页时若正在取词，这一次取词就此结束（关流 + 回 ready）。
    // 它自己会触发一次渲染（`send` → `onEnter` → `render`），下面那次是幂等的兜底。
    if (leavingLearn) abandonCapture();
    render(machine.state);
  }

  /**
   * 放弃这一次取词：回 `ready` 并（经由 `render`）关掉摄像头流。**不落任何事件。**
   *
   * 红线（任务书）：这条路不是拒帧、不是识别失败，只是"我不想拍了"——事件流里
   * 一条都不许增。所以这里**只**发 `cancelCapture`（表里那条什么都不记的转移），
   * 绝不借 `frameBad` 收尾：那会给 `frameRejections` 加一、往 `lastRejectReason` 写一个
   * 用户根本没遇到的失败理由，还会落一条 `frame_rejected`。
   *
   * 手选现场（`awaitingManualPick`）**必须在这里清掉**：它属于"这一次取词"。
   * 不清的话，用户放弃后重点「拍照」会直接看到上一次的手选词包——一屏他并没有请求的东西。
   *
   * @returns {boolean} 真的放弃了一次取词（当前不在 `capturing` 时返回 `false`，什么都不做）
   */
  function abandonCapture() {
    if (machine.state !== 'capturing') return false;
    awaitingManualPick = false;
    return machine.send('cancelCapture');
  }

  /**
   * 取景这一屏**是不是当前这一屏**（判据是**位置**，不含状态机）：落在学习页、
   * 且没有被待补抽屉盖住。
   *
   * 两处共用同一个判据，为的是不让"什么算取景屏在显示"有两个定义（那正是本仓反复
   * 踩过的"两处机制产出同一结果"）：`render()` 用它决定关不关流，`onCapture()` 用它
   * 决定相机开好之后要不要进 `capturing`。状态那一半由调用方自己拼——`render` 手上是
   * 将要渲染的 `state`，`onCapture` 手上是"即将进入 capturing"这件事本身。
   */
  function captureScreenVisible() {
    return tab === 'learn' && !viewingPending;
  }

  // ── 页面装配 ────────────────────────────────────────────────────────────────
  function render(state) {
    // 摄像头只在**取景这一屏真的在显示**时才有理由开着（判据是这一屏，不是状态机）。
    // 正常路径由 `abandonCapture()` 先把状态送回 ready 再渲染，这条是**防御性**的兜底：
    // 相机是异步开出来的（`onCapture` 里有 await），万一"开流"与"切屏"交错，这里仍能收口
    // ——留一路没人看的流就是灯一直亮着、电一直耗着。
    if (!(state === 'capturing' && captureScreenVisible())) stopStream();
    statusEl.textContent = `状态：${state}`;
    renderAppBar();
    renderNav();
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
    // 存好了就回到**来处**（与「返回」同一条路）：留在设置屏会让用户以为还没存上。
    goTab(tabBeforeSettings);
  }

  /** 清除已存的 Key（幂等）：留在设置屏，让"未配置"的状态当场可见。 */
  function onClearKey() {
    keyring.clearKey();
    setError('');
    render(machine.state);
  }

  /**
   * 一屏的**元素工厂**：`view` / `row` / `title` / `hint` / `action` 都绑在这一屏上。
   *
   * 为什么抽成工厂（阶段 A 的"壳 + 视图"拆分）：拆分前这五样是 `viewFor` 的局部变量，
   * 于是"渲染一屏"与"渲染哪一屏"是同一段代码；拆开后每个视图各拿一份，**谁也不共享 `row`**
   * （共享的话两个视图会往同一行动作里塞按钮，而按钮的颗数是动作行布局与断言口径的依据）。
   */
  function screen() {
    const view = [];
    const row = doc.createElement('div');
    row.className = 'row';
    // `cls` 是**可选**的语义类名：目前只有 `word` 屏那句"要学的那个词"用它（`word-title`）。
    // 加它的理由与按钮的 `primary` 同源：纯按 DOM 形状认"哪个 h2 是要学的词"不可能
    // （`word` 与 `composing` 的 h2 祖先链完全一样），所以让生产者显式声明。
    // 不留类名时 `className` 保持空串，既有 DOM 契约（h2 无类名）逐字不变。
    const title = (t, cls = '') => {
      const n = doc.createElement('h2');
      if (cls !== '') n.className = cls;
      n.textContent = t;
      return n;
    };
    const hint = (t) => { const n = doc.createElement('p'); n.className = 'muted'; n.textContent = t; return n; };
    // `primary` 是**显式声明**"这一屏的主操作"，不是按位置猜的。
    //   为什么必须显式：`settings` 与 `pending` 的动作行 DOM 形状**完全一样**
    //   （同为 `#app > div > div.row`），`button:nth-child(2)`（行里夹着隐藏 input）、
    //   `only-of-type`（设置屏那行有 3 个子节点）、`.muted 祖先`（实为普通 div）三种
    //   位置判据**全部实测失败**。所以"谁是主操作"只能由生产者说了算，样式侧只认 `.primary`。
    //   怎么用：**一屏至多一颗**——`pending`（手动补交 / 返回）与 `feedback`
    //   （再写一次 / 下一个词）是对等选项，都不传 `primary`（点亮其一 = 凭空造出并不存在的优先级）。
    //   只加类名，**不改文案、不改点击逻辑、不改 DOM 结构**（按钮仍是同一个 `row` 的第 N 个子节点）。
    const action = (label, onClick, disabled = false, primary = false) => {
      const b = doc.createElement('button');
      if (primary) b.className = 'primary';
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', onClick);
      row.append(b);
      return b;
    };
    return { view, row, title, hint, action };
  }

  /**
   * 一条词的列表行（`<span>` + 词名 span + "档位 · 时间" span + 到期时的 `该复习` 徽标）。
   *
   * 为什么是一整行而不是一颗只写词名的小药丸（阶段 B 之前的样子）：那一版报不出进度——
   * 用户看得见"学过 mug"，看不见"mug 排在第几档、下次什么时候该复习"，而后者才是他回来
   * 打开这一页想知道的事。
   *
   * 词名走 `span.word-name` 而不是裸文本：`.word-chip` 的字族（衬线）属于**英文词**，
   * 而这一行里还夹着中文（"第 1 档"），中文必须是界面无衬线（`styles.css` 文件头的排版口径）。
   * 同一个类名两屏复用：`homeView` 的已学词列与 `reviewView` 的到期清单。
   *
   * ⚠️ 它是 `mount()` 的**内部**函数（`stageLabelOf` / `reviewTimingText` 那两个读数助手
   * 才是模块级的）：它要用 `doc` ——那是 `mount(root, deps)` 的注入点，模块级没有它。
   * 挪出去的症状是 `ReferenceError: doc is not defined`，而且**只在"这一屏真的有词"时才炸**
   * （空词表走的是空状态那一支，碰不到这里），是一条很隐蔽的路径——本轮实测踩过一次。
   *
   * @param {object} word 词记录
   * @param {string} metaText 进度那一段的文字（由调用方拼，两个视图各有自己的说法）
   * @param {string[]} states `'due'`（已到期）/ `'gap'`（`dueAt` 坏掉那种夹缝记录）
   */
  function wordChip(word, metaText, states) {
    const chip = doc.createElement('span');
    chip.className = states.includes('due') ? 'word-chip word-due' : 'word-chip';
    const name = doc.createElement('span');
    name.className = 'word-name';
    // 词名取 `word`（本应用写记录时用的键），退回 `label`（诊断/导出里的老键）再退回 id。
    name.textContent = String(word?.word ?? word?.label ?? word?.id ?? '');
    const meta = doc.createElement('span');
    // ⚠️ `word-meta-due` 这一条与 `hint()` 的 `.muted` 同权重（一个类 = 0,1,0），
    // 靠 `styles.css` 里的书写顺序分胜负——类名拼在 `.word-meta` 之后是有意的，
    // 别改成"先判 due 再拼 meta"。
    meta.className = 'word-meta';
    if (states.includes('due')) meta.className += ' word-meta-due';
    if (states.includes('gap')) meta.className += ' word-meta-gap';
    meta.textContent = metaText;
    chip.append(name, meta);
    // 到期徽标：一个词**此刻**要不要复习，是这一屏最该被一眼看见的区别。
    // 它只标"该复习了"这件事，**不报数**——个数在卡片那一行总数里（同一屏两个同一来源的
    // 数迟早会不一致，而这一屏的每个数都只有一处起源）。
    if (states.includes('due')) {
      const badge = doc.createElement('span');
      badge.className = 'due-badge';
      badge.textContent = '该复习';
      chip.append(badge);
    }
    return chip;
  }

  // ── 视图：每个页签一个函数，壳只调其中一个 ────────────────────────────────────

  /**
   * 「设置 · API Key」那一屏（12A）。
   *
   * 与待补反馈同一个抽屉模式：任一屏都能打开（ready/word 屏必须可达是底线，入口按钮
   * 每屏都挂着）。**不回显明文**：已配置只说"已配置"，输入框永远从空白开始。
   * 阶段 A 起它同时是**底部第三枚页签**指向的那一屏：`tabBeforeSettings` 记住来处，
   * 「返回」与保存成功都回到那一页（文案仍是 `返回（<状态机状态>）`——它是既有文案，不改）。
   */
  function settingsView() {
    const s = screen();
    s.view.push(s.title('设置 · API Key'));
    s.view.push(s.hint(hasKey()
      ? '已配置：Key 已保存在这台手机的浏览器里（出于安全，这里不显示它的内容）。'
      : '未配置：还没有保存任何 Key。'));
    s.view.push(s.hint(SETTINGS_HINT));
    const keyInput = doc.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = '粘贴以 sk- 开头的 API Key';
    keyInput.value = '';                      // 永远从空白开始：配置状态靠上面那句话，不靠回显
    s.view.push(keyInput);
    s.action('保存', () => onSaveSettings(keyInput), false, true);
    s.action('清除 Key', onClearKey);
    s.action(`返回（${machine?.state ?? ''}）`, () => goTab(tabBeforeSettings));
    s.view.push(s.row);
    return s.view;
  }

  /**
   * 「待补反馈」抽屉（Task 9B §5.1）——不是页签，是**浮在当前页之上的一个抽屉**。
   */
  function pendingView() {
      // ── 待补反馈那一屏（Task 9B §5.1）────────────────────────────────────────────
      //
      // **它先于页签**：待补界面是"任一屏都能打开的一个抽屉"，不是某个页签或状态的分支。
      // （首版把它嵌在 `case 'ready'` 里，于是从反馈屏点入口时什么都不会发生——
      //  入口按钮每屏都挂着，界面却只在首页认它。`tests/pending-mount.test.mjs` 抓到了这一处。）
      // 阶段 A：底部页签**在抽屉打开时仍然渲染**（它是壳），点任一页签都会把抽屉关掉
      // （见 `goTab`）——否则用户会看到"页签亮着，内容却是另一屏"。
      const s = screen();
      const { view, row, title, hint, action } = s;
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

  /**
   * 「首页」（阶段 A 的默认页；**阶段 B 起它是真进度面**）。
   *
   * 这一屏回答三个问题，顺序就是用户关心的顺序：**今天有活儿吗 → 从哪儿开始 → 我学到了哪**。
   *
   * 六条口径（阶段 B 新增的后三条是这一轮的核心读数）：
   *   · **到期词数只有一处起源**：`dueList()`（`store.readWords()` + `units/scheduler.mjs`
   *     的 `dueWords`）。**没有到期词就不显示那一行**——不写"今天该复习 0 个词"：
   *     0 在那个位置不是一条信息，而是一句噪音（红线 4：没给的数不发明）。
   *   · 已学词数同样来自 `store.readWords()`；词表为空时给**像样的空状态**
   *     （说清"下一步做什么"），不是一片空白。阶段 B 把空状态分了两档：**没配 Key**
   *     的人下一步是去设置（不是去拍照——那一步会被拦下，空状态里给一个会被拦下的指引
   *     等于让他白跑一趟），配了 Key 的人下一步才是拍照。
   *   · **每个词都带进度**：词名 + 「第 N 档 / 已维护」+ 下次什么时候复习。读数全部来自
   *     `store.readWords()` 的记录本身（档位读 `stage`、时间读 `dueAt`，口径与那两条读数的
   *     完整理由见 `stageLabelOf` 的注释）；**到期的那几个词单独标出来**（`该复习` 徽标），
   *     于是"今天该复习哪几个"不用用户自己去比对日期。
   *   · **到期那一段自带出口**（「去学习」= 复用同一条识物链路的那一条路），但它**不是**
   *     这一屏唯一的出口：大字入口「开始学习」永远在，且在有到期词时是同一件事
   *     （`goTab('learn')`，两者点下去落在同一屏）。
   *   · **词记录一条都不隐藏**：列表铺的是 `store.readWords()` 的全集（包括 `dueAt` 坏掉、
   *     被 `dueWords` 静默略过的那种夹缝记录，它照样显示，只是如实说"缺下次复习时间"）。
   *     只铺到期的词会让用户永远看不见自己学过的词里有一条坏了。
   *   · 「开始学习」是这一屏的**大字入口**，但它**不是** `.primary`：重音只给"学习流程里
   *     那一颗推进按钮"是 `DEC-OPI-968b804d-…db.6` 的人裁决（六屏表由
   *     `tests/styles.test.mjs` 逐文案钉住、并断言"全站被标成主操作的调用点恰好那六颗"）。
   *     首页入口靠**尺寸**（56px / 1.125rem）与位置区分。要把它改成实心重音，需要一条新裁决
   *     + 把那六屏表扩成七屏——那是裁决不是实现细节，本阶段不擅自改。同理，阶段 B 新增的
   *     那两条出口（「去学习」）也**不带** `.primary`。
   *   · 到期那一行与**应用栏的状态行**同时出现是有意的：应用栏是"全局一行状态"（每个页签都在），
   *     首页这一条是**可行动的那一条**（带上"上次在哪儿学的、要换个地方重拍"）。
   */
  function homeView() {
    const s = screen();
    s.view.push(s.title('拍一下，学一个词'));
    s.view.push(s.hint('对准身边的一件东西拍一张，认出一个词，再用它写一句你自己的话——'
      + '这是这个应用的完整闭环。'));
    const now = clock();
    const due = dueList();
    const dueIds = new Set(due.map((w) => w.id));
    if (due.length > 0) {
      // 到期那一段整体装进 `.due`（左侧重音条 + 浅青底，本文件里"需要你处理的一件事"
      // 的既有写法）：一行总数 + 一句场景提示 + 一条出口。**总数与下面每个词的徽标同一个起源**
      // （`dueList()` / `dueIds`），所以它们不可能互相矛盾。
      const dueCard = doc.createElement('div');
      dueCard.className = 'due';
      const dueLine = doc.createElement('p');
      dueLine.textContent = `今天该复习 ${due.length} 个词`;
      dueCard.append(dueLine);
      // 场景提示是**建议**不是判定（系统不知道用户此刻站在哪儿），与 `ready` 屏同一口径。
      dueCard.append(s.hint(`最先到期的是「${due[0].lastScene ?? '未知'}」场景学的那个词——`
        + `复习走的是同一条识物链路：换个地方重新拍一张（例如 ${RECURRENCE_SCENE_EXAMPLES}）。`));
      const dueRow = doc.createElement('div');
      dueRow.className = 'row';
      const goBtn = doc.createElement('button');
      // 文案与复习页那条出口**逐字相同**（「去学习」）：两处指的是同一件事
      // （复现 = 去学习页重新拍一张、取到那个词），不同的文案会让用户以为是两条路。
      goBtn.textContent = '去学习';
      goBtn.addEventListener('click', () => goTab('learn'));
      dueRow.append(goBtn);
      dueCard.append(dueRow);
      s.view.push(dueCard);
      // 场景提示原本是独立的一行 `hint`，现在进了卡片：它描述的是卡片里那个总数，
      // 分开摆会让"这句话在说哪一件事"变得含糊。
    }
    const startBtn = s.action('开始学习', () => goTab('learn'));
    startBtn.className = 'start';     // 大字入口：靠尺寸区分（不是 `.primary`，理由见函数头）
    s.view.push(s.row);

    // ── 已学词概览（词数 + 一列**带进度**的词）──────────────────────────────────
    const words = Object.values(store.readWords()).sort((a, b) => (
      ((b?.createdAt ?? 0) - (a?.createdAt ?? 0)) || compareIds(a?.id, b?.id)
    ));
    const total = words.length;
    const head = doc.createElement('p');
    head.className = 'stat';
    head.textContent = total === 0 ? '还没有学过的词' : `已学 ${total} 个词`;
    s.view.push(head);
    if (total === 0) {
      // 空状态：告诉用户下一步做什么，而不是留白（"没有内容"与"没有设计"是两件事）。
      // 阶段 B 把它分成两档，因为**下一步是两件不同的事**：没配 Key 的人点「开始学习」
      // 是走不通的（`onCapture` 会把他拦下并指回设置），照旧让他"点上面的「开始学习」"
      // 就是让他白跑一趟；而空状态的全部职责恰恰是"告诉他下一步做什么"。
      // 这一档的用户是**首次访问者**（词表空 + 没 Key），所以他还没读过 ready 屏的引导，
      // 这里必须自带"为什么 / 去哪拿 / 存哪"三件事（口径与 `NO_KEY_GUIDANCE` 同源，只是更短）。
      const empty = doc.createElement('p');
      empty.className = 'empty';
      empty.textContent = hasKey()
        ? '学过的词会在这里排成一列，每个词都标出排到第几档、下次什么时候该复习。'
          + '点上面的「开始学习」，拍下身边的一件东西，第一个词就会出现。'
        : '还没有配置 API Key，所以现在点「开始学习」会被拦下——识物和造句都要用你自己的 Key'
          + '（在 platform.deepseek.com 创建一串以 sk- 开头的密钥，只保存在这台手机的浏览器里）。'
          + '先点下面的「设置（API Key）」粘贴保存，配好之后回来拍下身边的一件东西，'
          + '第一个词就会出现在这里。';
      s.view.push(empty);
    } else {
      const shown = words.slice(0, LEARNED_PREVIEW_MAX);
      const list = doc.createElement('div');
      list.className = 'word-list';
      for (const w of shown) {
        const isDue = dueIds.has(w?.id);
        // 到期／夹缝记录各有自己的形态（颜色 + 徽标），未到期的就是一行安静的进度。
        const states = [
          ...(isDue ? ['due'] : []),
          ...(!isDue && !isMaintained(w) && !Number.isFinite(w?.dueAt) ? ['gap'] : []),
        ];
        list.append(wordChip(w, `${stageLabelOf(w)} · ${reviewTimingText(w, now)}`, states));
      }
      s.view.push(list);
      if (total > shown.length) {
        s.view.push(s.hint(`另有 ${total - shown.length} 个词，学过的词都会留在记录里。`));
      }
    }
    return appendTail(s);
  }

  /**
   * 「复习」页（阶段 A：最小可用；**阶段 B 起是「清单 + 出口」**）。
   *
   * 页的语义**已由用户明确裁决**：复现就是**去学习页重新拍一张、取到那个词**——本页
   * 只做清单与出口，**不**做"点某个词直接进 word 屏"（那要动被冻结的状态机转移表）。
   * 所以这一屏的每个词都是一行**读数**（不是按钮）。
   *
   * 三条口径：
   *   · 数据只有两个来源，**一个新数都不造**——`dueList()`（到期词，已按到期时间从早到晚
   *     排好序）与 `openPending()`（还没补上的待补反馈条数，来自事件流派生的队列，
   *     `units/pending.mjs`）；
   *   · 清单每行给三样：**词名**、**排到第几档**、**到期多久了**（以及上次是在哪个场景学的）。
   *     到期多久是这页唯一"现在几点"相关的读数，它读的同样是记录里的 `dueAt`；
   *   · 出口三条，**每条都在没有到期词时也成立**：进**既有**待补抽屉（真有欠账时）、
   *     去学习页（复现走的是同一条识物链路）、以及底部的设置/诊断入口（`appendTail`）。
   *     **没有到期词时不是死路**：照旧给「去学习」，并在空状态里说清"现在不欠复习、
   *     想多学一个词就走这条路"。
   */
  function reviewView() {
    const s = screen();
    s.view.push(s.title('复习'));
    const now = clock();
    const due = dueList();
    s.view.push(s.hint(due.length > 0
      ? `今天该复习 ${due.length} 个词。换个地方重新拍一张、取到那个词，就算一次复现。`
      : '今天没有到期的词。学完一个词之后，它会在 1 天 / 3 天 / 7 天后各催你一次。'));
    if (due.length > 0) {
      const list = doc.createElement('div');
      list.className = 'word-list';
      for (const w of due) {
        // 这一行报的是"上次在哪儿学的 + 该复习多久了"：前者让用户知道要换个地方，
        // 后者让他知道这笔欠账有多旧（`dueAt` 已经过去多久，读的还是权威那个字段）。
        list.append(wordChip(
          w,
          `${stageLabelOf(w)} · 上次「${w.lastScene ?? '未知'}」场景 · ${reviewTimingText(w, now)}`,
          ['due'],
        ));
      }
      s.view.push(list);
    } else {
      // 空状态：**不是死路**。说清"现在确实不欠复习"，并把唯一那条出路指出来。
      const empty = doc.createElement('p');
      empty.className = 'empty';
      empty.textContent = '现在没有到期的词，所以这一页是空的——这是正常的。'
        + '想多学一个词就点下面的「去学习」拍一张；学完的词会自动排上 1 天 / 3 天 / 7 天，'
        + '到点了就会回到这一页。';
      s.view.push(empty);
    }
    const open = openPending().length;
    s.view.push(s.hint(open > 0
      ? `待补反馈 ${open} 条：那几句当时没拿到判定，原句一直留着，一条都不会丢。`
      : '待补反馈 0 条：没有欠着的判定。'));
    if (open > 0) s.action('去补交这几句', () => { abandonCapture(); viewingPending = true; render(machine.state); });
    // 「去学习」**永远在**（有到期词时它是复现的出口，没到期词时它是"再学一个"的出口）。
    s.action('去学习', () => goTab('learn'));
    s.view.push(s.row);
    return appendTail(s);
  }

  /**
   * 壳：**只渲染当前视图**。四个页签各一个视图函数，待补抽屉浮在页签之上。
   *
   * ⚠️ 这个分派是"非活动视图必须卸载"的**唯一落点**：`render()` 每次都
   * `bodyEl.replaceChildren(...viewFor(state))`，没被选中的视图连元素都不会被创建
   * ——所以首页那一屏里搜不到「拍照」（有浏览器实测为证，见阶段 A 报告）。
   */
  function viewFor(state) {
    if (viewingPending) return pendingView();
    if (tab === 'settings') return settingsView();
    if (tab === 'review') return reviewView();
    if (tab === 'home') return homeView();
    return learnView(state);
  }

  /**
   * 「学习」页：既有那条线性流程（`ready → capturing → word → reading → composing → feedback
   * → done`）**原样**搬进来——这一段是阶段 A 唯一的"搬家"，行为一字不改（连注释一起搬）。
   *
   * `ready` 取词屏就是这一页的一个视图：它是页签的**内容**，不再是"应用的第一屏"。
   */
  function learnView(state) {
    const s = screen();
    const { view, row, title, hint, action } = s;

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
        action('拍照', onCapture, storageFull(), true);
        // 12B：相册导入入口——与「拍照」并列的第二条输入源。背后是一个
        // `input[type=file][accept=image/*]`（移动浏览器上它会拉起相册/拍照选择器），
        // 选中后走**同一条**帧质检 → 识物链路（onAlbumPicked）。按钮负责把入口说人话。
        const albumInput = doc.createElement('input');
        albumInput.type = 'file';
        albumInput.accept = 'image/*';
        albumInput.addEventListener('change', () => onAlbumPicked(albumInput));
        const albumButton = doc.createElement('button');
        albumButton.textContent = '从相册选图';
        albumButton.disabled = storageFull();
        albumButton.addEventListener('click', () => {
          if (typeof albumInput.click === 'function') albumInput.click();
        });
        row.append(albumInput, albumButton);
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
          // 第三条出口（2026-09-17 人裁决）：**不想拍了**。「再拍一张」与候选词都要求
          // "继续这次取词"，没有它，这一屏对"我就想退出去"的用户是一条死路——
          // `capturing` 之前没有任何回 ready 的用户入口（`frameBad` 要真拍一张且会落拒帧事件）。
          // 文案「返回」与待补抽屉、设置屏既有的一致；**不落任何事件**（见 abandonCapture）。
          action('返回', abandonCapture);
          break;
        }
        view.push(title('对准物体，按「快门」'));
        if (videoEl !== null) view.push(videoEl);
        view.push(hint('这一帧先在端侧做质检（太暗 / 太糊当场退回），再送去识物。'));
        action('快门', onShutter, false, true);
        // 同上：取词屏的退出路径（不落事件）。它**不是**主操作——「快门」才是这一屏要走的路。
        action('返回', abandonCapture);
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
        // 这一屏的标题**就是**"要学的那个词"，所以它是全屏的视觉主角：
        // 走 `word-title` 语义类名，样式侧用衬线 + 大一号字号（口径见 styles.css 文件头）。
        view.push(title(shownWord?.word ?? '', 'word-title'));
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
        action('我会读了（开始跟读）', onWordReady, false, true);
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
          action('我读过了（自评打勾）', () => machine.send('readDone'), false, true);
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
        action('提交造句', onSubmit, false, true);
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
    return appendTail(s);
  }

  /**
   * 「壳尾」：待补入口 + 诊断页链接 + 设置入口。**三样都每屏都挂着**（理由见下面各处原文）。
   *
   * 它跟着**页签视图**走（首页 / 学习 / 复习），不跟着设置屏与待补抽屉走——那两屏各自有
   * 「返回」，在里面再挂一个"打开自己"的入口只会绕圈（与阶段 A 拆分前的行为**逐字一致**）。
   */
  function appendTail(s) {
    const { view } = s;
    // 「待补反馈」入口（§5.1 明文要求的那一屏）：与下面那个诊断页链接一样**每屏都挂着**。
    // 为什么不能只挂在首页：自动重试失败可能发生在任意一屏（用户正在造句、正在看反馈），
    // 只在首页给入口的话，用户当场没有任何地方能知道"刚才那次补交又没成"。
    // **只在真有待补/有归档时出现**：一个永远挂着"待补反馈（0 条）"的按钮只会让人以为出了事。
    const openCount = openPending().length;
    const archivedTotal = pendingList().length;
    if (!viewingPending && (openCount > 0 || archivedTotal > 0)) {
      const pendingBtn = doc.createElement('button');
      pendingBtn.textContent = `${PENDING_ENTRY_LABEL}（${openCount} 条）`;
      pendingBtn.addEventListener('click', () => {
        // 抽屉会把**当前这一屏**顶掉（`viewFor` 先看 `viewingPending`）：若此刻在取词，
        // 这一次取词就此结束——否则相机在整个待补界面期间都开着，从抽屉返回时还会
        // 撞上一块死画面。它自己会触发一次渲染，下面那次是幂等的兜底。
        abandonCapture();
        viewingPending = true;
        render(machine.state);
      });
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
    // 阶段 A 起它同时会切到「设置」页签（`goTab`）；返回时回到点它时所在的那一页。
    const settingsBtn = doc.createElement('button');
    settingsBtn.textContent = '设置（API Key）';
    settingsBtn.addEventListener('click', () => goTab('settings'));
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
    // 这里只清 `lastPick` / `shownWord`——**手选态 `awaitingManualPick` 不在这一处清**：
    // 进 `capturing` 的两条路各自已经把它清过了（快门在 `onShutter` 开头清、相册在
    // `onAlbumPicked` 里清），而回 `ready` 的两条转移（`frameBad` 与 `cancelCapture`）
    // 也各有清它的地方（前者必经 `onShutter`，后者在 `abandonCapture` 里）——
    // 也就是说，进到这一行时它**必然已经是 false**（能再点「拍照」= 手选现场刚被清过）。
    // 复审 Minor 4 记的就是这一点：原先这句注释写着"手选态也作废"，而代码并没有在这里清它；
    // 选的是**把注释改成实情**（而不是加一行清 `awaitingManualPick`）——那样加出来的行
    // 会与上面那几处重复（同一件事多个出处，谁也不可单独验证）。
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
    // 相机是**异步**开出来的（上面那个 await），这中间用户可能已经切走了页签、或打开了
    // 待补抽屉——那样取景屏根本不会显示，这一路流就没人看得见。此时**不进 capturing**：
    //   · 关掉刚开的那路流——不关就是泄漏（灯亮着、电耗着，而且再没有任何人会去 stop 它）；
    //   · 状态留在 `ready`，用户回到学习页看到的是**可取词**的那一屏，不是一块死画面。
    // 这一条与 `goTab` 里的 `abandonCapture()` 合起来保证：`capturing` 只在取景屏真的
    // 在显示时才成立（"人已经走开了，相机还在开"这条竞态就是这么堵上的）。
    if (!captureScreenVisible()) {
      stopStream();
      render(machine.state);
      return;
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
    await recognizeAndAdvance(grab);
  }

  /**
   * 「从相册选图」（Task 12B，转向 DEC-…26 第三项形态）：选中的图片走**同一条**
   * 帧质检 → 识物链路。与快门唯一的差别是"这一帧从哪来"——先在**本函数里**把文件解码成
   * 一帧（`units/album.mjs`，与 `grabFrame` 同形状的 `{ blob, stats }`），解码成功后
   * `send('capture')` 进 capturing，再把它交给 `recognizeAndAdvance`：质检与识物
   * 看见的东西与相机帧无法区分。事件口径不变：轮次与三类结论事件全部来自
   * `recognizeAndAdvance` 这一处起源（不新增事件类型，roundIndex 连续性照旧）。
   *
   * 为什么解码放在 `send('capture')` **之前**：状态机的 capturing 是"取词进行中"
   * （快门那一格），而"图打不开"是**用户情形**——解码失败时什么都没发生，
   * 状态机不许动、事件不许落，用户留在 ready 换一张再选。先推进再解码会让
   * 一次选图失败把用户搁在快门那一屏（那里没有"回去"的按钮）。
   */
  async function onAlbumPicked(input) {
    if (albumBusy) return;                    // 连选/双触发：上一次选图还在路上，忽略这一次
    setError('');
    // 与「拍照」同一条守卫：没有 Key 的识物是一个必然 401 的空转，图根本不该解码。
    // 不落事件、不动状态机：什么都没发生，就没有什么可记（"缺 Key"不是一次识物失败）。
    if (!hasKey()) {
      setError('先配置 API Key 再开始：点下面的「设置（API Key）」粘贴保存（platform.deepseek.com 可以创建）。');
      render(machine.state);
      return;
    }
    // 存储写满 → 停止派发新任务（§5.1）：与「拍照」同一条闸。
    if (storageFull()) {
      setError(STORAGE_FULL_SHORT);
      render(machine.state);
      return;
    }
    // 用户取消选择（没有文件）→ 什么都不发生。选完立刻清空 value：
    // 同一张图第二次选中时 change 才会再触发（浏览器的口径）。
    const file = input?.files?.[0] ?? null;
    try { input.value = ''; } catch { /* 个别替身上赋值失败就随它去，不影响主流程 */ }
    if (file === null) return;
    albumBusy = true;
    try {
      // 解码（含 RGBA→灰度→质检统计，全部在 album 单元里，与相机同一条管道）。
      const canvas = doc.createElement('canvas');
      const shot = await album.frameFromImageFile(file, canvas);
      // 解码成功 → 从这里起与快门同一条路：进 capturing（取词进行中），交共用尾巴。
      machine.send('capture');
      // 上一轮的结果清掉（与快门同一份清单）。
      lastPick = null;
      shownWord = null;
      awaitingManualPick = false;
      recurrenceNote = null;
      lastShotBlob = shot.blob;
      await recognizeAndAdvance(async () => shot);
    } catch (err) {
      // 解码的错：只把"这张图打不开"（IMAGE_NOT_READABLE）当成**用户情形**——
      // 状态机没动过、一条事件不落，错误区给一句能行动的话。
      if (err?.code === album.IMAGE_NOT_READABLE) {
        setError(`这张图片打不开，请换一张试试（${err?.message ?? err}）`);
        return;
      }
      // RangeError（参数/缓冲契约违约）= 编程错误：显示出来是为了不让用户面对"选了没反应"，
      // **同时原样重抛**，让它带着栈冒到控制台——绝不静默变成一次"这张照片不行"。
      if (err?.name === 'RangeError') {
        setError(`读图失败（这是程序缺陷，不是你的图片问题）：${err?.message ?? err}`);
      } else {
        setError(`读图失败：${err?.message ?? err}`);
      }
      throw err;
    } finally {
      albumBusy = false;
    }
  }

  /**
   * 取帧 → 端侧质检 → 最多两次识物请求 → 落事件/推进状态：**快门与相册选图共用的同一条尾巴**
   * （12B 抽取——两条输入源只有"这一帧从哪来"不同，此后的一切必须共用一处起源，
   * 否则事件口径迟早各自漂移）。
   *
   * 进本函数前调用方必须已把状态机送进 capturing（快门在 capturing 里天然成立；
   * 相册路径在解码成功后 `send('capture')`）。这里的取帧错误只剩**相机**的用户情形
   * （按快门太早）：相册的解码错误在 `onAlbumPicked` 里就地处置，到不了这里。
   */
  async function recognizeAndAdvance(grabFn) {
    let picked;
    try {
      // 取帧 → 端侧质检 → 最多两次识物请求，全在 `recognizeWithFallback` 里。
      // **本层不再自己判帧**（追加要求 1）：判帧只有一处起源，`frame_rejected` 与它的 reason
      // 都来自这个返回值，不存在"界面说太暗、记录说太糊"的可能。
      // 这里**不传 fetchImpl**：让 `recognize()` 用它自己的缺省（全局 `fetch`），
      // 于是"谁是网络出口"只有一个决定点，注入式测试也能接管它。
      // 12A：直连模型服务的 Key 在发请求那一刻从 keyring 读——设置里存好/清掉，下一拍就生效。
      picked = await runRecognize({
        grab: grabFn, frameQC, acceptableSets: ACCEPTABLE_SETS, exclude: [], apiKey: apiKeyNow(),
      });
    } catch (err) {
      // `grab()` 的错：只把"用户按快门太早"（VIDEO_NOT_READY）当成可预期的用户情形，
      // 不落事件、不改状态（没有产出结论就不是一轮）。
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

    // 走到这里说明这次取词动作（快门**或**相册选图，12B 起）**真的产出了一轮结论** → 开一轮。
    // 上面那个 `catch` 里的三种情形（按太早/图打不开、RangeError、其它取帧错误）都到不了这里：
    // 它们要么 return、要么原样重抛，一条事件都不落——所以事件流里的 roundIndex 是连续的
    // 1、2、3…，没有空洞（"做了但没产出结论"不是一轮，见 units/rounds.mjs 的定义）。
    const roundIndex = rounds.next();
    // 反馈事件（Task 8）沿用这一轮的编号：造句发生在取词的**同一轮**里，
    // 它不是一次新的快门——给反馈单开一个轮次号会让判据 B 的轮数虚增。
    lastRoundIndex = roundIndex;

    if (picked.mode === 'frame_rejected') {
      // 如实记录这一档（设计文档 §5.1）：先落事件再退状态，两件事都不许省。
      // 这一帧没送到模型，所以 attempts 是 0（见 units/recognize.mjs 的口径说明）。
      // 但它**同样是一次取词动作**（快门或选图），故同样带 roundIndex——端侧拦下的重拍也是重拍
      // （判据 B 的主要来源；相册选图被端侧拦下同样计入，两条输入源一个口径）。
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
