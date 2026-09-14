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
import { settlesWithin } from './helpers/watchdog.mjs';

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

test('识物失败路径的日志：上游正文里的密钥形状同样先抹再记（Task 8 复审 Item 1 的同形状）', async () => {
  // 识物这条腿与造句那条腿在同一个位置读上游正文片段（`server/recognize-upstream.mjs` 的
  // 非 2xx 分支），路由层的失败日志也照样把 message 写进 stderr。所以同一条纪律在这里也钉一遍：
  // 正文片段留着（诊断要的），密钥形状抹掉。
  const KEY = ENV.DEEPSEEK_API_KEY;
  const collected = [];
  const logApp = createApp({
    env: { ...ENV, DEEPSEEK_API_BASE: `http://127.0.0.1:${upstream.server.address().port}` },
    fetchImpl: fetch,
    logImpl: (line) => collected.push(line),
  });
  await new Promise((resolve) => logApp.listen(0, '127.0.0.1', resolve));
  try {
    upstream.setReply({
      status: 401,
      raw: JSON.stringify({
        error: { message: `Incorrect API key provided: ${KEY}`, type: 'invalid_request_error' },
        authorization: `Bearer ${KEY}`,
        request_id: 'req_9f2c1a',
      }),
    });
    const res = await postFrame({ url: `http://127.0.0.1:${logApp.address().port}/api/recognize` });
    assert.equal(res.status, 502, '上游 401 仍然如实报成失败');
    assert.equal((await res.json()).error, 'upstream_failed');

    const joined = collected.join('\n');
    assert.ok(!joined.includes(KEY), '失败路径的日志里同样不许出现密钥');
    assert.doesNotMatch(joined, /sk-[A-Za-z0-9_-]{3,}/, 'sk- 形状的串一个都不许留（含被截断的半截）');
    assert.doesNotMatch(joined, /Bearer\s+sk/i, 'Authorization 头的写法同样不许漏下去');
    assert.match(joined, /recognize 失败（upstream_failed/, '仍然要看得出"上游失败了"');
    assert.match(joined, /HTTP 401/, '状态码要留着');
    assert.match(joined, /invalid_request_error/, '上游正文的其余部分照旧可见：抹密钥 ≠ 删正文');
  } finally {
    logApp.closeAllConnections();
    await new Promise((resolve) => logApp.close(resolve));
  }
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

test('客户端声明的 mime 不是图片时，上游 data URL 的 mime 由服务端按字节判定（客户端说了不算）', async () => {
  // 标题原先写"按 JPEG 兜底"：那个分支（"声明不是 image/* 就当 JPEG"）在魔数校验落地后
  // 已经不存在了——mime 现在是**服务端按字节**判定的（`sniffImageMime`），与客户端的声明无关。
  // 断言本身仍然有效：这帧字节能通过校验、且上游收到的是 `data:image/jpeg;base64,`。
  upstream.replyJson({ candidates: [] });
  await postFrame({ mime: 'application/octet-stream' });
  const sent = JSON.parse(upstream.seen.at(-1).body);
  const url = sent.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
  assert.match(url, /^data:image\/jpeg;base64,/);
});

// ───────────────────────────── 图片魔数校验（Task 7 修复轮 · Important 5）─────────────────────────────
//
// 原先只查"mime 以 image/ 开头"——而 mime 是**客户端声明的**。一个 15 字节的垃圾 payload
// 因此能一路打到按张计费的视觉模型上。下面两条：垃圾必须被挡在端点（既有 400 形状），
// 真图必须照常通过，且 data URL 的 mime 由**服务端按字节**判定。

/** 一段没有任何图片魔数的垃圾（15 字节，客户端却可以宣称它是 image/jpeg）。 */
const JUNK = Buffer.from('not an image ::)');

test('客户端声明 image/jpeg 但字节不是图片 → 400 bad_request，且绝不打上游（不让垃圾花钱）', async () => {
  const before = upstream.seen.length;
  const res = await postFrame({ bytes: JUNK, mime: 'image/jpeg' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_request', '复用既有错误形状，不新造一种');
  assert.match(String(body.detail), /JPEG|PNG/, '要说清为什么这些字节不算图片');
  assert.equal(upstream.seen.length, before, '花在垃圾上的钱必须挡在这里——这是"太暗/太糊不花钱"的另一半');
});

test('PNG 魔数被接受，且 data URL 的 mime 由服务端按字节判定（客户端谎报 jpeg 也不算数）', async () => {
  upstream.replyJson({ candidates: [] });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  ]);
  await postFrame({ bytes: png, mime: 'image/jpeg', filename: 'frame.jpg' });
  const sent = JSON.parse(upstream.seen.at(-1).body);
  const url = sent.messages[0].content.find((p) => p.type === 'image_url').image_url.url;
  assert.match(url, /^data:image\/png;base64,/, '服务端按魔数判定，不听客户端的声明');
});

test('魔数校验的谓词：只认相机真的会产的两种格式（JPEG / PNG），其余一律 null', async () => {
  const { sniffImageMime } = await import('../server/index.mjs');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  for (const bad of [JUNK, Buffer.from([0xff, 0xd8]), Buffer.from([0x89, 0x50, 0x4e]), Buffer.alloc(0),
    Buffer.from('<html>'), Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) /* GIF：相机不产 */]) {
    assert.equal(sniffImageMime(bad), null, `${bad.toString('hex').slice(0, 16) || '(空)'} 不是受支持的图片`);
  }
});

// ───────────────────────── 服务端自己的请求处理上限（半开客户端不许占着连接）─────────────────────────

test('服务端设了 requestTimeout / headersTimeout 守卫，且都是正数、headers < request', async () => {
  const { SERVER_REQUEST_TIMEOUT_MS, SERVER_HEADERS_TIMEOUT_MS } = await import('../server/index.mjs');
  assert.equal(app.requestTimeout, SERVER_REQUEST_TIMEOUT_MS, '整个请求（含 body）的接收上限要在岗');
  assert.equal(app.headersTimeout, SERVER_HEADERS_TIMEOUT_MS, '只收半截请求头的连接也要被收掉');
  assert.ok(SERVER_REQUEST_TIMEOUT_MS > 0 && SERVER_HEADERS_TIMEOUT_MS > 0);
  assert.ok(SERVER_HEADERS_TIMEOUT_MS < SERVER_REQUEST_TIMEOUT_MS, '只发头的半开连接应比整个请求更早被收掉');
});

test('服务端"整个请求"的上限 > 客户端那条腿：慢但活着的上传由服务端收尾，不被客户端先掐', async () => {
  // Task 7 复审 Important 2 钉住的关系。原先常量注释里写着"两个守卫都大于客户端那条腿"，
  // 而 headersTimeout = 10s < 12000ms，那句话是错的（复审已确认行为不受影响：headers 那道闸
  // 只管"收齐请求头为止"，收齐之后就不再拦 live 上传）。**真正必须成立的关系是这一条**：
  // 上游慢但活着时，服务端要在自己的上游上限（8s）到点后把 502 写回去，客户端才有机会读到
  // "服务端说的失败形状"；若服务端先收掉连接，客户端只会看到一次网络层中断，
  // 分不清模型慢、服务端挂了还是网络断。
  const { SERVER_REQUEST_TIMEOUT_MS } = await import('../server/index.mjs');
  const { RECOGNIZE_REQUEST_TIMEOUT_MS } = await import('../web/units/recognize.mjs');
  assert.ok(
    SERVER_REQUEST_TIMEOUT_MS > RECOGNIZE_REQUEST_TIMEOUT_MS,
    `服务端整体请求上限 ${SERVER_REQUEST_TIMEOUT_MS}ms 必须 > 客户端那条腿 ${RECOGNIZE_REQUEST_TIMEOUT_MS}ms`,
  );
});

test('上游半开（收下请求却不回话）→ 在服务端上限内回 502 upstream_failed，不挂住客户端', async () => {
  // 上游桩：读完请求就**有意不回**（连接半开）。没有超时闸时，这个 Promise 永久 pending，
  // 界面卡在 capturing、每点一次快门就多挂一个请求，而事件一条都不会落。
  const stalled = createServer((req) => { req.resume(); /* 有意不回 */ });
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  const slowApp = createApp({
    env: { ...ENV, DEEPSEEK_API_BASE: `http://127.0.0.1:${stalled.address().port}` },
    fetchImpl: fetch,
    upstreamTimeoutMs: 60, // 测试专用注入：不真等生产上限
  });
  await new Promise((resolve) => slowApp.listen(0, '127.0.0.1', resolve));
  try {
    const t0 = Date.now();
    // 看门狗：上游超时闸被拆掉时，这条 POST 会挂着不返回（undici 默认要等 5 分钟），
    // 于是整个测试文件挂死。看门狗把它变成一次干净的失败。
    const res = await settlesWithin(
      postFrame({ url: `http://127.0.0.1:${slowApp.address().port}/api/recognize` }),
      5000, '服务端识物请求',
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false, '失败绝不长得像成功');
    assert.equal(body.error, 'upstream_failed', '服务端先超时 → 报它自己的失败形状（客户端据此落 request_failed）');
    assert.equal(typeof body.latency_ms, 'number');
    assert.ok(elapsed < 3000, `必须在上限（注入 60ms）附近收口，实测 ${elapsed}ms——挂住就等于用户界面卡死`);
  } finally {
    slowApp.closeAllConnections();
    await new Promise((resolve) => slowApp.close(resolve));
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
  }
});

test('上游先回响应头、再半截 body 卡住 → 502 upstream_failed（停顿不是"契约非法"）', async () => {
  // Task 7 复审 Important 1 的第二种形状：响应头已经回来了，卡住的是 **body**。
  // 修复前它在上游模块里被归成 `upstream_invalid` → 路由回 502 `upstream_invalid`，
  // 而这一档的处置方向是"改模型契约"——真凶却是上游连接停滞。
  const stalling = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":[{"message":{"content":"{\\"cand'); // 半截 JSON
      // 有意不 res.end()：body 停在这里
    });
  });
  await new Promise((resolve) => stalling.listen(0, '127.0.0.1', resolve));
  const slowApp = createApp({
    env: { ...ENV, DEEPSEEK_API_BASE: `http://127.0.0.1:${stalling.address().port}` },
    fetchImpl: fetch,
    upstreamTimeoutMs: 60, // 测试专用注入：不真等生产上限
  });
  await new Promise((resolve) => slowApp.listen(0, '127.0.0.1', resolve));
  try {
    const t0 = Date.now();
    const res = await settlesWithin(
      postFrame({ url: `http://127.0.0.1:${slowApp.address().port}/api/recognize` }),
      5000, '服务端识物请求（上游 body 停滞）',
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false, '失败绝不长得像成功');
    assert.equal(body.error, 'upstream_failed', '停顿按"上游失败（超时）"报，不是 upstream_invalid');
    assert.ok(elapsed < 3000, `必须在上限（注入 60ms）附近收口，实测 ${elapsed}ms`);
  } finally {
    slowApp.closeAllConnections();
    await new Promise((resolve) => slowApp.close(resolve));
    stalling.closeAllConnections();
    await new Promise((resolve) => stalling.close(resolve));
  }
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
