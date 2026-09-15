/**
 * 变异探针（可重复运行的证据生成器，零依赖、非测试文件）。
 *
 * 用途：把 review 轮（`rv3-probe.mjs`）枚举的 18 个变异体 + Task 4 的 12 个变异体 + Task 5 修复轮
 * 的 3 个环境校验变异体 + Task 6 的 26 个（状态机 13 + 相机/灰度 13）+ Task 7 的 8 个识物变异体
 * + Task 7 修复轮的 12 个（轮次/判据 B 口径 6 + 上游响应校验与超时 6）
 * + Task 7 复审轮的 2 个（停滞的响应体归超时）+ Task 8 的 16 个（造句反馈：客户端 10 + 上游 6）
 * + Task 9 的 28 个（跟读判定 K1–K6 + 已证等价的 K7，接线 P1–P22）
 * + Task 9B 的 13 个（待补反馈队列 Q1–Q8、storage_full Q9–Q11、reading_missed Q12–Q13）
 * + Task 10 的 17 个（导出统计口径 X1–X14 + 耗时落盘的 R16–R17；
 *   X12 的目标是 `web/app.mjs`，R16–R17 的目标是 `web/units/recognize.mjs`）
 * 固化成仓库内可复跑的证据——逐个"把实现改坏"，跑 `tests/` 下被登记的那 15 个测试文件，报告每个
 * 变异体是被测试抓到（DETECTED）还是溜过去了（MISSED），只要有该抓没抓到的就以非零码退出。
 *
 * 用法（在仓库根）：
 *   node scripts/mutation-probe.mjs            # 全部变异体
 *   node scripts/mutation-probe.mjs --only=M2  # 只跑 M2（`--only=F` = 整个 F 系列；规则见下）
 *   KEEP_TMP=1 node scripts/mutation-probe.mjs # 保留临时工作树以便排查
 *
 * `--only` 的匹配规则（大小写敏感；按变异体 **ID** 匹配，ID = 名字里第一个 `_` 之前那段，如
 * `F12_messageDropsValue` → `F12`）：
 *   1. 先按 ID **全串相等**——`--only=M1` 只跑 M1（不再连带 M10–M14），`--only=F12` 只跑 F12；
 *   2. 没有精确命中时退化为**族匹配**（ID 以该串开头）——`--only=F` 跑 F1…F12，`--only=Q` 跑 Q1…Q4，
 *      `--only=S` 跑 Task 6 的状态机 13 条，`--only=C` 跑相机/灰度 13 条 **与 Task 8 的
 *      compose 10 条**（两批的 ID 都是 `C<数字>`，族匹配会一起选中：想单跑后者请用
 *      `--only=C1_empty` 这样的全串，或看下面的说明），
 *      `--only=R` 跑 Task 7 的 15 条（R1–R15），`--only=U` 跑上游响应校验与超时的 7 条（U1–U7），
 *      `--only=V` 跑 Task 8 的服务端造句上游 6 条（V1–V6），
 *      `--only=K` 跑 Task 9 的跟读判定 7 条（K1–K7），`--only=P` 跑 Task 9 的接线 22 条（P1–P22）；
 *      `--only=Q` 跑 Task 9B 的 13 条（Q1–Q13），`--only=X` 跑 Task 10 的导出统计 14 条（X1–X14）；
 *      `--only=R16` / `--only=R17` 跑 Task 10 收口的耗时落盘两条（**必须写全串**：
 *      `--only=R` 会连同 Task 7/8 的 R1–R15 一起选中）；
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
 * Task 7：R1–R8 → 8/8 DETECTED，见 `task-7-report.md`；
 * Task 7 修复轮：R9–R14 与 U1–U6 → 12/12 DETECTED，见 `task-7-report.md` 修复轮一节——
 * 这一轮同时把 `server/recognize-upstream.mjs` 接进了探针（此前它的响应校验规则没有变异证据），
 * 仍**未接入**的是 `server/index.mjs`（路由层与魔数/超时守卫），理由见 TEST_FILES 上方注释）。
 * Task 7 复审轮的 R15 / U7 → 2/2 DETECTED，见 `task-7-report.md`「修复轮 2」一节——
 * 它们钉的是"响应头到了、body 还在流时上限到点"必须归**超时**（而不是"响应非法"），
 * 抓它的是两条真桩（真 createServer + 真 fetch，半截 body 挂住）的用例。
 * Task 8 的 C1–C9（`web/units/compose.mjs`）与 V1–V6（`server/feedback-upstream.mjs`）
 * → 15/15 DETECTED，见 `task-8-report.md`——这一轮把造句反馈链路的两半都接进了探针
 * （客户端那一腿的纯逻辑 + 服务端给上游的模型契约）。
 * Task 8 复审轮的 C10（`web/units/compose.mjs` 的 504/408 分支）→ 1/1 DETECTED，
 * 见 `task-8-report.md`「修复轮 2」一节——这一轮同时把 `server/redact.mjs` 放进
 * MODULE_FILES（只为临时树里 import 得到，没有变异体）。
 * Task 9 的 K1–K7（`web/units/speak.mjs` 的跟读判定，含一次口径变更：多词目标词改连续 token 匹配）
 * 与 P1–P22（`web/app.mjs` 的接线：入队幂等 / 到期提示 / 复现两种模式 / 不谎报换场景 / 落盘口径）
 * → 28/28 DETECTED，见 `task-9-report.md`——这一轮把 `speak` 接进了探针，
 * 并把两份**挂载**测试（跟读接线、复现与落盘）也接进 TEST_FILES：不接它们，
 * P 系列（本任务的重头）就没有任何变异证据。
 * Task 9B 的 Q1–Q13（待补队列 / storage_full / reading_missed）→ 13/13 DETECTED，
 * 见 `task-9b-report.md`。
 * Task 10 的 X1–X14 + R16–R17（`scripts/export.mjs` 的统计口径：造句总数不相加、判据 B 的分子与分母、
 * 两个失败率的分母、sceneChanged 的方向、top-3 的切片、补交成功率的分母、CSV 的 BOM、
 * 缺口的触发条件、耗时样本的同源性；`web/app.mjs` 与 `web/units/recognize.mjs` 的
 * "服务端没给耗时时**不写 0**"）
 * → 见 `task-10-report.md`——这是唯一一批**在 `scripts/` 下的**变异体，
 * 它把"数算错了没人看得出来"这一类缺陷第一次纳入了变异证据。
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
  rounds: 'web/units/rounds.mjs',
  'recognize-upstream': 'server/recognize-upstream.mjs',
  // Task 8 接入：造句反馈链路的两半——客户端那一腿（分档 + 原句保留 + 事件映射）与
  // 服务端给上游的模型契约（请求体形状 + 上游信封校验 + 超时）。
  compose: 'web/units/compose.mjs',
  'feedback-upstream': 'server/feedback-upstream.mjs',
  // Task 8 复审轮接入：两条上游腿共用的密钥形状抹除（进临时树只为"import 得到"，
  // 没有对应变异体——它是个逐条替换的纯函数，坏法太多而断言面很窄）。
  redact: 'server/redact.mjs',
  // Task 9 接入：跟读判定（token 规则 + 原样保留转写 + 可用性判定）。零 import 的纯逻辑模块，
  // 与 frame-qc / pick-word 同一个处境：它判的是"用户有没有说出目标词"，判错了没人看得出来。
  speak: 'web/units/speak.mjs',
  // Task 9B 接入：待补反馈队列（从事件流派生 + 重试时序 + 补交的可区分标记）。
  // 它 import `compose.mjs`，所以两份都必须在表里（少一份临时树就 import 不到）。
  pending: 'web/units/pending.mjs',
  // Task 9B 接入：存储层的配额判定与"标记 + 原样重抛"。
  // 它**零 import**（只用注入的 localStorage/indexedDB 句柄），进得来；
  // 而它承载的正是"存储写满"那一档——此前全项目没有任何代码发出 `storage_full`。
  store: 'web/units/store.mjs',
  // Task 10 接入：数据导出（判据统计）。它是**唯一一个在 scripts/ 下的变异目标**——
  // 临时树按相对路径建（`<tmp>/scripts/export.mjs`），它的 `import '../web/units/rounds.mjs'`
  // 正好指向临时树里的 `rounds`（同在上述 MODULE_FILES 里），故临时树 import 得到。
  // 它承载的是"判据 B 与各口径的数到底怎么算"——数算错了没有任何东西会报错，只会得出错的结论。
  export: 'scripts/export.mjs',
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
  // Task 7 修复轮接入的两份：`rounds`（判据 B 在事件流上的口径）与 `recognize-upstream`
  // （上游响应的逐条校验/截断/超时）。后者**进得来**：它是零 import 的纯逻辑模块，
  // 测试也只 import 它自己（不像 server/index.mjs 那样写死了 `../web/` 的绝对路径、
  // 也不起子进程），所以接进来既不假红也不拖慢。
  'tests/rounds.test.mjs',
  'tests/recognize-upstream.test.mjs',
  // Task 8 接入：`compose`（客户端那一腿的纯逻辑：分档、原句保留、事件映射）与
  // `feedback-upstream`（零 import 的纯逻辑模块，理由同 recognize-upstream）。
  // 两条都进得来：只 import 模块本身，不起子进程、不写死 `../web/` 的绝对路径。
  'tests/compose.test.mjs',
  // Task 9 接入：`speak`（跟读判定的纯逻辑）与两份**挂载**测试（跟读接线、复现与落盘）。
  // 后两条进得来是因为 `web/app.mjs` 本来就在 MODULE_FILES 里，夹具也都在 HELPER_FILES 里；
  // 它们 import 的东西（app / scheduler / speak / helpers）临时树里一个不少。
  // 不接它们的话，P 系列（入队幂等、复现两种模式、落盘口径）就没有任何变异证据。
  'tests/speak.test.mjs',
  'tests/speak-mount.test.mjs',
  'tests/recurrence-mount.test.mjs',
  // Task 9B 接入：待补反馈队列（纯逻辑 + 装配）与存储层的配额路径。
  // `tests/event-log.test.mjs` 同时接进来：`reading_missed` 是事件表的契约变更，
  // 不接它的话"事件类型漏登记"这类变异体没有任何证据。
  'tests/pending.test.mjs',
  'tests/pending-mount.test.mjs',
  'tests/storage-full.test.mjs',
  'tests/event-log.test.mjs',
  // Task 10 接入：导出的口径证据（X 系列的全部变异体都靠它抓）。
  // 它进得来：只 import `scripts/export.mjs` 与 `node:fs/os/path/child_process/url`，
  // 不起服务、不 import `server/index.mjs`（那条纪律见下面的长注释）。
  'tests/export.test.mjs',
];
// `tests/index-html.test.mjs` **有意不进这张表**：它读 `web/index.html` 这个真实文件，
// 而临时树只复制模块与测试，进来会因缺文件而假红。它由 `node --test` 全量套件守着。
//
// `tests/recognize-endpoint.test.mjs` / `tests/server.test.mjs` / `tests/feedback-endpoint.test.mjs`
// 同样**有意不进**（Task 7 起；Task 8 把造句端点也归进这一类）：
// 它们 import `server/index.mjs`，而后者的路由表里写死了 `../web/` 的绝对路径
// （`fileURLToPath(new URL('../web/', import.meta.url))`）——在临时树里那会指向**临时树的 web/**，
// 静态托管用例会对不上。要让它们进来，得先让临时树复制整个 `web/` 与 `server/`，
// 而这两份测试里还有子进程 + 15s 超时闸的用例：单次变异体可能要跑一分钟以上。
// 探针的价值在于**快**（现在一轮 < 2 分钟），因此这里只接纯逻辑模块，
// 那几个服务层文件由 `node --test` 全量套件守着。
// 连带的一条纪律（Task 8 的 `tests/compose.test.mjs` 就是照它写的）：进探针的测试文件
// **不许 import `server/index.mjs`**，否则临时树基线立刻假红、整轮结论作废——
// 跨模块的服务端关系用例要放在不进探针的那份文件里。
// **未被变异证据覆盖的服务层代码（如实记，别当成没这回事）**：`server/index.mjs` 的
// multipart 解析、错误分档、图片魔数校验、超时与半开连接守卫，造句端点的 body/字段守卫与
// `config_missing` 分档，以及 `createApp()` 的注入点——
// 它们由 tests/recognize-endpoint.test.mjs、tests/feedback-endpoint.test.mjs 与 tests/server.test.mjs
// 覆盖，但**没有变异体**。
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
  'tests/helpers/watchdog.mjs',
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
const ROUNDS = MODULE_FILES.rounds;
const UP = MODULE_FILES['recognize-upstream'];
const COMPOSE = MODULE_FILES.compose;
const FBUP = MODULE_FILES['feedback-upstream'];
const SPEAK = MODULE_FILES.speak;
const APP = MODULE_FILES.app;
// Task 9B 的三个新目标
const PENDING = MODULE_FILES.pending;
const STORE = MODULE_FILES.store;
// Task 10 的新目标（唯一一个在 scripts/ 下的）
const EXPORT = MODULE_FILES.export;

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
  // ── 轮次计数与判据 B 的口径（Task 7 修复轮 · Critical 1）：R9–R12 ──
  // 这批钉住的是"三个数不许互相推算"：轮数（一次快门一轮）≠ attempts（这一轮问过几次模型）
  // ≠ 帧被端侧拦下的次数。它们是判据 B（retry_rate）的唯一输入，算错任何一处，
  // Task 10 导出的"重拍率"就是错的，而且**看起来完全正常**。
  {
    name: 'R9_counterStuckAtOne', target: ROUNDS, expect: 'detected',
    why: '轮次计数器不再递增（每一轮都是 1）：会话里按了几次快门都只数出 1 轮，'
      + '于是"重拍次数 = 轮数 − 1"恒为 0——判据 B 永远显示"没人重拍过"，'
      + '而 attempts 与拒帧计数看着都正常',
    find: '      last += 1;',
    replace: '      last += 0;',
  },
  {
    name: 'R10_rejectedRoundsDropped', target: ROUNDS, expect: 'detected',
    why: 'ROUND_EVENT_TYPES 丢掉 frame_rejected：被端侧质检拦下的那一轮**也是一次快门**，'
      + '丢掉它等于把"太暗/太糊造成的重拍"从判据 B 里整体抹掉——而端侧前置拦截正是最主要的重拍来源',
    find: "export const ROUND_EVENT_TYPES = Object.freeze(['frame_rejected', 'recognize_ok', 'recognize_failed']);",
    replace: "export const ROUND_EVENT_TYPES = Object.freeze(['recognize_ok', 'recognize_failed']);",
  },
  {
    name: 'R11_reshootOffByOne', target: ROUNDS, expect: 'detected',
    why: '重拍次数算成轮数本身（少了 −1）：第一次快门被算成一次"重拍"，'
      + '重拍率整体虚高（一轮就成闸），而用户其实一次都没重拍',
    find: '  return Math.max(0, roundCountOfSession(events, sessionId) - 1);',
    replace: '  return Math.max(0, roundCountOfSession(events, sessionId));',
  },
  {
    name: 'R12_thresholdOnRounds', target: ROUNDS, expect: 'detected',
    why: '判据 B 的门槛错位：用"轮数 ≥2"代替"重拍 ≥2 次（轮数 ≥3）"——'
      + '只重拍过一次的会话也被算成"需重拍 ≥2 次"，分子虚高',
    find: '  return roundCount - 1 >= RESHOOTS_FOR_RETRY;',
    replace: '  return roundCount >= RESHOOTS_FOR_RETRY;',
  },
  {
    name: 'R13_missingRoundIndexSilentlySkipped', target: ROUNDS, expect: 'detected',
    why: '结论事件缺 roundIndex 时静默跳过（返回 null 而不是抛错）：写入路径漏字段会长得像'
      + '"这一轮不存在"，少算重拍而且没人会发现——正是全局约束 3 禁止的静默降级',
    find: `  if (v === null || v === undefined) {
    throw new Error(`,
    replace: `  if (v === null || v === undefined) {
    return null;
    throw new Error(`,
  },
  {
    name: 'R14_clientNoSignal', target: REC, expect: 'detected',
    why: '客户端识物请求不带 signal（等于没有超时）：上游半开时这个 Promise 永久 pending，'
      + '界面卡在 capturing、每点一次快门多挂一个请求，而且一条事件都不落（判据 B 连这一轮都统计不到）',
    find: '  const signal = AbortSignal.timeout(timeoutMs);',
    replace: '  const signal = undefined;',
  },
  {
    name: 'R15_stalledBodyLooksInvalid', target: REC, expect: 'detected',
    why: '响应头到了、body 还在流时被上限中止，不再认"这是我们那条上限到点了"（复审 Important 1）：'
      + '一次**网络停滞**被归成 `response_invalid`，而这一档的处置方向是"改服务端或模型契约"——'
      + 'Task 10 从 `recognize_failed.reason` 的分布里会读成"契约有问题"',
    find: `    if (isTimeoutAbort(err, signal)) {
      const timedOut = new Error(
        \`识物请求超时（\${timeoutMs}ms 未返回，已主动中止）：\${String(err?.message ?? err)}\`,
      );
      timedOut.code = RECOGNIZE_FAIL_REASONS.REQUEST_FAILED;
      throw timedOut;
    }`,
    replace: '    // 变异体：不再区分"上限到点"与"响应体不是 JSON"',
  },
  // ── 上游响应校验（Task 7 修复轮 · Important 4：把这份模块接进探针）：U1–U5 ──
  // 这批是 review 点名的"没有变异证据"的四条规则（逐条 label 校验 / score → null /
  // 3 条截断 / 32 MiB 上限），外加一条鉴权头。它们全在 server/recognize-upstream.mjs 里，
  // 而那份测试只 import 它自己、也不碰 web/ 路径，所以接得进来（见 TEST_FILES 的说明）。
  {
    name: 'U1_emptyLabelAccepted', target: UP, expect: 'detected',
    why: '空 label 不再判非法（只裁空白、不拒绝空串）：上游吐一个 `label: "  "` 就能通过校验，'
      + '客户端拿到一条没有词的候选，`pickWord` 之后表现为"识别不出来"——把上游的垃圾说成模型没认出',
    find: '  if (label === \'\') return null;',
    replace: '  // 变异体：空 label 也当合法',
  },
  {
    name: 'U2_scoreFabricatedZero', target: UP, expect: 'detected',
    why: 'score 缺失时编一个 0 冒充置信度（而不是如实给 null）：下游看到的"模型很确定它是 0 分"'
      + '是编出来的数，候选排序/诊断都会被带偏',
    find: '  const score = Number.isFinite(raw.score) ? raw.score : null;',
    replace: '  const score = Number.isFinite(raw.score) ? raw.score : 0;',
  },
  {
    name: 'U3_noCandidateTruncation', target: UP, expect: 'detected',
    why: '候选不再截到 3 条（设计文档 §4.1「三候选 + 人工重拍」）：上游多吐几条就全部回给客户端，'
      + '界面与统计都按"最多 3 条"写，多出来的会静默改变选择结果',
    find: '    candidates: normalized.slice(0, MAX_CANDIDATES),',
    replace: '    candidates: normalized,',
  },
  {
    name: 'U4_noDataUrlSizeGuard', target: UP, expect: 'detected',
    why: '去掉 32 MiB 上限守卫：明知会被上游拒绝的超大图照样发出去——白花一次往返与一次计费，'
      + '而且失败原因变成上游的 400，与"请求本身有问题"混在一起',
    find: '  if (dataUrlBytes > MAX_DATA_URL_BYTES) {',
    replace: '  if (false) {',
  },
  {
    name: 'U5_noAuthHeader', target: UP, expect: 'detected',
    why: '上游请求不带 Bearer 密钥：整条链路必然 401，而错误表现是"上游失败"，'
      + '排查的人会去怀疑网络与模型，不会想到是这里把凭据弄丢了',
    find: '        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,',
    replace: "        authorization: 'Bearer ',",
  },
  {
    name: 'U6_noUpstreamTimeout', target: UP, expect: 'detected',
    why: '上游请求不带 signal（等于没有超时）：上游半开时这条 Promise 永久 pending，'
      + '路由与连接都收不回来——本项目反复出现的"挂死而不是失败"',
    find: `  const signal = AbortSignal.timeout(timeoutMs);`,
    replace: '  const signal = undefined;',
  },
  {
    name: 'U7_stalledBodyLooksInvalid', target: UP, expect: 'detected',
    why: '上游先回响应头、body 再停滞时，不再认"上限到点"（复审 Important 1）：'
      + '上游停滞被归成 `upstream_invalid` → 路由回 502 upstream_invalid，'
      + '而这一档的意思是"模型契约不对"——排查的人会去改提示词/模型，真凶却是连接卡住',
    find: `    if (isTimeoutAbort(err, signal)) {
      const timedOut = new Error(
        \`上游请求超时（\${timeoutMs}ms 未返回，已主动中止）：\${String(err?.message ?? err)}\`,
      );
      timedOut.code = UPSTREAM_FAILED;
      throw timedOut;
    }`,
    replace: '    // 变异体：不再区分"上限到点"与"响应体不是 JSON"',
  },
  // ── 造句反馈：客户端那一腿（Task 8）：C1–C10 ──
  // 这批钉的是这条链路的四条红线：①空句不花钱；②`ok` 必须是"校验通过"而不是"HTTP 200"；
  // ③**原句永不丢**（成功与失败两条路都要带回来——它是产品赌注的证据本身）；
  // ④超时归超时、不归"响应非法"（Task 7 复审 Important 1 的同一课，在造句链路上重演）。
  // C10（复审轮追加）把第④条补全：504/408 这两条分支此前没有任何用例，删掉也不会红。
  {
    name: 'C1_emptySentenceHitsNetwork', target: COMPOSE, expect: 'detected',
    why: '空句不再当场拦下，而是照发不误：一次必然无用的调用被花掉，而"空句"这件事在数据里'
      + '也消失了（本来它是 `empty_sentence` 独立一档，看得见）',
    find: `  if (typeof sentence !== 'string' || sentence.trim() === '') {`,
    replace: '  if (false) {',
  },
  {
    name: 'C2_httpOkMeansUsable', target: COMPOSE, expect: 'detected',
    why: '去掉校验器那一关，直接把响应当反馈交出去：`ok` 从"校验通过、可用"退化成"HTTP 200"，'
      + '缺字段/取值越界的响应会以 `status:ok` 的形式流进界面与事件流——'
      + '全局约束 3（失败不得静默降级为成功）的反面',
    find: `  const verdict = validateFeedback(raw);
  if (!verdict.ok) {`,
    replace: `  const verdict = { ok: true, value: raw };
  if (false) {`,
  },
  {
    name: 'C3_httpFailureLooksOk', target: COMPOSE, expect: 'detected',
    why: '非 2xx 不再判失败，而是接着读 body：服务端报的 `502 upstream_failed` 会被当成一次判定'
      + '（HTTP 层面确实拿到了 JSON，但那不是反馈）',
    find: '  if (!res.ok) {',
    replace: '  if (false) {',
  },
  {
    name: 'C4_sentenceDroppedOnPending', target: COMPOSE, expect: 'detected',
    why: '落空时不带原句：学习者的句子在这条路径上消失，而"待反馈队列"与"补交"全都要靠它'
      + '（A2/A4：原句永不丢）——这类丢失在界面上看不出来，只有断言能拦住',
    find: `    status: 'pending', reason, error: error ?? reason, detail, sentence, word, scene,`,
    replace: `    status: 'pending', reason, error: error ?? reason, detail, word, scene,`,
  },
  {
    name: 'C5_validationErrorsDropped', target: COMPOSE, expect: 'detected',
    why: '校验失败时不再把 `validateFeedback` 的 `errors` 当诊断（换成一句笼统的"响应不合契约"）：'
      + 'Task 4 的复审把 `errors` 定成了"被持久化成 pending 原因的东西"——丢掉它就等于丢掉'
      + '"模型到底少给了什么/给了什么越界值"，排查只能回头猜',
    find: `      error: verdict.errors.join('; '),`,
    replace: "      error: '响应不合契约',",
  },
  {
    name: 'C6_uncertainMixedIntoOk', target: COMPOSE, expect: 'detected',
    why: '`uncertain` 不再单独落一条事件，而是混进 `feedback_ok`：设计文档 §4.2 要求它'
      + '"单独统计、不计入通过率"——混进去之后通过率的分子里多了拿不准的句子，而分母不变',
    find: "  if (result?.status === 'ok' && result.uncertain === true) {",
    replace: '  if (false) {',
  },
  {
    name: 'C7_okEventDropsSentence', target: COMPOSE, expect: 'detected',
    why: '成功那条事件不再带原句：`feedback_ok` 里只剩下判定，学习者的那句话在这条路径上丢了'
      + '（A4：句子就是语料，Task 9 要靠它持久化、验证三要靠它做人工标注对照）',
    find: `  const base = { sentence: result?.sentence ?? null, word: result?.word ?? null, scene: result?.scene ?? null };`,
    replace: '  const base = {};',
  },
  {
    name: 'C8_clientNoSignal', target: COMPOSE, expect: 'detected',
    why: '客户端请求不带 signal（等于没有超时）：上游半开时这个 Promise 永久 pending，'
      + '界面卡在"提交中"、学习者以为自己的句子没交出去，而且一条事件都不落——'
      + '本项目反复出现的"挂死而不是失败"',
    find: '  const signal = AbortSignal.timeout(timeoutMs);',
    replace: '  const signal = undefined;',
  },
  {
    name: 'C9_stalledBodyLooksInvalid', target: COMPOSE, expect: 'detected',
    why: '响应头到了、body 还在流时被上限中止，不再认"这是我们那条上限到点了"：'
      + '一次**网络停滞**被归成 `response_invalid`，而这一档的处置方向是"改服务端或模型契约"',
    find: `    if (isTimeoutAbort(err, signal)) {
      return pending({
        reason: FEEDBACK_FAIL_REASONS.TIMEOUT,
        detail: \`造句反馈请求超时（\${timeoutMs}ms 未返回，已主动中止）：\${String(err?.message ?? err)}\`,
        sentence,
        word,
        scene,
      });
    }`,
    replace: '    // 变异体：不再区分"上限到点"与"响应体不是 JSON"',
  },
  {
    name: 'C10_gatewayTimeoutLooksGeneric', target: COMPOSE, expect: 'detected',
    why: '504/408 不再单独归 `timeout`，而是落回泛泛的 `http_error`（Task 8 复审 Item 2 点名的'
      + '"有分支、无用例、无变异体"）：网关超时与"服务端说你请求不对"混成一档，'
      + '界面提示从"等服务端回话等太久了"变成"反馈服务这次没能返回结果"，'
      + '而处置方向（重试 / 看上游，不是改端侧输入）也随之丢掉',
    find: '    const gatewayTimeout = res.status === 504 || res.status === 408;',
    replace: '    const gatewayTimeout = false;',
  },
  // ── 造句反馈：服务端给上游的模型契约（Task 8）：V1–V6 ──
  // 与识物那批（U1–U7）同一个理由：这一层是**会被改坏但测试全绿**的地方，
  // 而它管的是"模型被要求输出什么"与"什么才算一份能往下走的响应"。
  {
    name: 'V1_promptLosesUncertainRewrite', target: FBUP, expect: 'detected',
    why: '提示词里那条"uncertain 也要给改写建议"被删掉：设计文档 §4.2 要求拿不准时仍给改写建议，'
      + '而 Task 4 的契约允许 `uncertain + rewrite: null`——不收紧校验器的前提下，'
      + '提示词是唯一要得到它的地方（A1），删掉它界面上就只剩一句"拿不准"',
    find: '  \'  When you answer "uncertain", STILL put a suggested rewrite in "rewrite"\',',
    replace: "  '',",
  },
  {
    name: 'V2_promptLosesFlawedRewrite', target: FBUP, expect: 'detected',
    why: '提示词里"flawed 必须给改写建议"那半句被删掉：模型的判定对了、改写却可以不给，'
      + '而界面上"哪里错了 + 该怎么写"是同一屏给出的（设计文档 §4.2 的响应契约要求 rewrite 可空'
      + '并不等于我们希望它空）',
    find: '  \'  (never "none"), and MUST give a corrected sentence in "rewrite".\',',
    replace: "  '',",
  },
  {
    name: 'V3_noJsonMode', target: FBUP, expect: 'detected',
    why: '上游请求不带 `response_format: json_object`（控制器 A4 要求的兜底）：'
      + '模型可以合法地吐一段散文，四个字段的解析随之变成"从文本里抠 JSON"——'
      + '那一档失败会从"契约问题"变成"上游无效"，排查方向被带偏',
    find: "    response_format: { type: 'json_object' },",
    replace: '    // 变异体：不带 JSON 模式',
  },
  {
    name: 'V4_seqSaysNone', target: FBUP, expect: 'detected',
    why: '把 content 判成合法 JSON 即可，不再要求它解出来是**对象**：一个 JSON 数组或字符串'
      + '（例如 `"correct"`、`[1,2]`）会被当成一份反馈往下走，而它连四个字段都没有',
    find: `  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {`,
    replace: '  if (false) {',
  },
  {
    name: 'V5_proseAccepted', target: FBUP, expect: 'detected',
    why: 'content 不是合法 JSON 时不再失败，而是编一个空对象当反馈：模型吐一段散文被静默降级成'
      + '"一份缺四个字段的响应"，真凶（模型契约没被遵守）在数据里消失——全局约束 3 的反面',
    find: `    throw invalid(\`上游 content 不是合法 JSON：\${redactSecrets(err?.message ?? err)}\`);`,
    replace: '    parsed = {};',
  },
  {
    name: 'V6_stalledBodyLooksInvalid', target: FBUP, expect: 'detected',
    why: '上游 body 停滞到上限时不再认"上限到点"（复审 Important 1 的同一形状）：'
      + '一次网络停滞被归成 `upstream_invalid` → 路由回 502 upstream_invalid，'
      + '而这一档的意思是"模型契约不对"，排查的人会去改提示词',
    find: `    if (isTimeoutAbort(err, signal)) {
      throw failed(\`上游请求超时（\${timeoutMs}ms 未返回，已主动中止）：\${String(err?.message ?? err)}\`);
    }`,
    replace: '    // 变异体：不再区分"上限到点"与"响应体不是 JSON"',
  },
  // ── 跟读判定（Task 9 · `web/units/speak.mjs`）：K1–K7 ──
  // 这批钉的是设计文档 §4.3 那条判据的全部内容：**只判有没有说出目标词**。
  // 判错了有两种方向，两种都很贵：判成"说出了"（用户没念也过关，跟读这一步等于没有）
  // 与判成"没说"（用户念对了却说没听到，只能靠跳过跟读逃出去）。所以 token 边界、
  // 大小写、转写原样保留、可用性只认函数、空序列默认值，各有一条。
  //
  // 口径变更（控制器裁定，见 task-9-report）：多词目标词从"永远判不出"改成"连续 token 子序列"。
  // K7 也随之从"已证等价"变成**可抓**的一条——重构把空序列的处理收敛成唯一一处
  // （`containsSequence` 的第一句），`checkSpeech` 不再另加早退，于是这一句是承重的。
  {
    name: 'K1_substringMatch', target: SPEAK, expect: 'detected',
    why: '把"连续 token 出现"退化成"拼成串再做子串包含"：`mugshot` 会被判成说出了 `mug`'
      + '（计划自带的用例就是为这条写的），于是"有没有说出这个词"不再成其为判据',
    find: '  return { said: containsSequence(tokenize(raw), tokenize(targetWord)), transcript: raw };',
    replace: "  return { said: tokenize(raw).join(' ').includes(tokenize(targetWord).join(' ')), transcript: raw };",
  },
  {
    name: 'K2_caseSensitive', target: SPEAK, expect: 'detected',
    why: '切词不做小写归一：语音引擎常把句首词首字母大写（`I see a Mug.`），'
      + '于是"念对了"被判成"没听到"——用户只能跳过跟读，而数据里看不出是判定坏了',
    find: "const tokenize = (s) => String(s ?? '').toLowerCase().split(/[^a-z']+/).filter(Boolean);",
    replace: "const tokenize = (s) => String(s ?? '').split(/[^a-z']+/).filter(Boolean);",
  },
  {
    name: 'K3_trimTranscript', target: SPEAK, expect: 'detected',
    why: '返回的转写被 trim 过：它是"用户到底说了什么"的唯一证据（复核引擎听错、将来做人工标注'
      + '都靠它），在这里顺手规整一下就把证据改掉了，而且改得没人看得见',
    find: '  return { said: containsSequence(tokenize(raw), tokenize(targetWord)), transcript: raw };',
    replace: '  return { said: containsSequence(tokenize(raw), tokenize(targetWord)), transcript: raw.trim() };',
  },
  {
    name: 'K4_availabilityTruthyNotFunction', target: SPEAK, expect: 'detected',
    why: '可用性判定只看"有没有这个字段"而不看它是不是函数：调用方会 `new` 它，'
      + '一个占位对象就能让界面进到"开始说"那条路，用户点下去的那一刻抛错',
    find: `  return typeof win?.SpeechRecognition === 'function'
    || typeof win?.webkitSpeechRecognition === 'function';`,
    replace: '  return win?.SpeechRecognition != null || win?.webkitSpeechRecognition != null;',
  },
  {
    name: 'K5_availabilityIgnoresWebkit', target: SPEAK, expect: 'detected',
    why: '只认 `SpeechRecognition`、丢掉 `webkitSpeechRecognition`：Safari / 旧 Chrome 只挂 webkit 那个名字，'
      + '于是整个跟读判定在这些浏览器上永远走降级（speech_unsupported 虚高）',
    find: `  return typeof win?.SpeechRecognition === 'function'
    || typeof win?.webkitSpeechRecognition === 'function';`,
    replace: "  return typeof win?.SpeechRecognition === 'function';",
  },
  {
    name: 'K6_availabilityReadsGlobalThis', target: SPEAK, expect: 'detected',
    why: '可用性判定不看传进来的对象、直接读全局：注入点就此失效（测试注入假引擎也没用），'
      + '而且这个模块不再是纯逻辑——它再也不能在 Node 里直接测',
    find: `  return typeof win?.SpeechRecognition === 'function'
    || typeof win?.webkitSpeechRecognition === 'function';`,
    replace: "  return typeof globalThis?.SpeechRecognition === 'function';",
  },
  {
    name: 'K7_dropEmptySeqGuard', target: SPEAK, expect: 'detected',
    why: '`containsSequence` 里"空序列不算出现"那一句被删掉：空目标词（空串 / 纯符号 / 纯空白 / null）'
      + '会**命中任何非空转写**——词表里一个配置错误（空串）就让所有人**自动**通过跟读。'
      + '这一句是该模块里**唯一**处理空序列的地方（`checkSpeech` 不再另加早退），所以它承重、'
      + '也必须能被抓到（口径变更前它是"等价变异体"，重构后是可抓的一条）',
    find: '  if (seq.length === 0) return false;',
    replace: '  // 变异体：空序列也当"出现"',
  },
  // ── Task 9 的接线（`web/app.mjs`）：P1–P22 ──
  // 这批钉的是这一轮新接的四条链：**入队幂等**（回环不许重置排期）、**复现两种模式分列**
  // （识物命中 / 手选，绝不合并）、**不许谎报换了场景**、**落盘口径**（submitCount /
  // revisions / dwellMs 是"这一轮"的停留）。每一条都对应一个"改坏了看不出来"的地方：
  // 排期被推回原点 → 复现永远不发生；sceneChanged 说谎 → 跨场景主张变成假数据；
  // dwellMs 记成累计值 → "这句花了多久"这个数永远拿不到。
  // 编号里**没有 P3**：原本想放"手写 dueAt 而不经 nextState"，但 `INTERVALS_DAYS[0]` 就是 1 天，
  // 手写出来的数值与原实现逐位相同——**行为不可分**，登记成 detected 只会得到一条假的 MISSED。
  // 它记在 task-9-report 的弱断言清单里（"dueAt 是否经 nextState 产出"这件事没有行为证据）。
  {
    name: 'P1_enqueueOverwritesExisting', target: APP, expect: 'detected',
    why: '入队不看是否已存在，直接按 stage 0 重排一次：**回环**（feedback → rewrite → composing → feedback）'
      + '每次提交都把 dueAt 推到新的 now，于是这个词永远到不了期——跨场景复现永远不会发生。'
      + 'brief §3.3.1 点名的就是这个坑，单次提交的用例照样全绿，只有回环用例抓得住',
    find: `    const id = wordIdOf(word);
    if (store.readWords()[id] !== undefined) return false;
    store.putWord(nextState({ id, word, stage: 0, lastScene: scene }, now));`,
    replace: `    const id = wordIdOf(word);
    store.putWord(nextState({ id, word, stage: 0, lastScene: scene }, now));`,
  },
  {
    name: 'P2_noEnqueue', target: APP, expect: 'detected',
    why: '学完不写词记录（就是本任务要补的那处缺口本身）：dueAt 永远不存在，'
      + '"学完即入队"与"到期复现"整条链一起消失，而界面上一切照旧',
    find: `    store.putWord(nextState({ id, word, stage: 0, lastScene: scene }, now));
    return true;`,
    replace: '    return true;',
  },
  {
    name: 'P4_recurrenceWithoutDueCheck', target: APP, expect: 'detected',
    why: '复现命中不再要求"这个词现在到期"（任一存在的词记录都算）：'
      + '还没到期的词也会被记一次复现并推进档位，复现率虚高、复现间隔被跳过',
    find: '    const target = dueList().find((w) => w.id === id);',
    replace: '    const target = dueList().find((w) => w.id === id) ?? store.readWords()[id];',
  },
  {
    name: 'P5_sceneChangedAlwaysTrue', target: APP, expect: 'detected',
    why: '`sceneChanged` 恒为 true：**谎报换了场景**（手选那一档根本没有场景、同一场景再拍到也算换了）。'
      + '跨场景复现是这一轮的核心主张，这个字段说谎等于把主张变成假数据',
    find: '    const sceneChanged = sceneChangedOf(scene, expectedScene);',
    replace: '    const sceneChanged = true;',
  },
  {
    name: 'P6_sceneChangedNaiveCompare', target: APP, expect: 'detected',
    why: '场景比较退化成裸的 `!==`（去掉"未知场景不算换"这条守卫）：手选档的"手动选择"与'
      + '上次的"kitchen"一比就成了"换了场景"——系统并不知道用户站在哪儿，却替他打了包票',
    find: `  const sceneChangedOf = (scene, expectedScene) => (
    isRealScene(scene) && isRealScene(expectedScene) && scene !== expectedScene
  );`,
    replace: '  const sceneChangedOf = (scene, expectedScene) => scene !== expectedScene;',
  },
  {
    name: 'P7_sceneChangedAlwaysFalse', target: APP, expect: 'detected',
    why: '`sceneChanged` 恒为 false：反向的说谎（真换了场景却说没换）。这一档看着"保守"，'
      + '但同样让"跨场景"这件事无法从数据里看出来',
    find: '    const sceneChanged = sceneChangedOf(scene, expectedScene);',
    replace: '    const sceneChanged = false;',
  },
  {
    name: 'P8_recurrenceMergedIntoScene', target: APP, expect: 'detected',
    why: '手选命中被记成 `recurrence_scene`（**两种模式合并**）：§3.4 要求分列，'
      + '因为"手选占比高"说明跨场景主张没被兑现——合并成一个总数就把这个信号抹掉了',
    find: "    record(store, source === 'manual' ? 'recurrence_manual' : 'recurrence_scene', {",
    replace: "    record(store, 'recurrence_scene', {",
  },
  {
    name: 'P9_manualRecurrenceNotRecorded', target: APP, expect: 'detected',
    why: '手选那条路不再记复现：用户在没被认出来的情况下自己找回这个词，'
      + '这次复现与它的排期推进一起消失（而且他下次还会被同一个词催一遍）',
    find: "    noteRecurrence('manual');",
    replace: '    // 变异体：手选不算复现',
  },
  {
    name: 'P10_recurrenceNotRecordedOnRecognize', target: APP, expect: 'detected',
    why: '识物命中那条路不再记复现（`recurrence_scene` 永不落）：整条"到期在新场景复现"的链'
      + '在数据里不存在，而界面照旧显示取到了词',
    find: "      noteRecurrence('recognized');",
    replace: '      // 变异体：识物命中不算复现',
  },
  {
    name: 'P11_speechMissLooksSaid', target: APP, expect: 'detected',
    why: '跟读判定结果被丢掉、一律当成"说出了"：**没念也过关**，跟读这一步等于没有，'
      + '而 reading_done 照样落一条——数据上看不出任何异常',
    find: "    const verdict = checkSpeech(shownWord?.word ?? '', transcript);",
    replace: '    const verdict = { said: true, transcript };',
  },
  {
    name: 'P12_unsupportedNotRecorded', target: APP, expect: 'detected',
    why: '转写不可用时不再落 `speech_unsupported`：降级这件事在数据里消失，'
      + '于是"多少人的浏览器根本做不了跟读判定"永远算不出来（全局约束 3：失败不得静默）',
    find: `    record(store, 'speech_unsupported', {
      sessionId,
      roundIndex: lastRoundIndex,
      wordId: null,
      word: shownWord?.word ?? null,
      scene: shownWord?.scene ?? null,
      reason: 'no_speech_recognition',
    }, clock);`,
    replace: '    // 变异体：不记降级标签',
  },
  {
    name: 'P13_unsupportedPretendsRead', target: APP, expect: 'detected',
    why: '降级路径**伪装成读对了**：转写不可用时也落一条 `reading_done`。'
      + '手动打勾只表示"我读了"，不是"系统听到我说出了目标词"——混记会让跟读通过率变成假的',
    find: '    if (speechOk) return;',
    replace: `    if (speechOk) return;
    record(store, 'reading_done', {
      sessionId,
      roundIndex: lastRoundIndex,
      wordId: null,
      word: shownWord?.word ?? null,
      scene: shownWord?.scene ?? null,
      transcript: null,
    }, clock);`,
  },
  {
    name: 'P14_speechAvailabilityIgnoresInjection', target: APP, expect: 'detected',
    why: '可用性判定改读全局而不是注入点：测试注入假引擎就再也驱动不了判定那条路，'
      + '而浏览器里注入点也失去意义（"判定来源只有一个"这条设计就此破掉）',
    find: '  const speechOk = isSpeechAvailable(speechWin);',
    replace: '  const speechOk = isSpeechAvailable(globalThis);',
  },
  {
    name: 'P15_composeSubmittedMissing', target: APP, expect: 'detected',
    why: '提交造句不再落盘（Task 6 曾刻意延后到 Task 9 的那一条）：学习者的句子是本轮'
      + '"成人愿为造句付多少成本"这批数据的载体，不落盘等于这次练习没有发生过',
    find: "    if (recordComposeSubmitted(text) === null) setError(`这句话没能记下来：${STORAGE_FULL_NOTICE}`);",
    replace: '    // 变异体：造句不落盘',
  },
  {
    name: 'P16_submitCountOffByOne', target: APP, expect: 'detected',
    why: '`submitCount` 少算一次（写成"提交次数 - 1"）：零改写会话会记成 0 次提交，'
      + '整个产出成本的分母从此偏一——progress 必办 1 要消除的正是这个歧义',
    find: `      submitCount: s.rewriteCount,
      revisions: s.rewriteCount - 1,`,
    replace: `      submitCount: s.rewriteCount - 1,
      revisions: s.rewriteCount - 1,`,
  },
  {
    name: 'P17_dwellIsCumulative', target: APP, expect: 'detected',
    why: '`dwellMs` 取快照里的累计值而不是"这一轮进入 composing 到提交"：回环之后第二次提交'
      + '会记成两轮之和（9000 记成 13000），§3.2 要的"这一句花了多久"这个数永远拿不到',
    find: '      dwellMs: composingEnteredAt === null ? null : clock() - composingEnteredAt,',
    replace: '      dwellMs: s.dwellMs.composing,',
  },
  {
    name: 'P18_dueHintHidden', target: APP, expect: 'detected',
    why: 'ready 态不再提示到期的词：复现这件事在界面上没有任何入口，'
      + '用户（和数据）都不会知道有词欠着一次新场景取词',
    find: `        const due = dueList();
        if (due.length > 0) {`,
    replace: `        const due = [];
        if (due.length > 0) {`,
  },
  {
    name: 'P19_dueHintDropsOthers', target: APP, expect: 'detected',
    why: '同时有多个到期词时不再说明还有几个在等：用户以为只有一个，'
      + '而"到期了却没被复现"的词会一直积压且没人知道',
    find: "            + (others > 0 ? `另有 ${others} 个词也到期了，先取这一个就行。` : '')));",
    replace: '            ));',
  },
  {
    name: 'P20_lastSceneOverwrittenByUnknown', target: APP, expect: 'detected',
    why: '排期写回时把 `lastScene` 无条件改成这次的场景：手选那一档的场景是占位值"手动选择"，'
      + '于是下次复现提示会说"上次是在「手动选择」场景学的"——一句没有信息量的话',
    find: '    store.putWord({ ...nextState(target, now), lastScene: isRealScene(scene) ? scene : expectedScene });',
    replace: '    store.putWord({ ...nextState(target, now), lastScene: scene });',
  },
  {
    name: 'P21_recurrenceNoAdvance', target: APP, expect: 'detected',
    why: '复现记了事件却不推进排期：这个词的 stage/dueAt 一动不动，'
      + '于是它永远停在同一个档位上被反复派发（1/3/7 天的阶梯根本没往上走）',
    find: '    store.putWord({ ...nextState(target, now), lastScene: isRealScene(scene) ? scene : expectedScene });',
    replace: '    // 变异体：不推进排期',
  },
  {
    name: 'P22_composeSubmittedLosesSentence', target: APP, expect: 'detected',
    why: '落盘时丢掉原句（只留一个"提交过"的计数）：产出成本能算，'
      + '但语料本身没了——验证三要拿这些话做人工标注，丢了就补不回来',
    find: '      sentence: text,',
    replace: '      sentence: null,',
  },

  // ── Task 9B：待补反馈队列（Q1–Q8）、storage_full（Q9–Q11）、reading_missed（Q12–Q13）──
  //
  // 这三件事共同的性质是 Task 7 那条教训：**再好的实现，如果测量它所需的数据没有被记录，
  // 整条验证链就是空的**。所以这一批变异体问的都是同一句话："这条路径静默失效时，
  // 有没有哪条用例会红？"
  {
    name: 'Q1_pendingNoId', target: APP, expect: 'detected',
    why: '`feedback_pending` 不再带 `pendingId`：待补条目**永远勾不掉**（补交成功的指针指不到它），'
      + '于是同一条欠账会被无限重发——而界面看起来一切正常',
    find: `      const withId = ev.type === 'feedback_pending'
        ? { ...fields, ...withPendingId({ sessionId, ts: clock(), payload: ev.payload }) }
        : fields;`,
    replace: '      const withId = fields;',
  },
  {
    name: 'Q2_retryTimerNeverScheduled', target: APP, expect: 'detected',
    why: '失败之后不排自动重试：设计 §5.1 的"自动重试 3 次"整条消失，'
      + '用户那句话只能靠手动补交（而绝大多数人不会去点）',
    find: `    const delay = Math.max(0, next.at - clock());
    retryTimer = setTimer(async () => {`,
    replace: `    const delay = Math.max(0, next.at - clock());
    if (delay >= 0) return;
    retryTimer = setTimer(async () => {`,
  },
  {
    name: 'Q3_retryIntervalHalved', target: APP, expect: 'detected',
    why: '重试间隔被改成设计之外的值（10s 改成 5s）：设定值没有测试钉住的话，'
      + '它会随某次"顺手调一下"静默漂移，而"三次重试 = 10/30/90 秒"是设计明文',
    find: '    const delay = Math.max(0, next.at - clock());',
    replace: '    const delay = Math.max(0, Math.floor((next.at - clock()) / 2));',
  },
  {
    name: 'Q4_retryUnlimited', target: APP, expect: 'detected',
    why: '自动重试不再有次数上限（排定时刻无视 `RETRY_DELAYS_MS` 的长度）：'
      + '一次服务端故障会让客户端**永远**重发下去，"仍失败"这个档位再也不成立',
    find: `      const at = scheduledRetryAt(item);
      if (at === null) continue;                     // 这条的自动重试已用完`,
    replace: `      const at = Number.isFinite(item.lastAttemptAt) ? item.lastAttemptAt + 10_000 : item.failedAt + 10_000;
      if (at === null) continue;                     // 这条的自动重试已用完`,
  },
  {
    name: 'Q5_retryLogsComposeSubmitted', target: APP, expect: 'detected',
    why: '补交时**也**落一条 `compose_submitted`：产出成本被记两次，'
      + '"成人愿为造句付多少成本"这个分母系统性偏大（补交越多偏得越厉害）',
    find: `  async function retryFeedback(item) {
    const fresh = pendingList().find((it) => it.pendingId === item.pendingId) ?? item;
    if (fresh.resolved) return;`,
    replace: `  async function retryFeedback(item) {
    const fresh = pendingList().find((it) => it.pendingId === item.pendingId) ?? item;
    if (fresh.resolved) return;
    recordComposeSubmitted(fresh.sentence);`,
  },
  {
    name: 'Q6_pendingCountNotDeduped', target: PENDING, expect: 'detected',
    why: '归档不再按 `pendingId` 归并（每个待补事件各自成条）：一条欠账重试失败 3 次会被数成 4 条，'
      + '界面告诉用户"你有 4 句话没拿到反馈"——对用户说假话，而且恰好是最不该出错的那个数',
    find: `    const id = pendingIdOf(e);
    const prev = byId.get(id);`,
    replace: `    const id = pendingIdOf(e);
    const prev = undefined;`,
  },
  {
    name: 'Q7_retryScheduledEvenWhenStoreFull', target: APP, expect: 'detected',
    why: '存储写满时照样排自动重试：每一次重试都必然写不进去，于是"写不进去"这件事'
      + '被反复重试掩盖成"网络问题"，而用户看到的是永远补不上的反馈',
    find: `    if (retryTimer !== null) return;
    if (storageFull()) return;`,
    replace: '    if (retryTimer !== null) return;',
  },
  {
    name: 'Q8_failedRetryResolvesItself', target: PENDING, expect: 'detected',
    why: '补交**又失败**时也带 `retriedPendingId`：一条失败的补交把自己的欠账勾掉，'
      + '那条句子从"还没补上"里消失、界面不再催，用户永远拿不到判定'
      + '（首版真写错过这一处，用例当场抓住了它）',
    find: `    const back = e?.payload?.retriedPendingId;
    if (typeof back === 'string' && back !== '' && !isPendingEvent(e)) resolvedIds.add(back);`,
    replace: `    const back = e?.payload?.retriedPendingId;
    if (typeof back === 'string' && back !== '') resolvedIds.add(back);`,
  },
  {
    name: 'Q9_storeErrorNameOnly', target: STORE, expect: 'detected',
    why: '配额判定只认 `name === \'QuotaExceededError\'`：Safari 与老 Firefox 给的是别的'
      + '形状（数字码 22 / 1014、`NS_ERROR_DOM_QUOTA_REACHED`），于是一整批浏览器上'
      + '`storage_full` 这个档位永远不可达，而"存储写满"会退化成一次崩溃',
    find: `  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  const code = typeof err.code === 'number' ? err.code : NaN;
  return code === 22 || code === 1014;`,
    replace: "  return err.name === 'QuotaExceededError';",
  },
  {
    name: 'Q10_storeQuotaSilentlySwallowed', target: STORE, expect: 'detected',
    why: '配额异常被**静默吞掉**（只置标记、不重抛）：写失败被伪装成写成功，'
      + '正是 Global Constraint 3 禁止的静默降级——调用方再也无法知道"这条没记下来"',
    find: `      if (isStoreFullError(err)) markStoreFull();
      throw err;`,
    replace: '      if (isStoreFullError(err)) markStoreFull();',
  },
  {
    name: 'Q11_markStoreFullNotIdempotent', target: STORE, expect: 'detected',
    why: '`markStoreFull` 不幂等：每次配额失败都再试着写一次元数据——'
      + '在已经满了的存储上反复写，把"写满"变成一处自激循环（brief §2.2 的自反悖论）',
    find: '    if (fullMarked) return false;\n    fullMarked = true;',
    replace: '    fullMarked = true;',
  },
  {
    name: 'Q12_readingMissedAlsoOnSkip', target: APP, expect: 'detected',
    why: '跳过跟读也记成 `reading_missed`：用户主动跳过跟读被算成"念错"，'
      + '跟读失败率从此虚高，而真凶（引擎听错）被这个噪声淹没',
    find: `  function onWordReady() {
    if (!machine.send('wordReady')) return;`,
    replace: `  function onWordReady() {
    record(store, 'reading_missed', {
      sessionId, roundIndex: lastRoundIndex, wordId: null,
      word: shownWord?.word ?? null, scene: shownWord?.scene ?? null,
      transcript: null, reason: 'skipped',
    }, clock);
    if (!machine.send('wordReady')) return;`,
  },
  {
    name: 'Q13_readingMissedBeforeMutualExclusion', target: APP, expect: 'detected',
    why: '`reading_missed` 写在了"念对了"那条分支**之前**：一次判定落两条'
      + '（`reading_done` + `reading_missed` 同时存在），跟读通过率与失败率都成了假数',
    find: `    const verdict = checkSpeech(shownWord?.word ?? '', transcript);
    if (verdict.said) {`,
    replace: `    const verdict = checkSpeech(shownWord?.word ?? '', transcript);
    record(store, 'reading_missed', {
      sessionId, roundIndex: lastRoundIndex, wordId: null,
      word: shownWord?.word ?? null, scene: shownWord?.scene ?? null,
      transcript: verdict.transcript, reason: 'always',
    }, clock);
    if (verdict.said) {`,
  },
  // ⚠️ 这一批里**没有**"调用方冗余去重"那条等价变异体（原编号 Q14，已删除）。
  // 它本来要证明的是：`app.mjs` 的 `openPending()` 里再加一层 `Set` 去重是**空的**
  // （归并已经在 `pending.mjs` 的 `pendingFeedbackArchive` 里做过）。事实成立
  // ——把它加回去，全仓测试确实全绿——但**探针证明不了它**：等价主张要过差分核对，
  // 而差分视图按**模块路径**注册，`app.mjs` 没有视图（它是装配层，一个 `view()` 函数
  // 得把整条挂载流程复刻一遍，成本远大于这一条的价值）。
  // 于是处置是：**不登记**那条变异体，改成在 `pending-mount.test.mjs` 里直接钉住
  // "入口给不出空列表"这个可观察行为（实测：把入口层的结果清空，8 条用例变红）。
  // 留着这一段是为了让下一个人不必重新发现一遍"app.mjs 不能登记等价变异体"。

  // ── Task 10：导出的口径（`scripts/export.mjs`）：X1–X11 ──────────────────────
  //
  // 这一批钉的是**计数的口径**，不是"函数会不会跑"。判据统计的坏法全都长得一样：
  // 数字仍然是个数字，只是它回答的不是原来那个问题——而看数据的人无从发觉。
  // 因此每一条都对着 brief §2 的某一条口径，且每一条都被 `tests/export.test.mjs`
  // 里一条**正向**用例抓住（用"某个数等于几"而不是"没抛错"）。
  {
    name: 'X1_composeTotalAddsFeedback', target: EXPORT, expect: 'detected',
    why: '造句总数把判定事件（feedback_ok）里的同一句也加进来：同一句话被数两遍，'
      + '而"成人愿为造句付多少成本"这个成本数就此虚高（诊断页把这句口径写在页面上，两处必然漂移）',
    find: `  const composeTotal = countOf(list, 'compose_submitted');`,
    replace: `  const composeTotal = countOf(list, 'compose_submitted') + countOf(list, 'feedback_ok');`,
  },
  {
    name: 'X2_retriedAnyTruthy', target: EXPORT, expect: 'detected',
    why: '`retried` 判成"有个真值就算"（`Boolean(...)`）：契约是**只有 `retried: true` 才算补交**'
      + '（`units/pending.mjs` 的 `retryEventFor`），杂值（`"yes"` / `1`）被算成补交后，'
      + '"补交来的判定"与"补交成功率"的分母一起被污染',
    find: `const isRetried = (e) => e?.payload?.retried === true;`,
    replace: `const isRetried = (e) => Boolean(e?.payload?.retried);`,
  },
  {
    name: 'X3_uncertaintyDenominatorIncludesPending', target: EXPORT, expect: 'detected',
    why: '`uncertain` 的分母把"没拿到判定"（feedback_pending）也算进去——**plan 示例的写法**。'
      + '后果方向恰好反了：网络越差、拿不到判定越多，线上看起来就越"判得不含糊"',
    find: `  const feedbackJudged = list.filter((e) => JUDGED_TYPES.includes(e?.type)).length;`,
    replace: `  const feedbackJudged = list.filter((e) => JUDGED_TYPES.includes(e?.type) || e?.type === 'feedback_pending').length;`,
  },
  {
    name: 'X4_readingDenominatorIncludesUnjudged', target: EXPORT, expect: 'detected',
    why: '跟读失败率的分母混进 `speech_unsupported` 与 `skipped_reading`（那两个是"没判过"）：'
      + '浏览器不支持的会话越多，跟读失败率看起来越低',
    find: `  const readingJudged = readingDone + readingMissed;`,
    replace: `  const readingJudged = readingDone + readingMissed + countOf(list, 'speech_unsupported') + countOf(list, 'skipped_reading');`,
  },
  {
    name: 'X5_sceneChangedNotTrue', target: EXPORT, expect: 'detected',
    why: '`sceneChanged` 反过来判（`!== false`）：缺字段/拿不准的那些也记成"换了场景"，'
      + '§3.4 要看的"跨场景到底有没有被兑现"直接虚高',
    find: `  const sceneChangedTrue = recurrence.filter((e) => e?.payload?.sceneChanged === true).length;`,
    replace: `  const sceneChangedTrue = recurrence.filter((e) => e?.payload?.sceneChanged !== false).length;`,
  },
  {
    name: 'X6_gateOffByOne', target: EXPORT, expect: 'detected',
    why: '判据 B 的门槛从"需重拍 ≥2 次"（R ≥ 3）松一格到"重拍 ≥1 次"（R ≥ 2）：'
      + '重拍率整体虚高，`retry_rate ≤ 0.2` 这条闸变得更容易不达标（或更容易被误判达标）',
    find: `  const needing = counted.filter(([, r]) => needsReshoot(r));`,
    replace: `  const needing = counted.filter(([, r]) => r - 1 >= 1);`,
  },
  {
    name: 'X7_denominatorAllSessions', target: EXPORT, expect: 'detected',
    why: '判据 B 的分母用"事件流里出现过的全部会话"（含只有 `blocked_permission`、'
      + '一次快门都没按过的会话）：相机没授权的用户被算成"没重拍"，重拍率被稀释',
    find: `  const counted = [...roundCounts.entries()].filter(([, r]) => r >= 1);`,
    replace: `  const counted = [...roundCounts.entries()];`,
  },
  {
    name: 'X8_top3NotSliced', target: EXPORT, expect: 'detected',
    why: 'top-3 命中不切前 3 个候选（整个候选数组里有没有就算命中）：'
      + 'top3 退化成"候选里含不含可接受词"，`top3 ≥ 0.85` 这条判据直接被放水',
    find: `      if (cands.slice(0, 3).some((c) => set.includes(c))) top3Hits += 1;`,
    replace: `      if (cands.some((c) => set.includes(c))) top3Hits += 1;`,
  },
  {
    name: 'X9_retrySuccessDenominator', target: EXPORT, expect: 'detected',
    why: '补交成功率的分母用"拿到判定的补交"而不是"试过几次补交"：'
      + '**补交失败的那些拿不到判定、会被分母剔掉**，于是分母只剩成功的那几条，'
      + '成功率恒为 1——而"补交到底能不能救回反馈"正是那条队列存在的理由（首版真写错过这一处）',
    find: `    retrySuccessRate: rate(retriedResolved, retriedAttempts.length),`,
    replace: `    retrySuccessRate: rate(retriedResolved, retriedJudged),`,
  },
  {
    name: 'X10_retriedResolvedNoPointerCheck', target: EXPORT, expect: 'detected',
    why: '"补上了"只判 `retriedPendingId` 这个键**存在**而不判它是非空字符串：'
      + '补交**又失败**那条若带了空值指针，会被读成"补上了"，欠账被凭空勾掉',
    find: `    (e) => typeof e?.payload?.retriedPendingId === 'string' && e.payload.retriedPendingId !== '',`,
    replace: `    (e) => e?.payload?.retriedPendingId !== undefined,`,
  },
  {
    name: 'X11_csvNoBom', target: EXPORT, expect: 'detected',
    why: 'CSV 去掉 UTF-8 BOM：Excel 按本地编码（简中 Windows 上是 GBK）解释含中文的 payload，'
      + '整张表变乱码——而乱码会让人以为"数据坏了"，正是 brief §2 第 8 条要避免的那件事',
    find: '  return `\\uFEFF${[header, ...rows].map((r) => r.map(escapeCell).join(\',\')).join(\'\\n\')}\\n`;',
    replace: '  return `${[header, ...rows].map((r) => r.map(escapeCell).join(\',\')).join(\'\\n\')}\\n`;',
  },
  {
    name: 'X12_writeLatencyZeroWhenMissing', target: APP, expect: 'detected',
    why: '服务端没给耗时时**写 0**（`Number.isFinite(x) ? x : 0`）：0 是一个"合法且极好"的读数，'
      + '于是 `latency_p95` 永远漂亮，而真凶（服务端没回这个数）被一个假数字盖住。'
      + '注意它在"服务端给了有限数"那一支上与真实现**完全一致**，所以只有"没给"那条用例能抓它',
    find: '        ...(Number.isFinite(picked.latencyMs) ? { latencyMs: picked.latencyMs } : {}),',
    replace: '        latencyMs: Number.isFinite(picked.latencyMs) ? picked.latencyMs : 0,',
  },
  {
    name: 'X13_gapWhenNoRecognizeOk', target: EXPORT, expect: 'detected',
    why: '缺口判据退回"一条耗时样本都没有就报"：只跑过相机那几步、**一条 recognize_ok 都没有**的流'
      + '会被报成"缺耗时字段"——那是"还没数据"，不是"数据源坏了"，两者对 Task 11 的处置完全不同',
    find: '  if (recognized.length > 0 && latencies.length === 0) {',
    replace: '  if (latencies.length === 0) {',
  },
  {
    name: 'X14_latencyIncludesFailures', target: EXPORT, expect: 'detected',
    why: '耗时的样本里混进 `recognize_failed`：判据 A 的样本数（分母）是 `recognize_ok` 的条数，'
      + '把失败那几次的等待也算进 p95，两个数就不是同源的了（"取词成功的等待"被"失败的等待"污染）',
    find: '  const latencies = recognized\n    .filter((e) => Number.isFinite(e?.payload?.latencyMs))',
    replace: '  const latencies = list\n    .filter((e) => Number.isFinite(e?.payload?.latencyMs))',
  },
  // ── Task 10 收口：`recognize` 带出服务端自报的耗时（判据 A 的 p95 的唯一数据来源）──
  // 这两条与 X12–X14 同属 Task 10，但目标模块是 `recognize.mjs`，沿用该模块既有的
  // R 系列编号（R1–R15 已用），故为 R16/R17。
  {
    name: 'R16_latencyZeroFallback', target: REC, expect: 'detected',
    why: '服务端没回 `latency_ms` 时兜底成 **0** 而不是 `null`：0 是"合法且极好"的读数，'
      + '用它代替"不知道"会让 p95 看起来完美——判据 A 的 p95 不能建立在编造的数据上',
    find: 'const serverLatencyOr = (data) => (Number.isFinite(data?.latency_ms) ? data.latency_ms : null);',
    replace: 'const serverLatencyOr = (data) => (Number.isFinite(data?.latency_ms) ? data.latency_ms : 0);',
  },
  {
    name: 'R17_latencyAcceptsNonFinite', target: REC, expect: 'detected',
    why: '耗时不做有限性校验（原样带出 `data.latency_ms`）：服务端回一个字符串/`null`/`NaN` '
      + '会被下游当成耗时读数，p95 算出 `NaN` 或参与字符串比较，而**看起来仍是"算过了"**',
    find: '  return { candidates: data.candidates, latencyMs: serverLatencyOr(data) };',
    replace: '  return { candidates: data.candidates, latencyMs: data.latency_ms ?? null };',
  },
];

// ─────────────────────────────────────────────────────────── 工具
/**
 * 单个变异体子进程的**墙钟上限**（护栏 4）。`node:test` 默认超时是 `Infinity`，所以一条把测试
 * 跑挂的变异体会让探针无限期挂住、不给诊断（本项目 Task 2 已吃过同款亏：手写测试替身的
 * `oncomplete` 永不触发 → 零输出挂死，看起来像"还在跑"而不是"失败"）。
 * 取值理由：整套测试当前约 1.5s（改前/改后全量 `node --test` 的 `duration_ms` 为 1515 / 1528），
 * 30s 已是**约 20 倍**整套测试、**三个数量级**于单文件耗时的余量——正常变异体绝无可能撞上，而它能保证
 * 卡死的那一个在 30s 内变成一条可读的诊断而不是一次无限等待。成本上界从"无限"变成
 * `30 个变异体 × 30s`（最坏 15 分钟，且首个超时即 FAIL 退出，实际远小于此）。
 *
 * **Task 10 提到 60s**：`tests/export.test.mjs` 里有 6 条用例会 `execFileSync` 起子进程跑 CLI，
 * 全是**冷启动**（每次约 60–70ms，但机器忙时会拉长），这一整套的墙钟比纯逻辑那套高一个量级。
 * 提高这一道闸的代价只是"真卡死时多等一会儿"，而**降低它的代价是把一次慢启动误判成 TIMEOUT**
 * （TIMEOUT 按"未抓到"单列，会污染结论）。宁可等，不要误判。
 */
