// web/units/teach/knowledge.mjs
//
// 知识资产的**格式校验**与查找。**纯逻辑：零浏览器 API、零副作用**（不读文件——
// 数据由调用方 import/载入后传进来，这样 Node 与浏览器两条路径同源）。
//
// 为什么内容资产需要校验器（设计稿 §11 风险 7）：**英语教学质量是产品的命**，
// 而这些资产既不是代码也不是测试——如果词条缺释义、搭配写错、同一个词录两遍，
// 引擎再好也在教错的东西。校验器不能保证内容**对**，但能挡住"格式不全"与"重复"这两类
// 机械可检的坏法，让内容审校的人只需要看语义。
//
// ---------------------------------------------------------------------------
// 代价（如实记，别含糊过去）
// ---------------------------------------------------------------------------
//   ① 格式校验**不等于教学质量背书**。谁审语义、按什么标准验收，目前**没有流程**
//      （已登记为契约载体的 ASSUMPTIONS 假设 4）——这是本形态最容易被低估的风险。
//      **本模块通过 ≠ 这 20 个词条的英文是对的。**没有任何人审过它们。
//   ② 本模块只认识"字段齐不齐 / 有没有重复"，**不认识**：释义对不对、搭配地不地道、
//      例句是不是真的、易混词区分的语域差别是否成立、某个词值不值得教。
//   ③ 它**不检查** `fits` 里的词与词库是否对得上（某个词可能不被任何情境覆盖，
//      或 `fits` 里出现词库里根本没有的词）——这条交叉一致性目前**没有任何机制检查**。
//      这是已知缺口，如实登记，不在这里偷偷补一个半吊子的检查。
//
// ---------------------------------------------------------------------------
// 字段面的**刻意不对称**（总控授权的两处改动，2026-09-17）
// ---------------------------------------------------------------------------
// 设计稿 §4 对重点词库写的是「词 + **词族** + 搭配 + **例句** + 易混词对比」，
// 而计划 Task 7 的 seed schema 只有四个字段（`headword` / `meaning` / `collocations` /
// `confusables`）——`wordFamily` 与 `example` 不在里面。
//
// 处置：**种子数据补上这两个字段，校验器不把它们设成必填。** 这个不对称是**刻意的**：
//   · 补数据：数据正在被写，现在加是零成本；将来加是一次数据迁移。且"字段面比设计稿 §4 窄"
//     是仓库已登记的缺口。
//   · 不设必填：计划 `plan:1079` 有一条**必须通过**的用例——
//     `{ headword: 'mug', meaning: '马克杯', collocations: ['a coffee mug'] }` ⇒ `length === 0`。
//     把这两个字段设成必填就会弄红计划自带的断言，而**改坏计划自带的断言是不可接受的**。
//   · 后果如实记：校验器**挡不住**"将来有人写了一条新词却忘了 `wordFamily` / `example`"。
//     那一格目前只有数据侧（种子复核）挡得住，没有机械护栏。要补必填需先改 `plan:1079` 那条用例。
//
// ---------------------------------------------------------------------------
// 三处比计划更严的地方（都是"加法"，不弄红计划自带断言）
// ---------------------------------------------------------------------------
//   1. `confusables` **若存在**必须是非空字符串数组。计划的 `validateWords` **完全没检查它**
//      （种子里 20 条每条都有它）。它属于**格式保护**（挡住 `"confusables": "cup"` 这种
//      标量写法与空串成员），不是内容判断。写成"若存在"而不是必填，是为了让计划 `plan:1079`
//      那条最小条目（没有 `confusables`）继续通过。
//   2. 三个列表项（`collocations` / `fits` / `confusables`）的**成员必须是非空字符串**。
//      计划只查了"是不是非空数组"：`collocations: [null]` 与 `['']` 在计划里**通过**。
//      一个空搭配教不了任何东西，一条 `''` 的 `fits` 也指不到任何词。
//   3. 重复检查的 key 做**大小写归一**，但**报错里保留原词**。计划 `plan:1140-1141` 写的是
//      `const key = w.headword.toLowerCase()` 却把 `key` 印进报错里——于是报错文案会
//      **印出一个词库里并不存在的拼写**（写的人看到 `duplicate headword: mug` 会去找小写的
//      `mug`，而库里两条其实是 `Mug` 与 `mug`）。归一用于**比较**，原文用于**给人看**。
//      ⚠️ 计划自带用例（两条都是小写）对这两版**没有区分力**：`['duplicate headword: mug']`
//      两种实现都给得出来（见 `tests/teach-knowledge.test.mjs` 的"大小写不敏感"那组）。
//
// `validateGrammar` 的 `point` 与 `validateScenes` 的 `id` 都**不做**大小写归一（比较用原值）：
// 计划的语义是"同一个语法点 / 同一个情境 id 录两遍"，而两个不同的语法点写在同一行里是**真不同**。
// `englishTrap` 那种大小写差异（两个人都把同一条中式英语记了一遍）**本模块抓不到**——如实记。

/** 契约声明的导出面恰好是这四个。 */
const EXPORTS = Object.freeze(['validateWords', 'validateGrammar', 'validateScenes', 'findWord']);

