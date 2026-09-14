/**
 * 实弹探针：**真的**走一遍完整造句反馈链路，并把观测到的每一件事如实打印出来。
 *
 * 这是控制器对 Task 8 的追加要求 A3：单元测试只证明"我们自己写的桩能被正确调用"，
 * 证明不了"端点能把一句真话送给模型并拿回一份可用的判定"。本脚本起一个**真实子进程**服务
 * （`node --env-file=.env server/index.mjs`，与生产启动方式逐字一致），用真实凭据打
 * 少量几次调用（**每次都要花钱**，所以句子是写死的，不给它加参数乱跑）。
 *
 * 默认的四条语料覆盖控制器点名的三种情形 + 一条冲 `uncertain` 的边界句：
 *   1. clearly-correct      —— 目标词用对了（预期 `correct` / `none`）；
 *   2. wrong-word           —— 该用 mug 却写了 cup（预期 `flawed` / `word_choice`）；
 *   3. bad-collocation      —— 语法没大错但搭配不地道（预期 `flawed` / `collocation`）；
 *   4. borderline-uncertain —— 明显别扭但语法说得通的英文句（逼 `uncertain`）。
 * 预期只是**预期**：脚本照实打印模型真正回了什么，不符就说不符，绝不改成"应该的样子"。
 *
 * ⚠️ 第 4 条**不是**计划 step 6 点名的触发器（那一条要求"乱码"输入）。真正用退化输入去问
 * "`uncertain` 这一档够不够得到"的是 `--degenerate` 模式（下面三条，**3 次计费调用**）：
 *   · garbage-bytes  —— 一串随机字符（计划 step 6 点名的乱码）；
 *   · another-script —— 整句中文（既不是英文，也没有目标词）；
 *   · fragmented     —— 多子句碎片、没有动词主干。
 *
 * 走的是**客户端那一腿**（`submitSentence`）而不是裸 fetch：这样探针同时覆盖
 * "客户端 → 服务端 → 上游 → 客户端 → validateFeedback"整条链路，
 * 也就是 `tests/feedback-endpoint.test.mjs` 用桩覆盖的那条链路的真弹版本。
 *
 * 打印的字段（Task 8 复审 Item 2 起**每条都有**）：HTTP 状态、四个字段、**服务端自报的
 * `latency_ms`**、**服务端回的 `usage` token 计数**、端到端耗时、校验器结论，以及服务端 stderr 里
 * 与反馈有关的那几行（失败时这是唯一线索）。
 * `latency_ms` / `usage` 由包在 `fetchImpl` 外面的那一层用 `res.clone()` 从**响应信封**里读出来
 * ——它们是报告要引用的证据，必须由产出物自己给出，**不再靠"另外再发一次裸调用"**（那一次会白花
 * 一份钱，而且让调用次数与报告说的对不上）。`--envelope` 只在"怀疑信封里还有别的东西"时才用。
 *
 * **绝不伪造结果**：拿不到密钥、请求失败、上游报错、字段不合契约，都照原样打印并标记出来。
 * 密钥本身从不打印（只报"有没有"）。
 *
 * 用法（在仓库根）：
 *   node --env-file=.env scripts/probe-feedback-live.mjs [--port=8899]          # 4 次计费调用
 *   node --env-file=.env scripts/probe-feedback-live.mjs --degenerate           # 3 次计费调用（退化输入）
 *   node --env-file=.env scripts/probe-feedback-live.mjs --envelope             # 额外 1 次裸信封调用
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { submitSentence, FEEDBACK_REQUEST_TIMEOUT_MS } from '../web/units/compose.mjs';
import { validateFeedback } from '../web/units/feedback.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice('--port='.length) : 0) || (8900 + (process.pid % 90));
const BOOT_TIMEOUT_MS = 20_000;

/**
 * `--degenerate`：跑 Item 3 的**退化输入**探测（3 次计费调用），而不是默认的四条正常语料。
 *
 * 存在的理由：默认那四条（含一条专冲 `uncertain` 的别扭英文句）在真实调用里**一次都没换来
 * `uncertain`**，而计划 step 6 点名的触发条件是**乱码**输入。这个模式用真正退化的输入去问一次
 * "这一档到底够不够得到"——每次都要花钱，所以只有三条，且必须显式加参数才会跑。
 */
