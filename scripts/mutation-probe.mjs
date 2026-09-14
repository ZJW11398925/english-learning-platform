/**
 * 变异探针（可重复运行的证据生成器，零依赖、非测试文件）。
 *
 * 用途：把 review 轮（`rv3-probe.mjs`）枚举的 18 个变异体 + Task 4 的 11 个变异体固化成仓库内
 * 可复跑的证据——逐个"把实现改坏"，跑 `tests/scheduler.test.mjs` + `tests/pick-word.test.mjs` +
 * `tests/feedback.test.mjs`，报告每个变异体是被测试抓到（DETECTED）还是溜过去了（MISSED），
 * 只要有该抓没抓到的就以非零码退出。
 *
 * 用法（在仓库根）：
 *   node scripts/mutation-probe.mjs            # 全部 29 个变异体
 *   node scripts/mutation-probe.mjs --only=M2  # 只跑名字含 M2 的（F/Q 同理）
 *   KEEP_TMP=1 node scripts/mutation-probe.mjs # 保留临时工作树以便排查
 *
 * 三条护栏（少一条结论就可能是假阴性）：
 * 1. **不碰仓库源码**。变异只写进 `os.tmpdir()` 下的临时工作树（`<tmp>/web/units/*.mjs` +
 *    `<tmp>/tests/*.test.mjs` 的逐字副本），跑完把临时模块按字节还原，并用 sha256 逐次核对；
 *    同时每次变异后都核对仓库里各模块的哈希未变。进程被强杀也不会留下被改坏的仓库文件。
 * 2. **基线必须先绿**。临时树跑原实现若不 0 退出，整轮结论作废（直接失败退出）。
 * 3. **退出码取自子进程的 `exit` 事件**。本环境不允许 piped 子进程 stdio，且 `node:test` 在
 *    `beforeExit` 时还没写 `process.exitCode`（那时仍是 0）——所以既不能用管道拿输出，也不能
 *    让子进程自报结果：只用 exit 事件的 code 判定。子进程输出改写到日志文件（文件描述符，不是管道）。
 *
 * 变异体元数据：`expect: 'detected'` = 必须被测试抓到；`expect: 'equivalent'` = 与真实现**语义
 * 等价**（构造上不可能被抓到，见该条 why）。等价的那些不算漏网，但必须由差分核对证明等价，
 * 证明不过就反过来算漏网（说明它其实可被抓到）。
 *
 * 结论：见文末运行输出的汇总行（Task 3：17/17 可抓变异体 DETECTED + M2 证为等价变异体；
 * Task 4：11/11 可抓变异体 DETECTED，见 `task-4-report.md`）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_FILES = {
  scheduler: 'web/units/scheduler.mjs',
  'pick-word': 'web/units/pick-word.mjs',
  feedback: 'web/units/feedback.mjs',
};
const TEST_FILES = ['tests/scheduler.test.mjs', 'tests/pick-word.test.mjs', 'tests/feedback.test.mjs'];
const TEST_ARGS = ['--test', ...TEST_FILES];
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────────────────────────────────── 变异体定义
// 每条 find 必须是当前实现里的**唯一原文**：找不到即 PATCH-FAILED 并以非零码退出，
// 这样源码漂移不会被悄悄吞掉（探针自己也会被"钉住"）。
const SCHED = MODULE_FILES.scheduler;
const PICK = MODULE_FILES['pick-word'];
const FEEDBACK = MODULE_FILES.feedback;

const PICK_ORIGINAL = `export function pickWord({ candidates, acceptableSets, exclude = [] }) {
  const accepted = new Set();
  for (const labels of Object.values(acceptableSets)) for (const l of labels) accepted.add(l);

  for (const c of candidates) {
    if (!accepted.has(c.label)) continue;
    if (exclude.includes(c.label)) continue;
    return { word: c.label, reason: \`候选 \${c.label} 命中可接受集\` };
  }
  return null;
}`;

const NEXTSTATE_ORIGINAL = `export function nextState(word, now) {
  const stage = (word.stage ?? 0) + 1;
  if (stage > INTERVALS_DAYS.length) {
    return { ...word, stage, dueAt: null, maintained: true, lastReviewedAt: now };
  }
  return { ...word, stage, dueAt: now + INTERVALS_DAYS[stage - 1] * DAY_MS, lastReviewedAt: now };
}`;

const FILTER_ORIGINAL = `.filter((w) => !isMaintained(w) && w.dueAt !== null && w.dueAt <= now)
    .sort((a, b) => (a.dueAt - b.dueAt) || compareId(a.id, b.id));`;
const SORT_ORIGINAL = `.sort((a, b) => (a.dueAt - b.dueAt) || compareId(a.id, b.id));`;

const MUTANTS = [
  // ── scheduler：M1–M14 ──
  {
    name: 'M1_dropIsMaintained', target: SCHED, expect: 'detected',
    why: 'dueWords 丢掉 !isMaintained：maintained 但 dueAt 还在过去的词会被当待办推出来',
    find: FILTER_ORIGINAL,
    replace: `.filter((w) => w.dueAt !== null && w.dueAt <= now)
    .sort((a, b) => (a.dueAt - b.dueAt) || compareId(a.id, b.id));`,
  },
  {
    name: 'M2_dropDueAtNotNull', target: SCHED, expect: 'equivalent',
    why: 'dueWords 丢掉中间那条 w.dueAt !== null。**构造上不可抓**：该条只在 !isMaintained(w) && w.dueAt === null '
      + '时才有区别，而 isMaintained 对 dueAt === null 恒返回 true，故条件不可满足；dueAt 为 undefined/NaN/字符串时 '
      + '`<= now` 两边同为 false，也过滤得掉。因此它是一条**等价变异体**，不是漏网（这正是它需要一条'
      + '「钉住 isMaintained 的 dueAt===null 分支」的测试来当正当性的原因）',
    find: FILTER_ORIGINAL,
    replace: `.filter((w) => !isMaintained(w) && w.dueAt <= now)
    .sort((a, b) => (a.dueAt - b.dueAt) || compareId(a.id, b.id));`,
  },
  {
    name: 'M3_noSort', target: SCHED, expect: 'detected',
    why: '去掉排序（brief 原实现）：输出退回 Object.values 的键插入顺序',
    find: FILTER_ORIGINAL,
    replace: `.filter((w) => !isMaintained(w) && w.dueAt !== null && w.dueAt <= now);`,
  },
  {
    name: 'M4_anchorOldDueAt', target: SCHED, expect: 'detected',
    why: '间隔从旧 dueAt 起算而不是从完成时刻 now 起算',
    find: 'dueAt: now + INTERVALS_DAYS[stage - 1] * DAY_MS',
    replace: 'dueAt: (word.dueAt ?? now) + INTERVALS_DAYS[stage - 1] * DAY_MS',
  },
  {
    name: 'M5_difficultyShifts', target: SCHED, expect: 'detected',
    why: '自评难度开始影响间隔（首版明确禁止的自适应）',
    find: 'dueAt: now + INTERVALS_DAYS[stage - 1] * DAY_MS',
    replace: "dueAt: now + (INTERVALS_DAYS[stage - 1] + (word.difficulty === 'hard' ? 1 : 0)) * DAY_MS",
  },
  {
    name: 'M6_dropsDifficulty', target: SCHED, expect: 'detected',
    why: '推进状态时把 difficulty 丢掉（自评结果没留下来）',
    find: '  return { ...word, stage, dueAt: now + INTERVALS_DAYS[stage - 1] * DAY_MS, lastReviewedAt: now };',
    replace: '  const { difficulty, ...rest } = word;\n'
      + '  return { ...rest, stage, dueAt: now + INTERVALS_DAYS[stage - 1] * DAY_MS, lastReviewedAt: now };',
  },
  {
    name: 'M7_strictLt', target: SCHED, expect: 'detected',
    why: '到期判定 <= 变成 <：到期当刻不算到期',
    find: 'w.dueAt <= now',
    replace: 'w.dueAt < now',
  },
  {
    name: 'M8_inPlace', target: SCHED, expect: 'detected',
    why: 'nextState 就地改写入参并返回同一个对象（调用方留不下旧状态）',
    find: NEXTSTATE_ORIGINAL,
    replace: `export function nextState(word, now) {
  word.stage = (word.stage ?? 0) + 1;
  word.dueAt = word.stage > INTERVALS_DAYS.length ? null : now + INTERVALS_DAYS[word.stage - 1] * DAY_MS;
  word.lastReviewedAt = now;
  if (word.dueAt === null) word.maintained = true;
  return word;
}`,
  },
  {
    name: 'M9_terminalNoFlag', target: SCHED, expect: 'detected',
    why: '终态忘了 maintained: true（只置 dueAt: null）',
    find: 'return { ...word, stage, dueAt: null, maintained: true, lastReviewedAt: now };',
    replace: 'return { ...word, stage, dueAt: null, lastReviewedAt: now };',
  },
  {
    name: 'M10_earlyMaintained', target: SCHED, expect: 'detected',
    why: '提前一档转 maintained：1/3/7 里的 7 天档永远不会被派发',
    find: 'if (stage > INTERVALS_DAYS.length) {',
    replace: 'if (stage >= INTERVALS_DAYS.length) {',
  },
  {
    name: 'M11_copies', target: SCHED, expect: 'detected',
    why: 'dueWords 返回对象的副本而不是存储层里的原记录（按 id 写回会写丢/写错）',
    find: SORT_ORIGINAL,
    replace: `${SORT_ORIGINAL.replace(/;$/, '')}\n    .map((w) => ({ ...w }));`,
  },
  {
    name: 'M12_noStageDefault', target: SCHED, expect: 'detected',
    why: '丢掉 stage ?? 0 兜底：stage 缺失的新词算不出 dueAt',
    find: 'const stage = (word.stage ?? 0) + 1;',
    replace: 'const stage = word.stage + 1;',
  },
  {
    name: 'M13_noDueAtNullDisjunct', target: SCHED, expect: 'detected',
    why: 'isMaintained 只剩 maintained 标志，丢掉 dueAt === null 分支',
    find: 'return word.maintained === true || word.dueAt === null;',
    replace: 'return word.maintained === true;',
  },
  {
    name: 'M14_noMaintainedDisjunct', target: SCHED, expect: 'detected',
    why: 'isMaintained 只看 dueAt === null，丢掉 maintained 标志分支',
    find: 'return word.maintained === true || word.dueAt === null;',
    replace: 'return word.dueAt === null;',
  },
  // ── pick-word：Q1–Q4 ──
  {
    name: 'Q1_scoreOrder', target: PICK, expect: 'detected',
    why: '先按 score 降序再取第一个可接受候选：让模型置信度左右了选词',
    find: PICK_ORIGINAL,
    replace: `export function pickWord({ candidates, acceptableSets, exclude = [] }) {
  const accepted = new Set();
  for (const labels of Object.values(acceptableSets)) for (const l of labels) accepted.add(l);
  const first = [...candidates].sort((a, b) => b.score - a.score)
    .find((c) => accepted.has(c.label) && !exclude.includes(c.label));
  return first ? { word: first.label, reason: \`候选 \${first.label} 命中可接受集\` } : null;
}`,
  },
  {
    name: 'Q2_topScoreFirst', target: PICK, expect: 'detected',
    why: '只看最高分候选是否可接受：高分上位词会把后面的可接受词一起挡掉',
    find: PICK_ORIGINAL,
    replace: `export function pickWord({ candidates, acceptableSets, exclude = [] }) {
  const accepted = new Set();
  for (const labels of Object.values(acceptableSets)) for (const l of labels) accepted.add(l);
  const [top] = [...candidates].sort((a, b) => b.score - a.score);
  if (!top || !accepted.has(top.label) || exclude.includes(top.label)) return null;
  return { word: top.label, reason: \`候选 \${top.label} 命中可接受集\` };
}`,
  },
  {
    name: 'Q3_ignoresExclude', target: PICK, expect: 'detected',
    why: '忽略 exclude：复现时会把刚学过的同一个词再取一次',
    find: PICK_ORIGINAL,
    replace: `export function pickWord({ candidates, acceptableSets, exclude = [] }) {
  const accepted = new Set();
  for (const labels of Object.values(acceptableSets)) for (const l of labels) accepted.add(l);
  const first = candidates.find((c) => accepted.has(c.label));
  return first ? { word: first.label, reason: \`候选 \${first.label} 命中可接受集\` } : null;
}`,
  },
  {
    name: 'Q4_hypernymFallback', target: PICK, expect: 'detected',
    why: '无可接受候选时退而返回上位词（把取词失败伪装成成功）',
    find: PICK_ORIGINAL,
    replace: `export function pickWord({ candidates, acceptableSets, exclude = [] }) {
  const accepted = new Set();
  for (const labels of Object.values(acceptableSets)) for (const l of labels) accepted.add(l);
  const ok = candidates.find((c) => accepted.has(c.label) && !exclude.includes(c.label));
  const loose = ok ?? candidates.find((c) => !exclude.includes(c.label));
  return loose ? { word: loose.label, reason: \`候选 \${loose.label} 命中可接受集\` } : null;
}`,
  },
  // ── feedback（Task 4）：F1–F10 ──
  {
    name: 'F1_binaryVerdicts', target: FEEDBACK, expect: 'detected',
    why: '从合法档位里删掉 uncertain，逼模型在"对/错"二选一（全局约束 4 的反面：拿不准会被逼成自信的错答案）',
    find: "export const VERDICTS = Object.freeze(['correct', 'flawed', 'uncertain']);",
    replace: "export const VERDICTS = Object.freeze(['correct', 'flawed']);",
  },
  {
    name: 'F2_disguiseUncertain', target: FEEDBACK, expect: 'detected',
    why: '把 uncertain 改写成 flawed 后照样报成功——最坏的静默降级：调用方看不出异常，'
      + 'uncertain 单独统计的口径（全局约束 4）被污染',
    find: '  return errors.length === 0 ? { ok: true, value: raw } : { ok: false, errors };',
    replace: '  if (errors.length > 0) return { ok: false, errors };\n'
      + "  return { ok: true, value: raw.verdict === 'uncertain' ? { ...raw, verdict: 'flawed' } : raw };",
  },
  {
    name: 'F3_blankRewriteOk', target: FEEDBACK, expect: 'detected',
    why: '空白串 rewrite 被当成合法改写建议（模型没真给出改写，界面会显示一段空白当建议）',
    find: "    if (typeof raw.rewrite !== 'string' || raw.rewrite.trim() === '') {",
    replace: "    if (typeof raw.rewrite !== 'string') {",
  },
  {
    name: 'F4_correctSideInverted', target: FEEDBACK, expect: 'detected',
    why: 'correct 一侧的搭配关系反向：判"对"却带着错误类型的数据会入库（统计里"通过的句子"带着语法错误）',
    find: "    if (raw.verdict === 'correct' && raw.error_type !== 'none') {",
    replace: "    if (raw.verdict === 'correct' && raw.error_type === 'none') {",
  },
  {
    name: 'F5_flawedSideInverted', target: FEEDBACK, expect: 'detected',
    why: 'flawed 一侧的关系反向：放行"有错却说不清错在哪"，同时把正常的 flawed 响应全判成不可用',
    find: "    if (raw.verdict === 'flawed' && raw.error_type === 'none') {",
    replace: "    if (raw.verdict === 'flawed' && raw.error_type !== 'none') {",
  },
  {
    name: 'F6_failFast', target: FEEDBACK, expect: 'detected',
    why: '在第一条缺字段上短路：调用方一次只看到一个缺失字段（brief 的用例要求同时报出 rewrite 与 note）',
    find: `  for (const k of REQUIRED_FIELDS) {
    if (!(k in raw)) errors.push(\`缺少字段 \${k}\`);
  }`,
    replace: '  const missing = REQUIRED_FIELDS.find((k) => !(k in raw));\n'
      + '  if (missing) return { ok: false, errors: [`缺少字段 ${missing}`] };',
  },
  {
    name: 'F7_arrayAllowed', target: FEEDBACK, expect: 'detected',
    why: '去掉 Array.isArray 拦截：数组（typeof 也是 object）被当成"缺四个字段"的对象，'
      + '诊断指向错误的原因——真正的问题是它根本不是响应对象',
    find: "  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {",
    replace: "  if (raw === null || typeof raw !== 'object') {",
  },
  {
    name: 'F8_relationshipUnguarded', target: FEEDBACK, expect: 'detected',
    why: '搭配关系不再等两个字段各自合法：取值越界时叠加一句"搭配错了"，把诊断带偏',
    find: '  if (verdictInRange && errorTypeInRange) {',
    replace: "  if ('verdict' in raw && 'error_type' in raw) {",
  },
  {
    name: 'F9_doubleReportOnMissing', target: FEEDBACK, expect: 'detected',
    why: '字段缺失时同时按缺字段和"取值越界: undefined"各报一遍：同一件事说两遍，诊断翻倍',
    find: "  if ('verdict' in raw && !verdictInRange) {",
    replace: '  if (!verdictInRange) {',
  },
  {
    name: 'F10_valueCopy', target: FEEDBACK, expect: 'detected',
    why: '成功时返回入参的副本而不是入参本身：破坏"原样返回"的同一引用契约（调用方拿着返回值'
      + '与库里那条记录不是同一个对象，就地更新/同一性判断会失配）',
    find: '  return errors.length === 0 ? { ok: true, value: raw } : { ok: false, errors };',
    replace: '  return errors.length === 0 ? { ok: true, value: { ...raw } } : { ok: false, errors };',
  },
  {
    name: 'F11_unfrozenConstants', target: FEEDBACK, expect: 'detected',
    why: '去掉 Object.freeze：档位变成可运行时改动的普通数组——统计口径的契约就此可被'
      + '任何一处 import 悄悄改写（改完还不报错）',
    find: "export const VERDICTS = Object.freeze(['correct', 'flawed', 'uncertain']);",
    replace: "export const VERDICTS = ['correct', 'flawed', 'uncertain'];",
  },
];

// ─────────────────────────────────────────────────────────── 工具
/** 跑一次聚焦测试，只信 **exit 事件的 code**（本环境不能读子进程管道输出）。 */
function runTests(cwd, logPath) {
  const fd = fs.openSync(logPath, 'w');
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch { /* 已关 */ } } };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, TEST_ARGS, { cwd, stdio: ['ignore', fd, fd] });
    child.on('exit', (code, signal) => { close(); resolve({ code, signal }); });
    child.on('error', (err) => { close(); resolve({ code: null, signal: null, error: err }); });
  });
}

