// web/dialogue.mjs
//
// 新形态的对话视图：一个单线程的滚动对话 + 一个输入框。
//
// **与旧形态的 `web/app.mjs` 并存，互不 import**（`DEC-…db.56` 把识物降级为
// "主动求助时的一条查询路径"，不删除）。等新形态跑通、用户确认之后，再决定谁做首页。
//
// 视图的职责边界（有意收窄）：它**只做渲染与收集输入**。所有的教学判断
// （挑焦点、选方法、定难度、组装提示词、校验输出）都在 `web/units/teach/**` 的纯模块里。
// 这样"教什么"可以在 Node 里被确定性地测，而"长什么样"才需要浏览器。
//
// 代价（如实记）：MVP 是**单线程对话**，没有历史会话列表、没有作品回看
// （设计稿 §8 的作品化是下一步，Task 12）。没有它，"拥有感"这一条还没兑现。
// 另一条：一次会话就是一次会话（`session.mjs` 的 `close` 没有回到 `intake` 的转移），
// 而本视图**从不发 `close`**——刷新页面即新开一次，历史不在盘上（同 §11 风险 3）。
//
// ===========================================================================
// 本轮对计划 Task 10 Step 3 的三处改动（每一处都在仓库外实测过，见
// `.superpowers/sdd/task-10-report.md`）
// ===========================================================================
// ① **`bandRules` 真的用上了**（计划第 1656 行的 Interfaces 把它列为 Consumes，
//    而计划第 1730–1816 行的实现里**没有 import 也没有用**——"接口文档里写了" ≠ "它在跑"；
//    同族先例是 Task 8 声明了不存在的 `read()` / `recordFocus()`）。
//    接法是：把当前档位的 `maxChars` 绑到输入框的 `maxLength` 上。
//    **这不动任何教学含义**：`maxChars` 按 `difficulty.mjs` 文件头是"拦住模型的长篇大论"
//    的尺子，这里用同一个权威值给输入框一个同源的软上限（不在这里再抄一份数字——
//    抄一份就是给同一件事造第二个出处）。⚠️ 它**约束不了**学习者：他多打的字会被浏览器
//    挡在输入框外，而这只是 UX；焦点命中与否与输入长度无关（`checkReply` 只看模型的回复）。
//
// ② **不再从 `candidates` 里找焦点**（计划第 1810 行写的是
//    `candidates.find(c => c.ref === focus.ref)?.meaning ?? ...`）。`pickFocus` 的返回值
//    **本来就是 `makeFocus` 造的对象**（`focus.mjs` 第 71 行：`kind` / `ref` / `meaning`
//    三样都带），所以那次 find 是**绕远路**，而且它有一条静默坏路：候选的
//    `meaning` 是 `undefined` 时，`?? '某个说法'` 会把一个**已知的释义**丢成占位符。
//    直接用 `focus.meaning` 与计划的意图（"围绕他的焦点造一个情境"）等价，且少一个失败面。
//    护栏：焦点释义本身为空串时退回"某个说法"（**空串不能被拼成 `围绕「」`**）。
//
// ③ **入口守卫**（计划没有）：`root` 不是容器 ⇒ 响亮抛 TypeError，与 `web/app.mjs` 的
//    `mount` 同口径。理由不是洁癖：`web/dialogue.html`（Task 11）里一个拼错的容器 id
//    会让 `root.replaceChildren` 抛 "Cannot read properties of null"——那句话指向
//    **DOM 内部**，而真因是"容器没找到"。同族代价 `profile.mjs` 的 storage 守卫已登记。
//
// ===========================================================================
// 照计划原样、但**必须如实登记的后果**（任务书第四节 2，两条都是实测核实过的）
// ===========================================================================
// (a) **状态机在本视图里零可观测效果**。每回合发的是 `content` → `focusPicked` →
//     `staged`，而 `session.mjs` 的 `stage` 拍只有 `produced` / `stuck` / `cancel`
//     三个出口——**没有 `content`**。所以**从第二回合起**这两次 `send` 都是**非法转移**
//     （`send` 对非法动作静默返回 false）。三处返回值全被丢弃、`onEnter` 是空函数
//     （计划第 1791 行）、没有任何地方读 `session.phase` ⇒ 它对本视图不产生任何可见后果。
//     **不为了"让它有用"而改写相位接线**：那会改变提示词内容 = 改变教学行为。
//     护栏钉住的是"第二回合的行为与第一回合同构"（不可观测 = 不可回退）。
// (b) **`phase: 'elicit'` 与会话实际相位不一致**：会话永远停在 `stage`（见 (a)），
//     而提示词里印的是 `elicit`。两者不一致，如实登记，不修——
//     "什么时候算逼产出"是教学判断，且 `validate.mjs` 的允许表按拍子整格不同
//     （`DEC-…db.92`），擅自改相位会连带改掉校验口径。
// (c) **`learnerState: 'untouched'` 是常量**（计划第 1813 行）：`focus.mjs` 的 `status`
//     恒为 `FOCUS_STATUS[0]`，而 `profile.mjs` **没有**记录焦点状态的接口
//     （计划声明过的 `recordFocus()` 不存在，见 `DEC-…db.96`）。⇒ 第六槽在整个 MVP 里
//     恒为 `'untouched'`。**没有为它发明一套"焦点状态怎么推进"的语义**：那是教学判断，
//     本轮没有真实数据支撑，强行补 = 凭空发明阈值。
// (d) **`exclude: []`（计划第 1802 行）⇒ `focus.mjs` 的"不复述同一个焦点"能力
//     零生产调用点**：每个回合拿到同一批候选 ⇒ 候选只有一个时同一个词被反复教。
//     ⚠️ **不要用"排除上一轮焦点"来随手修好它**：候选只有一个时排除后 `pickFocus`
//     返回 `null`，学习者会**每隔一回合**收到"这个我一时接不上"——那比重复更坏。
//     （`pickFocus` 的 exclude 是给"多个候选"准备的，而 MVP 的候选只有一个。）
// (e) **`scenes[0]`（计划第 1810 行）**：多场景时只用第一个，`fits` 与当前焦点**不参与**
//     匹配。⇒ 情境与焦点可能不搭。同样不修：那需要一个匹配算法，而不是一个 `[0]`。
//
// ===========================================================================
// 点击处理器**没有错误面**（任务书第四节 4）
// ===========================================================================
// `addEventListener('click', async () => {...})` 是 async 且**没有 try/catch**（照计划）。
// 实测结论：**该有的错误面已经由 `runTurn` 提供了**——`generate` 抛错 / 返回 `null` /
// 空串都走"降级为模板话术"那条路（`loop.mjs` 偏离 ②），所以模型这一层不存在
// "学习者发了消息却永远等不到回复"。而**处理器级**的逃逸要 `runTurn` 自己 reject
// 才可能发生（六槽违约 / 非法档位 / 非法拍子），那些字面量都在本文件里、由测试与
// 源码级护栏钉住；`band` 来自 `profile`，而 `profile.mjs` 的读路径**按合法档位集合回退**
// （越界档位安全退回默认档，非"是不是整数"判）——所以它在生产路径上不可达。
// ⇒ **照计划不补 try/catch**：补了会多造一句"教学内容"（视图自己编的话），
// 而那正是视图职责边界要挡的事。代价如实登记：**若将来有人把会抛错的输入接到
// `runTurn` 上，逃逸的 rejection 只会表现为"学习者的消息石沉大海"**，没有界面提示。
// 检测机制本身有判别力，证据见测试里那条子进程用例。

