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
// 代价（如实记）：MVP 是**单线程对话**，没有历史会话列表、没有"哪一天聊过什么"的导航。
// 另一条：一次会话就是一次会话（`session.mjs` 的 `close` 没有回到 `intake` 的转移），
// 而本视图**从不发 `close`**——刷新页面即新开一次。
//
// ===========================================================================
// Task 12：作品回看与导出（兑现设计稿 §8 的"拥有感"与 §11 风险 3 的长期语料）
// ===========================================================================
//   · 作品按 `WORK_KEY` 落在**调用方注入的那个 storage** 上（`web/dialogue.html` 注的是
//     `localStorage`）⇒ 刷新页面 / 关标签页再打开，回看与导出里**东西还在**。
//   · **读回发生在挂载时**（`readWork(storage)`，坏数据安全回退成空作品）；
//     **写回发生在回合落定之后**（学习者那句 + 系统回复那句都渲染完之后，一次 `appendTurn`）。
//   · 导出的下载（`Blob` + `URL.createObjectURL`）**只在这个文件里**——`work.mjs` 是纯模块，
//     只吐字符串；下载出口可以注入（`deps.download`），注入不进来时退化成"摊出只读 JSON"。
//   · **只有一份权威**：作品的存储键是 `work.mjs` 的 `WORK_KEY`，本视图不另存一份内存副本
//     真相（`work` 就是盘上那份的读回值，每次写回都是它的新数组）。
//   ⚠️ **没做删除**：设计稿的 `PRIVACY_CONSTRAINTS` 里"可删除"这一半**本视图没有出口**
//   （清浏览器数据会连 API Key 与画象一起删）。如实登记为缺口，见
//   `.superpowers/sdd/task-12-report.md`。
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
import { WORK_KEY, appendTurn, readWork, renderWork, workDayOf, exportWork } from './units/teach/work.mjs';

/** 首屏邀请（视图自己造的两句话之一，另一句是"挑不出焦点"的换话题邀请）。 */
const EMPTY_PROMPT = '说说你今天干了什么，或者你现在想说什么——中文就行。';

/** 挑不出焦点时的换话题邀请（视图自己造的另一句）。 */
const NO_FOCUS_HINT = '这个我一时接不上——换一件今天的事说说？';

/** 焦点一个都没挑出来时，情境槽的兜底（`focus.meaning` 为空串时的占位）。 */
const FOCUS_PLACEHOLDER = '某个说法';

/** 回看出口的按钮文案（`tests/dialogue-mount.test.mjs` 的按钮清单按精确文案钉住）。 */
const REVIEW_LABEL = '回看我写过的';

/** 导出出口的按钮文案。 */
const EXPORT_LABEL = '导出记录';

/** 作品还是空的时候回看里说的那句（空作品不许是一片空白）。 */
const EMPTY_WORK_NOTE = '还没有写过什么——等你今天开口，这里会攒成你自己的日记。';

/** 每个回合写进提示词【拍子】槽的值。**照计划第 1813 行**，见文件头后果 (b)。 */
const TURN_PHASE = 'elicit';

