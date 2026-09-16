/**
 * 实弹探针（直连版）：**真的**走一遍完整识物链路，并把观测到的每一件事如实打印出来。
 *
 * Task 12C 起本项目没有服务端（server 代理已退役，转向 DEC-…23/26），识物这条腿是
 * **浏览器直连** `api.deepseek.com`——本探针在 Node 里驱动**同一份客户端实现**
 * （`web/units/recognize.mjs` 的 `recognize()`），打真模型：
 *   · 候选（label / score / scene，客户端校验与截断后的原样）；
 *   · `latencyMs`（**客户端实测**：从发出请求到解出可用候选——与线上口径同尺，
 *     这正是 `RECOGNIZE_REQUEST_TIMEOUT_MS` 弱网标定要采的数）；
 *   · 校验失败 / 超时 / 401 / 429 的原样报错。
 *
 * **绝不伪造结果**：拿不到密钥、请求失败、上游报错，都照原样打印并以非零码退出。
 * 密钥本身从不打印（只报"有没有"）。**每次运行花一次真实调用（真金白银）**——
 * 它是证据工具，不是测试（设计文档 §5.2：真实模型调用不写自动测）。
 *
 * 用法（在仓库根）：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/probe-recognize-live.mjs [图片路径] [--timeout=12000]
 * 缺省图片：`tmp/probe-mug.jpg`，由
 *   `powershell -NoProfile -File scripts/make-probe-image.ps1 -Out tmp/probe-mug.jpg`
 * 生成（用 Windows 自带的 System.Drawing 编码器；**不要**再手写 JPEG 编码器，
 * 那段弯路见 task-7-report.md）。做真机/端到端验证时，直接换成手机拍下来的照片更好：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/probe-recognize-live.mjs captures/mug.jpg
 *
 * （旧版会起 server 子进程打本机代理并观测"服务端自报 latency_ms"；那层随
 * Task 12C 的 server 退役一并消失，本文件是它的直连继承者。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recognize, RECOGNIZE_REQUEST_TIMEOUT_MS } from '../web/units/recognize.mjs';
import { DEEPSEEK_MODEL } from '../web/units/deepseek.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const imagePath = path.resolve(REPO, args.find((a) => !a.startsWith('--')) ?? 'tmp/probe-mug.jpg');
const timeoutArg = args.find((a) => a.startsWith('--timeout='));
const TIMEOUT_MS = Number(timeoutArg ? timeoutArg.slice('--timeout='.length) : 0) || RECOGNIZE_REQUEST_TIMEOUT_MS;

const say = (line) => process.stdout.write(`${line}\n`);

// ── 前置检查（缺什么就说什么，绝不假装跑过）──────────────────────────────────
if (!fs.existsSync(imagePath)) {
  say(`找不到图片：${imagePath}\n  先生成一张：powershell -NoProfile -File scripts/make-probe-image.ps1 -Out tmp/probe-mug.jpg`);
  process.exitCode = 1;
  process.exit(1);
}
const image = fs.readFileSync(imagePath);
// 只做最粗的形状检查：是 JPEG（SOI 魔数）且不是空文件。
// **刻意不做"图能不能解码"的判断**——本脚本没有可靠的解码器，而"看起来像 JPEG"曾经骗过我一次
// （自写编码器产出的彩色雪花也能通过魔数检查）。所以规则是：图必须是**人确认过能看**的
// 那张（tmp/probe-mug.jpg 已由实施者肉眼确认，或直接用真人拍的照片）。
if (image.length < 1024 || image[0] !== 0xff || image[1] !== 0xd8) {
  say(`图片不像一张真 JPEG（${image.length} 字节，前 2 字节 ${image[0]?.toString(16)} ${image[1]?.toString(16)}）`);
  process.exitCode = 1;
  process.exit(1);
}
const KEY = process.env.DEEPSEEK_API_KEY;
if (typeof KEY !== 'string' || KEY.trim() === '') {
  say('环境变量 DEEPSEEK_API_KEY 缺失或为空——直连世界里 Key 由调用方自带：\n'
    + '  DEEPSEEK_API_KEY=sk-xxx node scripts/probe-recognize-live.mjs [图片路径]');
  process.exitCode = 1;
  process.exit(1);
}

say('=== 实弹探针（直连版）：识物链路 → api.deepseek.com ===');
say(`图片：${path.relative(REPO, imagePath)}（${image.length} 字节，前 4 字节 ${[...image.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}）`);
say(`配置：直连 https://api.deepseek.com model=${DEEPSEEK_MODEL} detail=low key=已提供(${KEY.length} 字符)`);
say(`客户端这一腿的上限：${TIMEOUT_MS}ms`);

// 图片字节 → Blob（recognize() 吃的就是 camera/相册产出的那一口）。
const blob = new Blob([image], { type: 'image/jpeg' });

let result;
try {
  result = await recognize(blob, {
    apiKey: KEY,
    fetchImpl: fetch,
    timeoutMs: TIMEOUT_MS,
    nowImpl: () => performance.now(),
  });
} catch (err) {
  say('\n识物失败（原样转述，不猜测）：');
  say(`  code = ${String(err?.code ?? '(无 code)')}`);
  say(`  message = ${String(err?.message ?? err)}`);
  process.exitCode = 1;
  process.exit(1);
}

const { candidates, latencyMs } = result;
say('\n--- 逐项核对（客户端校验与截断后的原样）---');
say(`latencyMs = ${JSON.stringify(latencyMs)}（客户端实测：发出请求 → 解出可用候选；缺值=时钟没给出有限数，绝不补 0）`);
say(`候选 ${candidates.length} 条：`);
for (const [i, c] of candidates.entries()) {
  say(`  ${i + 1}. label=${JSON.stringify(c.label)} score=${JSON.stringify(c.score)} scene=${JSON.stringify(c.scene)}`);
}
if (candidates.length === 0) {
  say('\n如实记录：模型没有给出任何候选（no_candidates）——这是真实观测，不改写成成功');
  process.exitCode = 2;
} else {
  const labels = candidates.map((c) => c.label);
  say(`\n候选是否含可接受词（mug/cup）：${labels.some((l) => ['mug', 'cup'].includes(l)) ? '是' : '否'}`);
  if (!labels.some((l) => ['mug', 'cup'].includes(l))) {
    say('（如实记录：模型没给到我们词表里的词——这是真实观测，不改写成成功）');
    process.exitCode = 2;
  }
}
