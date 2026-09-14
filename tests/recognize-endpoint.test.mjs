// tests/recognize-endpoint.test.mjs
//
// `/api/recognize` 路由层的测试（Task 7）。上游用**本地桩服务**替掉，于是这一层完全可自动测
// ——设计文档 §5.2 说"真实模型调用不写自动测"，指的是不拿真模型当测试依赖，而不是不测路由。
//
// 这层要钉住的四件事，每一条都对应一种"改坏了还不报错"：
//   ① **密钥只在服务端**：客户端拿不到，响应里也不回显；上游请求头里必须有它（否则整条链路 401）。
//   ② **请求体形状就是已核实的模型契约**：图片在 user message 的 content 数组里、detail=low、
//      response_format=json_object。这些只有断言能拦住（真模型那一趟不可重复，不能当测试）。
//   ③ **失败不得长得像成功**：上游 500 / 非 JSON / candidates 不是数组 → 都是 ok:false，
//      绝不回一个空候选的 200（全局约束 3）。
//   ④ **畸形输入打不死进程**：无图、乱码 body、超大体、诡异 content-type 都只坏这一个请求
//      （Task 5 已吃过一次"一条请求换一条命"的亏）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createApp, parseMultipart } from '../server/index.mjs';

const ENV = {
  DEEPSEEK_API_KEY: 'sk-fake-server-side-key-0123456789',
  DEEPSEEK_API_BASE: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-flash',
  VISION_DETAIL: 'low',
};
/** 一帧假的 JPEG 字节（只看字节是否原样送到，不看它是不是真能解码）。 */
const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03, 0xff, 0xd9]);

/** 上游桩：记录每一次收到的请求，按当前 `reply` 回。 */
function upstreamStub() {
  const seen = [];
  let reply = { status: 200, body: { choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] } };
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
    /** 上游用 `{candidates:[...]}` 的 content 字符串回一个成功响应。 */
    replyJson(obj, extra = {}) {
      reply = { status: 200, body: { choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 42 }, ...extra } };
    },
  };
}

let upstream;
let app;
let origin;

