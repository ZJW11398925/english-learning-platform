// web/units/teach/work.mjs
//
// 作品：学习者写过的每一天。**纯逻辑：零浏览器 API、零副作用、零 storage。**
//
// ---------------------------------------------------------------------------
// 为什么"作品"是这一形态里最重要的可视化物（设计稿 §8）
// ---------------------------------------------------------------------------
// 契约 IN_SCOPE 承诺了「个人进度与已掌握词可视化」，但新形态里**没有分数可看**
// （`NON_GOALS` 禁掉了分数焦虑），于是进度只能靠另一种东西承载——
// **翻回去看你自己第一天写的东西**（设计稿 §8 原话：「这本**你自己的英文日记**就是进度」）。
// 这份东西同时兑现三件事：拥有感、留存来源（留存来自"这是我写的"而非打卡）、复现的素材。
//
// ---------------------------------------------------------------------------
// 为什么导出必须在 MVP 里（设计稿 §11 风险 3）
// ---------------------------------------------------------------------------
// 没有账号 = 长期语料只在本机，**清一次浏览器数据就清空全部积累**。契约
// `PRIVACY_CONSTRAINTS` 写明"可导出、可删除"，而导出是唯一能兑现"带走"这一半的东西。
// 它不是锦上添花的功能，是这个形态的产品级风险处置。
//
// ---------------------------------------------------------------------------
// 零浏览器 API 与"只有一份权威"
// ---------------------------------------------------------------------------
// 本模块**不 import 任何东西、不碰 storage、不碰 Blob/URL**：
//   · 落盘由**调用方**（`web/dialogue.mjs`）用注入的 `storage` 做，键是下面的 `WORK_KEY`；
//   · 导出的下载（`Blob` + `URL.createObjectURL`）也在调用方，本模块只吐字符串。
// 这样"作品"可以在 Node 里被确定性地测，而浏览器那一半只剩一根接线。
// ⚠️ **不许开第二个存储真相**：作品的权威只有 `WORK_KEY` 这一份（本仓已经吃过
// "同一件事两个出处、两处一旦不一致就静默谎报"的代价，见 `AGENTS.md` 阶段 B 读数口径）。
//
// ---------------------------------------------------------------------------
// 代价（如实记，别含糊过去）
// ---------------------------------------------------------------------------
//   ① **MVP 只做导出，没做导入。** 换设备能带走数据、但还不能搬回来。导入需要版本与合并
//      策略（两台设备各写了一半怎么办），不在本轮范围。
//   ② **"可删除"这个承诺本模块没有兑现，界面也没有出口。** 设计稿只说"可导出/可导入至少
//      要能在册"，而"删除"需要一次**不可逆**的用户确认（那是界面与教学判断，不是纯函数能
//      顺手加的东西）。⇒ 这里**不声称可删除**，把它登记为缺口（详见
//      `.superpowers/sdd/task-12-report.md`）。学习者真要清空可以清浏览器数据——但那会把
//      API Key 与画象一起删掉，所以"只删作品"这件事今天**做不到**。
//   ③ **日期是 UTC 的**（调用方用 `new Date().toISOString().slice(0, 10)`，照计划原文）。
//      理由：`work.mjs` 自己不读时钟，"今天是哪天"由调用方决定，本模块只负责分组。
//      ⚠️ 代价：UTC+8 的晚上 8 点之后写的作品会被分到**第二天**。这是已登记的范围切分，
//      不是"已处理"——要改成本地日期需在调用方取本地日历字段。
//   ④ **同一份 (date, learner, system) 只落一条。** 见 `appendTurn` 的去重段。
//   ⑤ **写失败是静默的**：`setItem` 抛（配额满 / 隐私模式）时调用方吞掉异常 ⇒ 作品不推进，
//      而**界面上没有任何症状**（同族：`profile.mjs` 代价 ①）。这不是"已处理"，是"已接受"。
//   ⑥ **本模块不认识教学价值**。它能保证"记下来了、坏数据不传下去"，保证不了
//      "这段记录值得回看"——后者是教学判断，纯函数测不了。
//
// 读宽写严（照 `profile.mjs` 的范本，口径照抄）：
//   · **读路径**（`readWork`）：坏数据 ⇒ 安全回退成能用的部分，**不抛错**。
//     一份坏作品不该把学习者锁在门外。
//   · **写路径**（`appendTurn`）：契约违约（null / 缺字段 / 类型不对）⇒ **响亮抛 `TypeError`**。
//     这些入参只来自引擎自己，静默兜底会把一个真 bug 变成看不见的行为差异。
//   · ⚠️ **读取路径的安全回退不是放宽写入路径的理由**：`appendTurn([], null)` 照抛不误。