const DEGENERATE = args.includes('--degenerate');
/**
 * `--envelope`：额外做**一次**裸 HTTP 调用（真实计费），只为打印完整响应信封。
 *
 * Task 8 复审后默认**不需要**它：逐条的输出里已经有 HTTP 状态、`latency_ms` 与 `usage` 了
 * （见下面的 `fetchImpl` 反射）。留着它只为"怀疑信封里还有别的东西"这种偶发核对。
 */
const ENVELOPE = args.includes('--envelope');

const say = (line) => process.stdout.write(`${line}\n`);

/** 三条写死的正常语料（见文件头：不给参数，免得"随手多跑几次"把额度花光）。 */
const NORMAL_CASES = [
  {
    label: 'clearly-correct',
    expectation: 'verdict=correct / error_type=none',
    input: { sentence: 'I put the mug on the desk every morning.', word: 'mug', scene: 'desk' },
  },
  {
    label: 'wrong-word',
    expectation: 'verdict=flawed / error_type=word_choice（该说 mug 却写了 cup）',
    input: { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
  },
  {
    label: 'bad-collocation',
    expectation: 'verdict=flawed / error_type=collocation（搭配不地道）',
    input: { sentence: 'I very like my mug.', word: 'mug', scene: 'kitchen' },
  },
  {
    // 这一条是**冲 `uncertain` 去的**：真实调用里从没出现过这一档，而它是设计文档 §4.2 的
    // 核心让步（"拿不准"是合法答案）。用一句明显别扭、但语法上说不清对错的句子去逼它。
    // 逼不出来也照实记——那是一条真实的观测，不是探针的失败。
    // ⚠️ 复审结论：**它不是计划 step 6 点名的那个触发器**（那一条要求乱码输入），
    // 所以这一条只能算"别扭英文"，真正冲这一档的是 `--degenerate` 的三条。
    label: 'borderline-uncertain',
    expectation: 'verdict=uncertain（逼不出来就如实记：模型给了别的判定）',
    input: { sentence: 'The mug it is on desk maybe.', word: 'mug', scene: 'desk' },
  },
];

/**
 * 退化输入（`--degenerate`，**3 次计费调用**）：每条都真的不可能出现在正常语料里。
 *
 * 为什么是这三条（Task 8 复审 Item 3）：计划 step 6 点名"乱码"是 `uncertain` 的触发条件，
 * 而上一轮的实现换成了"别扭但语法完整的英文句"——于是这一档**从没被它指定的触发器探过**。
 */
const DEGENERATE_CASES = [
  {
    label: 'garbage-bytes',
    expectation: '计划 step 6 点名的"乱码"：verdict=uncertain（或任何明确判定，照实记）',
    input: { sentence: 'x7#§q!Z\%&*()_+|}{[]":;?/\\~^`<>,.😀🧱', word: 'mug', scene: 'desk' },
  },
  {
    label: 'another-script',
    expectation: '整句是中文（不是英文，也没有目标词）：verdict=uncertain（或任何明确判定，照实记）',
    input: { sentence: '我把杯子放在桌子上，然后去上班了。', word: 'mug', scene: 'desk' },
  },
  {
    label: 'fragmented',
    expectation: '多子句碎片、没有动词主干：verdict=uncertain（或任何明确判定，照实记）',
    input: { sentence: 'mug … desk, and then, maybe not, because the, um, cup? yes no', word: 'mug', scene: 'desk' },
  },
];

const CASES = DEGENERATE ? DEGENERATE_CASES : NORMAL_CASES;

// ── 前置检查（缺什么就说什么，绝不假装跑过）──────────────────────────────────
for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE', 'DEEPSEEK_MODEL']) {
  if (!process.env[k] || String(process.env[k]).trim() === '') {
    say(`环境变量 ${k} 缺失或为空——请用 node --env-file=.env 运行本脚本`);
    process.exit(1);
  }
}

