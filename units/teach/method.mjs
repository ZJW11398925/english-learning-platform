// web/units/teach/method.mjs
//
// 提问方法库与换挡（设计稿 §3.2 方法库 / §3.3 换挡判据 / §3.6.2 降级路径）。
//
// **纯逻辑：零 import、零浏览器 API、零副作用。**
//
// 为什么"方法"是产品的核心资产而不是外壳：要学习者用上 hesitate，问"你今天怎么样"是错的
// ——正确做法是**造一个他必须犹豫的情境**（角色扮演）。同一个词用不同方法教，效果不同，
// 所以需要"方法 × 目标"的匹配（§3.2）；没有一种方法永远好，所以需要**换挡**（§3.3）。
//
// **防审讯是硬规则**：设计稿 §2.3 写明"任何提问方式连续使用即失效"，§3.3 的信号表把
// "同一方法连续 2 次"列为**强制换方法**。用户原话是"每天都问今天怎么样，会问烦"。所以
// "连续两次同一种方法"由代码拒绝，不靠提示词自觉——"闭嘴"类负面约束是提示词工程里最容易
// 失效的一类（设计稿 §6 风险 5），机械可校验的那部分必须落到代码上。
//
// 两条入口的处置**故意不对称**（与 `teach/focus.mjs` / `units/state-machine.mjs` 同口径）：
// `chooseMethod` 的 `history` 是**引擎自己的状态**（不是模型给的自由文本），类型写错是程序 bug
// ⇒ 响亮抛 TypeError，绝不静默当成空历史——`history: 'guess'` 会被逐字符索引（`'guess'[4]` 是
// 's'），静默换来一个**看起来正常**的答案，这比抛错坏得多（同族：`teach/session.mjs` 里
// `send('toString')` 曾静默改坏状态）。而 `null` / `undefined` 是"这次还没有历史"，与
// `focus.mjs` 对 `exclude: null` 的口径一致：当作空，不是类型错误。
// `narrowOnStuck` 的入参是一个**方法名**，不在降级表里就是契约违约 ⇒ 响亮抛错；且查表只认
// **自有属性**——否则 `narrowOnStuck('toString')` 会返回 `Object.prototype.toString` 这个
// **函数**，而签名声明的是 `→ string`，且全程不抛错（与 `teach/session.mjs` 已修的同一族缺陷）。
//
// 代价（如实记）：
//   ① 本模块不认识教学效果。它只保证"不重复、不连续"，保证不了"这次选的方法对这个焦点真的
//      合适"——后者需要真实使用观察（HUMAN_EVALUATION），纯函数测不了。
//   ② 规则 1（连续两次即拒）与规则 2（最近用过的不选）在当前规则集下**互为冗余**：规则 2 的
//      条件恰是规则 1 的否定，两条 `banned.add(last)` 加进的是**同一个集合**，故删掉任何一条都
//      不改变任何输入下的输出（已用 9520 组输入穷举验证）。保留规则 1 是因为它就是本模块存在的
//      理由、且 §3.3 点名了这条信号；但**真正顶住"不审讯"的是规则 2**，且没有测试能单独锁住
//      规则 1 那一行——这是这套规则集的固有性质，不是测试写漏了。
//   ③ 规则 5（四种全被排除时的出口）会把 `exclude` 里也有的方法返回出去："永不返回 null"压过
//      "尊重 exclude"。它只在 exclude 已覆盖四种、且最近用过的是最后一种时才可达——那时不存在
//      "既不被排除又合规"的答案；宁可给一个方法，也不让调用方拿到 null 去炸掉整轮教学。
//   ④ `history` 里出现九种里**非 MVP** 的方法名（如 'task'）是合法的（第二批会上线），本模块
//      容忍它，但返回值只会在 MVP 四种里——非 MVP 的名字不许顺着 history 泄漏成返回值。

/** 首批四种方法（设计稿 §3.4）：并集刚好覆盖四拍。 */
export const MVP_METHODS = Object.freeze(['recall', 'roleplay', 'guess', 'upgrade']);

/** 全部九种（其余五种第二批，见设计稿 §3.4）。 */
export const ALL_METHODS = Object.freeze([
  'roleplay', 'task', 'describe', 'translate', 'sentence-finish',
  'guess', 'recall', 'reflect', 'upgrade',
]);

