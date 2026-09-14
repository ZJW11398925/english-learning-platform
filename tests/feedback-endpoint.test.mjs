// tests/feedback-endpoint.test.mjs
//
// `/api/feedback` 与 `/api/recognize` 是**同一条代理契约**下的两个端点：密钥只在服务端、
// 上游响应先过形状校验、任何畸形输入只坏这一个请求。本文件把这条契约在造句端点上重钉一遍。
//
// 上游用**本地桩服务**替掉（设计文档 §5.2："真实模型调用不写自动测"指的是不拿真模型当
// 测试依赖，而不是不测路由）。真实调用由 `scripts/probe-feedback-live.mjs` 负责，结果记在
// task-8-report.md 的实弹探针一节。
//
// 这里最要紧的一条是**信封与语义的分工**：
//   · 服务端管**信封**——上游 HTTP 状态、`choices[0].message.content` 在不在、它是不是 JSON、
//     解出来是不是对象。任一项不成立就是 `502 upstream_invalid`，绝不让垃圾长得像成功；
//   · 四个字段的**语义**由客户端的 `validateFeedback`（Task 4）判，这里**不重复判**
//     （两处各判一套，迟早各自漂移）。所以"verdict 取值越界"的响应在端点这一层是 200，
//     到客户端才变成 pending——下面有用例把这条分工钉住。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApp } from '../server/index.mjs';
import { feedbackUpstream, FEEDBACK_PROMPT, UPSTREAM_TIMEOUT_MS } from '../server/feedback-upstream.mjs';
import { submitSentence, FEEDBACK_FAIL_REASONS, FEEDBACK_REQUEST_TIMEOUT_MS } from '../web/units/compose.mjs';
import { validateFeedback } from '../web/units/feedback.mjs';
import { settlesWithin } from './helpers/watchdog.mjs';

const ENV = {
  DEEPSEEK_API_KEY: 'sk-fake-server-side-key-0123456789',
  DEEPSEEK_API_BASE: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-flash',
  VISION_DETAIL: 'low',
};

/** 一份合法的模型反馈（模型会把四个字段放在 content 的 JSON 字符串里）。 */
const GOOD = { verdict: 'flawed', error_type: 'word_choice', rewrite: 'I use a mug.', note: '词选得更准' };

/** 上游桩：收下每次请求，按当前 `reply` 回。 */
function upstreamStub() {
  const seen = [];
  let reply = { status: 200, body: { choices: [{ message: { content: JSON.stringify(GOOD) } }] } };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const { status, raw, body } = reply;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw !== undefined ? raw : JSON.stringify(body));
    });
  });
  return {
    server,
    seen,
    setReply(r) { reply = r; },
    /** 上游回一份 content=JSON.stringify(obj) 的成功响应。 */
    replyContent(obj, extra = {}) {
      reply = { status: 200, body: { choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 301 }, ...extra } };
    },
  };
}

let upstream;
let app;
let origin;
const logs = [];