const CHILD_TIMEOUT_MS = 60_000;
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
 *
 * Task 9 起还要**先整条剥掉"再导出"**（`export { … } from '…';`）：只去掉行首那个 `export `
 * 的话，剩下的 `{ … } from '…';` 不是合法语句——而 `web/app.mjs` 顶上正好有这么一条，
 * 于是 P 系列（本任务的全部接线变异体）第一次跑全是 PATCH-FAILED。
 *
 * Task 10 起还要**把 `import.meta` 换掉**：`scripts/export.mjs` 用
 * `import.meta.main`（Node 24 的"是不是被当命令跑"判定）与 `import.meta.url`，
 * 而 `import.meta` 只在 ES 模块里合法——`new Function` 见它同样报语法错，
 * 于是 X 系列第一次跑全部 PATCH-FAILED（与 Task 9 那条同源、同一种失效形状：
 * **探针的语法门把"新模块的新语法"误判成"变异体坏了"**）。
 * 换成 `({})` 之后它的取值不再被检查（与"剥掉 import/export 行"同一个代价）。
 * **局限（如实记，别当成没这回事）**：剥掉 import/export 行之后再查语法，等于不再检查那些行本身。
 * 现有变异体的 `find` 全在函数体/常量里，没有一条动 import/export 行，所以这道门对当前变异集
 * 的能力不变；将来若出现改 import 行的变异体，这里会漏，届时应换成真编译检查（例如 `node --check`）。
 */