/** 存储键（与旧形态的 `elp.apiKey` / `elp.words` / `elp.events` 及画象 `elp.teach.profile` 并列，互不覆盖）。 */
export const WORK_KEY = 'elp.teach.work';

/**
 * 回合的形状守卫：**逐字段报自己的那句话**（写路径用，违约即抛）。
 *
 * 为什么每类违约要报不同的文案（红线 16）：两类坏法印同一句话时，删掉其中一条分支
 * **不可观测**——没有任何测试能区分它们。错误文案的区分度是护栏可观测性的前提。
 *
 * @throws {TypeError} 不是对象 / date 不是非空字符串 / learner 或 system 不是字符串
 */
function assertTurn(turn) {
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) {
    throw new TypeError(`回合必须是一个对象，收到 ${JSON.stringify(turn) ?? String(turn)}`);
  }
  if (typeof turn.date !== 'string' || turn.date.trim() === '') {
    throw new TypeError('回合缺 date（作品要按天分组，没有日期就没法分组）');
  }
  if (typeof turn.learner !== 'string') {
    throw new TypeError(`回合缺 learner 文本（必须是字符串，收到 ${JSON.stringify(turn.learner) ?? String(turn.learner)}）`);
  }
  if (typeof turn.system !== 'string') {
    throw new TypeError(`回合缺 system 文本（必须是字符串，收到 ${JSON.stringify(turn.system) ?? String(turn.system)}）`);
  }
}

/**
 * 回合的**形状判定**（读路径用，不抛错）。
 *
 * 与写路径共用同一组字段规则，但结果是一个布尔值：读路径的职责是"能用的留下、不能用的丢掉"，
 * 而不是把已经在盘上的坏数据变成一次抛错。**两处规则同源**（都在这一个文件里、都按
 * `date` / `learner` / `system` 三个非空字符串判），不会各自漂移。
 */
function isTurnShape(v) {
  return v !== null
    && typeof v === 'object'
    && !Array.isArray(v)
    && typeof v.date === 'string' && v.date.trim() !== ''
    && typeof v.learner === 'string'
    && typeof v.system === 'string';
}

/** 干净的落盘形状：**只留契约里的三个键**（内部对象原样存盘会把未来的字段泄漏成盘上契约）。 */
const toStored = (turn) => ({ date: turn.date, learner: turn.learner, system: turn.system });

/**
 * 按天分组标题（`renderWork` 用）。
 *
 * `2026-09-17` → `2026年9月17日`：人读的日期。**不做"今天/昨天"这类相对词**——
 * 那需要读时钟，而本模块是纯函数（同一份输入必须给同一份输出）；相对词还要求
 * "现在几点"参与，是视图层的判断。也不做成 `9月17日`（丢掉年份）：作品是**跨月跨年**
 * 攒起来的东西，年份掉了之后"去年今天写了什么"就看不出来了。
 */