say('=== 实弹探针：Task 8 造句反馈端点（/api/feedback）===');
say(`配置：base=${process.env.DEEPSEEK_API_BASE} model=${process.env.DEEPSEEK_MODEL} `
  + `key=${process.env.DEEPSEEK_API_KEY ? `已提供(${String(process.env.DEEPSEEK_API_KEY).length} 字符)` : '缺失'}`);
say(`客户端这一腿的上限：${FEEDBACK_REQUEST_TIMEOUT_MS}ms`);
say(`模式：${DEGENERATE ? '--degenerate（退化输入，冲 uncertain）' : '默认（正常语料）'}`
  + `；这一轮**计费调用 ${CASES.length + (ENVELOPE ? 1 : 0)} 次**`
  + `（语料 ${CASES.length} 条${ENVELOPE ? ' + 裸信封 1 次' : ''}），另加 1 次零计费空句边界`);

// ── 起真实服务子进程（输出重定向到文件：本环境不允许 piped stdio）──────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task8-live-probe-'));
const logPath = path.join(tmpDir, 'server.log');
const fd = fs.openSync(logPath, 'w');
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: REPO, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', fd, fd],
});
const readLog = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; }; };

const waitForListen = async () => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readLog().includes(`listening on http://localhost:${PORT}`)) return true;
    if (child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

/** 观测记录：原样留下来给报告用（每条一行 JSON，必要时可粘进报告）。 */
const observations = [];
let exitCode = 0;

/**
 * 一次请求的**真实信封**（HTTP 状态 + 响应体），由包在 `fetchImpl` 外的那一层反射出来。
 *
 * 为什么这样拿（Task 8 复审 Item 2）：`submitSentence` 只交回分档结论与四个字段，
 * `latency_ms` / `usage` 在**响应信封**里——而报告要引用它们，就必须由**产出物自己**给出，
 * 不能靠"另外再发一次裸调用"。于是这里包一层 fetch：用 `res.clone()` 读一份副本，
 * 原响应照样交回 `submitSentence`（它是消费者，不能被我抢了 body）。
 */
async function callCase(label, input) {
  const t0 = Date.now();
  let http = null;
  const fetchImpl = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, init);
    let body = null;
    try { body = await res.clone().json(); } catch { body = null; }
    http = { status: res.status, body };
    return res;
  };
  let result = null;
  let threw = null;
  try {
    result = await submitSentence(input, { fetchImpl });
  } catch (err) {
    threw = err;
  }
  return {
    label, input, result, threw, http, elapsed_ms: Date.now() - t0,
  };
}