import { createSession } from './units/teach/session.mjs';
import { pickFocus } from './units/teach/focus.mjs';
import { chooseMethod } from './units/teach/method.mjs';
import { runTurn } from './units/teach/loop.mjs';
import { createProfile } from './units/teach/profile.mjs';
import { bandRules } from './units/teach/difficulty.mjs';

/** 首屏邀请（视图自己造的两句话之一，另一句是"挑不出焦点"的换话题邀请）。 */
const EMPTY_PROMPT = '说说你今天干了什么，或者你现在想说什么——中文就行。';

/** 挑不出焦点时的换话题邀请（视图自己造的另一句）。 */
const NO_FOCUS_HINT = '这个我一时接不上——换一件今天的事说说？';

/** 焦点一个都没挑出来时，情境槽的兜底（`focus.meaning` 为空串时的占位）。 */
const FOCUS_PLACEHOLDER = '某个说法';

/** 每回合写进提示词【拍子】槽的值。**照计划第 1813 行**，见文件头后果 (b)。 */
const TURN_PHASE = 'elicit';

/** 每回合写进提示词【学习者状态】槽的值。**照计划第 1813 行**，见文件头后果 (c)。 */
const LEARNER_STATE = 'untouched';

/**
 * 入口守卫：`root` 必须是一个容器元素（与 `web/app.mjs` 的 `mount` 同口径）。
 * @throws {TypeError} 不是元素
 */
function assertRoot(root) {
  if (root === null || root === undefined || typeof root.replaceChildren !== 'function') {
    throw new TypeError('mountDialogue: 需要传入一个容器元素（web/dialogue.html 里的容器）');
  }
}