/** 从 node:test 输出里取出失败的用例名（拿不到就返回空数组，判定仍以退出码为准）。 */
function failingTests(logPath) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return []; }
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/.exec(line.trim());
    if (!m) continue;
    const name = m[1].trim();
    if (name.endsWith('.mjs') || name === 'failing tests:') continue; // 文件级失败行与汇总标题不算用例
    names.push(name);
  }
  return [...new Set(names)];
}

/**
 * 变异体自身必须是**能解析的**合法模块：否则它只会让测试加载失败（退出码非 0），
 * 那种"抓到"是崩溃而不是断言，会伪造出 DETECTED。这里用去 export 后 `new Function` 做语法门。
 * （本仓库两个模块只用 `export function` / `export const`，没有 import / 顶层 await。）
 */
function syntaxOk(source, rel) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(source.replace(/^export /gm, ''));
    return null;
  } catch (err) {
    return `变异体语法错误（${rel}）：${err.message}`;
  }
}

/**
 * 差分核对用的"可观察输出视图"：按**目标模块**取，每个模块各一份。
 * 键与 `MUTANTS[].target` 同空间（模块相对路径，本文件一路以路径为模块键）。
 * 视图必须只看被测模块真正承诺的行为（scheduler 的四个输出、pick-word 的选词结果、
 * feedback 的常量与校验结果），这样"差分一致"才有资格当"语义等价"的证据。
 */