/** 把一次观测按人读的顺序打出来（HTTP 状态 → 判定 → 信封字段 → 校验器 → 与预期对照）。 */
function reportCase(obs, index, total) {
  const { label, input, result, threw, http, elapsed_ms: elapsed } = obs;
  say(`───── [${index}/${total}] ${label} ─────`);
  say(`输入：sentence=${JSON.stringify(input.sentence)} word=${input.word} scene=${input.scene}`);
  say(`预期（设计文档 §4.2 的契约下的**期望**，不是保证）：${CASES.find((c) => c.label === label).expectation}`);
  say(`HTTP：${http === null ? '(没有响应)' : http.status}`);

  if (threw !== null) {
    // `submitSentence` 的契约是"不抛错"，抛了就说明有编程错误——照实报，不掩盖。
    say(`！！客户端抛出了异常（这违反 submitSentence 的契约）：${threw?.stack ?? threw}`);
    say('');
    return;
  }

  const env = http?.body ?? null;
  say(`服务端自报 latency_ms：${env?.latency_ms ?? '(响应里没有)'}　端到端耗时（含浏览器那一层）：${elapsed} ms`);
  say(`usage（服务端回的真实 token 计数）：${JSON.stringify(env?.usage ?? null)}`);
  say(`status=${result.status} reason=${result.reason ?? '(无)'} error=${JSON.stringify(result.error ?? null)}`);
  if (result.status === 'ok') {
    const f = result.feedback;
    const v = validateFeedback(f);
    say(`四个字段：verdict=${JSON.stringify(f.verdict)} error_type=${JSON.stringify(f.error_type)}`
      + ` rewrite=${JSON.stringify(f.rewrite)} note=${JSON.stringify(f.note)}`);
    say(`uncertain 标记：${result.uncertain === true ? 'true（拿不准，单独统计，不计入通过率）' : 'false'}`);
    say(`validateFeedback：${v.ok ? '通过' : `不通过 → ${v.errors.join('; ')}`}`);
    say(`是否与预期一致：${matchesExpectation(label, f) ? '一致' : '**不一致**（如实记录，不改成"应该的样子"）'}`);
    if (!v.ok) exitCode = 2;
  } else {
    say(`原句是否完整带回：${result.sentence === input.sentence ? '是（一字不差）' : `否 → ${JSON.stringify(result.sentence)}`}`);
    say(`诊断：${JSON.stringify(result.detail ?? null)}`);
    say('（这是一次**失败**观测：不算通过，如实计入报告）');
    exitCode = 2;
  }
  say('');
}