function dayHeading(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return date;   // 不是 YYYY-MM-DD 就原样印（不发明一个假日期）
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 追加一个回合，返回**新数组**（不改原数组——调用方要留旧状态）。
 *
 * **去重的判据（有意为之，且必须写明）**：若新回合与**最后一条**的 `(date, learner, system)`
 * 完全相同，则原样返回一份新数组、不追加。理由是这件东西的实物形态是一本日记：
 * 重新挂载（刷新页面）与该回合被写两次是同一个可观测情形，而他们俩在**任何测试里都不可区分**
 * ⇒ 与其让它随调用次数增长，不如定成一条明确的规则并测出来。
 * ⚠️ 代价：同一天里他真的**逐字**说了两遍同一句话时，第二遍不会被记下。
 *
 * @param {Array} list 现有作品
 * @param {{date: string, learner: string, system: string}} turn
 * @returns {Array} 新数组
 * @throws {TypeError} list 不是数组 / turn 形状违约
 */
export function appendTurn(list, turn) {
  if (!Array.isArray(list)) throw new TypeError('appendTurn: list 必须是数组');
  assertTurn(turn);
  const next = toStored(turn);
  const last = list[list.length - 1];
  if (last !== undefined && isTurnShape(last)
    && last.date === next.date && last.learner === next.learner && last.system === next.system) {
    return [...list];   // 同一个回合被写了两次（重新挂载 / 重复调用）：原样返回，不重复记
  }
  return [...list, next];
}

/**
 * 把一份**可能坏了**的盘上数据读成能用的作品（**读路径：不抛错**）。
 *
 * 三条回退，都是"坏数据不该把学习者锁在门外"的直接落地：
 *   · 读不出来（`getItem` 自己抛）/ 不是 JSON / 不是数组 ⇒ **空作品**；
 *   · 数组里某一条形状不对 ⇒ **丢掉那一条**（逐条回退，不是整份丢掉——一条坏记录不该
 *     让其余几十天的日记一起消失）；
 *   · 形状对但有**契约外的键** ⇒ 只留 `date` / `learner` / `system` 三个。
 *
 * 📌 **顺带的形状归一**：旧版本（或手改）留下的 `{"learner":{"text":"..."}}` 这类嵌套形状
 * 在这里会**丢掉该条**。本轮没有任何代码写过这种形状，所以是一条防御性回退，不是因为
 * 存在这种历史数据。**未在真实浏览器里验证过**"有没有别的形状曾经落过盘"。
 *
 * @param {{ getItem: Function }} storage 调用方注入的存储（本模块不碰 `localStorage`）
 * @returns {Array} 能用的作品（坏数据 ⇒ 空数组或丢掉坏条）
 */
export function readWork(storage) {
  try {
    const raw = storage.getItem(WORK_KEY);
    if (raw === null || raw === undefined || raw === '') return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTurnShape).map(toStored);
  } catch {
    return [];   // 非法 JSON / getItem 自己抛：坏数据静默退回空作品
  }
}

/**
 * 渲染成人话：**按天分组的行块**（给回看视图用）。
 *
 * 返回 `string[]`，每个元素是**一天**的一块文本：先一行日期标题，再每回合一行
 * `你说：…　我回：…`。视图把每一块原样印出来即可（不自己解析日期、不自己拼文案）。
 * 日期**一天只印一次**（标题里印），回合行里不再重复——那正是"按天分组"的意思。
 *
 * 为什么**分组产物由本模块给**而不是让视图解析：那就成了"同一件事两个出处"——
 * 一处印 `2026年9月17日`、一处印 `2026-09-17` 时会不一致，而且视图得正则解析自己刚生成的文案。
 * `workDayOf(list[i])` 是每一天的**分组键**（同一份权威），视图拿它印标题。
 *
 * @param {Array} list
 * @returns {string[]} 每天一块
 * @throws {TypeError} list 不是数组
 */
export function renderWork(list) {
  if (!Array.isArray(list)) throw new TypeError('renderWork: list 必须是数组');
  const blocks = [];
  let currentDay = null;
  for (const turn of list) {
    const day = workDayOf(turn);
    if (day !== currentDay) {
      currentDay = day;
      // 一天一块：标题行 + 该天所有回合行（同一天不重复印日期标题）
      blocks.push([renderDay(day)]);
    }
    blocks[blocks.length - 1].push(`你说：${turn.learner}　我回：${turn.system}`);
  }
  return blocks.map((lines) => lines.join('\n'));
}

/**
 * 取一个回合所属的**日期分组键**。
 *
 * 单独导出而不是让视图去正则解析 `renderWork` 的输出：分组的出处只有一个，
 * 视图里再解析一次日期就是给同一件事造第二个出处。
 */
export function workDayOf(turn) {
  return turn.date;
}

/** 一行分组标题对应的人话日期（视图印标题用；`renderWork` 的每一块第一行就是它）。 */
function renderDay(date) {
  return dayHeading(date);
}

/**
 * 导出成 JSON 字符串（隐私承诺的兑现路径）。
 *
 * 内容 = 盘上那份作品的**原样**（`JSON.stringify(list, null, 2)`，空作品 ⇒ `[]`）。
 * **本地完成**：本模块只吐字符串，不经过任何服务器；下载由调用方用
 * `Blob` + `URL.createObjectURL` 做（`web/dialogue.mjs` 的 `download` 出口）。
 *
 * @param {Array} list
 * @returns {string}
 * @throws {TypeError} list 不是数组
 */
export function exportWork(list) {
  if (!Array.isArray(list)) throw new TypeError('exportWork: list 必须是数组');
  return JSON.stringify(list, null, 2);
}