const DIFF_VIEWS = {
  [SCHED]: (mod) => {
    const NOW = 1757850000000;
    const shapes = [
      { dueAt: NOW - 1 }, { dueAt: NOW }, { dueAt: NOW + 1 }, { dueAt: 0 }, { dueAt: -1 },
      { dueAt: null }, {}, { dueAt: undefined }, { dueAt: Number.NaN }, { dueAt: 'abc' }, { dueAt: '' },
      { dueAt: Number.POSITIVE_INFINITY }, { dueAt: Number.NEGATIVE_INFINITY },
      { dueAt: NOW, maintained: true }, { dueAt: null, maintained: false }, { dueAt: NOW - 1, maintained: false },
    ];
    const words = Object.fromEntries(shapes.map((s, i) => [`w${i}`, { id: `w${i}`, stage: 1, ...s }]));
    return JSON.stringify({
      due: mod.dueWords(words, NOW).map((w) => w.id),
      flags: Object.values(words).map((w) => mod.isMaintained(w)),
      next: Object.values(words).map((w) => mod.nextState({ ...w }, NOW)),
      intervals: [...mod.INTERVALS_DAYS],
    });
  },
  [PICK]: (mod) => {
    const sets = { mug: ['mug', 'cup'], kettle: ['kettle'] };
    const cases = [
      { candidates: [{ label: 'mug', score: 0.9 }], acceptableSets: sets, exclude: [] },
      { candidates: [{ label: 'container', score: 0.95 }, { label: 'cup', score: 0.6 }], acceptableSets: sets, exclude: [] },
      { candidates: [{ label: 'kettle', score: 0.5 }, { label: 'mug', score: 0.5 }], acceptableSets: sets, exclude: [] },
      { candidates: [{ label: 'mug', score: 0.9 }], acceptableSets: sets, exclude: ['mug'] },
      { candidates: [{ label: 'container', score: 0.9 }], acceptableSets: sets, exclude: [] },
      { candidates: [], acceptableSets: sets, exclude: [] },
      { candidates: [{ label: 'kettle', score: 0.5 }], acceptableSets: sets },
    ];
    return JSON.stringify(cases.map((c) => mod.pickWord(c)));
  },
  [FEEDBACK]: (mod) => {
    const inputs = [
      null, undefined, 42, 'correct', true, () => {}, [],
      ['correct', 'none', null, 'note'],
      {}, { verdict: 'correct' }, { verdict: 'bad', error_type: 'none', rewrite: null, note: 'x' },
      { verdict: 'correct', error_type: 'none', rewrite: null, note: 'x' },
      { verdict: 'correct', error_type: 'grammar', rewrite: 'a', note: 'b' },
      { verdict: 'correct', error_type: 'spelling', rewrite: null, note: 'x' },
      { verdict: 'flawed', error_type: 'none', rewrite: 'a', note: 'b' },
      { verdict: 'flawed', error_type: 'collocation', rewrite: 'a', note: 'b' },
      { verdict: 'flawed', error_type: 'spelling', rewrite: 42, note: 7 },
      { verdict: 'uncertain', error_type: 'none', rewrite: null, note: '拿不准' },
      { verdict: 'uncertain', error_type: 'grammar', rewrite: '   ', note: ' ' },
      { verdict: 'uncertain', error_type: 'word_choice', rewrite: '  spaced  ', note: ' ok ' },
    ];
    return JSON.stringify({
      verdicts: [...mod.VERDICTS],
      errorTypes: [...mod.ERROR_TYPES],
      results: inputs.map((i) => mod.validateFeedback(i)),
    });
  },
};

