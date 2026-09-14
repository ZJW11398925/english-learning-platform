// tests/recognize-upstream.test.mjs
//
// 识物上游调用的契约测试（`server/recognize-upstream.mjs`）。
//
// 为什么值得自动测：设计文档 §5.2 说"真实模型调用不写自动测"，那指的是**不拿真模型当测试依赖**。
// 但**请求体形状**与**响应校验**是纯逻辑，而且正是最容易"改坏了还全绿"的两处：
//   · 图片挪出 user message（官方文档：放进 system/assistant 会 400）——只有断言能拦住；
//   · `detail` 丢了 → 悄悄按 `auto`/`high` 计费，成本模型（设计文档 §5.1 的省钱手段）失效；
//   · 响应不校验 → 上游吐垃圾时返回空候选，看起来像"识物成功但没认出东西"（全局约束 3）。
// 真模型那一趟见报告「实弹探针」一节，它**不可重复**，不能当测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  recognizeUpstream, RECOGNIZE_PROMPT, MAX_CANDIDATES, UPSTREAM_INVALID, UPSTREAM_FAILED,
  UPSTREAM_TIMEOUT_MS,
} from '../server/recognize-upstream.mjs';
import { settlesWithin } from './helpers/watchdog.mjs';

const ENV = {
  DEEPSEEK_API_KEY: 'sk-fake-key-for-tests',
  DEEPSEEK_API_BASE: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-flash',
  VISION_DETAIL: 'low',
};
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** 造一个假上游：记录请求，按参数回一个响应。 */
function fakeUpstream({ status = 200, body = null, raw = null, throws = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throws !== null) throw throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (raw !== null ? JSON.parse(raw) : body),
      text: async () => (raw !== null ? raw : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

/** 上游正常返回 `{candidates:[...]}` 时的完整响应体（content 是**字符串**，这是 OpenAI 格式）。 */
const upstreamJson = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 123 } });

// ───────────────────────────────────────── 请求体契约（模型契约的落点）─────────────────────────────────────────

test('打到 `${BASE}/chat/completions`，带 Bearer 密钥与 JSON content-type', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }] }) });
  await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  assert.equal(up.calls.length, 1);
  assert.equal(up.calls[0].url, 'https://api.deepseek.com/chat/completions');
  const headers = up.calls[0].init.headers;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.authorization, `Bearer ${ENV.DEEPSEEK_API_KEY}`);
});

test('BASE 末尾多余斜杠不会拼出 `//chat/completions`', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({
    image: IMAGE, env: { ...ENV, DEEPSEEK_API_BASE: 'https://api.deepseek.com//' }, fetchImpl: up.fetchImpl,
  });
  assert.equal(up.calls[0].url, 'https://api.deepseek.com/chat/completions');
});

test('模型取自 env.DEEPSEEK_MODEL（识物必须 flash；写死别的型号就会静默失配）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({ image: IMAGE, env: { ...ENV, DEEPSEEK_MODEL: 'deepseek-flash' }, fetchImpl: up.fetchImpl });
  assert.equal(JSON.parse(up.calls[0].init.body).model, 'deepseek-flash');
});

test('图片只出现在 user message 的 content 数组里（放 system/assistant 会被上游 400）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  const body = JSON.parse(up.calls[0].init.body);
  assert.equal(body.messages.length, 1, '本调用只用一条消息');
  assert.equal(body.messages[0].role, 'user');
  const parts = body.messages[0].content;
  assert.ok(Array.isArray(parts), 'content 必须是数组（多模态形状）');
  const img = parts.find((p) => p.type === 'image_url');
  assert.ok(img, 'content 数组里必须有 image_url 部分');
  assert.equal(parts[0].type, 'text', '文本在前、图在后（与已核实的请求体形状一致）');
  assert.match(img.image_url.url, /^data:image\/jpeg;base64,/, '图片必须是 base64 data URL');
  // 图片部分里绝不能出现密钥之类的凭据
  assert.ok(!img.image_url.url.includes(ENV.DEEPSEEK_API_KEY));
});

test('detail 用 env.VISION_DETAIL（缺省 low）——它直接决定 token 成本与 512px 口径', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  const body = JSON.parse(up.calls[0].init.body);
  const img = body.messages[0].content.find((p) => p.type === 'image_url');
  assert.equal(img.image_url.detail, 'low');
});

