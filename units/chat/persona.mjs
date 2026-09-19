// web/units/chat/persona.mjs
//
// 人设卡：形状、归一、校验。人设是**用户自己的**（产品核心：自设 AI 伙伴），
// 本模块只负责「一张人设卡像不像一张人设卡」，不猜内容、不补内容。
//
// ── 四个字段（任务书冻结）────────────────────────────────────────────────────
//   `name`       名字（屏上最显眼的那个词）
//   `bio`        身份背景（一两句：她是谁、过着什么样的日子）
//   `tone`       语气（怎么说话：松弛/干脆/温和…）
//   `difficulty` 英语难度倾向（对学习者的英语难度偏好，自由文本，如「入门」「进阶」）
//
// ── null 的语义（与 `../write/parse.mjs` 同一条纪律）───────────────────────────
// `normalizePersona` 返回 `null` = 这张卡**形状不对、整张不可用**（缺字段/非字符串/
// 纯空白）。字段级的宽容只到「剪首尾空白」——绝不为缺的字段编默认值：编出来的
// 「默认语气」会被下游当成模型/用户说的。
//
// ── 持久化 ────────────────────────────────────────────────────────────────────
// 存储本身在装配层（`web/chat.mjs` 直接读写 `elp.chat.persona.v1`，一个键、
// 一个定义处）；本模块不碰存储。
//
// 纯逻辑模块：零 import、零浏览器 API。

/** 人设卡的字段清单（顺序即卡片上的展示顺序）。 */
export const PERSONA_FIELDS = Object.freeze(['name', 'bio', 'tone', 'difficulty']);

/** 非空字符串剪过空白后返回；其余 null。 */
const trimmed = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * 把一份原始对象归一成人设卡。
 * @returns {{name: string, bio: string, tone: string, difficulty: string} | null}
 *   四个字段都齐且都是非空白字符串才算一张卡；否则 `null`（整张不可用，不部分接受）。
 */
export function normalizePersona(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const field of PERSONA_FIELDS) {
    const v = trimmed(raw[field]);
    if (v === null) return null;
    out[field] = v;
  }
  return out;
}

/** 名字的展示上限：超过就截断加省略号（模型偶尔吐一整句当名字；屏上只当标题用）。 */
export const PERSONA_NAME_MAX = 24;

/** 屏上那行副标题：名字底下的身份一句话（bio 超长只取第一句，屏是 390 宽）。 */
export function personaSubtitle(persona) {
  const p = normalizePersona(persona);
  if (p === null) return '';
  const firstSentence = p.bio.split(/[。.!?！？\n]/)[0]?.trim() || p.bio;
  const shown = firstSentence.length > 40 ? `${firstSentence.slice(0, 40)}…` : firstSentence;
  return shown;
}

/** 屏上那行名字（超长截断，`PERSONA_NAME_MAX` 是唯一出处）。 */
export function personaName(persona) {
  const p = normalizePersona(persona);
  if (p === null) return '';
  return p.name.length > PERSONA_NAME_MAX ? `${p.name.slice(0, PERSONA_NAME_MAX)}…` : p.name;
}