before(async () => {
  upstream = upstreamStub();
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.server.address().port}`;

  app = createApp({
    env: { ...ENV, DEEPSEEK_API_BASE: upstreamBase },
    fetchImpl: fetch,
    // 本文件里的服务端**不**直接把日志写进 stderr（那会把测试输出弄脏）——收集起来供断言。
    logImpl: (line) => logs.push(line),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  upstream.server.closeAllConnections();
  await new Promise((resolve) => upstream.server.close(resolve));
});

/** 客户端那一侧的真实请求形状：`submitSentence()` 打的就是这个（JSON body）。 */
const postFeedback = (payload, url = `${origin}/api/feedback`) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const SAID = { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' };

// ─────────────────────────────────────────── 正常路径 ───────────────────────────────────────────

test('正常路径：200 + ok:true + 四个字段原样 + latency_ms + usage', async () => {
  upstream.replyContent(GOOD, { usage: { prompt_tokens: 301, completion_tokens: 44, total_tokens: 345 } });
  const res = await postFeedback(SAID);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(
    { verdict: body.verdict, error_type: body.error_type, rewrite: body.rewrite, note: body.note },
    GOOD,
    '四个字段原样透传（服务端不当"规整器"，也不猜字段）',
  );
  assert.equal(Number.isInteger(body.latency_ms), true, 'latency_ms 是整数毫秒');
  assert.deepEqual(body.usage, { prompt_tokens: 301, completion_tokens: 44, total_tokens: 345 });
});

test('请求体就是已核实的模型契约：模型 flash / system+user / JSON 模式 / Bearer 密钥', async () => {
  upstream.replyContent(GOOD);
  const before = upstream.seen.length;
  await postFeedback(SAID);
  assert.equal(upstream.seen.length, before + 1, '一次造句 = 一次上游调用');
  const sent = JSON.parse(upstream.seen.at(-1).body);
  assert.equal(upstream.seen.at(-1).url, '/chat/completions');
  assert.equal(sent.model, 'deepseek-flash');
  assert.deepEqual(sent.response_format, { type: 'json_object' }, 'JSON 模式兜底"必须是 JSON"');
  assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user']);
  const userText = JSON.stringify(sent.messages[1].content);
  for (const s of [SAID.sentence, SAID.word, SAID.scene]) assert.ok(userText.includes(s));
  assert.equal(upstream.seen.at(-1).headers.authorization, `Bearer ${ENV.DEEPSEEK_API_KEY}`, '密钥由服务端注入上游');
});

test('服务端日志留下原句（验证三的语料采集），但绝不打印密钥', async () => {
  upstream.replyContent(GOOD);
  logs.length = 0;
  await postFeedback({ sentence: 'I put the mug on the desk.', word: 'mug', scene: 'desk' });
  const joined = logs.join('\n');
  assert.match(joined, /I put the mug on the desk\./, '原句要进服务端日志（供验证三收集语料）');
  assert.match(joined, /mug/);
  assert.ok(!joined.includes(ENV.DEEPSEEK_API_KEY), '日志里绝不出现密钥');
  assert.ok(!joined.includes('sk-'), '日志里不出现任何 sk- 开头的串');
});

test('uncertain 响应照样 200 透传（服务端不替模型改判，也不把它当失败）', async () => {
  upstream.replyContent({ verdict: 'uncertain', error_type: 'none', rewrite: null, note: '这句我拿不准' });
  const res = await postFeedback({ sentence: 'The colourless green ideas sleep.', word: 'mug', scene: 'desk' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.verdict, 'uncertain');
  assert.equal(body.rewrite, null, '原样透传：契约允许 uncertain + rewrite:null（不许在服务端"补齐"）');
});

test('密钥绝不出现在给客户端的响应里（成功与失败两条路）', async () => {
  upstream.replyContent(GOOD);
  const okText = await (await postFeedback(SAID)).text();
  assert.ok(!okText.includes(ENV.DEEPSEEK_API_KEY));
  assert.ok(!okText.includes('sk-'));

  upstream.setReply({ status: 500, raw: `{"error":"bad key ${ENV.DEEPSEEK_API_KEY}"}` });
  const failText = await (await postFeedback(SAID)).text();
  assert.ok(!failText.includes(ENV.DEEPSEEK_API_KEY), '失败响应里同样不许回显密钥');
  assert.ok(!failText.includes('bad key'), '上游原文不进响应（只进服务端日志）');
});

// ───────────────────────── 信封校验：垃圾绝不长得像成功 ─────────────────────────

test('上游 500 → 502 upstream_failed，ok:false（不是一份"没判出问题"的 200）', async () => {
  upstream.setReply({ status: 500, raw: '{"error":"boom"}' });
  const res = await postFeedback(SAID);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'upstream_failed');
  assert.equal('verdict' in body, false, '失败响应里不许带一个 verdict 字段（免得被当成一次判定）');
});

test('上游 200 但响应体不是 JSON → 502 upstream_invalid', async () => {
  upstream.setReply({ status: 200, raw: '<html>not json</html>' });
  const res = await postFeedback(SAID);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_invalid');
});

test('上游 200 但 content 不是 JSON（模型吐了一段散文）→ 502 upstream_invalid', async () => {
  upstream.replyContent('当然！这句话很好。');
  const res = await postFeedback(SAID);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_invalid');
});

test('上游 200 但缺 choices / content → 502 upstream_invalid', async () => {
  for (const body of [{ choices: [] }, { choices: [{ message: {} }] }, {}]) {
    upstream.setReply({ status: 200, body });
    const res = await postFeedback(SAID);
    assert.equal(res.status, 502, `${JSON.stringify(body)} 应判上游无效`);
    assert.equal((await res.json()).error, 'upstream_invalid');
  }
});

test('信封与语义的分工：四个字段的取值越界由客户端判 —— 端点这一层是 200，客户端落 pending', async () => {
  // 服务端管"能不能解析出对象"，语义归 Task 4 的校验器。这条分工写在这里，免得将来有人
  // 在服务端又写一套字段校验（两处各判一套，迟早漂移）。
  upstream.replyContent({ verdict: 'great', error_type: 'none', rewrite: null, note: 'x' });
  const res = await postFeedback(SAID);
  assert.equal(res.status, 200, '服务端不判语义');
  const proxyResult = await res.json();
  assert.equal(proxyResult.ok, true);

  // 客户端拿到这份响应 → pending（校验器说了算），诊断里点名出错的字段
  const clientResult = await submitSentence(SAID, {
    fetchImpl: async () => ({ ok: true, json: async () => proxyResult }),
  });
  assert.equal(clientResult.status, 'pending');
  assert.equal(clientResult.reason, FEEDBACK_FAIL_REASONS.RESPONSE_INVALID);
  assert.match(clientResult.error, /verdict/);
  assert.equal(clientResult.sentence, SAID.sentence);
});

// ─────────────────────────────── 畸形输入：只坏这一个请求 ───────────────────────────────

test('空句子/缺句子的请求 → 400 bad_request，且**不打上游**（省一次调用）', async () => {
  for (const body of [{}, { sentence: '' }, { sentence: '   ' }, { sentence: 42 }, { word: 'mug', scene: 'kitchen' }]) {
    const before = upstream.seen.length;
    const res = await postFeedback(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应回 400`);
    const out = await res.json();
    assert.equal(out.error, 'bad_request');
    assert.match(String(out.detail), /sentence/, '要说清缺的是什么（不然看起来像"模型判不出来"）');
    assert.equal(upstream.seen.length, before, '空句不该发生任何上游调用——每一次调用都要花钱');
  }
});

