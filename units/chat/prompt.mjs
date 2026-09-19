// web/units/chat/prompt.mjs
//
// 上行 messages 的唯一组装处（「模型看到的是不是我们以为的东西」只有一个改动点）。
//
// ── VS1 的边界就写在提示词里 ──────────────────────────────────────────────────
// 本切片**没有教学时刻**（纯聊）——提示词明确交代「不纠正、不上课、不主动给翻译」，
// 把上一形态的死因（把模型当产品、给答案杀死学习）挡在门口；教学时刻是 VS2 的切片，
// 到时候这里的「不教」条款跟着改，而不是靠模型自觉。
// 人设**不扮演医疗/心理专家**是契约 NON_GOAL，落点也在这里（提示词说了 + 屏上人设
// 卡不出现这类承诺）。
//
// ── 回复语言是设置，不是人设 ─────────────────────────────────────────────────
// 用户随时可切（英语缺省 / 中文可切），切了**下一次调用就生效**——所以它进的是
// `buildChatMessages` 的参数（每次组 prompt 时读设置），不进人设卡（人设卡不该
// 因为换个回复语言就重生成）。
//
// ── 历史截断（`HISTORY_LIMIT`）────────────────────────────────────────────────
// VS1 没有长期记忆：对话历史是**单会话级**，会一直长。上行只带**最近 N 条**（拍的值：
// 50 条 ≈ 25 个来回，覆盖一天里正常的一次聊天；再久远的上下文本切片本来也不承诺
// 记得住）。截断只影响上行——本地历史一条不删，屏上照旧全量渲染。
//
// 纯逻辑模块：零 import、零浏览器 API。

/** 上行携带的最大历史条数（含双方；system 与本次 user 不占这个额度）。拍的值，未标定。 */
export const HISTORY_LIMIT = 50;

/** 非空字符串才算一条能上行的历史（存储里的坏条目在这里被跳过，不让一条坏数据废掉整次发送）。 */
const usableEntry = (e) => e !== null && typeof e === 'object' && !Array.isArray(e)
  && (e.role === 'user' || e.role === 'assistant')
  && typeof e.content === 'string' && e.content.trim() !== '';

/**
 * 回复语言 → 提示词里的那一句话（两种语言各一段完整交代，不做字符串拼接的偏方）。
 */
function languageClause(replyLanguage) {
  return replyLanguage === 'zh'
    ? '- 用**中文**回复（学习者把回复语言切到了中文；他说什么语言你都回中文，他夹的英文正常理解）。'
    : '- 用**英文**回复，像朋友发消息那样自然、口语；他没学过的词可以偶尔出现，但不堆难词。';
}

/**
 * 系统提示词：人设 + 对话规则（VS1 纯聊版）。
 */
export function systemPrompt(persona, replyLanguage) {
  const p = persona; // 由调用方保证已归一（engine 侧有断言门）
  return [
    `你在陪一位中国的成年人英语学习者聊天。他给自己设计了你的角色，你要把这个角色演活。`,
    `你的角色设定：`,
    `- 名字：${p.name}`,
    `- 身份背景：${p.bio}`,
    `- 语气：${p.tone}`,
    `- 对他英语难度的倾向：${p.difficulty}`,
    ``,
    `对话规则：`,
    languageClause(replyLanguage),
    `- 回复要短，一般一到三句，像真人发消息；别写长篇，别列要点。`,
    `- 他说中文你就顺着中文聊，他说英文你就顺着英文聊；他中英混着说很正常，自然接住。`,
    `- 这是纯聊天，不是上课：**不纠正他的错误、不讲解语法、不主动给翻译、不布置练习**。就算他的英文有错，也先顺着内容聊下去。`,
    `- 每次最多问一个问题，也可以不问；让对话自然流动，别查户口。`,
    `- 保持角色，不主动说自己是 AI 或语言模型；他直接问到就诚实简短地答，然后继续聊。`,
    `- 不扮演医生、心理咨询师等专业人士；聊到健康、情绪的沉重处，如实说自己不是专家，像个朋友那样陪着聊，必要时建议他找真正专业的人。`,
  ].join('\n');
}

/**
 * 组一次聊天腿的上行 messages。
 *
 * @param {object} input
 *   - `persona`：**已归一**的人设卡（`./persona.mjs` 的 `normalizePersona` 产物；
 *     没归一直接传进来是装配错误，当场抛）。
 *   - `history`：`[{role:'user'|'assistant', content}]`，取**最近 `HISTORY_LIMIT` 条**。
 *   - `userText`：这一句要说的话（非空白字符串；空文本当场抛——那是调用方的 bug）。
 *   - `replyLanguage`：`'en' | 'zh'`（缺省 `'en'`；别的值按 `'en'`——设置层已限值域）。
 * @returns {{role:string, content:string}[]}
 */
export function buildChatMessages({ persona, history = [], userText, replyLanguage = 'en' } = {}) {
  const text = typeof userText === 'string' ? userText.trim() : '';
  if (text === '') {
    throw new TypeError('buildChatMessages: userText 必须是非空白字符串（空文本不上行）');
  }
  if (persona === null || typeof persona !== 'object'
    || typeof persona.name !== 'string' || typeof persona.bio !== 'string'
    || typeof persona.tone !== 'string' || typeof persona.difficulty !== 'string') {
    throw new TypeError('buildChatMessages: persona 必须是 normalizePersona 归一过的那张卡');
  }
  const past = (Array.isArray(history) ? history : []).filter(usableEntry)
    .map((e) => ({ role: e.role, content: e.content }))
    .slice(-HISTORY_LIMIT);
  return [
    { role: 'system', content: systemPrompt(persona, replyLanguage === 'zh' ? 'zh' : 'en') },
    ...past,
    { role: 'user', content: text },
  ];
}

/**
 * 人设生成腿的上行 messages：一句话描述 → 一张 JSON 人设卡。
 * 产出的 JSON 由 `./engine.mjs` 用 `../write/parse.mjs` 的 parseEnvelope 解、
 * `./persona.mjs` 的 normalizePersona 归一——本函数只负责「怎么问」。
 */
export function buildPersonaGenMessages({ description } = {}) {
  const d = typeof description === 'string' ? description.trim() : '';
  if (d === '') {
    throw new TypeError('buildPersonaGenMessages: description 必须是非空白字符串');
  }
  return [
    {
      role: 'system',
      content: [
        `你是人设卡生成器。学习者用一句话描述了他想跟谁练英语聊天，你把这句话扩成一张人设卡。`,
        `只输出一个 JSON 对象，不要输出任何别的文字。字段：`,
        `- "name"：名字，2 到 12 个字，像真人的名字（可以是中文名或外文名，跟着描述的气质走）`,
        `- "bio"：身份背景，一到两句中文，具体一点（住哪、做什么、日子怎么过）`,
        `- "tone"：语气，一句中文描述他怎么说话（例：松弛爱开玩笑 / 干脆直接 / 温和不催）`,
        `- "difficulty"：从「入门」「适中」「进阶」里选一个词，估计这位学习者合适的英语难度`,
      ].join('\n'),
    },
    { role: 'user', content: d },
  ];
}
