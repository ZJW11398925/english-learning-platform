// web/units/teach/focus.mjs
//
// 焦点：这一次要教的那**一个**点（词 / 结构 / 表达问题）。
//
// **纯逻辑：零 import、零浏览器 API、零副作用。**
//
// 为什么"一次只挑一个"要写进代码而不是提示词：设计稿 §2.3 的引导纪律里
// "一次只教一个点"若只写在提示词里，模型会顺手把三个问题一起说——那是批改，不是教学。
// 把 pickFocus 定成"返回单个对象"之后，"一次多个焦点"在类型上就不可能。
//
// 为什么"学习者优先"是硬规则（设计稿 §2.1 优先级 1）：如果每次都由系统选词，
// 我们其实是在**替学习者规定他该注意什么**——这与"引导他自己去看、自己想"相悖。
// system 来源只在没有学习者内容时使用（由调用方保证，本模块只如实标记来源）。
//
// 代价（如实记）：本模块**不判断**候选是否真的出现在 content 里——它只做挑选与排除。
// "这个词到底是不是他内容里的重点"需要模型参与，那是 loop 的事，不是纯函数的事。
//
// 两条入口的处置**故意不对称**（与 `units/state-machine.mjs` / `teach/session.mjs` 同口径）：
// `makeFocus` 是**显式调用方**的契约闸门，非法 kind / source 响亮抛 TypeError；
// `pickFocus` 是**面向模型**的入口，它的输入不可信——缺 ref、kind 不在枚举里、exclude 传 null，
// 一律**静默跳过 / 当作空**，绝不把一次正常的挑选炸掉。理由：候选是一个模型给的数组，
// 里面混进一条 `kind: 'phrase'` 的概率不是零；若让它抛穿，模型的一次笔误就吃掉**整轮教学**
// （一个焦点都挑不出来），而它本来只是"这条候选不能用"。
// 代价（如实记）：kind 写错的候选会被**悄悄丢掉**，调用方看不出"模型这次给的 kind 全是垃圾"——
// 挑选层不记账，也不返回"为什么没挑出来"。要发现它得看候选本身，那是 loop 的事。
// 这是有意的取舍：这里宁可少一个焦点的**诊断信息**，也不许因为垃圾输入**丢掉整轮教学**。
// 另注：守卫只查 kind 是否在枚举里，不查它是否与 content 匹配（见上一条代价）。

/** 焦点来源。learner = 从他的内容里挑的；system = 系统给的情境里带来的。 */
export const FOCUS_SOURCES = Object.freeze(['learner', 'system']);

const FOCUS_KINDS = Object.freeze(['word', 'structure', 'expression']);
const FOCUS_STATUS = Object.freeze(['untouched', 'recognized', 'usable']);

/**
 * 造一个焦点（冻结对象）。
 * @throws {TypeError} kind / source 不在枚举里（契约违约）
 */
export function makeFocus({ kind, ref, meaning, source }) {
  if (!FOCUS_KINDS.includes(kind)) {
    throw new TypeError(`makeFocus: kind 必须是 ${FOCUS_KINDS.join(' / ')} 之一，收到 ${JSON.stringify(kind)}`);
  }
  if (!FOCUS_SOURCES.includes(source)) {
    throw new TypeError(`makeFocus: source 必须是 ${FOCUS_SOURCES.join(' / ')} 之一，收到 ${JSON.stringify(source)}`);
  }
  return Object.freeze({ kind, ref: String(ref), meaning: String(meaning ?? ''), source, status: FOCUS_STATUS[0] });
}

/**
 * 挑出这一次要教的那一个焦点。
 *
 * 输入按**不可信**处理：候选里不可用的条目（缺 ref / kind 不在枚举里）被静默跳过，
 * 继续看下一个——第一个可用候选胜出。全不可用（或被 exclude 全排除、或没有候选）返回 null。
 *
 * @param {{ content?: string, candidates?: Array<{kind,ref,meaning}>, exclude?: string[] | null }} input
 * @returns {Readonly<object> | null} 挑不出来就返回 null——**宁可这轮不教，也不许重复教**
 */
export function pickFocus({ content = '', candidates = [], exclude = [] } = {}) {
  // `candidates` 与 `exclude` 走**同一条**空值处置：两者都可能是调用方直传的 null
  // （"这次没有要排除的"），只给其中一个兜底，等于把"防御"写成了看运气的。
  const skip = new Set((exclude ?? []).map(String));
  // kind 守卫与 `ref != null` 守卫是**同一条规则**：候选是一个模型给的数组，里面混进
  // `kind: 'phrase'`（或拼错的 `words`）与缺 ref 属于同一类垃圾。同一个函数里，同一类垃圾
  // 不该有两种相反的处置——把它交给 makeFocus，一条坏候选就抛穿整轮教学。
  const usable = (candidates ?? []).filter((c) => (
    c && c.ref != null && FOCUS_KINDS.includes(c.kind) && !skip.has(String(c.ref))
  ));
  if (usable.length === 0) return null;
  const chosen = usable[0];
  const source = String(content).trim() === '' ? 'system' : 'learner';
  return makeFocus({ kind: chosen.kind, ref: chosen.ref, meaning: chosen.meaning, source });
}