test('完全不是 JSON 的 body → 400，进程继续服务', async () => {
  const res = await fetch(`${origin}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all {{{',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
  assert.equal((await fetch(`${origin}/nope.js`)).status, 404, '进程必须仍然活着');
});

test('缺 word/scene 的请求 → 400（提示词需要它们，不能靠模型猜）', async () => {
  for (const body of [{ sentence: 'I use a cup.' }, { sentence: 'I use a cup.', word: 'mug' }, { sentence: 'I use a cup.', scene: 'kitchen' }]) {
    const before = upstream.seen.length;
    const res = await postFeedback(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应回 400`);
    assert.equal(upstream.seen.length, before);
  }
});

test('超大 body → 400，且进程继续服务', async () => {
  const res = await fetch(`${origin}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence: 'x'.repeat(2 * 1024 * 1024), word: 'mug', scene: 'kitchen' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
  assert.equal((await fetch(`${origin}/api/has-no-such-file`)).status, 404);
});

test('服务端缺模型配置 → 500 config_missing，且诊断说清缺了什么（不是一句"URL 解析失败"）', async () => {
  // 没有 `.env` 的进程（误启动、测试夹具）里，缺配置若被放任走到上游模块，会变成
  // "Failed to parse URL from undefined/chat/completions"——那句话看起来像上游故障，
  // 真凶却是这份进程没加载配置。这条把诊断钉在"缺哪个变量"上。
  const naked = createApp({ env: {}, fetchImpl: async () => { throw new Error('不该走到这里'); }, logImpl: () => {} });
  await new Promise((resolve) => naked.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${naked.address().port}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SAID),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'config_missing');
    assert.match(String(body.detail), /DEEPSEEK_API_KEY/, '要说清缺的是哪个变量');
    assert.ok(!String(body.detail).includes('Failed to parse URL'), '不该把配置问题报成一句 URL 解析失败');
  } finally {
    naked.closeAllConnections();
    await new Promise((resolve) => naked.close(resolve));
  }
});

// ───────────────────── 上游半开：服务端先超时、先把它自己的失败形状写回来 ─────────────────────

test('上游半开（收下请求却不回话）→ 在上限内回 502 upstream_failed，不挂住客户端', async () => {
  const stalled = createServer((req) => { req.resume(); /* 有意不回 */ });
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const slowApp = createApp({
    env: { ...ENV, DEEPSEEK_API_BASE: `http://127.0.0.1:${stalled.address().port}` },
    fetchImpl: fetch,
    upstreamTimeoutMs: 60, // 测试专用注入：不真等生产上限
    logImpl: () => {},
  });
  await new Promise((resolve) => slowApp.listen(0, '127.0.0.1', resolve));
  try {
    const t0 = Date.now();
    const res = await settlesWithin(
      postFeedback(SAID, `http://127.0.0.1:${slowApp.address().port}/api/feedback`),
      5000, '服务端造句请求',
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'upstream_failed');
    assert.ok(elapsed < 3000, `必须在上限（注入 60ms）附近收口，实测 ${elapsed}ms——挂住就等于用户界面卡死`);
  } finally {
    slowApp.closeAllConnections();
    await new Promise((resolve) => slowApp.close(resolve));
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
  }
});

