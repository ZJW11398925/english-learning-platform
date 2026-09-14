/**
 * 变异探针（可重复运行的证据生成器，零依赖、非测试文件）。
 *
 * 用途：把 review 轮（`rv3-probe.mjs`）枚举的 18 个变异体 + Task 4 的 12 个变异体 + Task 5 修复轮
 * 的 3 个环境校验变异体 + Task 6 的 26 个（状态机 13 + 相机/灰度 13）+ Task 7 的 8 个识物变异体
 * 固化成仓库内可复跑的证据——逐个"把实现改坏"，跑 `tests/` 下被登记的那 9 个测试文件，报告每个
 * 变异体是被测试抓到（DETECTED）还是溜过去了（MISSED），只要有该抓没抓到的就以非零码退出。
 *
 * 用法（在仓库根）：
 *   node scripts/mutation-probe.mjs            # 全部 67 个变异体
 *   node scripts/mutation-probe.mjs --only=M2  # 只跑 M2（`--only=F` = 整个 F 系列；规则见下）
 *   KEEP_TMP=1 node scripts/mutation-probe.mjs # 保留临时工作树以便排查
 *
 * `--only` 的匹配规则（大小写敏感；按变异体 **ID** 匹配，ID = 名字里第一个 `_` 之前那段，如
 * `F12_messageDropsValue` → `F12`）：
 *   1. 先按 ID **全串相等**——`--only=M1` 只跑 M1（不再连带 M10–M14），`--only=F12` 只跑 F12；
 *   2. 没有精确命中时退化为**族匹配**（ID 以该串开头）——`--only=F` 跑 F1…F12，`--only=Q` 跑 Q1…Q4，
 *      `--only=S` 跑 Task 6 的状态机 13 条，`--only=C` 跑相机/灰度 13 条，`--only=R` 跑 Task 7 的 8 条；
 *   3. 两者皆空即当场 FAIL（并列出全部可用 ID），绝不"跑 0 个然后 PASS"。
 * 这修掉了原先的子串匹配：那时 `--only=F` 会把 `M9_terminalNoFlag`、`Q2_topScoreFirst`、
 * `Q4_hypernymFallback` 一起选中（14 个而不是 11 个），选中的集合与"只看 F 系列"的意图不符。
 * 不给 `--only=` 或给空值即全跑。
 *
 * 四条护栏（少一条结论就可能是假阴性）：
 * 1. **不碰仓库源码**。变异只写进 `os.tmpdir()` 下的临时工作树（`<tmp>/web/units/*.mjs` +
 *    `<tmp>/tests/*.test.mjs` 的逐字副本），跑完把临时模块按字节还原，并用 sha256 逐次核对；
 *    同时每次变异后都核对仓库里各模块的哈希未变。进程被强杀也不会留下被改坏的仓库文件。
 * 2. **基线必须先绿**。临时树跑原实现若不 0 退出，整轮结论作废（直接失败退出）。
 * 3. **退出码取自子进程的 `exit` 事件**。本环境不允许 piped 子进程 stdio，且 `node:test` 在
 *    `beforeExit` 时还没写 `process.exitCode`（那时仍是 0）——所以既不能用管道拿输出，也不能
 *    让子进程自报结果：只用 exit 事件的 code 判定。子进程输出改写到日志文件（文件描述符，不是管道）。
 * 4. **每次运行有墙钟上限**（`CHILD_TIMEOUT_MS`）。`node:test` 默认超时是 `Infinity`，没有这道闸，
 *    一条"把测试跑挂"的变异体会让整个探针无限期挂住且不给任何诊断（本项目已吃过一次同款亏）。
 *    超时即强杀整棵进程树，并按"未抓到"单列一类（`TIMEOUT`，与 `MISSED` 分开打印），挂住 ≠ 干净失败。
 *
 * 变异体元数据：`expect: 'detected'` = 必须被测试抓到；`expect: 'equivalent'` = 与真实现**语义
 * 等价**（构造上不可能被抓到，见该条 why）。等价的那些不算漏网，但必须由差分核对证明等价，
 * 证明不过就反过来算漏网（说明它其实可被抓到）。
 *
 * 结论：见文末运行输出的汇总行（Task 3：17/17 可抓变异体 DETECTED + M2 证为等价变异体；
 * Task 4：12/12 可抓变异体 DETECTED，见 `task-4-report.md`；
 * Task 5 修复轮：N1–N3 → 3/3 DETECTED，见 `task-5-report.md` 修复轮一节；
 * Task 6：S1–S13 与 C1–C13 → 26/26 DETECTED，见 `task-6-report.md`；
 * Task 7：R1–R8 → 8/8 DETECTED，见 `task-7-report.md`）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 被变异 / 被复制进临时树的模块。
 *
 * Task 6 起这张表里**不全是变异目标**：`state-machine` 与 `camera` 有对应变异体；
 * `app` / `frame-qc` / `event-log` 没有变异体，它们进表只是为了让临时树里"测试 import 得到"——
 * `tests/state-machine.test.mjs` import `web/app.mjs`，app 又（按需）动态 import
 * `units/frame-qc.mjs`、`units/event-log.mjs`；少复制一个，临时树里的测试就会因缺文件而失败，
 * 那会把"基线假红"和"变异被抓到"混成一谈（本探针最忌讳的假信号）。
 * 顺带好处：它们也进了"仓库源码全程未被改动"的哈希核对名单。
 */