before(async () => {
  upstream = upstreamStub();
  await new Promise((resolve) => upstream.server.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.server.address().port}`;

  app = createApp({ env: { ...ENV, DEEPSEEK_API_BASE: upstreamBase }, fetchImpl: fetch });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  upstream.server.closeAllConnections();
  await new Promise((resolve) => upstream.server.close(resolve));
});

/** 客户端那一侧的真实请求形状：`recognize()` 用的就是 FormData + 字段名 image。 */
async function postFrame({ bytes = FRAME, mime = 'image/jpeg', filename = 'frame.jpg', field = 'image', url = `${origin}/api/recognize` } = {}) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: mime }), filename);
  return fetch(url, { method: 'POST', body: form });
}

// ─────────────────────────────────────────── 正常路径 ───────────────────────────────────────────

test('正常路径：200 + ok:true + 候选 + latency_ms', async () => {
  upstream.replyJson({ candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }] });
  const res = await postFrame();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.candidates, [{ label: 'mug', score: 0.9, scene: 'kitchen' }]);
  assert.equal(Number.isInteger(body.latency_ms), true, 'latency_ms 必须是整数毫秒（判据计算要用）');
  assert.ok(body.latency_ms >= 0);
});

test('上游请求体就是已核实的模型契约（模型 / user message / detail / JSON 模式）', async () => {
  upstream.replyJson({ candidates: [] });
  const before = upstream.seen.length;
  await postFrame();
  assert.equal(upstream.seen.length, before + 1, '一次识物 = 一次上游调用');
  const sent = JSON.parse(upstream.seen.at(-1).body);
  assert.equal(upstream.seen.at(-1).url, '/chat/completions');
  assert.equal(sent.model, 'deepseek-flash', '识物必须用 flash（pro 不支持 Vision）');
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0].role, 'user', '图片必须在 user message 里（放别处会 400）');
  const img = sent.messages[0].content.find((p) => p.type === 'image_url');
  assert.ok(img, 'content 数组里必须有 image_url');
  assert.equal(img.image_url.detail, 'low', 'detail 取自 VISION_DETAIL（默认 low = 512px 口径）');
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.equal(upstream.seen.at(-1).headers.authorization, `Bearer ${ENV.DEEPSEEK_API_KEY}`, '密钥由服务端注入上游');
});

test('上传的字节原样送到上游（不能被任何"顺手转换"改坏）', async () => {
  upstream.replyJson({ candidates: [] });
  await postFrame();
  const sent = JSON.parse(upstream.seen.at(-1).body);
  const url = sent.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), FRAME);
  assert.match(url, /^data:image\/jpeg;base64,/);
});

test('密钥绝不出现在给客户端的响应里（全局约束 1）', async () => {
  upstream.replyJson({ candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }] });
  const okRes = await postFrame();
  const okText = await okRes.text();
  assert.ok(!okText.includes(ENV.DEEPSEEK_API_KEY), '响应里不许出现密钥');
  assert.ok(!okText.includes('sk-'), '响应里不许出现任何 sk- 开头的串');

  // 失败路径同样不许回显（上游原文里常常带着请求头）
  upstream.setReply({ status: 500, raw: `{"error":"bad key ${ENV.DEEPSEEK_API_KEY}"}` });
  const failRes = await postFrame();
  const failText = await failRes.text();
  assert.ok(!failText.includes(ENV.DEEPSEEK_API_KEY), '失败响应里同样不许回显密钥');

  // 上游没给 usage 时，响应里的 usage 必须是 null（不是 {}、不是编出来的 0）
  upstream.setReply({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] } });
  const noUsage = await (await postFrame()).json();
  assert.equal(noUsage.usage, null, '上游没给 usage 就如实报 null，不编 token 数');
});

test('候选最多 3 个（设计文档 §4.1：三候选）', async () => {
  upstream.replyJson({
    candidates: [
      { label: 'a', score: 1, scene: 's' }, { label: 'b', score: 1, scene: 's' },
      { label: 'c', score: 1, scene: 's' }, { label: 'd', score: 1, scene: 's' },
    ],
  });
  const body = await (await postFrame()).json();
  assert.equal(body.candidates.length, 3);
  assert.deepEqual(body.candidates.map((c) => c.label), ['a', 'b', 'c']);
});

test('usage 以 token 计数的形状回出去（成本核算只认真实计数）', async () => {
  upstream.setReply({
    status: 200,
    body: {
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }],
      usage: { prompt_tokens: 341, completion_tokens: 27, total_tokens: 368 },
      model: 'deepseek-flash',
    },
  });
  const body = await (await postFrame()).json();
  assert.deepEqual(body.usage, { prompt_tokens: 341, completion_tokens: 27, total_tokens: 368 });
});

// ───────────────────────────────────── 上游失败：绝不长得像成功 ─────────────────────────────────────

test('上游 500 → 502 upstream_failed，ok:false（不是空候选的 200）', async () => {
  upstream.setReply({ status: 500, raw: '{"error":"boom"}' });
  const res = await postFrame();
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'upstream_failed');
});

test('上游 200 但不是 JSON → 502 upstream_invalid', async () => {
  upstream.setReply({ status: 200, raw: '<html>not json</html>' });
  const res = await postFrame();
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'upstream_invalid');
});

test('上游 200 但 candidates 不是数组 → 502 upstream_invalid（brief Step 5 的第①件事）', async () => {
  upstream.setReply({ status: 200, body: { choices: [{ message: { content: '{"candidates":"nope"}' } }] } });
  const res = await postFrame();
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'upstream_invalid');
  assert.equal('candidates' in body, false, '失败响应里不该带一个 candidates 字段（免得被当成空候选读）');
});

test('上游连不上 → 502 upstream_failed（本地桩关掉再打）', async () => {
  const dead = createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadBase = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((resolve) => { dead.closeAllConnections(); dead.close(resolve); });
  const lonely = createApp({ env: { ...ENV, DEEPSEEK_API_BASE: deadBase }, fetchImpl: fetch });
  await new Promise((resolve) => lonely.listen(0, '127.0.0.1', resolve));
  try {
    const res = await postFrame({ url: `http://127.0.0.1:${lonely.address().port}/api/recognize` });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'upstream_failed');
  } finally {
    lonely.closeAllConnections();
    await new Promise((resolve) => lonely.close(resolve));
  }
});

