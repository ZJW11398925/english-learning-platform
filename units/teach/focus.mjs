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
 * @param {{ content?: string, candidates?: Array<{kind,ref,meaning}>, exclude?: string[] }} input
 * @returns {Readonly<object> | null} 挑不出来就返回 null——**宁可这轮不教，也不许重复教**
 */
export function pickFocus({ content = '', candidates = [], exclude = [] } = {}) {
  const skip = new Set(exclude.map(String));
  const usable = (candidates ?? []).filter((c) => c && c.ref != null && !skip.has(String(c.ref)));
  if (usable.length === 0) return null;
  const chosen = usable[0];
  const source = String(content).trim() === '' ? 'system' : 'learner';
  return makeFocus({ kind: chosen.kind, ref: chosen.ref, meaning: chosen.meaning, source });
}
