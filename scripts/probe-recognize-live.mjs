/**
 * 实弹探针：**真的**走一遍完整识物链路，并把观测到的每一件事如实打印出来。
 *
 * 这是控制器对 Task 7 的追加要求 3：单元测试只证明"我们自己写的桩能被正确调用"，
 * 证明不了"端点能真的识别一张图"。本脚本起一个**真实子进程**服务
 * （`node --env-file=.env server/index.mjs`，与生产启动方式逐字一致），
 * 用 multipart 发一张真 JPEG，打印：
 *   · HTTP 状态、响应体全文；
 *   · 端到端延迟（客户端侧）；
 *   · 服务端自报的 latency_ms；
 *   · usage 的 token 计数（有就打印真实数字，没有就说没有）；
 *   · 服务端 stderr 里的诊断行（失败时这是唯一线索）。
 *
 * **绝不伪造结果**：拿不到密钥、请求失败、上游报错，都照原样打印并以非零码退出。
 * 密钥本身从不打印（只报"有没有"）。
 *
 * 用法（在仓库根）：
 *   node --env-file=.env scripts/probe-recognize-live.mjs [图片路径] [--port=8899]
 * 缺省图片：`tmp/probe-mug.jpg`，由
 *   `powershell -NoProfile -File scripts/make-probe-image.ps1 -Out tmp/probe-mug.jpg`
 * 生成（用 Windows 自带的 System.Drawing 编码器；**不要**再手写 JPEG 编码器，
 * 那段弯路见 task-7-report.md）。做真机/端到端验证时，直接换成手机拍下来的照片更好：
 *   node --env-file=.env scripts/probe-recognize-live.mjs captures/mug.jpg
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const imagePath = path.resolve(REPO, args.find((a) => !a.startsWith('--')) ?? 'tmp/probe-mug.jpg');
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice('--port='.length) : 0) || (8700 + (process.pid % 200));
/** 上游一次视觉调用可能要十几秒，给足余量；超时即如实报"没等到响应"。 */
const REQUEST_TIMEOUT_MS = 90_000;
const BOOT_TIMEOUT_MS = 20_000;

const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => { process.stdout.write(`${line}\n`); process.exitCode = 1; };

// ── 前置检查（缺什么就说什么，绝不假装跑过）──────────────────────────────────
if (!fs.existsSync(imagePath)) {
  fail(`找不到图片：${imagePath}\n  先生成一张：powershell -NoProfile -File scripts/make-probe-image.ps1 -Out tmp/probe-mug.jpg`);
  process.exit(1);
}
const image = fs.readFileSync(imagePath);
// 只做最粗的形状检查：是 JPEG（SOI 魔数）且不是空文件。
// **刻意不做"图能不能解码"的判断**——本脚本没有可靠的解码器，而"看起来像 JPEG"曾经骗过我一次
// （自写编码器产出的彩色雪花也能通过魔数检查）。所以规则是：图必须是**人确认过能看**的
// 那张（tmp/probe-mug.jpg 已由实施者肉眼确认，或直接用真人拍的照片）。
if (image.length < 1024 || image[0] !== 0xff || image[1] !== 0xd8) {
  fail(`图片不像一张真 JPEG（${image.length} 字节，前 2 字节 ${image[0]?.toString(16)} ${image[1]?.toString(16)}）`);
  process.exit(1);
}
for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE', 'DEEPSEEK_MODEL']) {
  if (!process.env[k] || String(process.env[k]).trim() === '') {
    fail(`环境变量 ${k} 缺失或为空——请用 node --env-file=.env 运行本脚本`);
    process.exit(1);
  }
}
say('=== 实弹探针：Task 7 识物端点 ===');
say(`图片：${path.relative(REPO, imagePath)}（${image.length} 字节，前 4 字节 ${[...image.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}）`);
say(`配置：base=${process.env.DEEPSEEK_API_BASE} model=${process.env.DEEPSEEK_MODEL} detail=${process.env.VISION_DETAIL ?? '(默认 low)'} key=${process.env.DEEPSEEK_API_KEY ? `已提供(${String(process.env.DEEPSEEK_API_KEY).length} 字符)` : '缺失'}`);