const MODULE_FILES = {
  scheduler: 'web/units/scheduler.mjs',
  'pick-word': 'web/units/pick-word.mjs',
  feedback: 'web/units/feedback.mjs',
  env: 'server/env.mjs',
  'state-machine': 'web/units/state-machine.mjs',
  camera: 'web/units/camera.mjs',
  'frame-qc': 'web/units/frame-qc.mjs',
  'event-log': 'web/units/event-log.mjs',
  app: 'web/app.mjs',
  recognize: 'web/units/recognize.mjs',
};
const TEST_FILES = [
  'tests/scheduler.test.mjs',
  'tests/pick-word.test.mjs',
  'tests/feedback.test.mjs',
  'tests/env.test.mjs',
  'tests/state-machine.test.mjs',
  'tests/camera.test.mjs',
  'tests/app-mount.test.mjs',
  'tests/recognize.test.mjs',
  'tests/recognize-mount.test.mjs',
];
// `tests/index-html.test.mjs` **有意不进这张表**：它读 `web/index.html` 这个真实文件，
// 而临时树只复制模块与测试，进来会因缺文件而假红。它由 `node --test` 全量套件守着。
//
// `tests/recognize-upstream.test.mjs` / `tests/recognize-endpoint.test.mjs` / `tests/server.test.mjs`
// 同样**有意不进**（Task 7）：它们 import `server/recognize-upstream.mjs` / `server/index.mjs`，
// 而后者的路由表里写死了 `../web/` 的绝对路径（`fileURLToPath(new URL('../web/', import.meta.url))`）
// ——在临时树里那会指向**临时树的 web/**，静态托管用例会对不上。要让它们进来，得先让临时树
// 复制整个 `web/` 与 `server/`，而这两份测试里还有子进程 + 15s 超时闸的用例：
// 单次变异体可能要跑一分钟以上，59+8 个变异体就是小时级。探针的价值在于**快**（现在一轮 < 1 分钟），
// 因此这里只接纯逻辑模块，服务层由 `node --test` 全量套件守着。
const TEST_ARGS = ['--test', ...TEST_FILES];
/**
 * 测试夹具体系（Task 7 起必需）：`tests/recognize-mount.test.mjs` 与 `tests/app-mount.test.mjs`
 * 都 import `tests/helpers/*.mjs`。少复制一个，临时树里的基线就会因"缺文件"而假红——
 * 而基线假红会让整轮结论作废（探针最忌讳的假信号）。
 * 它们不参与变异（没有对应的变异体），进表只为"临时树里 import 得到"。
 */
const HELPER_FILES = [
  'tests/helpers/dom.mjs',
  'tests/helpers/fakes.mjs',
  'tests/helpers/mount-harness.mjs',
];
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);

/** 变异体 ID：名字里第一个 `_` 之前的那段（`F12_messageDropsValue` → `F12`）。 */
const mutantPrefix = (name) => name.split('_')[0];