test('用 response_format 的 JSON 模式兜底，并要求返回 candidates', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  const body = JSON.parse(up.calls[0].init.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const text = body.messages[0].content.find((p) => p.type === 'text').text;
  assert.match(text, /candidates/, '提示词必须点名 candidates 字段');
  assert.match(text, /JSON/, '提示词必须要求 JSON');
  assert.equal(text, RECOGNIZE_PROMPT, '提示词就是导出的那一条（改提示词要有意为之）');
});

test('图片按原始字节 base64 编码（不是二次编码、不是空串）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  const body = JSON.parse(up.calls[0].init.body);
  const url = body.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
  const b64 = url.slice('data:image/jpeg;base64,'.length);
  assert.deepEqual(Buffer.from(b64, 'base64'), IMAGE);
});

test('mime 可覆盖（客户端上传的不是 JPEG 时不许硬说成 JPEG）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({ image: IMAGE, mime: 'image/png', env: ENV, fetchImpl: up.fetchImpl });
  const body = JSON.parse(up.calls[0].init.body);
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

// ─────────────────────────────────────────── 响应校验与截断 ───────────────────────────────────────────

test('正常响应：返回校验后的候选，score/scene 原样', async () => {
  const up = fakeUpstream({
    body: upstreamJson({
      candidates: [
        { label: 'mug', score: 0.9, scene: 'kitchen' },
        { label: 'cup', score: 0.6, scene: 'kitchen' },
      ],
    }),
  });
  const r = await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  assert.deepEqual(r.candidates, [
    { label: 'mug', score: 0.9, scene: 'kitchen' },
    { label: 'cup', score: 0.6, scene: 'kitchen' },
  ]);
});

test(`最多保留 ${MAX_CANDIDATES} 个候选（设计文档 §4.1：三候选 + 人工重拍）`, async () => {
  const up = fakeUpstream({
    body: upstreamJson({
      candidates: [
        { label: 'a', score: 1, scene: 's' }, { label: 'b', score: 1, scene: 's' },
        { label: 'c', score: 1, scene: 's' }, { label: 'd', score: 1, scene: 's' },
        { label: 'e', score: 1, scene: 's' },
      ],
    }),
  });
  const r = await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  assert.equal(r.candidates.length, 3);
  assert.deepEqual(r.candidates.map((c) => c.label), ['a', 'b', 'c'], '保留的是**靠前**（置信度高）的三个');
});

test('候选数组为空是合法的"什么都没认出来"（不是错误）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  const r = await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  assert.deepEqual(r.candidates, []);
});

test('usage 原样带出（成本核算只认真实计数，不用估算）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  const r = await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  assert.deepEqual(r.usage, { prompt_tokens: 123 });
});

test('score 缺失/非法 → null（不编造一个 0 或 1 冒充置信度）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [{ label: 'mug', scene: 'kitchen' }] }) });
  const r = await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  assert.equal(r.candidates[0].score, null);
  assert.equal(r.candidates[0].scene, 'kitchen');
});

test('label 两侧空白被裁掉；裁完为空 → 判非法', async () => {
  const ok = fakeUpstream({ body: upstreamJson({ candidates: [{ label: '  mug  ', score: 0.5, scene: ' kitchen ' }] }) });
  const r = await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: ok.fetchImpl });
  assert.deepEqual(r.candidates[0], { label: 'mug', score: 0.5, scene: 'kitchen' });

  const bad = fakeUpstream({ body: upstreamJson({ candidates: [{ label: '   ', score: 0.5, scene: 'kitchen' }] }) });
  await assert.rejects(
    () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: bad.fetchImpl }),
    (err) => err.code === UPSTREAM_INVALID,
  );
});

// ──────────────────────────────────────────── 失败路径 ────────────────────────────────────────────

test('网络层抛异常 → upstream_failed（带原因，不吞）', async () => {
  const up = fakeUpstream({ throws: new Error('ECONNREFUSED') });
  await assert.rejects(
    () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl }),
    (err) => err.code === UPSTREAM_FAILED && /ECONNREFUSED/.test(err.message),
  );
});

test('上游非 2xx → upstream_failed，message 带状态码（401 与 500 要能分开看）', async () => {
  for (const status of [400, 401, 429, 500, 502]) {
    const up = fakeUpstream({ status, raw: '{"error":{"message":"nope"}}' });
    await assert.rejects(
      () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl }),
      (err) => err.code === UPSTREAM_FAILED && err.message.includes(String(status)),
    );
  }
});