/**
 * 情境槽：取第一个场景的 `setup`，没有就围绕焦点造一句。
 *
 * `Object.hasOwn` 是**防御性**的（`scenes[0].toString` 会顺着原型链取到一个函数，
 * 那会被 `assemblePrompt` 印进提示词）——同族缺陷本仓已修过三次
 * （`teach/session.mjs` 的 `send` / `teach/method.mjs` 的 `narrowOnStuck` / `teach/prompt.mjs` 的方法表）。
 * 顺带把 `scenes[0]` 是 `null` / 非对象 / `setup` 不是字符串都归到同一条兜底路上
 * （计划只挡了"`scenes` 为空"这一种）。
 */
function sceneFor(scenes, focus) {
  const first = scenes[0];
  const setup = (first !== null && typeof first === 'object' && Object.hasOwn(first, 'setup')) ? first.setup : undefined;
  if (typeof setup === 'string' && setup.trim() !== '') return setup;
  const meaning = focus.meaning.trim() === '' ? FOCUS_PLACEHOLDER : focus.meaning;
  return `围绕「${meaning}」的一个日常情境`;
}

/**
 * 把对话挂到容器上。
 * @param {HTMLElement} root
 * @param {{ doc?: object, storage: object, generate: Function, candidates?: Array, scenes?: Array }} deps
 *   - `doc`：DOM 工厂，默认 `globalThis.document`（与 `web/app.mjs` 的 `mount` 同一个既有做法）。
 *     **不许写成 `root.ownerDocument ?? globalThis.document`**：本仓库的假 DOM
 *     （`tests/helpers/dom.mjs` 的 `makeEl`）既没有 `ownerDocument`，Node 里也没有
 *     `globalThis.document`，那样写会让整个挂载在测试里当场炸（计划第 1760 行的原话，已实测）。
 *   - `storage`：学习者画象的存储（**由调用方注入**，视图不直接读写 `localStorage`）。
 *   - `generate`：模型调用，形状 `({ prompt, attempt }) => Promise<string>`（`runTurn` 的契约）。
 *     本视图**不自己发请求**——这是"教学判断可以在 Node 里确定性地测"的前提。
 *   - `candidates` / `scenes`：候选焦点与情境（缺省 `[]`）。
 * @returns {Promise<void>}
 * @throws {TypeError} `generate` 不是函数 / `root` 不是容器 / `storage` 缺 `getItem`+`setItem`
 *   （`storage` 的守卫由 `createProfile` 提供，**一个 HTTP 请求都不会发**）
 */
export async function mountDialogue(root, deps = {}) {
  assertRoot(root);
  const { doc = globalThis.document, storage, generate, candidates = [], scenes = [] } = deps;
  if (typeof generate !== 'function') {
    throw new TypeError('mountDialogue: generate 必须是函数（模型调用由调用方注入）');
  }
  const profile = createProfile({ storage });
  // 当前档位的字符上限（`bandRules` 的**唯一**生产调用点，见文件头改动 ①）。
  // 先读档再建 DOM：storage 违约在**动界面之前**就响亮抛错（界面不许出现"挂了一半"的样子）。
  const maxChars = bandRules(profile.band()).maxChars;

  /** 本次挂载的对话记录（**纯内存**：作品落盘是 Task 12 的事，见文件头代价）。 */
  const transcript = [];
  const log = doc.createElement('div');
  log.className = 'dialogue-log';
  const input = doc.createElement('textarea');
  input.placeholder = EMPTY_PROMPT;
  input.rows = 3;
  input.maxLength = maxChars;
  const send = doc.createElement('button');
  send.textContent = '发送';
  send.className = 'primary';
  const row = doc.createElement('div');
  row.className = 'row';
  row.append(send);
  root.replaceChildren(log, input, row);

  const push = (who, body) => {
    transcript.push({ who, body });
    const el = doc.createElement('p');
    el.className = who === 'system' ? 'say-system' : 'say-learner';
    el.textContent = body;
    log.append(el);
  };

  const session = createSession({ onEnter: () => {} });
  push('system', EMPTY_PROMPT);

  send.addEventListener('click', async () => {
    const content = String(input.value ?? '').trim();
    if (content === '') return;
    input.value = '';
    push('learner', content);
    // 三次转移的返回值**全部被丢弃**（照计划）。从第二回合起前两次是非法转移，
    // 静默返回 false 且不留痕——见文件头后果 (a)。
    session.send('content');
    session.send('focusPicked');

    const focus = pickFocus({ content, candidates, exclude: [] });
    if (focus === null) {
      push('system', NO_FOCUS_HINT);
      return;
    }

    const method = chooseMethod({ history: profile.methodsUsed(), preferred: null });
    profile.recordMethod(method);
    const scene = sceneFor(scenes, focus);
    session.send('staged');

    const turn = await runTurn({
      generate,
      phase: TURN_PHASE,
      method,
      band: profile.band(),
      focus,
      learnerState: LEARNER_STATE,
      scene,
    });
    push('system', turn.text);
  });
}