/** 每个回合写进提示词【学习者状态】槽的值。**照计划第 1813 行**，见文件头后果 (c)。 */
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
 * @param {{ doc?: object, storage: object, generate: Function, candidates?: Array, scenes?: Array, download?: Function }} deps
 *   - `doc`：DOM 工厂，默认 `globalThis.document`（与 `web/app.mjs` 的 `mount` 同一个既有做法）。
 *     **不许写成 `root.ownerDocument ?? globalThis.document`**：本仓库的假 DOM
 *     （`tests/helpers/dom.mjs` 的 `makeEl`）既没有 `ownerDocument`，Node 里也没有
 *     `globalThis.document`，那样写会让整个挂载在测试里当场炸（计划第 1760 行的原话，已实测）。
 *   - `storage`：画象**与作品**的存储（**由调用方注入**，视图不直接读写 `localStorage`）。
 *   - `generate`：模型调用，形状 `({ prompt, attempt }) => Promise<string>`（`runTurn` 的契约）。
 *     本视图**不自己发请求**——这是"教学判断可以在 Node 里确定性地测"的前提。
 *   - `candidates` / `scenes`：候选焦点与情境（缺省 `[]`）。
 *   - `download`：导出作品的下载出口，形状 `({ filename, text }) => void`。**可注入是为了
 *     能在 Node 里测**（`Blob` 与 `URL.createObjectURL` 是浏览器 API，假 DOM 里没有）；
 *     不注入、或它自己抛错时，导出退化成"摊出一个只读的 JSON 框让学习者自己复制"——
 *     绝不允许"按了导出什么都没发生"（同族：`web/dialogue.html` 的失败路径都要有出口）。
 *   - `Blob` / `urlFactory`：**只在测试里注入**（浏览器里它们就是全局的）。
 *     `urlFactory` 的形状是 `{ createObjectURL, revokeObjectURL }`，缺省取 `globalThis.URL`。
 * @returns {Promise<void>}
 * @throws {TypeError} `generate` 不是函数 / `root` 不是容器 / `storage` 缺 `getItem`+`setItem`
 *   （`storage` 的守卫由 `createProfile` 提供，**一个 HTTP 请求都不会发**）
 */