/** `--only` 选中哪些变异体（规则见文件头）：先 ID 全串相等，未命中再按 ID 前缀族匹配。 */
function selectMutants(value) {
  if (!value) return MUTANTS;
  const exact = MUTANTS.filter((m) => mutantPrefix(m.name) === value);
  return exact.length ? exact : MUTANTS.filter((m) => mutantPrefix(m.name).startsWith(value));
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────────────────────────────────── 变异体定义
// 每条 find 必须是当前实现里的**唯一原文**：找不到即 PATCH-FAILED 并以非零码退出，
// 这样源码漂移不会被悄悄吞掉（探针自己也会被"钉住"）。
const SCHED = MODULE_FILES.scheduler;
const PICK = MODULE_FILES['pick-word'];
const FEEDBACK = MODULE_FILES.feedback;
const ENV = MODULE_FILES.env;
const SM = MODULE_FILES['state-machine'];
const CAM = MODULE_FILES.camera;
const REC = MODULE_FILES.recognize;

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
  {
    name: 'F12_messageDropsValue', target: FEEDBACK, expect: 'detected',
    why: '越界消息丢掉实际取值（只报"error_type 取值越界"，不再说模型给的是什么）：调用方把它'
      + '`join("; ")` 成 `feedback_pending` 的原因时会拿到一条无法定位的诊断——不知道模型到底吐了'
      + '哪个值，只能回头猜。这条钉住的正是报告 §八.3 说的"文案半契约"里唯一不许退化的部分：'
      + '*点名字段 + 带上实际取值*（措辞可以变，取值必须在）',
    find: '    errors.push(`error_type 取值越界: ${String(raw.error_type)}`);',
    replace: "    errors.push('error_type 取值越界');",
  },
  // ── env（Task 5 修复轮）：N1–N3 ──
  // 这三条是 Task 5 实施者用一次性脚本测出来"改回去测试仍然全绿"的三处，现在固化成探针条目。
  // 注意：它们只跑 tests/env.test.mjs 能覆盖的纯函数层；`server/index.mjs` 未接入本探针
  // （它有 import 语句，过不了下面的 `new Function` 语法闸；其路由层由 tests/server.test.mjs 覆盖）。
  {
    name: 'N1_dropPortValidation', target: ENV, expect: 'detected',
    why: '删掉 PORT 正整数校验：PORT=abc → NaN / PORT=0 / PORT=8.5 都会被原样交给 listen()，'
      + '把"配置写错"推迟成一句难懂的绑端口错误（甚至绑到随机端口）',
    find: `  if (!Number.isInteger(env.PORT) || env.PORT <= 0) {
    throw new Error(\`PORT 非法: \${String(source.PORT)}\`);
  }`,
    replace: '',
  },
  {
    name: 'N2_dropStringCoercion', target: ENV, expect: 'detected',
    why: '必需项不再 String() 转换：注入数字/布尔等 source 时返回值不再是字符串，'
      + '下游按字符串用它（拼 URL、trim、比较）会静默变形',
    find: '  for (const k of REQUIRED) env[k] = String(source[k]);',
    replace: '  for (const k of REQUIRED) env[k] = source[k];',
  },
  {
    name: 'N3_messageDropsStartCommand', target: ENV, expect: 'detected',
    why: '报错信息丢掉"启动方式: node --env-file=.env server/index.mjs"那半句：'
      + '读者分不清"密钥没填"和".env 没加载"，只能回头翻文档',
    find: `      \`缺少必需的环境变量: \${missing.join(', ')}（见 .env.example）\\n\`
      + \`启动方式: \${START_COMMAND}（.env 由 Node 运行时加载，不是由本程序解析）\`,`,
    replace: `      \`缺少必需的环境变量: \${missing.join(', ')}\`,`,
  },
  // ── 状态机（Task 6）：S1–S13 ──
  // 这批全部围绕同一个产品约束：**造句（composing）不可跳过**，以及"敷衍样本可筛"
  // 所依赖的两个记录量（停留时长、改写次数）。改坏任何一条，采集到的就不是
  // "愿不愿意产出"，而是"用户在哪儿退出"。
  {
    name: 'S1_unfrozenTable', target: SM, expect: 'detected',
    why: '转移表不冻结（只冻内层）："能不能跳过造句"这条产品约束退化成可运行时改写的普通对象，'
      + '任何一处 import 都能改它，而且改完不报错',
    find: 'export const TRANSITIONS = Object.freeze({',
    replace: 'export const TRANSITIONS = ({',
  },
  {
    name: 'S2_wordReadySkipsReading', target: SM, expect: 'detected',
    why: 'word 态按"我会读了"直接落到 composing：跟读这一步被整段跳过，'
      + '而 skipped_reading 还记成 false（数据上看不出用户没读）',
    find: "  word: Object.freeze({ wordReady: 'reading' }),",
    replace: "  word: Object.freeze({ wordReady: 'composing' }),",
  },
  {
    name: 'S3_finishFromComposing', target: SM, expect: 'detected',
    why: '给 composing 多开一个出口 finish：用户可以不造句就走人——正是设计文档 §3.2 '
      + '明确不许发生的那件事（拿到的会是退出点分布，不是"愿不愿意"）',
    find: "  composing: Object.freeze({ submit: 'feedback' }),",
    replace: "  composing: Object.freeze({ submit: 'feedback', finish: 'done' }),",
  },
  {
    name: 'S4_frameBadStaysCapturing', target: SM, expect: 'detected',
    why: '被拒的帧不退回 ready：用户卡在拍摄态，没有任何按钮能出去（只能刷新页面）',
    find: "  capturing: Object.freeze({ frameOk: 'word', frameBad: 'ready' }),",
    replace: "  capturing: Object.freeze({ frameOk: 'word', frameBad: 'capturing' }),",
  },
  {
    name: 'S5_dropFrameRejectionCounter', target: SM, expect: 'detected',
    why: '被拒的帧不计数：frame_rejected 永不落，下游 retry_rate（判据 B）整个失真——'
      + '正是全局约束 3 禁止的"失败静默"',
    find: '        ctx.frameRejections += 1;',
    replace: '        // 变异体：不计数',
  },
  {
    name: 'S6_dropSkippedReadingFlag', target: SM, expect: 'detected',
    why: '跳过跟读不置 skipped_reading：跳过与没跳过在数据里长得一样，'
      + '而"跟读被大量跳过"是要单独看见的信号',
    find: "      if (action === 'skipReading') ctx.skippedReading = true;",
    replace: '      // 变异体：不记 skipped_reading',
  },
  {
    name: 'S7_dropRewriteIncrement', target: SM, expect: 'detected',
    why: '提交造句不累加次数：改写过一版与一次成型分不出来，'
      + '§3.2 的"时长过短 + 未改写 → 敷衍样本"就筛不出来了',
    find: '      if (action === \'submit\') ctx.rewriteCount += 1;',
    replace: '      // 变异体：不累加改写次数',
  },
  {
    name: 'S8_illegalActionReturnsTrue', target: SM, expect: 'detected',
    why: '非法动作不再返回 false（而是"照原状态走一遍流程并返回 true"）：调用方以为点击被接受了，'
      + '状态机却纹丝不动——界面与状态从此对不上，且没有任何报错',
    find: '      const next = TRANSITIONS[state][action];',
    replace: '      const next = TRANSITIONS[state][action] ?? state;',
  },
  {
    name: 'S9_noInitialOnEnter', target: SM, expect: 'detected',
    why: '构造时不以 ready 调一次 onEnter：首屏没有任何渲染时机（页面停在空白），'
      + '而 onEnter 的语义也从"每个状态都收到"变成"除首个之外"',
    find: `  // 构造即进入 ready：调用方拿到机器时首屏就有一次渲染时机。
  onEnter(state);`,
    replace: '  // 构造即进入 ready：调用方拿到机器时首屏就有一次渲染时机。',
  },
  {
    name: 'S10_dropDwell', target: SM, expect: 'detected',
    why: '离开状态时不结算停留时长：dwellMs 恒为 0，"停留时长过短"这条敷衍判据失去输入',
    find: '    ctx.dwellMs[state] += t - enteredAt;',
    replace: '    // 变异体：不结算停留时长',
  },
  {
    name: 'S11_snapshotLeaksLedger', target: SM, expect: 'detected',
    why: '快照直接交出内部账本（不是副本）且丢掉当前状态的未结算段：调用方随手改一下返回值，'
      + '就改坏了状态机的记录——统计数字变成"谁读谁改"的产物',
    find: '      dwellMs: { ...ctx.dwellMs, [state]: ctx.dwellMs[state] + (now() - enteredAt) },',
    replace: '      dwellMs: ctx.dwellMs,',
  },
  {
    name: 'S12_rejectReasonPassthrough', target: SM, expect: 'detected',
    why: '拒帧理由不做枚举校验就透传给界面：模型/上游给什么就显示什么，'
      + '等于替系统编一个理由（reason="ok" 也会被当成"太暗"显示出去）',
    find: '        ctx.lastRejectReason = REJECT_REASONS.includes(reason) ? reason : null;',
    replace: '        ctx.lastRejectReason = reason ?? null;',
  },
  {
    name: 'S13_staleRejectReason', target: SM, expect: 'detected',
    why: '重新拍照时不清掉上一条拒帧理由：用户会拿上一次的失败原因解释这一次的画面',
    find: "      if (action === 'capture') ctx.lastRejectReason = null;",
    replace: '      // 变异体：不清上一条拒帧理由',
  },
  // ── 相机与灰度转换（Task 6）：C1–C13 ──
  // C1 就是 task-6 修正 1 存在的理由：brief 那版 grabFrame 把 RGBA 裸缓冲交出去，
  // 与只收灰度的 computeStats 一接就抛。其余各条钉住 toGrayscale 的算术与取帧的几处响亮失败。
  {
    name: 'C1_rgbaPassthrough', target: CAM, expect: 'detected',
    why: 'grabFrame 把 RGBA 裸缓冲交给 computeStats（brief 的原样）：长度是像素数的 4 倍，'
      + 'computeStats 响亮抛 RangeError——这一条就是"修正 1"要防的事故本身',
    find: '    stats: computeStats(toGrayscale(img.data, img.width, img.height), img.width, img.height),',
    replace: '    stats: computeStats(img.data, img.width, img.height),',
  },
  {
    name: 'C2_grayscaleSimpleAverage', target: CAM, expect: 'detected',
    why: '用 (R+G+B)/3 代替 BT.601 亮度权重：灰度值整体偏移（纯红 76 → 85），'
      + '亮度阈值 40 与模糊阈值 80 的量纲随之变形（它们只对原来的灰度定义有意义）',
    find: '    const v = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);',
    replace: '    const v = Math.round((rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3);',
  },
  {
    name: 'C3_grayscaleNoRound', target: CAM, expect: 'detected',
    why: '去掉四舍五入改为截断：每个通道最多差 1（140.75 → 140 而非 141），'
      + '亮度均值整体系统性偏低',
    find: '    const v = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);',
    replace: '    const v = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) | 0;',
  },
  {
    name: 'C4_grayscaleFoldsAlpha', target: CAM, expect: 'detected',
    why: '把 alpha 折进亮度（乘 a/255）：全透明像素算成纯黑，'
      + '带透明通道的一帧会被判"太暗"而白白退回重拍',
    find: '    const v = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);',
    replace: '    const v = Math.round((0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) * (rgba[o + 3] / 255));',
  },
  {
    name: 'C5_grayscaleNoClamp', target: CAM, expect: 'detected',
    why: '去掉夹紧：越界通道值回绕成"看着合理"的错灰度（400 → 144），'
      + '一个错误的采样伪装成一次正常读取',
    find: '    out[i] = v < 0 ? 0 : (v > 255 ? 255 : v);',
    replace: '    out[i] = v;',
  },
  {
    name: 'C6_grayscaleNoLengthCheck', target: CAM, expect: 'detected',
    why: 'toGrayscale 不校验长度就按 RGB 读：短缓冲读出 undefined、长缓冲被当成别的格式，'
      + 'NaN 或错值一路流到质检——正是"静默重解释输入"',
    find: `  if (rgba.length !== n * 4) {
    throw new RangeError(
      \`toGrayscale: rgba.length 必须恰好等于 width*height*4 = \${n * 4}（= \${String(width)}×\${String(height)}×4），\`
      + \`收到 \${String(rgba.length)}\`,
    );
  }`,
    replace: '  // 变异体：不校验长度',
  },
  {
    name: 'C7_wrongDimsToComputeStats', target: CAM, expect: 'detected',
    why: '把视频的 videoWidth/videoHeight 当成图像尺寸传给 computeStats（而不是这张缩过的图的尺寸）：'
      + '那对数字来自另一张图，长度校验一比对就抛 RangeError',
    find: '    stats: computeStats(toGrayscale(img.data, img.width, img.height), img.width, img.height),',
    replace: '    stats: computeStats(toGrayscale(img.data, img.width, img.height), vw, vh),',
  },
  {
    name: 'C8_noUpscaleGuard', target: CAM, expect: 'detected',
    why: '去掉 Math.min(1, …)：小图被放大到 512 长边（320×240 → 512×384）——'
      + '放大不增加任何信息，只让每一帧的编码与上传更贵',
    find: '  const scale = Math.min(1, maxEdge / Math.max(vw, vh));',
    replace: '  const scale = maxEdge / Math.max(vw, vh);',
  },
  {
    name: 'C9_noMediaDevicesGuard', target: CAM, expect: 'detected',
    why: '没有 mediaDevices 时不再给明确错误：用户（和读日志的人）看到的是 '
      + '"Cannot read properties of undefined (reading \'getUserMedia\')"，'
      + '根本看不出这是"http:// + 局域网 IP 不是安全上下文"（全局约束 2）',
    find: `  if (mediaDevices === undefined || mediaDevices === null
    || typeof mediaDevices.getUserMedia !== 'function') {
    throw new Error(
      'openCamera: 这个环境没有可用的摄像头接口（navigator.mediaDevices 缺失）。'
      + 'getUserMedia 只在安全上下文可用：https:// 域名或 localhost；'
      + '用 http:// + 局域网 IP 打开时必然失败，请走内网穿透的 HTTPS 地址。',
    );
  }`,
    replace: '  // 变异体：没有 mediaDevices 时不给明确错误',
  },
  {
    name: 'C10_noTrackStopOnPlayFail', target: CAM, expect: 'detected',
    why: '起播失败时不关摄像头：轨迹还活着（指示灯亮着、耗电），界面上却没有画面，'
      + '用户只能刷新页面（隐私与电量都吃亏）',
    find: `    for (const track of stream.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* 停不掉也只能继续抛原始错误 */ }
    }`,
    replace: '    // 变异体：不关摄像头',
  },
  {
    name: 'C11_nullBlobOk', target: CAM, expect: 'detected',
    why: 'toBlob 给回 null 也照常返回：Task 7 会拿一个空 blob 去 POST 一趟识物，'
      + '"编码失败"被静默降级成"发出去过"',
    find: `  if (blob === null || blob === undefined) {
    // 真 toBlob 在画布被污染（跨域图）或尺寸为 0 时会以 null 回调。照常返回的话，
    // Task 7 会拿 null 去 POST 一趟识物——失败被静默降级成"发出去过"。
    throw new Error('grabFrame: 画布编码失败（toBlob 回调收到 null），本帧不可用');
  }`,
    replace: '  // 变异体：编码失败也照常返回',
  },
  {
    name: 'C12_noVideoReadyGuard', target: CAM, expect: 'detected',
    why: '不检查视频是否出画：按快门太早本应是"稍等一秒"的用户情形，'
      + '变异后却会悄悄产出一张 1×1 的帧送去质检（恒判太糊），用户永远等不到画面',
    find: `  if (!Number.isInteger(vw) || !Number.isInteger(vh) || vw <= 0 || vh <= 0) {
    // 这是**用户情形**（按快门比相机出画早），所以是一个可识别的普通 Error，
    // 而不是下游 computeStats 会抛的那种 RangeError——两者的处置完全不同。
    const err = new Error(
      \`grabFrame: 视频还没出画（videoWidth=\${String(vw)}, videoHeight=\${String(vh)}），请稍候再按快门\`,
    );
    err.code = VIDEO_NOT_READY;
    throw err;
  }`,
    replace: '  // 变异体：不检查视频是否出画',
  },
  {
    name: 'C13_noMaxEdgeValidation', target: CAM, expect: 'detected',
    why: '不校验 maxEdge：0 或非整数会被静默当成缩放系数，拍出一张 1×1 的帧'
      + '（质检必然判太糊，而调用方完全不知道是参数写错了）',
    find: `  if (!Number.isInteger(maxEdge) || maxEdge <= 0) {
    throw new RangeError(\`grabFrame: maxEdge 必须是正整数，收到 \${String(maxEdge)}\`);
  }`,
    replace: '  // 变异体：不校验 maxEdge',
  },
  // ── 识物链路（Task 7）：R1–R8 ──
  // 这批钉的是三条红线：①取不到词**绝不假造**；②判帧只有一处起源、帧被拒不消耗尝试；
  // ③落空的**原因**要能区分"内容配置问题"与"请求失败"（Task 3 review 指出的数据质量缺口）。
  {
    name: 'R1_manualFabricatesWord', target: REC, expect: 'detected',
    why: '两轮落空时把空串当词返回（`word: ""` 而不是 `null`）：界面与下游会把空串当成一个词，'
      + '"取不到词"这件事就此被静默降级成"取到了"——全局约束 3 的反面',
    find: "    mode: 'manual', word: null, candidates: lastCandidates, attempts, ...lastFailure,",
    replace: "    mode: 'manual', word: '', candidates: lastCandidates, attempts, ...lastFailure,",
  },
  {
    name: 'R2_dropRejectReason', target: REC, expect: 'detected',
    why: '帧被拒时不带 reason：界面只能给一句通用文案，用户看不出该开灯还是该拿稳手机'
      + '（REJECT_HINT 的两档文案就此失效）',
    find: "    return { mode: 'frame_rejected', reason: verdict.reason, word: null, candidates: [], attempts: 0 };",
    replace: "    return { mode: 'frame_rejected', word: null, candidates: [], attempts: 0 };",
  },
  {
    name: 'R3_judgeTwice', target: REC, expect: 'detected',
    why: '在两次尝试的循环里**再判一次**同一帧（第二套判定机制）：追加要求 1 明令禁止的两处判帧，'
      + '同一帧被读两次、拒帧计数与实际不符，且与 mount 侧的判定可能各自漂移',
    find: '    attempts += 1;',
    replace: '    if (!frameQC.judgeFrame(stats).ok) lastFailure = null;\n    attempts += 1;',
  },
  {
    name: 'R4_attemptsCountsRejectedFrame', target: REC, expect: 'detected',
    why: '被拒的帧也计入 attempts：attempts 的口径从"真的问过模型几次"变成"按了几次快门"，'
      + '下游按它算重试/调用成本会整体偏高',
    find: "    return { mode: 'frame_rejected', reason: verdict.reason, word: null, candidates: [], attempts: 0 };",
    replace: "    return { mode: 'frame_rejected', reason: verdict.reason, word: null, candidates: [], attempts: 1 };",
  },
  {
    name: 'R5_missReasonMerged', target: REC, expect: 'detected',
    why: '落空一律报"识别失败"：内容配置问题（模型给的词不在词表里）与模型能力问题在数据里'
      + '再也分不开——正是 Task 3 review 记下的那道缺口',
    find: `  if (candidates.length === 0) {
    return { reason: RECOGNIZE_FAIL_REASONS.NO_CANDIDATES, detail: '模型没有返回任何候选' };
  }`,
    replace: `  if (candidates.length === 0) {
    return { reason: RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET, detail: '模型没有返回任何候选' };
  }`,
  },
  {
    name: 'R6_twoMissesBecomeOne', target: REC, expect: 'detected',
    why: '只问一次模型就降级：用户第 2 次尝试的权利被吞掉，而计划写的是"第 2 次仍失败才退手选"'
      + '（attempts 也会恒为 1）',
    find: '  for (let i = 0; i < 2; i += 1) {',
    replace: '  for (let i = 0; i < 1; i += 1) {',
  },
  {
    name: 'R7_httpFailureLooksEmpty', target: REC, expect: 'detected',
    why: 'HTTP 失败返回空候选而不是抛错：调用方把它当成"识物成功但没认出东西"，'
      + '服务不可用被记成模型能力不足（全局约束 3）',
    find: `    const err = new Error(\`识物请求失败 HTTP \${res.status}\`);
    err.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
    throw err;`,
    replace: '    return { candidates: [] };',
  },
  {
    name: 'R8_uncountedMiss', target: REC, expect: 'detected',
    why: '落空的那次尝试不计数：`attempts` 记的不是真实调用次数，'
      + '降级时的"问了几次"与调用成本核算都对不上',
    find: '    attempts += 1;',
    replace: '    // 变异体：不计数',
  },
];