/**
 * 差分核对：变异体与真实现是否在给定输入域上给出完全相同的输出。
 * 目标模块没有定义视图时**返回不一致**（保守方向：等价主张证明不过，就按漏网处理），而不是抛错中断整轮。
 */
async function differentialAgreement(targetKey, pristinePath, mutantPath) {
  const view = DIFF_VIEWS[targetKey];
  if (!view) return { agree: false, real: '（无）', mutant: `未为 ${targetKey} 定义差分视图` };
  const load = async (p) => import(`${pathToFileURL(p).href}?v=${Date.now()}${Math.random()}`);
  const [real, mutant] = [await load(pristinePath), await load(mutantPath)];
  const [a, b] = [view(real), view(mutant)];
  return { agree: a === b, real: a, mutant: b };
}

// ─────────────────────────────────────────────────────────── 主流程
const pristine = Object.fromEntries(
  Object.values(MODULE_FILES).map((rel) => [rel, fs.readFileSync(path.join(REPO, rel))]),
);
const repoHashes = Object.fromEntries(Object.entries(pristine).map(([rel, buf]) => [rel, sha256(buf)]));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task3-mutation-probe-'));
const tmpModule = Object.fromEntries(
  Object.values(MODULE_FILES).map((rel) => [rel, path.join(tmpRoot, rel)]),
);
const logPath = path.join(tmpRoot, 'probe-run.log');
const results = [];
let hardFailure = null;