function syntaxOk(source, rel) {
  try {
    const stripped = source
      .replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];\s*$/gm, '')
      .replace(/^export /gm, '')
      // 单行 import（`import x from '…';`）
      .replace(/^import .*?;$/gm, '')
      // **多行 import**（`import {\n  a,\n  b,\n} from '…';`）。
      // Task 9B 之前 `app.mjs` 的 import 全是单行的，这条缺陷一直没暴露；
      // 它一旦漏掉，整个 P 系列都会以"变异体语法错误"收场（看起来像探针坏了，
      // 而根因是这行正则）—— 与 Task 9 §5.4 那条 `export { … } from` 的坑同源。
      // 剥掉之后不再检查这些行（它们本来也不参与变异），局限写在文件头。
      .replace(/^import [\s\S]*?from\s*['"][^'"]*['"];\s*$/gm, '')
      // `import.meta`（Task 10：`scripts/export.mjs` 的"被当成命令跑"判定）
      .replace(/import\.meta/g, '({})');
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
  // Task 9：`speak` 的差分视图。**目前没有等价变异体用它**（K7 在口径变更后从"等价"改判为
  // "可抓"），留着它是为了让将来任何"等价"主张都能被差分核对证明——探针的纪律是
  // "等价主张必须由差分核对证明，证明不过就反过来按漏网处理"。
  // 视图取的是这个模块真正承诺的东西：两个函数的返回值，输入域要覆盖空值、大小写、
  // 标点、多词目标词、数字/非 ASCII 转写这些恰好踩在规则边界上的形状。
  [SPEAK]: (mod) => {
    const words = ['mug', 'MUG', 'mugshot', '', null, undefined, 'notebook computer',
      'ice-cream', 'mug2', '的', 0, 42];
    const transcripts = ['I see a Mug.', 'a mug, and a MUG!', 'mugshot', 'two mugs', '',
      '   ', '  mug  ', 'ice cream', 'I use a notebook computer', 'mug2', 'mug的', '一个 mug',
      null, undefined, 0, 42, 'MUG'];
    const wins = [undefined, null, 0, 1, 'x', true, {}, { SpeechRecognition: () => {} },
      { webkitSpeechRecognition: () => {} }, { SpeechRecognition: {} }, { SpeechRecognition: () => {}, webkitSpeechRecognition: {} }];
    return JSON.stringify({
      speech: words.flatMap((w) => transcripts.map((t) => {
        const r = mod.checkSpeech(w, t);
        return [r.said, String(r.transcript)];
      })),
      avail: wins.map((w) => mod.isSpeechAvailable(w)),
    });
  },
  // Task 9B：`pending` 的差分视图。**目前由 Q14（调用方冗余去重）这一条等价主张使用**。
  // 视图取的是这个模块真正承诺的东西：从事件流派生出的队列（每条欠账的 id / 原句 /
  // 重试次数 / 是否已补交 / 排定时刻），输入域覆盖同 id 多次重试、已补交的指针、
  // 旧版无 id 的事件、乱序、坏数据这些恰好踩在归并规则边界上的形状。
  [PENDING]: (mod) => {
    const ev = (ts, payload, type = 'feedback_pending', sessionId = 's1') => (
      { ts, type, wordId: null, roundIndex: 1, sessionId, payload }
    );
    const PA = 'p_s1_1000';
    const cases = [
      [],
      [ev(1_000, { sentence: 'a', pendingId: PA })],
      [ev(1_000, { sentence: 'a', pendingId: PA }), ev(1_010, { sentence: 'a', pendingId: PA, retried: true, attempt: 1 })],
      [ev(1_000, { sentence: 'a', pendingId: PA }), ev(1_010, { sentence: 'a', pendingId: PA, retried: true, attempt: 1 }),
        ev(1_040, { sentence: 'a', pendingId: PA, retried: true, attempt: 2 }),
        ev(1_130, { sentence: 'a', pendingId: PA, retried: true, attempt: 3 })],
      [ev(1_000, { sentence: 'a', pendingId: PA }), ev(1_100, { sentence: 'a', verdict: 'correct', retried: true, retriedPendingId: PA }, 'feedback_ok')],
      // 旧版事件（payload 里没有 id）→ 派生 id 必须与真实现一致
      [ev(500, { sentence: 'legacy' })],
      // 乱序 + 两条不同欠账
      [ev(2_000, { sentence: 'b', pendingId: 'p_s1_2000' }), ev(1_000, { sentence: 'a', pendingId: PA })],
      // 坏数据：不给数组 / 元素是 null
      null, undefined, 'x', 42, [null, undefined, {}],
    ];
    return JSON.stringify(cases.map((c) => mod.pendingFeedbackArchive(c).map((it) => [
      it.pendingId, it.sentence, it.autoAttempts, it.resolved, it.retried, it.failedAt, it.lastAttemptAt,
    ])));
  },
};