export const METHOD_LABELS = Object.freeze({
  roleplay: '角色扮演',
  task: '任务驱动',
  describe: '描述与命名',
  translate: '翻译对照',
  'sentence-finish': '半句接龙',
  guess: '情境猜词',
  recall: '回忆叙述',
  reflect: '纠错反思',
  upgrade: '扩展与升格',
});

/** 卡住时往哪个更结构化的方法降（设计稿 §3.6.2 的降级路径）。 */
const STUCK_FALLBACK = Object.freeze({
  roleplay: 'guess',
  recall: 'guess',
  guess: 'recall',
  upgrade: 'recall',
});

/**
 * 选下一个方法。
 *
 * 规则优先级（写死，不许改顺序）：
 *   1. **连续两次相同 = 拒绝**（防审讯，硬规则，压过偏好）
 *   2. 最近一次用过的也不选（至少隔一次）
 *   3. 尊重 preferred（学习者/引擎的偏好；兑现不了就静默忽略，偏好不是命令）
 *   4. 否则按 MVP 顺序取第一个没用过的
 *   5. 四种全被排除 → 轮转回**最早**用过的那个（history 按时间顺序，最后一个是最近用的）；
 *      history 里没有 MVP 方法可轮转时退回 MVP 第一个。**永不返回 null**：总得有个方法。
 *
 * 返回值**恒为 MVP_METHODS 之一**（非 MVP 的方法名不参与选择，也不会被返回）。
 *
 * @param {{ history?: string[]|null, preferred?: string|null, exclude?: string[]|null }} input
 * @returns {string}
 * @throws {TypeError} history / exclude 不是数组（null / undefined = "这次没有"，不算违约）
 */
export function chooseMethod({ history = [], preferred = null, exclude = [] } = {}) {
  const log = history ?? [];        // null / undefined = 这次还没有历史（不是类型错误）
  if (!Array.isArray(log)) {
    throw new TypeError(`chooseMethod: history 必须是方法名数组（null/undefined 表示没有历史），收到 ${JSON.stringify(history)}`);
  }
  const skip = exclude ?? [];       // 同一条空值处置：null = 这次没有要排除的
  if (!Array.isArray(skip)) {
    throw new TypeError(`chooseMethod: exclude 必须是方法名数组（null/undefined 表示不排除），收到 ${JSON.stringify(exclude)}`);
  }

  const last = log[log.length - 1] ?? null;
  const prev = log[log.length - 2] ?? null;
  const banned = new Set(skip.map(String));
  // 规则 1：连续两次相同 → 那个方法本轮禁用（防审讯）
  if (last !== null && last === prev) banned.add(last);
  // 规则 2：最近一次用过的不选（上一条是它的特例，见文件头代价 ②）
  if (last !== null) banned.add(last);

  const usable = MVP_METHODS.filter((m) => !banned.has(m));
  if (preferred && usable.includes(preferred)) return preferred;   // 规则 3
  if (usable.length > 0) return usable[0];                          // 规则 4

  // 规则 5：轮转回**最早**用过的那个——即 history 里第一次出现的 MVP 方法。
  // 不能写成 `MVP_METHODS.find(m => log.includes(m))`：那取的是**MVP 枚举顺序**里第一个
  // 出现过的（history = ['guess','recall'] 会返回 recall，而最早用过的是 guess）。
  // 也要挡掉非 MVP 名字：history 里一个 'task' 不是"用过 MVP 方法"，不许进轮转。
  const earliest = log.find((m) => MVP_METHODS.includes(m));
  return earliest ?? MVP_METHODS[0];
}

/**
 * 卡住时的降级方法（换方法，而不是继续逼——设计稿 §3.4.2 行为约束 3）。
 *
 * 只认降级表上的**自有属性**：`Object.prototype` 上有 `toString` / `constructor` /
 * `__proto__` / `hasOwnProperty`，靠 `STUCK_FALLBACK[current]` 直查会顺着原型链取到它们，
 * 于是本函数返回一个**函数**（签名声明 `→ string`）且不抛错。
 *
 * @param {string} current 卡住时正在用的方法名
 * @returns {string}
 * @throws {TypeError} 不在降级表上的方法名（含 null / undefined / 对象 / 原型链名字）
 */
export function narrowOnStuck(current) {
  const next = Object.hasOwn(STUCK_FALLBACK, current) ? STUCK_FALLBACK[current] : undefined;
  if (typeof next !== 'string') {
    throw new TypeError(`narrowOnStuck: 不认识的方法 ${JSON.stringify(current)}；已知：${Object.keys(STUCK_FALLBACK).join(' / ')}`);
  }
  return next;
}
