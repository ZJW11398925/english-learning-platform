/**
 * 实弹探针：**真的**走一遍完整造句反馈链路，并把观测到的每一件事如实打印出来。
 *
 * 这是控制器对 Task 8 的追加要求 A3：单元测试只证明"我们自己写的桩能被正确调用"，
 * 证明不了"端点能把一句真话送给模型并拿回一份可用的判定"。本脚本起一个**真实子进程**服务
 * （`node --env-file=.env server/index.mjs`，与生产启动方式逐字一致），用真实凭据打
 * 少量几次调用（**每次都要花钱**，所以句子是写死的三条，不给它加参数乱跑）。
 *
 * 三条句子覆盖控制器点名的三种情形：
 *   1. clearly-correct —— 目标词用对了（预期 `correct` / `none`）；
 *   2. wrong-word      —— 该用 mug 却写了 cup（预期 `flawed` / `word_choice`）；
 *   3. bad-collocation —— 语法没大错但搭配不地道（预期 `flawed` / `collocation`）。
 * 预期只是**预期**：脚本照实打印模型真正回了什么，不符就说不符，绝不改成"应该的样子"。
 *
 * 走的是**客户端那一腿**（`submitSentence`）而不是裸 fetch：这样探针同时覆盖
 * "客户端 → 服务端 → 上游 → 客户端 → validateFeedback"整条链路，
 * 也就是 `tests/feedback-endpoint.test.mjs` 用桩覆盖的那条链路的真弹版本。
 *
 * 打印的字段：每条的 HTTP 状态、四个字段、`latency_ms`、`usage` token 计数、端到端耗时、
 * 校验器结论、以及服务端 stderr 里与反馈有关的那几行（失败时这是唯一线索）。
 * **绝不伪造结果**：拿不到密钥、请求失败、上游报错、字段不合契约，都照原样打印并标记出来。
 * 密钥本身从不打印（只报"有没有"）。
 *
 * 用法（在仓库根）：
 *   node --env-file=.env scripts/probe-feedback-live.mjs [--port=8899]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { submitSentence } from '../web/units/compose.mjs';
import { validateFeedback } from '../web/units/feedback.mjs';
import { FEEDBACK_REQUEST_TIMEOUT_MS } from '../web/units/compose.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice('--port='.length) : 0) || (8900 + (process.pid % 90));
const BOOT_TIMEOUT_MS = 20_000;

const say = (line) => process.stdout.write(`${line}\n`);

/** 三条写死的探针句子（见文件头：不给参数，免得"随手多跑几次"把额度花光）。 */
const CASES = [
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
];

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
say(`客户端这一腿的上限：${FEEDBACK_REQUEST_TIMEOUT_MS}ms；计划调用 ${CASES.length} 次（每次计费）`);

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