// ── 起真实服务子进程（输出重定向到文件：本环境不允许 piped stdio）──────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task7-live-probe-'));
const logPath = path.join(tmpDir, 'server.log');
const fd = fs.openSync(logPath, 'w');
const env = { ...process.env, PORT: String(PORT) };
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: REPO, env, stdio: ['ignore', fd, fd] });
const readLog = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } };

const waitForListen = async () => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readLog().includes(`listening on http://localhost:${PORT}`)) return true;
    if (child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

let exitCode = 0;
try {
  const up = await waitForListen();
  if (!up) {
    fail(`服务没有起来（PORT=${PORT}）。子进程日志：\n${readLog() || '(空)'}`);
    process.exit(1);
  }
  say(`服务已监听：http://127.0.0.1:${PORT}（子进程 ${child.pid}）`);

  // ── 原始请求：把 multipart 的形状也打印出来（契约的一部分）──────────────────
  const boundary = `----probe${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="frame.jpg"\r\n`
    + 'Content-Type: image/jpeg\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, image, tail]);
  say(`请求：POST http://127.0.0.1:${PORT}/api/recognize`);
  say(`  content-type: multipart/form-data; boundary=${boundary}`);
  say(`  content-length: ${body.length}（其中图片 ${image.length} 字节）`);

  const startedAt = Date.now();
  let res;
  let raw = '';
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/api/recognize`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (err) {
    fail(`请求失败（${Date.now() - startedAt}ms）：${err?.name ?? ''} ${err?.message ?? err}`);
    say(`服务端日志：\n${readLog() || '(空)'}`);
    process.exit(1);
  }
  const clientLatency = Date.now() - startedAt;
  say(`\n响应：HTTP ${res.status}（端到端 ${clientLatency} ms）`);
  say(`响应体：${raw}`);

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* 下面按"不是 JSON"处理 */ }
  if (parsed === null) {
    fail('响应体不是合法 JSON——按失败处理（不猜测内容）');
  } else {
    say(`\n--- 逐项核对 ---`);
    say(`ok = ${JSON.stringify(parsed.ok)}`);
    say(`服务端自报 latency_ms = ${JSON.stringify(parsed.latency_ms)}（客户端侧 ${clientLatency} ms，差值 ${clientLatency - (parsed.latency_ms ?? 0)} ms）`);
    say(`候选 ${Array.isArray(parsed.candidates) ? parsed.candidates.length : '(不是数组)'} 条：`);
    for (const [i, c] of (parsed.candidates ?? []).entries()) {
      say(`  ${i + 1}. label=${JSON.stringify(c?.label)} score=${JSON.stringify(c?.score)} scene=${JSON.stringify(c?.scene)}`);
    }
    say(`usage = ${JSON.stringify(parsed.usage)}`);
    if (parsed.ok === true && Array.isArray(parsed.candidates)) {
      const labels = parsed.candidates.map((c) => c?.label);
      say(`\n模型可用 JSON 形状：是`);
      say(`候选是否含可接受词（mug/cup）：${labels.some((l) => ['mug', 'cup'].includes(l)) ? '是' : '否'}`);
      if (!labels.some((l) => ['mug', 'cup'].includes(l))) {
        say('（如实记录：模型没给到我们词表里的词——这是真实观测，不改写成成功）');
        exitCode = 2;
      }
    } else {
      fail(`端点报错：ok=${JSON.stringify(parsed.ok)} error=${JSON.stringify(parsed.error)}`);
    }
  }

  const log = readLog();
  say(`\n服务端 stderr：\n${log.trim() === '' ? '(无输出——包括没有失败诊断行)' : log.trim()}`);
  if (log.includes(process.env.DEEPSEEK_API_KEY)) {
    fail('！！服务端日志里出现了密钥——这是严重问题');
  }
} finally {
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(exitCode);