try {
  // 临时树：测试文件逐字副本 + 模块原实现副本
  for (const rel of [...Object.values(MODULE_FILES), ...TEST_FILES]) {
    const dest = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), dest);
  }

  // 护栏 1：基线必须绿
  const base = await runTests(tmpRoot, logPath);
  const baselineOk = base.code === 0;
  console.log(`基线（临时树 · 原实现）：exit=${base.code} ${baselineOk ? '✓ 绿' : '✗ 非绿 —— 整轮结论作废'}`);
  if (!baselineOk) {
    console.log(fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-25).join('\n'));
    hardFailure = '基线不绿：探针自身不可信，先修基线';
  }

  const selected = MUTANTS.filter((m) => m.name.includes(only));
  if (!hardFailure) {
    for (const m of selected) {
      const target = tmpModule[m.target];
      const rel = m.target; // 模块键就是相对路径（原先误写成 MODULE_FILES[m.target]，诊断里会打印 undefined）
      // 每条 find 必须命中当前实现且唯一，否则视为探针自身失效
      const count = pristine[m.target].toString('utf8').split(m.find).length - 1;
      if (count !== 1) {
        results.push({ ...m, verdict: `PATCH-FAILED（find 命中 ${count} 次）`, caught: [], exit: null });
        hardFailure = `变异体 ${m.name} 的 find 在 ${rel} 里命中 ${count} 次（应为 1）——源码已漂移，探针需同步`;
        break;
      }
      const mutated = pristine[m.target].toString('utf8').replace(m.find, m.replace);
      const syntaxError = syntaxOk(mutated, rel);
      if (syntaxError) {
        results.push({ ...m, verdict: `PATCH-FAILED（${syntaxError}）`, caught: [], exit: null });
        hardFailure = syntaxError;
        break;
      }
      fs.writeFileSync(target, mutated);

      const { code, signal } = await runTests(tmpRoot, logPath);
      const caught = failingTests(logPath);
      const detected = code !== 0;

      // 还原临时模块并按哈希核对"逐字节还原"
      fs.writeFileSync(target, pristine[m.target]);
      const restored = sha256(fs.readFileSync(target)) === repoHashes[m.target];

      // 仓库源码必须一直没被碰过
      const repoIntact = Object.values(MODULE_FILES)
        .every((r) => sha256(fs.readFileSync(path.join(REPO, r))) === repoHashes[r]);

      let verdict;
      if (m.expect === 'detected') {
        verdict = detected ? 'DETECTED' : 'MISSED';
      } else {
        // 声称等价的：必须由差分核对证明等价，证明不过则反过来按漏网处理
        const equivPath = path.join(tmpRoot, `equiv-${m.name}.mjs`);
        fs.writeFileSync(equivPath, mutated);
        const diff = await differentialAgreement(m.target, target, equivPath);
        const proved = !detected && diff.agree;
        verdict = proved ? 'EQUIVALENT（差分核对一致，构造上不可抓）'
          : `OVERCLAIM（差分不一致或其实被抓到 → 按漏网处理）`;
      }
      results.push({ ...m, verdict, caught, exit: code, signal, restored, repoIntact });
      if (!hardFailure && ((m.expect === 'detected' && !detected) || (m.expect !== 'detected' && verdict.startsWith('OVERCLAIM')))) {
        hardFailure = `变异体 ${m.name} 未被测试抓到（期望：${m.expect}）`;
      }
      if (!restored || !repoIntact) {
        hardFailure = `变异体 ${m.name} 之后模块字节未还原（restored=${restored} repoIntact=${repoIntact}）`;
      }
      if (hardFailure) break;
    }
  }
} finally {
  results.forEach((r) => {
    console.log(`\n[${r.verdict}] ${r.name}  (${r.target}, exit=${r.exit}${r.signal ? `, signal=${r.signal}` : ''})`);
    console.log(`  为什么算坏：${r.why}`);
    if (r.caught.length) console.log(`  抓到它的用例：${r.caught.slice(0, 3).join(' / ')}${r.caught.length > 3 ? ` …（共 ${r.caught.length} 条）` : ''}`);
    else if (r.exit !== 0) console.log('  抓到它的用例：（退出码非 0 但未解析出用例名——本环境不读管道输出，日志在临时树里）');
  });
  if (process.env.KEEP_TMP === '1') console.log(`\n临时工作树保留在：${tmpRoot}`);
  else fs.rmSync(tmpRoot, { recursive: true, force: true });
}