test('上游先回响应头、再半截 body 卡住 → 502 upstream_failed（停顿不是"契约非法"）', async () => {
  const stalling = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":[{"message":{"content":"{\\"verdict');
      // 有意不 res.end()：body 停在这里
    });
  });
  await new Promise((resolve) => stalling.listen(0, '127.0.0.1', resolve));
  const slowApp = createApp({
    env: { ...ENV, DEEPSEEK_API_BASE: `http://127.0.0.1:${stalling.address().port}` },
    fetchImpl: fetch,
    upstreamTimeoutMs: 60,
    logImpl: () => {},
  });
  await new Promise((resolve) => slowApp.listen(0, '127.0.0.1', resolve));
  try {
    const res = await settlesWithin(
      postFeedback(SAID, `http://127.0.0.1:${slowApp.address().port}/api/feedback`),
      5000, '服务端造句请求（上游 body 停滞）',
    );
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'upstream_failed', '停顿按"上游失败（超时）"报，不是 upstream_invalid');
  } finally {
    slowApp.closeAllConnections();
    await new Promise((resolve) => slowApp.close(resolve));
    stalling.closeAllConnections();
    await new Promise((resolve) => stalling.close(resolve));
  }
});

// ───────────────────── 客户端 → 真服务端 → 桩上游：整条链路一起走一遍 ─────────────────────

test('端到端（真客户端 + 真路由 + 桩上游）：submitSentence 拿回 ok 与校验过的反馈', async () => {
  upstream.replyContent(GOOD);
  const r = await submitSentence(SAID, {
    fetchImpl: (path, init) => fetch(`${origin}${path}`, init),
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.feedback.verdict, 'flawed');
  assert.equal(r.feedback.rewrite, 'I use a mug.');
  assert.equal(r.uncertain, false);
  assert.equal(validateFeedback(r.feedback).ok, true);
  assert.equal(r.sentence, SAID.sentence);
});

test('端到端：上游失败时 learner 的句子仍然完整回来（A2/A4 的整链路证据）', async () => {
  upstream.setReply({ status: 500, raw: '{"error":"boom"}' });
  const said = 'I put the mug on the desk.';
  const r = await submitSentence({ ...SAID, sentence: said }, {
    fetchImpl: (path, init) => fetch(`${origin}${path}`, init),
  });
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, FEEDBACK_FAIL_REASONS.HTTP_ERROR);
  assert.equal(r.sentence, said, '失败路径上原句一字不差地带回来（补交全靠它）');
  assert.deepEqual({ word: r.word, scene: r.scene }, { word: 'mug', scene: 'kitchen' });
});

// ───────────────────────────── 服务端 / 客户端两条腿的常量 ─────────────────────────────

test('上游那一腿的上限是正整数，且不紧于 5s（太紧会把正常慢调用误报成失败）', () => {
  assert.ok(Number.isInteger(UPSTREAM_TIMEOUT_MS) && UPSTREAM_TIMEOUT_MS >= 5000, `实测取值 ${UPSTREAM_TIMEOUT_MS}ms`);
  assert.ok(UPSTREAM_TIMEOUT_MS < FEEDBACK_REQUEST_TIMEOUT_MS);
});

test('服务端整体请求上限（30s）> 客户端这条腿：慢请求由服务端收尾，不被客户端先掐', async () => {
  // 这条跨模块关系放在本文件而不是 `tests/compose.test.mjs`：后者要进变异探针的临时工作树，
  // 而 `server/index.mjs` 的路由表写死了 `../web/` 的绝对路径，在临时树里会让基线假红
  // （理由与探针 TEST_FILES 上方那段注释同源）。
  const { SERVER_REQUEST_TIMEOUT_MS } = await import('../server/index.mjs');
  assert.ok(
    SERVER_REQUEST_TIMEOUT_MS > FEEDBACK_REQUEST_TIMEOUT_MS,
    `服务端整体请求上限 ${SERVER_REQUEST_TIMEOUT_MS}ms 必须 > 造句这条腿 ${FEEDBACK_REQUEST_TIMEOUT_MS}ms`,
  );
});

test('上游模块的注入点是真的：`feedbackUpstream` 可用假 fetch 单独驱动（本文件全靠它）', async () => {
  const { feedback } = await feedbackUpstream({
    sentence: 'x', word: 'mug', scene: 'kitchen',
    env: ENV,
    fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }),
    }),
  });
  assert.deepEqual(feedback, GOOD);
  assert.ok(FEEDBACK_PROMPT.length > 100, '提示词是一段真材实料的强约束，不是占位');
});