// ─────────────────────────────────────────────────────────── 工具
/**
 * 单个变异体子进程的**墙钟上限**（护栏 4）。`node:test` 默认超时是 `Infinity`，所以一条把测试
 * 跑挂的变异体会让探针无限期挂住、不给诊断（本项目 Task 2 已吃过同款亏：手写测试替身的
 * `oncomplete` 永不触发 → 零输出挂死，看起来像"还在跑"而不是"失败"）。
 * 取值理由：整套测试当前约 1.5s（改前/改后全量 `node --test` 的 `duration_ms` 为 1515 / 1528），30s 已是
 * **约 20 倍**整套测试、**三个数量级**于单文件耗时的余量——正常变异体绝无可能撞上，而它能保证
 * 卡死的那一个在 30s 内变成一条可读的诊断而不是一次无限等待。成本上界从"无限"变成
 * `30 个变异体 × 30s`（最坏 15 分钟，且首个超时即 FAIL 退出，实际远小于此）。
 */
const CHILD_TIMEOUT_MS = 30_000;
/** 强杀后再等这么久还没收到 `exit` 就自己结算：否则"杀不掉"又会退化成永久挂住。 */
const KILL_GRACE_MS = 5_000;

/**
 * 超时后强杀**整棵进程树**。Windows 上 `child.kill()` 只终止直接子进程，`node --test` 派生出来的
 * 孙子测试进程会活下来继续挂住（正是要防的那种僵死），故 Windows 走 `taskkill /T /F`。
 */