try {
  const up = await waitForListen();
  if (!up) {
    say(`服务没有起来（PORT=${PORT}）。子进程日志：\n${readLog() || '(空)'}`);
    process.exit(1);
  }
  say(`服务已监听：http://127.0.0.1:${PORT}（子进程 ${child.pid}）\n`);

  // 编号规则（Task 8 复审 Item 2 的"编号要诚实"）：**先算出这一轮到底会打几次上游**，
  // 再按同一个序列编号。`--envelope` 那次裸调用是**第 1 次**，四（三）条语料排在它后面。
  const total = CASES.length + (ENVELOPE ? 1 : 0);
  let no = 0;

  if (ENVELOPE) {
    no += 1;
    // 诊断用的一次**裸 HTTP**请求（真的要花一次钱），只为打印完整信封。
    // 默认**不需要**它：逐条的 `latency_ms`/`usage` 已由上面那层 fetch 反射给出。
    // ⚠️ 空句那种 400 换不来这份信封（服务端在打上游之前就返回了），所以这里必须是真句。
    say(`── 信封字段核对（第 ${no} 次调用，**真实计费一次**；只为看完整响应信封）──`);
    const t0 = Date.now();
    const nakedRes = await fetch(`http://127.0.0.1:${PORT}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sentence: 'This is my mug.', word: 'mug', scene: 'desk' }),
    });
    const nakedRaw = await nakedRes.text();
    const elapsed = Date.now() - t0;
    say(`HTTP ${nakedRes.status}（端到端 ${elapsed} ms）：${nakedRaw}`);
    observations.push({
      index: no, label: 'envelope-naked', http_status: nakedRes.status, envelope: nakedRaw, elapsed_ms: elapsed,
    });
    say('');
  }

  for (const c of CASES) {
    no += 1;
    const obs = await callCase(c.label, c.input);
    reportCase(obs, no, total);
    const { result, http, elapsed_ms: elapsed } = obs;
    observations.push({
      index: no,
      label: c.label,
      billable: true,
      http_status: http?.status ?? null,
      latency_ms: http?.body?.latency_ms ?? null,
      usage: http?.body?.usage ?? null,
      status: result?.status ?? null,
      reason: result?.reason ?? null,
      fields: result?.status === 'ok'
        ? {
          verdict: result.feedback.verdict,
          error_type: result.feedback.error_type,
          rewrite: result.feedback.rewrite,
          note: result.feedback.note,
        }
        : null,
      uncertain: result?.uncertain ?? null,
      elapsed_ms: elapsed,
    });
  }

  // 另外一条**零计费**的边界输入（空句）。两层各自都要证明：
  //   ① 客户端那一层：`submitSentence` 在**发请求之前**就返回（`http_status` 是 null = 一次网络
  //      请求都没有），这是"空句不花钱"的端侧证据；
  //   ② 服务端那一层：绕过客户端直接 POST 一个空句，服务端在**打上游之前**回 400
  //      （这是"别人写个脚本乱打也花不掉钱"的服务端证据）。
  say('── 零计费边界（空句）──');
  const blankT0 = Date.now();
  const blankObs = await callCase('blank-sentence', { sentence: '   ', word: 'mug', scene: 'kitchen' });
  say(`客户端这一层：HTTP ${String(blankObs.http?.status ?? null)}（null = 一次请求都没发出去）`
    + `，status=${blankObs.result?.status} reason=${blankObs.result?.reason}`
    + `，端到端 ${Date.now() - blankT0} ms`);
  const directRes = await fetch(`http://127.0.0.1:${PORT}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence: '   ', word: 'mug', scene: 'kitchen' }),
  });
  say(`服务端这一层（绕过客户端直接打）：HTTP ${directRes.status}：${await directRes.text()}`);
  observations.push({
    index: 'zero-billing',
    label: 'blank-sentence',
    billable: false,
    client_http_status: blankObs.http?.status ?? null,
    server_direct_http_status: directRes.status,
    status: blankObs.result?.status ?? null,
    reason: blankObs.result?.reason ?? null,
  });
  say('');

  // 服务端自己记的 usage / latency_ms 只在响应里；stderr 里是每条的原句采集行。
  const log = readLog();
  say('── 服务端 stderr（原句采集行：验证三的语料入口）──');
  say(log.trim() === '' ? '(无输出)' : log.trim());
  if (log.includes(process.env.DEEPSEEK_API_KEY) || log.includes('sk-')) {
    say('！！服务端日志里出现了疑似密钥的串——这是严重问题');
    exitCode = 3;
  }

  say('\n── 观测汇总（机器可读）──');
  say(JSON.stringify(observations, null, 2));

  // Item 3 的那一问由产出物自己回答：这一档到底出没出现过。
  // 只看**真的拿到了四个字段**的那些条目（`null` = 这一条落空了，`undefined` = 信封/边界那种
  // 本来就没有字段的记录——两者都不算"拿到判定"）。
  const judged = observations.filter((o) => o.fields !== null && o.fields !== undefined);
  const uncertains = judged.filter((o) => o.fields.verdict === 'uncertain');
  say('');
  say(`── 本轮 ${CASES.length} 次真实调用（另有 ${ENVELOPE ? 1 : 0} 次裸信封调用 + 1 次零计费空句）`
    + `：拿到判定的 ${judged.length} 次里 uncertain 出现 ${uncertains.length} 次`
    + `${uncertains.length === 0 ? '（这一档在本次观测里**不可达**，见报告）' : '（这一档**可达**，见报告）'} ──`);
} finally {
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(exitCode);

/** 与上面列出的预期逐条对照（**只用于打印"一致/不一致"**，不参与任何判定）。 */
function matchesExpectation(label, feedback) {
  if (!feedback || typeof feedback !== 'object') return false;
  if (label === 'clearly-correct') return feedback.verdict === 'correct' && feedback.error_type === 'none';
  if (label === 'wrong-word') return feedback.verdict === 'flawed' && feedback.error_type === 'word_choice';
  if (label === 'bad-collocation') return feedback.verdict === 'flawed' && feedback.error_type === 'collocation';
  // 这几条都是"冲 uncertain 去"的诊断用例：**如实打印模型到底给了什么**（下面 reportCase 会把
  // verdict/error_type 逐字打出来）。只有真的出现 `uncertain` 才算"一致"——逼不出来就明写"不一致"，
  // 那正是 Item 3 要的观测，不许把它美化成"符合预期"。
  if (['borderline-uncertain', 'garbage-bytes', 'another-script', 'fragmented'].includes(label)) {
    return feedback.verdict === 'uncertain';
  }
  return false;
}
