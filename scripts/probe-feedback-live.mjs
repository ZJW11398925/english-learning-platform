/**
 * 实弹探针（直连版）：**真的**走一遍完整造句反馈链路，并把观测到的每一件事如实打印出来。
 *
 * 这是控制器对 Task 8 的追加要求 A3 的直连继承者（server 代理已随 Task 12C 退役，转向
 * DEC-…23/26）：单元测试只证明"我们自己写的桩能被正确调用"，证明不了"一句真话能送给
 * 真模型并拿回一份可用的判定"。本脚本在 Node 里驱动**同一份客户端实现**
 * （`web/units/compose.mjs` 的 `submitSentence`，浏览器直连 `api.deepseek.com`），
 * 用访问者自带的 Key 打少量几次调用（**每次都要花钱**，所以句子是写死的，不给它加参数乱跑）。
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
 * 走的是**整条直连链路**（`submitSentence` → 真 HTTPS → 上游 → 客户端校验器）而不是裸 fetch。
 * 打印的字段：HTTP 状态、**信封里的 usage token 计数**（由包在 `fetchImpl` 外面那层用
 * `res.clone()` 从响应信封里读出来——报告要引用的证据必须由产出物自己给出）、端到端耗时、
 * 四个字段、校验器结论。旧版的"服务端自报 latency_ms / 服务端 stderr"随代理退役一起消失。
 *
 * **绝不伪造结果**：拿不到密钥、请求失败、上游报错、字段不合契约，都照原样打印并标记出来。
 * 密钥本身从不打印（只报"有没有"）。
 *
 * 用法（在仓库根）：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/probe-feedback-live.mjs                # 4 次计费调用
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/probe-feedback-live.mjs --degenerate   # 3 次计费调用（退化输入）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { submitSentence, FEEDBACK_REQUEST_TIMEOUT_MS } from '../web/units/compose.mjs';
import { validateFeedback } from '../web/units/feedback.mjs';
import { DEEPSEEK_MODEL } from '../web/units/deepseek.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEGENERATE = process.argv.slice(2).includes('--degenerate');

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
const KEY = process.env.DEEPSEEK_API_KEY;
if (typeof KEY !== 'string' || KEY.trim() === '') {
  say('环境变量 DEEPSEEK_API_KEY 缺失或为空——直连世界里 Key 由调用方自带：\n'
    + '  DEEPSEEK_API_KEY=sk-xxx node scripts/probe-feedback-live.mjs');
  process.exitCode = 1;
  process.exit(1);
}

say('=== 实弹探针（直连版）：造句反馈链路 → api.deepseek.com ===');
say(`配置：直连 https://api.deepseek.com model=${DEEPSEEK_MODEL} key=已提供(${KEY.length} 字符)`);
say(`客户端这一腿的上限：${FEEDBACK_REQUEST_TIMEOUT_MS}ms`);
say(`模式：${DEGENERATE ? '--degenerate（退化输入，冲 uncertain）' : '默认（正常语料）'}`
  + `；这一轮**计费调用 ${CASES.length} 次**，另加 1 次零计费空句边界\n`);

/** 观测记录：原样留下来给报告用（每条一行 JSON，必要时可粘进报告）。 */
const observations = [];
let exitCode = 0;

/**
 * 一次调用：走 `submitSentence`（与线上同一份实现），信封里的 usage 由外层 `res.clone()`
 * 读出来——不靠"另外再发一次裸调用"（那会白花一份钱，还让调用次数与报告对不上）。
 */
async function callCase(label, input) {
  const t0 = Date.now();
  let http = null;
  const fetchImpl = async (url, init) => {
    const res = await fetch(url, init);
    let body = null;
    try { body = await res.clone().json(); } catch { body = null; }
    http = { status: res.status, body };
    return res;
  };
  let result = null;
  let threw = null;
  try {
    result = await submitSentence(input, { apiKey: KEY, fetchImpl });
  } catch (err) {
    threw = err;
  }
  return { label, input, result, threw, http, elapsed_ms: Date.now() - t0 };
}

/** 把一次观测按人读的顺序打出来（HTTP 状态 → 判定 → 字段 → 校验器 → 与预期对照）。 */
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
  say(`usage（信封里的真实 token 计数）：${JSON.stringify(env?.usage ?? null)}　端到端耗时：${elapsed} ms`);
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

for (const [i, c] of CASES.entries()) {
  const obs = await callCase(c.label, c.input);
  reportCase(obs, i + 1, CASES.length);
  const { result, http, elapsed_ms: elapsed } = obs;
  observations.push({
    index: i + 1,
    label: c.label,
    billable: true,
    http_status: http?.status ?? null,
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

// 一条**零计费**的边界输入（空句）：`submitSentence` 在**发请求之前**就返回——
// `http` 保持 null（一次网络请求都没有），这是"空句不花钱"的端侧直连证据。
say('── 零计费边界（空句）──');
const blankT0 = Date.now();
const blankObs = await callCase('blank-sentence', { sentence: '   ', word: 'mug', scene: 'kitchen' });
say(`客户端这一层：HTTP ${String(blankObs.http?.status ?? null)}（null = 一次请求都没发出去）`
  + `，status=${blankObs.result?.status} reason=${blankObs.result?.reason}`
  + `，端到端 ${Date.now() - blankT0} ms\n`);
observations.push({
  index: 'zero-billing',
  label: 'blank-sentence',
  billable: false,
  client_http_status: blankObs.http?.status ?? null,
  status: blankObs.result?.status ?? null,
  reason: blankObs.result?.reason ?? null,
});

say('── 观测汇总（机器可读）──');
say(JSON.stringify(observations, null, 2));

// Item 3 的那一问由产出物自己回答：这一档到底出没出现过。
// 只看**真的拿到了四个字段**的那些条目（`null` = 这一条落空了，`undefined` = 边界那种
// 本来就没有字段的记录——两者都不算"拿到判定"）。
const judged = observations.filter((o) => o.fields !== null && o.fields !== undefined);
const uncertains = judged.filter((o) => o.fields.verdict === 'uncertain');
say('');
say(`── 本轮 ${CASES.length} 次真实调用（另有 1 次零计费空句）：拿到判定的 ${judged.length} 次里`
  + ` uncertain 出现 ${uncertains.length} 次`
  + `${uncertains.length === 0 ? '（这一档在本次观测里**不可达**，见报告）' : '（这一档**可达**，见报告）'} ──`);
process.exit(exitCode);

/** 与上面列出的预期逐条对照（**只用于打印"一致/不一致"**，不参与任何判定）。 */
function matchesExpectation(label, feedback) {
  if (!feedback || typeof feedback !== 'object') return false;
  if (label === 'clearly-correct') return feedback.verdict === 'correct' && feedback.error_type === 'none';
  if (label === 'wrong-word') return feedback.verdict === 'flawed' && feedback.error_type === 'word_choice';
  if (label === 'bad-collocation') return feedback.verdict === 'flawed' && feedback.error_type === 'collocation';
  // 这几条都是"冲 uncertain 去"的诊断用例：**如实打印模型到底给了什么**（上面 reportCase 会把
  // verdict/error_type 逐字打出来）。只有真的出现 `uncertain` 才算"一致"——逼不出来就明写"不一致"，
  // 那正是 Item 3 要的观测，不许把它美化成"符合预期"。
  if (['borderline-uncertain', 'garbage-bytes', 'another-script', 'fragmented'].includes(label)) {
    return feedback.verdict === 'uncertain';
  }
  return false;
}