const detectedCount = results.filter((r) => r.verdict === 'DETECTED').length;
const missed = results.filter((r) => r.verdict === 'MISSED');
const overclaim = results.filter((r) => r.verdict.startsWith('OVERCLAIM'));
const patchFailed = results.filter((r) => r.verdict.startsWith('PATCH-FAILED'));
const equivalent = results.filter((r) => r.verdict.startsWith('EQUIVALENT'));

console.log('\n================ 汇总 ================');
console.log(`变异体：${results.length}/${MUTANTS.length}（--only=${only || '（全部）'}）`);
console.log(`DETECTED（被测试抓到）：${detectedCount}`);
console.log(`EQUIVALENT（与真实现等价，构造上不可抓，已差分核对）：${equivalent.length}${equivalent.length ? ` → ${equivalent.map((r) => r.name).join(', ')}` : ''}`);
console.log(`MISSED（该抓没抓到）：${missed.length}${missed.length ? ` → ${missed.map((r) => r.name).join(', ')}` : ''}`);
console.log(`OVERCLAIM（声称等价但差分不一致）：${overclaim.length}`);
console.log(`PATCH-FAILED（探针与源码不同步）：${patchFailed.length}`);
if (hardFailure) console.log(`判定：FAIL —— ${hardFailure}`);
else console.log('判定：PASS —— 可抓变异体无一漏网，仓库源码全程未被改动');
process.exitCode = hardFailure ? 1 : 0;