function killTree(child) {
  const { pid } = child;
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } });
      return;
    } catch { /* 落回 SIGKILL */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
}

/**
 * 跑一次聚焦测试，只信 **exit 事件的 code**（本环境不能读子进程管道输出）。
 * 正常退出仍以 code 判定；只有超过 `CHILD_TIMEOUT_MS` 才走超时结算，且结算出来的 code 是 `null`，
 * 绝不会在超时时伪造一个"非 0 退出码"（那会把挂住误判成 DETECTED）。
 */
function runTests(cwd, logPath) {
  const fd = fs.openSync(logPath, 'w');
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch { /* 已关 */ } } };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, TEST_ARGS, { cwd, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      close();
      resolve(r);
    };
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      killTimer = setTimeout(
        () => settle({ code: null, signal: `PROBE-TIMEOUT(${CHILD_TIMEOUT_MS}ms)`, timedOut: true }),
        KILL_GRACE_MS,
      );
    }, CHILD_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      // 强杀触发的 exit 按"超时"结算，不冒充一次正常退出（更不冒充一次"干净的失败"）
      if (timedOut) settle({ code: null, signal: `PROBE-TIMEOUT(${CHILD_TIMEOUT_MS}ms)`, timedOut: true });
      else settle({ code, signal });
    });
    child.on('error', (err) => { settle({ code: null, signal: null, error: err }); });
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
 * 那种"抓到"是崩溃而不是断言，会伪造出 DETECTED。这里用去 export/import 后 `new Function` 做语法门。
 *
 * Task 6 起这道门多剥一层 `import`：`web/units/camera.mjs` 有
 * `import { computeStats } from './frame-qc.mjs';`，而 `import` 声明只在 ES 模块里合法，
 * `new Function` 见它就报语法错（原注释里写的"本仓库模块只有 export"已不再成立）。
 * **局限（如实记，别当成没这回事）**：剥掉 import 行之后再查语法，等于不再检查 import 行本身。
 * 现有变异体的 `find` 全在函数体/常量里，没有一条动 import 行，所以这道门对当前变异集的能力不变；
 * 将来若出现改 import 行的变异体，这里会漏，届时应把它换成真编译检查（例如 `node --check`）。
 */