// ─────────────────────────────── 畸形输入：只坏这一个请求，进程活着 ───────────────────────────────

test('没带 image 字段 → 400 bad_request，且**不打上游**（省一次调用）', async () => {
  const before = upstream.seen.length;
  const res = await postFrame({ field: 'photo' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_request');
  assert.match(body.detail, /image/, '要说清缺的是哪个字段');
  assert.equal(upstream.seen.length, before, '缺图时不该发生任何上游调用');
});

test('image 字段是空的（0 字节）→ 400，不当成一张可识别的图送出去', async () => {
  const before = upstream.seen.length;
  const res = await fetch(`${origin}/api/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=X' },
    body: Buffer.from('--X\r\nContent-Disposition: form-data; name="image"; filename="f.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\r\n--X--\r\n'),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
  assert.equal(upstream.seen.length, before);
});

test('完全不是 multipart 的 body → 400 而不是 500/崩进程', async () => {
  const res = await fetch(`${origin}/api/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
  // 关键：进程还活着、还在服务
  assert.equal((await fetch(`${origin}/nope.js`)).status, 404);
});

test('边界串是垃圾 / 半截 multipart → 400，且进程继续服务', async () => {
  for (const raw of [
    '--abc\r\nContent-Disposition: form-data; name="image"; filename="a.jpg"\r\n\r\n', // 没有收尾边界
    'garbage without boundary at all',
    '\r\n\r\n\r\n',
  ]) {
    const res = await fetch(`${origin}/api/recognize`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=abc' },
      body: raw,
    });
    assert.equal(res.status, 400, `${JSON.stringify(raw.slice(0, 30))} 应回 400`);
  }
  assert.equal((await fetch(`${origin}/nope.js`)).status, 404, '一连串畸形请求之后服务必须仍然活着');
});

test('超大 body → 400，且不把整个 body 读进内存', async () => {
  const res = await fetch(`${origin}/api/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=abc' },
    body: Buffer.alloc(2 * 1024 * 1024, 0x41),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
  assert.equal((await fetch(`${origin}/nope.js`)).status, 404);
});

test('content-type 说不是图片时按 JPEG 兜底（不把上游的 mime 交给客户端控制）', async () => {
  upstream.replyJson({ candidates: [] });
  await postFrame({ mime: 'application/octet-stream' });
  const sent = JSON.parse(upstream.seen.at(-1).body);
  const url = sent.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
  assert.match(url, /^data:image\/jpeg;base64,/);
});

// ──────────────────────────────────── parseMultipart 的谓词级用例 ────────────────────────────────────

test('parseMultipart：name/filename/mime 与多字段都能认出来，二进制内容按字节切（不走 UTF-8）', () => {
  // 内容里故意放非法 UTF-8 字节（0xff 0xd8 是 JPEG 魔数）：若实现用 utf8 转字符串再切，
  // 这些字节会变成 U+FFFD，送去上游的就是一张被改坏的图 —— 比"解析失败"更糟（静默改坏）。
  const bin = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x80, 0x81, 0xfe]);
  const body = Buffer.concat([
    Buffer.from('--B1\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n'),
    Buffer.from('--B1\r\nContent-Disposition: form-data; name="image"; filename="f.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
    bin,
    Buffer.from('\r\n--B1--\r\n'),
  ]);
  const { fields, files } = parseMultipart(body, 'multipart/form-data; boundary=B1');
  assert.equal(fields.get('note'), 'hello');
  assert.equal(files.get('image').mime, 'image/jpeg');
  assert.deepEqual(files.get('image').data, bin, '字节必须原样（含非法 UTF-8 字节）');
});

test('parseMultipart：没有 boundary 或不是 multipart 时返回空（拿不准就当没收到）', () => {
  for (const ct of ['application/json', 'multipart/form-data', 'text/plain; boundary=', null, undefined]) {
    const { fields, files } = parseMultipart(Buffer.from('--X\r\n\r\nhi\r\n--X--\r\n'), ct);
    assert.equal(fields.size, 0, `content-type=${String(ct)} 不该解析出字段`);
    assert.equal(files.size, 0);
  }
});