/** @throws {TypeError} 不是数组（契约违约要**响亮**抛，不许静默放过一份坏资产） */
function assertArray(v, name) {
  if (!Array.isArray(v)) {
    throw new TypeError(`${name}: 必须是数组，收到 ${JSON.stringify(v) ?? String(v)}`);
  }
}

/** 非空字符串（纯空白与空串同罪：留一个空字段等于没写） */
function isFilled(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** 校验词库，返回错误清单（空数组 = 通过）。 */
export function validateWords(list) {
  assertArray(list, 'validateWords');
  const errors = [];
  const seen = new Set();
  list.forEach((w, i) => {
    const headwordOk = isFilled(w?.headword);
    if (!headwordOk) errors.push(`[${i}] 缺 headword`);
    if (!isFilled(w?.meaning)) errors.push(`[${i}] 缺 meaning`);
    // ⚠️ 两类坏法要**报不同的文案**：`collocations: []`（少了整个字段）与 `collocations: ['']`
    //（字段在、但里面是空串）是两回事。写成同一条 `缺 collocations` 会让**后者不可观测**——
    // 本轮实测：V12（把成员检查整行删掉）当时**全绿通过**，根因就是两条分支文案一模一样，
    // 删掉成员分支后返回值逐字不变。护栏要能分辨，报错就得先能分辨。
    if (!Array.isArray(w?.collocations) || w.collocations.length === 0) errors.push(`[${i}] 缺 collocations`);
    else if (!w.collocations.every(isFilled)) errors.push(`[${i}] collocations 里的成员必须都是非空字符串`);
    // `confusables` **若存在**必须是非空字符串数组（可选，见文件头"三处更严的地方" 1）
    if (w?.confusables !== undefined) {
      if (!Array.isArray(w.confusables) || w.confusables.length === 0) errors.push(`[${i}] confusables 存在时不许为空`);
      else if (!w.confusables.every(isFilled)) errors.push(`[${i}] confusables 里的成员必须都是非空字符串`);
    }
    // 查重只在 headword **真的存在**时进行（两条都缺 headword 不是"同一个词录了两遍"），
    // 比较用小写归一，报错用**原文**（见文件头"三处更严的地方" 3）。
    if (headwordOk) {
      const key = w.headword.toLowerCase();
      if (seen.has(key)) errors.push(`duplicate headword: ${w.headword}`);
      seen.add(key);
    }
  });
  return errors;
}

/** 校验语法库。 */
export function validateGrammar(list) {
  assertArray(list, 'validateGrammar');
  const errors = [];
  const seen = new Set();
  list.forEach((g, i) => {
    if (!isFilled(g?.point)) errors.push(`[${i}] 缺 point`);
    if (!isFilled(g?.chineseTrap)) errors.push(`[${i}] 缺 chineseTrap`);
    if (!isFilled(g?.fix)) errors.push(`[${i}] 缺 fix`);
    if (isFilled(g?.point)) {
      if (seen.has(g.point)) errors.push(`duplicate point: ${g.point}`);
      seen.add(g.point);
    }
  });
  return errors;
}

/** 校验情境库。 */
export function validateScenes(list) {
  assertArray(list, 'validateScenes');
  const errors = [];
  const seen = new Set();
  list.forEach((s, i) => {
    if (!isFilled(s?.id)) errors.push(`[${i}] 缺 id`);
    if (!isFilled(s?.setup)) errors.push(`[${i}] 缺 setup`);
    if (!Array.isArray(s?.fits) || s.fits.length === 0) errors.push(`[${i}] 缺 fits`);
    else if (!s.fits.every(isFilled)) errors.push(`[${i}] fits 里的成员必须都是非空字符串`);
    if (isFilled(s?.id)) {
      if (seen.has(s.id)) errors.push(`duplicate id: ${s.id}`);
      seen.add(s.id);
    }
  });
  return errors;
}

/**
 * 按词头查找（大小写不敏感）。找不到返回 null——**不发明词条**。
 *
 * 为什么 `headword` 必须**先是非空字符串**才参与比较（而不是 `String(headword).toLowerCase()`）：
 * `String(null)` = `'null'`、`String(undefined)` = `'undefined'`——**对不存在的输入发明了一个字符串**，
 * 再拿它去比。平时看不出差别，但只要词库里有一条 `headword: "null"`，`findWord(list, null)`
 * 就会返回**词库里的那条**：学习者问 A，系统教 B。本仓出过同形的真事故
 * （`extractContent` 返回 `null` 时界面把 `"null"` 当教学回复显示）。
 * 同理，坏条目（`headword: null`）不许被 `String()` 变成可命中的值。
 *
 * @throws {TypeError} `list` 不是数组（与三个校验器同一个口径，不是静默 null）
 */
export function findWord(list, headword) {
  assertArray(list, 'findWord');
  if (!isFilled(headword)) return null;   // 没给词 / 给了空白 ≠ 找某个词
  const key = headword.toLowerCase();
  return list.find((w) => isFilled(w?.headword) && w.headword.toLowerCase() === key) ?? null;
}

/** 导出面自检：本模块只许导出契约声明的那四个（防止调试期临时导出的内部件留在生产里）。 */
void EXPORTS;