export async function mountDialogue(root, deps = {}) {
  assertRoot(root);
  const {
    doc = globalThis.document, storage, generate, candidates = [], scenes = [], download,
    Blob: BlobCtor = globalThis.Blob, urlFactory = globalThis.URL,
  } = deps;
  if (typeof generate !== 'function') {
    throw new TypeError('mountDialogue: generate 必须是函数（模型调用由调用方注入）');
  }
  const profile = createProfile({ storage });
  // 当前档位的字符上限（`bandRules` 的**唯一**生产调用点，见文件头改动 ①）。
  // 先读档再建 DOM：storage 违约在**动界面之前**就响亮抛错（界面不许出现"挂了一半"的样子）。
  const maxChars = bandRules(profile.band()).maxChars;

  /** 本次挂载的对话记录（**纯内存**：它是"这一次会话聊了什么"，不是作品）。
   *  作品在 `work` 里，而且是**盘上那份的读回值**（只有一份权威，见文件头 Task 12 段）。 */
  const transcript = [];
  const log = doc.createElement('div');
  log.className = 'dialogue-log';
  // 作品区：回看的内容与"导出兜底"都落在这里（挂在记录区里面，与对话流同一个滚动区）。
  // 建了就一直在，**但里面是空的**——回看的内容只在按下「回看我写过的」之后才生成
  // （这是"没打开回看之前 DOM 里没有回看条"那条反向控制的界面侧前提）。
  const workArea = doc.createElement('div');
  workArea.className = 'work-area';
  log.append(workArea);
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
  const review = doc.createElement('button');
  review.textContent = REVIEW_LABEL;
  const exportBtn = doc.createElement('button');
  exportBtn.textContent = EXPORT_LABEL;
  const workRow = doc.createElement('div');
  workRow.className = 'row';
  workRow.append(review, exportBtn);
  // root 的直接子节点恰好四个：记录区（含作品区）/ 输入框 / 发送行 / 作品行。
  root.replaceChildren(log, input, row, workRow);

  const push = (who, body) => {
    transcript.push({ who, body });
    const el = doc.createElement('p');
    el.className = who === 'system' ? 'say-system' : 'say-learner';
    el.textContent = body;
    log.append(el);
  };

  const session = createSession({ onEnter: () => {} });
  push('system', EMPTY_PROMPT);

  // ═══ 作品：挂载时**按 WORK_KEY 从注入的 storage 读回**（读路径坏数据安全回退） ═══
  // 照计划原样交付时这里是 `let work = []` 纯内存 ⇒ 刷新页面后回看与导出皆空，
  // 而所有测试都会绿（`DEC-OPI-968b804d-…db.107` 已核实）。这一行就是那个缺口的修法。
  let work = readWork(storage);

  /** 把回看视图重画一遍（**只在按下「回看我写过的」时调用**）。 */
  const drawWork = () => {
    // 每次重画前清空：连点两次不许把上次那批再追加一遍。
    workArea.replaceChildren();
    if (work.length === 0) {
      // 空作品不许是一片空白（第一次按回看的人要知道这里将来装什么）。
      const note = doc.createElement('p');
      note.className = 'say-system';
      note.textContent = EMPTY_WORK_NOTE;
      workArea.append(note);
      return;
    }
    // `renderWork` 按天分组（每天一块：标题行 + 该天所有回合行），分组的权威在 work.mjs 里。
    // 视图**只负责把每一块印出来**，不解析日期、不自己拼文案。
    // `workDayOf` 是分组键的同一份权威（标题行的日期与它同源，不会两处印出不同的日期）。
    let cursor = 0;
    for (const block of renderWork(work)) {
      void workDayOf(work[cursor]);
      const parts = block.split('\n');
      cursor += parts.length - 1;   // 这一块里有几个回合（标题行不算）
      // 按天分组的标题——回看视图**自己**的东西：没打开回看之前它在 DOM 之外
      // （该判据的反向控制见 `tests/teach-work.test.mjs`）。
      const heading = doc.createElement('p');
      heading.className = 'work-day';
      [heading.textContent] = parts;
      workArea.append(heading);
      for (const line of parts.slice(1)) {
        const el = doc.createElement('p');
        el.className = 'work-line';
        el.textContent = line;
        workArea.append(el);
      }
    }
  };

  review.addEventListener('click', () => {
    drawWork();
  });

  /** 导出的下载出口：`Blob` + `URL.createObjectURL`，**本地完成、不经过任何服务器、不上传**。
   *  注入的 `deps.download` 优先（测试用它，顺便让这一截在浏览器之外也可验）；
   *  两者都没有（旧浏览器）⇒ 返回 false，由调用方走"摊出 JSON"那条兜底。 */
  const startDownload = ({ filename, text: body }) => {
    if (typeof download === 'function') {
      download({ filename, text: body });
      return true;
    }
    if (typeof BlobCtor !== 'function' || urlFactory === null || typeof urlFactory?.createObjectURL !== 'function') {
      return false;   // 下载出口整体不可用
    }
    const blob = new BlobCtor([body], { type: 'application/json' });
    const href = urlFactory.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    urlFactory.revokeObjectURL(href);
    return true;
  };

  exportBtn.addEventListener('click', () => {
    const body = exportWork(work);
    let delivered = false;
    try {
      delivered = startDownload({ filename: '我的英语作品.json', text: body });
    } catch {
      delivered = false;   // 注入的实现自己炸了：与"没有出口"同一条兜底路
    }
    if (delivered) return;
    // **不许静默什么都不发生**：摊出一个只读的 JSON 框让学习者自己复制。
    // 导出是契约承诺（设计稿 §11 风险 3 的长期语料处置），这条路必须走得通。
    // 📌 已知代价：它摊在**作品区**里，而作品区会被下一次「回看我写过的」的 `replaceChildren()`
    // 清掉 ⇒ 兜底框在看一眼回看之后就没了（再按一次「导出记录」就回来）。
    // 这是有意的（不从对话区里另开一块），但它确实是这个位置换来的代价。
    const shows = doc.createElement('textarea');
    shows.value = body;
    shows.readOnly = true;
    workArea.append(shows);
  });

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

    // ═══ 作品写回：**学习者那句 + 系统这句都落定之后**才落一条 ═══
    // 为什么放在这里（而不是在 push('learner', ...) 之后）：半条回合不是作品——
    // 系统的回复还没到就落盘，会让"回看"里出现自己写了半句的幻觉。
    // 日期照计划原文取 UTC 的 YYYY-MM-DD（代价见 `work.mjs` 文件头 ③）。
    // 写失败（配额满 / 隐私模式）**不抛错**：学习流程不许因为写不进去而中断。
    work = appendTurn(work, { date: new Date().toISOString().slice(0, 10), learner: content, system: turn.text });
    try {
      storage.setItem(WORK_KEY, exportWork(work));
    } catch {
      // 存储满了 / 隐私模式：这一次没记住（代价已登记在 work.mjs 文件头 ⑤）
    }
  });
}