/**
 * 差分核对：变异体与真实现是否在给定输入域上给出完全相同的输出。
 * 目标模块没有定义视图时**返回不一致**（保守方向：等价主张证明不过，就按漏网处理），而不是抛错中断整轮。
 *
 * `PROBE_DIFF_DEBUG=1` 时把两侧的差异打出来——**等价主张失败时最需要的是"哪里不一样"**，
 * 而只有 `agree=false` 一个布尔值的话，读的人分不清是"视图真的抓到了差异"还是
 * "视图自己坏了/抛错了"（Task 9B 实测踩过：`view()` 抛错被静默吞成 agree=false，
 * 看起来像一条 OVERCLAIM，实际是差分视图的实现问题）。
 */
async function differentialAgreement(targetKey, pristinePath, mutantPath) {
  const view = DIFF_VIEWS[targetKey];
  if (!view) return { agree: false, real: '（无）', mutant: `未为 ${targetKey} 定义差分视图` };
  const load = async (p) => import(`${pathToFileURL(p).href}?v=${Date.now()}${Math.random()}`);
  const [real, mutant] = [await load(pristinePath), await load(mutantPath)];
  const call = (mod, label) => {
    try {
      return { value: view(mod) };
    } catch (err) {
      return { value: `（差分视图在 ${label} 上抛错：${String(err?.message ?? err)}）`, threw: true };
    }
  };
  const a = call(real, '真实现');
  const b = call(mutant, '变异体');
  if (a.value !== b.value && process.env.PROBE_DIFF_DEBUG === '1') {
    console.log(`\n[差分调试] ${targetKey} 两侧输出不一致（视图抛错：real=${a.threw === true} mutant=${b.threw === true}）`);
    console.log(`  真实现：${String(a.value).slice(0, 400)}`);
    console.log(`  变异体：${String(b.value).slice(0, 400)}`);
  }
  return { agree: a.value === b.value, real: a.value, mutant: b.value };
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