try {
  const up = await waitForListen();
  if (!up) {
    say(`服务没有起来（PORT=${PORT}）。子进程日志：\n${readLog() || '(空)'}`);
    process.exit(1);
  }
  say(`服务已监听：http://127.0.0.1:${PORT}（子进程 ${child.pid}）\n`);

  for (const [i, c] of CASES.entries()) {
    say(`───── [${i + 1}/${CASES.length}] ${c.label} ─────`);
    say(`输入：sentence=${JSON.stringify(c.input.sentence)} word=${c.input.word} scene=${c.input.scene}`);
    say(`预期（设计文档 §4.2 的契约下的**期望**，不是保证）：${c.expectation}`);

    const t0 = Date.now();
    let result;
    let threw = null;
    try {
      // 走真链路：客户端单元 → 真服务端子进程 → 真上游。
      result = await submitSentence(c.input, {
        fetchImpl: (p, init) => fetch(`http://127.0.0.1:${PORT}${p}`, init),
      });
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - t0;

    if (threw !== null) {
      // `submitSentence` 的契约是"不抛错"，抛了就说明有编程错误——照实报，不掩盖。
      say(`！！客户端抛出了异常（这违反 submitSentence 的契约）：${threw?.stack ?? threw}`);
      observations.push({ label: c.label, threw: String(threw?.message ?? threw) });
      exitCode = 2;
      continue;
    }

    say(`端到端耗时：${elapsed} ms`);
    say(`status=${result.status} reason=${result.reason ?? '(无)'} error=${JSON.stringify(result.error ?? null)}`);
    if (result.status === 'ok') {
      const f = result.feedback;
      const v = validateFeedback(f);
      say(`四个字段：verdict=${JSON.stringify(f.verdict)} error_type=${JSON.stringify(f.error_type)}`
        + ` rewrite=${JSON.stringify(f.rewrite)} note=${JSON.stringify(f.note)}`);
      say(`uncertain 标记：${result.uncertain === true ? 'true（拿不准，单独统计，不计入通过率）' : 'false'}`);
      say(`validateFeedback：${v.ok ? '通过' : `不通过 → ${v.errors.join('; ')}`}`);
      say(`是否与预期一致：${matchesExpectation(c.label, f) ? '一致' : '**不一致**（如实记录，不改成"应该的样子"）'}`);
    } else {
      say(`原句是否完整带回：${result.sentence === c.input.sentence ? '是（一字不差）' : `否 → ${JSON.stringify(result.sentence)}`}`);
      say(`诊断：${JSON.stringify(result.detail ?? null)}`);
      say('（这是一次**失败**观测：不算通过，如实计入报告）');
      exitCode = 2;
    }
    observations.push({
      label: c.label,
      status: result.status,
      reason: result.reason ?? null,
      fields: result.status === 'ok'
        ? {
          verdict: result.feedback.verdict,
          error_type: result.feedback.error_type,
          rewrite: result.feedback.rewrite,
          note: result.feedback.note,
        }
        : null,
      uncertain: result.uncertain ?? null,
      elapsed_ms: elapsed,
    });
    say('');
  }

  // ── 第 4 次调用：诊断用的一次**裸 HTTP**请求（真的要花一次钱）─────────────────
  // 为什么还要多发一次：上面三条走的是 `submitSentence`，它只把四个字段交回来，而
  // `latency_ms` 与 `usage`（真实 token 计数）在**响应信封**里——不把整份响应打出来，
  // "服务端到底回没回真实 token 数"就只能靠猜，而本项目的纪律是成本核算只认真实计数
  // （shared-context「仍然未知」一节）。这一次用一个**必然会被判 correct 的最短句**：
  // 最省 token，且它的四个字段上面已经见过，多这一次只为看信封。
  // ⚠️ 空句那种 400 换不来这份信封（服务端在打上游之前就返回了），所以这里必须是真句。
  say('── 信封字段核对（第 4 次调用，**真实计费一次**；只为看 latency_ms / usage 的真实形状）──');
  const nakedRes = await fetch(`http://127.0.0.1:${PORT}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence: 'This is my mug.', word: 'mug', scene: 'desk' }),
  });
  const nakedRaw = await nakedRes.text();
  say(`HTTP ${nakedRes.status}：${nakedRaw}`);
  say('');

  // 另外一条**零计费**的边界输入（空句）：证明服务端在打上游之前就把空句拦下了。
  say('── 零计费边界（空句；服务端在打上游之前就返回）──');
  const blankRes = await fetch(`http://127.0.0.1:${PORT}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence: '   ', word: 'mug', scene: 'kitchen' }),
  });
  say(`HTTP ${blankRes.status}：${await blankRes.text()}`);
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
} finally {
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(exitCode);

/** 与文件头那三条预期逐条对照（**只用于打印"一致/不一致"**，不参与任何判定）。 */
function matchesExpectation(label, feedback) {
  if (!feedback || typeof feedback !== 'object') return false;
  if (label === 'clearly-correct') return feedback.verdict === 'correct' && feedback.error_type === 'none';
  if (label === 'wrong-word') return feedback.verdict === 'flawed' && feedback.error_type === 'word_choice';
  if (label === 'bad-collocation') return feedback.verdict === 'flawed' && feedback.error_type === 'collocation';
  return false;
}