test('响应体不是 JSON → upstream_invalid（且不回显整段响应）', async () => {
  const up = fakeUpstream({ raw: '<html>gateway</html>' });
  await assert.rejects(
    () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl }),
    (err) => err.code === UPSTREAM_INVALID,
  );
});

test('content 缺失/为空 → upstream_invalid', async () => {
  for (const body of [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: '  ' } }] }]) {
    const up = fakeUpstream({ body });
    await assert.rejects(
      () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl }),
      (err) => err.code === UPSTREAM_INVALID,
      `body=${JSON.stringify(body)} 应判非法`,
    );
  }
});

test('content 不是合法 JSON → upstream_invalid（绝不从散文里抠一个词当成功）', async () => {
  const up = fakeUpstream({ body: { choices: [{ message: { content: 'The object is a mug.' } }] } });
  await assert.rejects(
    () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl }),
    (err) => err.code === UPSTREAM_INVALID,
  );
});

test('candidates 不是数组 → upstream_invalid（空候选冒充成功的最危险入口）', async () => {
  for (const bad of ['nope', 42, {}, null]) {
    const up = fakeUpstream({ body: upstreamJson({ candidates: bad }) });
    await assert.rejects(
      () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl }),
      (err) => err.code === UPSTREAM_INVALID,
      `candidates=${JSON.stringify(bad)} 应判非法`,
    );
  }
});

test('任一条候选连 label 都给不出来 → 整份判非法（不静默剔掉坏条目）', async () => {
  const up = fakeUpstream({
    body: upstreamJson({ candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }, { score: 0.5 }] }),
  });
  await assert.rejects(
    () => recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl }),
    (err) => err.code === UPSTREAM_INVALID,
  );
});

test('图片超过 data URL 上限时当场失败，不发那次请求（省往返也省事）', async () => {
  // 32 MiB 的合法 JPEG 在端侧（512px 长边）不可能出现；构造上用一个超大缓冲模拟"上游限制被撞上"。
  // 取"刚好越线"而不是远远超过：base64 会把这笔内存放大 4/3，测试自己不该成为内存压力源。
  const huge = Buffer.alloc(Math.ceil((32 * 1024 * 1024 * 3) / 4) + 1024, 0x41);
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await assert.rejects(
    () => recognizeUpstream({ image: huge, env: ENV, fetchImpl: up.fetchImpl }),
    (err) => err.code === UPSTREAM_INVALID && /上限/.test(err.message),
  );
  assert.equal(up.calls.length, 0, '明知会超限就不要发出去');
});

// ───────────────────────────────────── 超时闸（Task 7 修复轮 · Critical 2）─────────────────────────────────────

/** 永不回话、但如实遵守 signal 的 fetch（真 fetch 在半开连接上就是这个行为）。 */
const stalledFetch = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});

test('每次上游调用都带 signal（没有它，上游半开会让这条链路永久挂住）', async () => {
  const up = fakeUpstream({ body: upstreamJson({ candidates: [] }) });
  await recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: up.fetchImpl });
  assert.ok(up.calls[0].init.signal instanceof AbortSignal, '上游 fetch 必须带 signal');
});

test('上游永不回话 → 在上限内抛 upstream_failed（不是永久 pending）', async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => settlesWithin(
      recognizeUpstream({ image: IMAGE, env: ENV, fetchImpl: stalledFetch, timeoutMs: 30 }),
      2000, '上游请求',
    ),
    (err) => err.code === UPSTREAM_FAILED && /超时|timeout/i.test(String(err.message)),
    '超时按上游失败报（不是"形状非法"），且消息里说清是超时',
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `必须在注入的上限（30ms）内收口，实测 ${elapsed}ms`);
});

test('默认上限是首轮设定值：正整数字面量，且小于客户端那条腿（由客户端一侧的用例钉住关系）', () => {
  assert.ok(Number.isInteger(UPSTREAM_TIMEOUT_MS), 'UPSTREAM_TIMEOUT_MS 必须是整数毫秒');
  assert.ok(UPSTREAM_TIMEOUT_MS > 0);
  // 上限必须显著高于实测端到端时延（实弹探针 1.8s / 3.0s），否则真实模型偶发慢会被误报成上游失败
  assert.ok(UPSTREAM_TIMEOUT_MS >= 5000, `上限 ${UPSTREAM_TIMEOUT_MS}ms 太紧：会把慢一点的正常调用误报成失败`);
});