function syntaxOk(source, rel) {
  try {
    const stripped = source.replace(/^export /gm, '').replace(/^import .*?;$/gm, '');
    // eslint-disable-next-line no-new-func
    new Function(stripped);
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
  // 临时树：测试文件逐字副本 + 模块原实现副本 + 测试夹具体系
  for (const rel of [...Object.values(MODULE_FILES), ...TEST_FILES, ...HELPER_FILES]) {
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

  const selected = selectMutants(only);
  if (!hardFailure && selected.length === 0) {
    // `--only` 打错一个字就会"跑 0 个变异体然后 PASS"——那是最坏的一种假绿，必须当场拦下
    hardFailure = `--only=${only} 没有匹配到任何变异体（可用 ID：${[...new Set(MUTANTS.map((m) => mutantPrefix(m.name)))].join(', ')}）`;
  }
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

      const { code, signal, timedOut } = await runTests(tmpRoot, logPath);
      // 超时的子进程没有 exit code（code=null），绝不能被 `code !== 0` 当成"被测试抓到"
      const caught = timedOut ? [] : failingTests(logPath);
      const detected = !timedOut && code !== 0;

      // 还原临时模块并按哈希核对"逐字节还原"
      fs.writeFileSync(target, pristine[m.target]);
      const restored = sha256(fs.readFileSync(target)) === repoHashes[m.target];

      // 仓库源码必须一直没被碰过
      const repoIntact = Object.values(MODULE_FILES)
        .every((r) => sha256(fs.readFileSync(path.join(REPO, r))) === repoHashes[r]);

      let verdict;
      if (timedOut) {
        // 挂住的变异体不是"被测试抓到"，也不是一次 MISSED（它根本没跑完，没有干净失败可读）。
        // 单列一类，避免读者把"探针被卡死"误读成"测试覆盖不足"。等价变异体也不给 EQUIVALENT：
        // 连跑完都没跑完，等价主张无从谈起。
        verdict = `TIMEOUT（${CHILD_TIMEOUT_MS}ms 未退出，已强杀整棵进程树 → 按未抓到处理）`;
      } else if (m.expect === 'detected') {
        verdict = detected ? 'DETECTED' : 'MISSED';
      } else {
        // 声称等价的：必须由差分核对证明等价，证明不过则反过来按漏网处理
        // 差分副本放在**被测模块旁边**（不是临时树根）：这样变异体里的相对 import
        // （`./frame-qc.mjs`）才解析得到。对无 import 的模块，位置变化不改变任何行为。
        const equivPath = path.join(path.dirname(target), `equiv-${m.name}.mjs`);
        fs.writeFileSync(equivPath, mutated);
        const diff = await differentialAgreement(m.target, target, equivPath);
        const proved = !detected && diff.agree;
        verdict = proved ? 'EQUIVALENT（差分核对一致，构造上不可抓）'
          : `OVERCLAIM（差分不一致或其实被抓到 → 按漏网处理）`;
      }
      results.push({ ...m, verdict, caught, exit: code, signal, timedOut, restored, repoIntact });
      if (!hardFailure && timedOut) {
        hardFailure = `变异体 ${m.name} 的子进程 ${CHILD_TIMEOUT_MS}ms 未退出（已强杀）——挂住不等于抓到，按未抓到处理`;
      } else if (!hardFailure && ((m.expect === 'detected' && !detected) || (m.expect !== 'detected' && verdict.startsWith('OVERCLAIM')))) {
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
    else if (r.timedOut) console.log(`  抓到它的用例：（无——子进程 ${CHILD_TIMEOUT_MS}ms 未退出被强杀，读不到任何干净的失败）`);
    else if (r.exit !== 0) console.log('  抓到它的用例：（退出码非 0 但未解析出用例名——本环境不读管道输出，日志在临时树里）');
  });
  if (process.env.KEEP_TMP === '1') console.log(`\n临时工作树保留在：${tmpRoot}`);
  else fs.rmSync(tmpRoot, { recursive: true, force: true });
}

const detectedCount = results.filter((r) => r.verdict === 'DETECTED').length;
const missed = results.filter((r) => r.verdict === 'MISSED');
const timedOutList = results.filter((r) => r.verdict.startsWith('TIMEOUT'));
const overclaim = results.filter((r) => r.verdict.startsWith('OVERCLAIM'));
const patchFailed = results.filter((r) => r.verdict.startsWith('PATCH-FAILED'));
const equivalent = results.filter((r) => r.verdict.startsWith('EQUIVALENT'));

console.log('\n================ 汇总 ================');
console.log(`变异体：${results.length}/${MUTANTS.length}（--only=${only || '（全部）'}）`);
console.log(`DETECTED（被测试抓到）：${detectedCount}`);
console.log(`EQUIVALENT（与真实现等价，构造上不可抓，已差分核对）：${equivalent.length}${equivalent.length ? ` → ${equivalent.map((r) => r.name).join(', ')}` : ''}`);
console.log(`MISSED（该抓没抓到，跑完了但没有干净失败）：${missed.length}${missed.length ? ` → ${missed.map((r) => r.name).join(', ')}` : ''}`);
console.log(`TIMEOUT（${CHILD_TIMEOUT_MS}ms 未退出被强杀，按未抓到处理，单列不与 MISSED 混同）：${timedOutList.length}${timedOutList.length ? ` → ${timedOutList.map((r) => r.name).join(', ')}` : ''}`);
console.log(`OVERCLAIM（声称等价但差分不一致）：${overclaim.length}`);
console.log(`PATCH-FAILED（探针与源码不同步）：${patchFailed.length}`);
if (hardFailure) console.log(`判定：FAIL —— ${hardFailure}`);
else console.log('判定：PASS —— 可抓变异体无一漏网，仓库源码全程未被改动');
process.exitCode = hardFailure ? 1 : 0;
