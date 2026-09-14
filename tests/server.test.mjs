// tests/server.test.mjs
//
// Task 5 的服务层测试。此前 `server/index.mjs` 在 import 时无条件 `listen()`，任何测试都 import
// 不了它——它的路由、MIME 表、越界拒绝、405、以及两个"未实现"端点全靠一次性人工探针
// （task-5-report.md §3.3，脚本已删、不进 CI）。这里把那些行为钉进套件。
//
// 纪律：
// 1. 绑定端口 **0**，让 OS 分配空闲端口，再从 `server.address().port` 读实际端口——不写死 8787，
//    避免与真实服务/别的测试撞端口。跑完在 `after` 里关服务并断开 keep-alive 连接，绝不留监听。
// 2. 只 import 工厂 `createApp()`：生产入口（直接执行时 loadEnv + listen + 打印监听行）由子进程测试覆盖。
// 3. 测试**不读 `.env`**，也不依赖它的内容。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApp, isInsideWebRoot } from '../server/index.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const INDEX_HTML = join(WEB_ROOT, 'index.html');
const STORE_MJS = join(WEB_ROOT, 'units', 'store.mjs');
const ENTRY = join(REPO_ROOT, 'server', 'index.mjs');
/** 子进程输出只能重定向到文件描述符：本环境不允许 piped stdio（见 scripts/mutation-probe.mjs 护栏 3）。 */
const TMP = fs.mkdtempSync(join(os.tmpdir(), 'task5-server-test-'));
const CHILD_TIMEOUT_MS = 15_000;
/** 泄漏哨兵：假密钥只要出现在任何一处输出里，这条测试就响。 */
const FAKE_KEY = 'sk-test-DO-NOT-LOG-0123456789abcdef';

let app;
let origin;
let port;
/** 子进程测试必须清理干净，否则套件会留下孤儿进程。每个子进程注册进来，after 里兜底全杀。 */
const liveChildren = new Set();

before(async () => {
  app = createApp();
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
  ({ port } = app.address());
  origin = `http://127.0.0.1:${port}`;
});

after(async () => {
  // 兜底：任何还没退出的子进程在这里再杀一次（正常路径已在用例内 kill 掉）。
  for (const child of liveChildren) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  liveChildren.clear();
  // fetch 默认复用 keep-alive 连接，只 close() 会等空闲连接超时；先断开再关，套件不吊着不退出。
  app.closeAllConnections();
  await new Promise((resolve, reject) => app.close((err) => (err ? reject(err) : resolve())));
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────── 辅助

/** 裸 socket 发请求：让原始 request-target 原样上线（`fetch` 会在发送前把 `..` 归一化掉）。 */
function rawGet(target) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => { buf += c; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    sock.setTimeout(CHILD_TIMEOUT_MS, () => { sock.destroy(); reject(new Error(`裸请求超时：${target}`)); });
  });
}

/**
 * 往**任意**端口发原始 target 的裸请求（rawGet 的端口参数版）。
 *
 * 畸形 target 必须走裸 socket：`fetch`/`URL` 在发送前就把它归一化/拒绝了，到不了服务端；
 * 而且畸形请求的正确结局是「服务端回 4xx」——裸 socket 能明确区分三种结局：
 *   ① 拿到响应 → 回的就是响应原文；② 连接被重置；③ 一直没人应答（超时）。
 * 超时不是"慢"，而是**请求被丢弃**（服务端抛异常后 res 从未 end），调用方要按失败处理。
 */
function rawGetOn(p, target, timeoutMs = CHILD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = connect(p, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => { buf += c; });
    sock.on('end', () => resolve(buf));
    // 连接被重置也把已读到的内容交回去：进程猝死时客户端通常看到的就是 ECONNRESET，
    // 让断言自己去看"有没有 400"，而不是在辅助函数里就抛掉证据。
    sock.on('error', () => resolve(buf));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error(`裸请求超时（未收到任何响应）：${target}`)); });
  });
}

/** 从原始响应文本里取状态码（响应不是 HTTP 时返回 null）。 */
function statusOf(raw) {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * 起一个**真实子进程**服务：`node server/index.mjs`，端口显式给（`PORT=0` 会被 loadEnv 判非法）。
 * 输出只能重定向到文件描述符——本环境不允许 piped stdio（见本文件顶部注释与
 * `scripts/mutation-probe.mjs` 护栏 3），所以用 spawnLogged。
 */
async function startChildServer(label, extraEnv = {}) {
  const p = await freePort();
  const spawned = spawnLogged(['server/index.mjs'], cleanEnv({
    DEEPSEEK_API_KEY: FAKE_KEY,
    DEEPSEEK_API_BASE: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: 'deepseek-flash',
    PORT: String(p),
    ...extraEnv,
  }), label);
  liveChildren.add(spawned.child);
  const originUrl = `http://127.0.0.1:${p}`;

  // 不能只看日志就宣布"活着"：日志出现后再打一个正常请求，确认它真能应答。
  await waitForLog(spawned.read, `listening on http://localhost:${p}`, label);
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  for (;;) {
    const exited = await Promise.race([
      spawned.done.then((r) => r),
      new Promise((r) => setTimeout(() => r(null), 100)),
    ]);
    if (exited) {
      throw new Error(`子进程在起来之后、应答正常请求之前就退出了：code=${exited.code} signal=${exited.signal}\n${exited.text}`);
    }
    try {
      const res = await fetch(`${originUrl}/nope.js`);
      const ok = res.status === 404;
      await res.arrayBuffer();
      if (ok) return { ...spawned, origin: originUrl, port: p };
    } catch { /* 还没起来，重试 */ }
    if (Date.now() > deadline) throw new Error(`子进程起来了但不应答（${label}）：${JSON.stringify(spawned.read())}`);
  }
}

/** 取一个空闲端口（绑 0 再释放）。子进程要真实端口，因为 PORT=0 会被 loadEnv 判非法。 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: p } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return p;
}

/** 干净环境：剥掉可能从外层 shell 继承进来的密钥/PORT，免得子进程测试结果取决于我的终端。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('DEEPSEEK_') || k === 'PORT' || k === 'VISION_DETAIL') delete env[k];
  }
  return { ...env, ...extra };
}

function spawnLogged(args, env, label) {
  const logPath = join(TMP, `${label}.log`);
  const fd = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd] });
  const read = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } };
  let closed = false;
  const done = new Promise((resolve) => {
    const settle = (r) => {
      if (!closed) { closed = true; try { fs.closeSync(fd); } catch { /* 已关 */ } }
      resolve({ ...r, text: read() });
    };
    child.on('exit', (code, signal) => settle({ code, signal }));
    child.on('error', (err) => settle({ code: null, signal: null, error: err }));
  });
  return { child, done, logPath, read };
}

/** 跑一个子进程到退出，超时强杀并如实报告成"超时"（不冒充任何退出码）。 */
async function runToExit(args, env, label) {
  const { child, done } = spawnLogged(args, env, label);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, CHILD_TIMEOUT_MS);
  const r = await done;
  clearTimeout(timer);
  if (r.signal === 'SIGKILL') return { ...r, timedOut: true };
  return r;
}

async function waitForLog(read, needle, label) {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (read().includes(needle)) return read();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等不到子进程输出「${needle}」（${label}）：${JSON.stringify(read())}`);
}

// ─────────────────────────────────────────────────────────── 静态托管

test('GET /units/store.mjs：200 且 content-type 为 text/javascript; charset=utf-8（钉住静态链路与 MIME 表）', async () => {
  const res = await fetch(`${origin}/units/store.mjs`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  // 顺带证明内容是真文件本身，而不是空响应骗过状态码
  assert.equal(await res.text(), fs.readFileSync(STORE_MJS, 'utf8'));
});

test('GET /：web/index.html 不存在时 404，存在时 200 text/html（Task 6 加首页后本用例自动继续成立）', async () => {
  const res = await fetch(`${origin}/`);
  // 首页文件属于 Task 6，本任务按 brief 不创建它。所以这里**不能写死 404**：写完 Task 6 后
  // 这条断言会自动走 200 分支。判据取"仓库里 web/index.html 到底在不在"这个客观事实，
  // 而不是"今天返回什么"——这样状态码与文件系统不一致时仍然会失败（403/500 两个分支都不接受）。
  if (fs.existsSync(INDEX_HTML)) {
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.ok((await res.text()).length > 0, '首页存在时不应返回空 body');
  } else {
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
});

test('GET /nope.js：根内不存在的文件 → 404 {"error":"not_found"}', async () => {
  const res = await fetch(`${origin}/nope.js`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('GET /.env：web/ 之外的文件一律不给（.env 就在仓库根躺着，但服务不吐它的内容）', async () => {
  const res = await fetch(`${origin}/.env`);
  assert.notEqual(res.status, 200, 'web/ 之外的 .env 绝不能被 200 送出');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  // 说明：`.env` 在本工作树里确实存在（git 已忽略），所以这条在工作树里不是空转——
  // 真被托管出去的话状态码会是 200、content-type 会是 application/octet-stream、body 会是文件正文。
  // 反过来也不依赖它存在（干净检出没有 .env 时同样 404 通过）。
});

// ─────────────────────────────────────────────────────────── 越界拒绝

test('越界请求：原始 request-target 带 .. 也越不过 web/，且不是 500', async () => {
  // 为什么用裸 socket：`fetch` 与 `new URL` 在发送前就按 WHATWG 规则折叠 `..` 段，带 `..` 的请求
  // 根本到不了服务端，测出来的只是客户端行为。裸 socket 把原始 target 原样写上线路。
  //
  // 实测（Node v24.13.0）：服务端 `new URL(req.url, 'http://localhost')` **同样**会折叠 `..`
  // ——`/../../.env` → pathname `/.env` → 落到 `web/.env`（不存在）→ 404。也就是说 403 分支
  // 在这条数据流上**不可达**，它是一层防御性代码。因此本用例证明的是端到端性质：
  //   ① 没有任何 target 能拿到 web/ 之外的内容；② 不是 500；③ 不吐出 .env 的正文。
  for (const target of ['/../../.env', '/..%2f..%2f.env', '/C:/Windows/win.ini']) {
    const raw = await rawGet(target);
    const status = Number(raw.split(' ')[1]);
    assert.ok(
      status === 403 || status === 404,
      `${target} 应被拒绝（403 forbidden 或 404 not_found），实际 ${status}`,
    );
    assert.match(raw, /"error":"(forbidden|not_found)"/, `${target} 应回 JSON 错误体而不是别的什么东西`);
    assert.ok(!raw.includes('DEEPSEEK_API_KEY'), `${target} 的响应里出现了 .env 的键名——文件被托管出去了`);
  }
});

test('越界守卫谓词：web/ 之外的路径一律判假（含"同前缀兄弟目录"这个经典坑）', () => {
  // 守卫本身（`full === WEB_ROOT || full.startsWith(WEB_ROOT + sep)`）用单元测试直接钉住。
  // 只写前缀不加分隔符的话，`D:\测试1\web-evil` 会被误判成"在 web/ 里"，故最后两条是重点。
  assert.equal(isInsideWebRoot(WEB_ROOT), true, 'web 根本身算在里');
  assert.equal(isInsideWebRoot(join(WEB_ROOT, 'index.html')), true);
  assert.equal(isInsideWebRoot(join(WEB_ROOT, 'units', 'store.mjs')), true);
  assert.equal(isInsideWebRoot(join(WEB_ROOT, '.env')), true, '路径在 web/ 里（文件不存在是 404 的事，不是越界）');
  assert.equal(isInsideWebRoot(join(WEB_ROOT, '..', '.env')), false, '仓库根的 .env 在 web/ 之外');
  assert.equal(isInsideWebRoot(join(WEB_ROOT, '..', '..', '.env')), false);
  assert.equal(
    isInsideWebRoot(join(WEB_ROOT, '..', 'web-evil')),
    false,
    'web-evil 与 web 只差一个分隔符，朴素前缀检查会误放行',
  );
  assert.equal(
    isInsideWebRoot(join(WEB_ROOT, '..', 'server', 'env.mjs')),
    false,
    'server/env.mjs 在 web/ 之外',
  );
});

// ─────────────────────────────────────────────────────────── 畸形 request-target（不得打死进程）

/**
 * 这几条用例钉的是一个**已验证的远程崩溃**（Task 5 修复轮 2，详见 task-5-report.md）：
 * `serveStatic` 曾直接 `new URL(req.url, 'http://localhost')`，而 `req.url` 完全由对端控制。
 * target `//`（空 host）让 `new URL` 抛 `TypeError [ERR_INVALID_URL]`；异常从 async listener
 * 里逃出去成为 unhandled rejection → Node 默认 `--unhandled-rejections=throw` → **整个进程退出（code 1）**。
 * 从 Task 6 起服务要经隧道暴露到公网 HTTPS（getUserMedia 要求安全上下文），于是这就是一条
 * 任何人都能触发的 DoS：一个请求换一条命。
 *
 * 修复后的契约：畸形 target → `400 {"error":"bad_request"}`，且**服务继续活着**。
 * 因此每条用例都是"两段式"：先发畸形请求断言 400，再发一个正常请求断言仍然 200——
 * 只断言 400 是不够的，那证明不了进程没死。
 */
test('畸形 target `//`：回 400 bad_request 而不是打死进程，且随后正常请求仍成功', async () => {
  // 走裸 socket：`fetch`/`URL` 会在发送前把 `//` 归一化，根本到不了服务端。
  const raw = await rawGet('//');
  assert.equal(
    statusOf(raw),
    400,
    `畸形 target 必须是 400（响应原文前 80 字：${JSON.stringify(raw.slice(0, 80))}）——` +
    '若这里超时或收到 ECONNRESET，说明服务端把请求丢了/进程死了',
  );
  assert.match(raw, /"error":"bad_request"/, '错误体形状要与本服务既有 JSON 错误一致');
  // 不断言"body 恰好是这 23 字节"、也不把传输细节算进契约：实测响应是 chunked
  // （`17\r\n{"error":"bad_request"}\r\n0`），逐字相等会把分块帧格式一起钉死（今天换个
  // `res.end(s)` 的实现就假红）。这里断言的是"body 就是这一个 JSON 对象"。
  assert.match(raw.split('\r\n\r\n')[1] ?? '', /^\S+\r?\n?(\{"error":"bad_request"\})/, 'body 应就是该 JSON');

  // 关键断言：进程还活着、还在服务。
  const res = await fetch(`${origin}/units/store.mjs`);
  assert.equal(res.status, 200, '畸形请求之后服务必须仍然正常应答（进程没被打死）');
  assert.equal(await res.text(), fs.readFileSync(STORE_MJS, 'utf8'));
});

test('另一个畸形 target `///`：同样 400 + 进程存活（不是只给 `//` 打的补丁）', async () => {
  const raw = await rawGet('///');
  assert.equal(statusOf(raw), 400, `响应原文前 80 字：${JSON.stringify(raw.slice(0, 80))}`);
  assert.match(raw, /"error":"bad_request"/);
  const res = await fetch(`${origin}/nope.js`);
  assert.equal(res.status, 404, '畸形请求之后服务必须仍然正常应答');
});

test('正常请求不受影响：路由/405/两个桩端点在该守卫落地后逐字未变', async () => {
  // 与前面各用例有意重叠：守卫若写错（例如把所有请求都判成畸形），会在**这里**响。
  const ok = await fetch(`${origin}/units/store.mjs`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/javascript; charset=utf-8');
  await ok.arrayBuffer();

  const missing = await fetch(`${origin}/nope.js`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });

  const wrongMethod = await fetch(`${origin}/`, { method: 'PUT' });
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(await wrongMethod.json(), { error: 'method_not_allowed' });

  for (const path of ['/api/recognize', '/api/feedback']) {
    const stub = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ probe: true }),
    });
    assert.equal(stub.status, 200);
    assert.deepEqual(await stub.json(), { ok: false, error: 'not_implemented_until_task_8' });
  }
});

test('进程级回归闸：真实子进程 `node server/index.mjs` 被畸形请求打过之后仍然活着', async () => {
  // 为什么要有这条：上面的用例证明的是"同一个进程里响应是 400"，而**这个缺陷的危害正是进程死亡**。
  // 只有起真实子进程、发畸形请求、再确认它既没退出也仍能应答，才真正钉住"进程不死"。
  // 输出重定向到文件描述符（本环境不允许 piped stdio），子进程在 finally 里必杀。
  const srv = await startChildServer('malformed-target');
  try {
    const before = await fetch(`${srv.origin}/nope.js`);
    assert.equal(before.status, 404);
    await before.arrayBuffer();

    const raw = await rawGetOn(srv.port, '//');
    assert.equal(statusOf(raw), 400, `响应原文前 80 字：${JSON.stringify(raw.slice(0, 80))}`);

    const exited = await Promise.race([
      srv.done.then((r) => r),
      new Promise((r) => setTimeout(() => r(null), 400)),
    ]);
    assert.equal(
      exited,
      null,
      `发完 GET // 之后子进程退出了：code=${exited?.code} signal=${exited?.signal}\n${exited?.text ?? ''}`,
    );

    const after = await fetch(`${srv.origin}/units/store.mjs`);
    assert.equal(after.status, 200, '畸形请求之后子进程必须仍然正常应答');
    assert.equal(await after.text(), fs.readFileSync(STORE_MJS, 'utf8'));
    assert.ok(!srv.read().includes(FAKE_KEY), '密钥绝不能被打印出来');

    // 两个 400 **不是同一件事**，这条断言就是用来分开它们的：
    //   · 期望路径：parseTarget() 认出畸形 target → 直接 400，handleRequest 的兜底 catch 不参与；
    //   · 退化路径：守卫没了 → `new URL` 抛异常 → 兜底 catch 接住 → 也回 400（进程同样不死）
    //     ——但兜底 catch 会往 stderr 写一行 `request handler error:`。
    // 因此"stderr 干净"正是"守卫真的在岗"的可观测证据。没有这条断言时，把守卫整条删掉
    // 测试仍然全绿（实测 G1 MISSED）——那样套件就分不清"被防住了"和"被兜底接住了"。
    const stderr = srv.read();
    assert.ok(
      !stderr.includes('request handler error'),
      `畸形 target 应由 parseTarget 的守卫直接处理，不该落到兜底 catch：\n${stderr}`,
    );
  } finally {
    srv.child.kill('SIGKILL');
    await srv.done;
    liveChildren.delete(srv.child);
  }
});

// ─────────────────────────────────────────────────────────── 端点占位与未知方法

test('POST /api/recognize：200 但 ok:false 的"未实现"标记（绝不长得像成功）', async () => {
  const res = await fetch(`${origin}/api/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false, 'ok 必须显式为 false——失败不得静默降级为成功');
  assert.equal(body.error, 'not_implemented_until_task_8');
});

test('POST /api/feedback：同样返回 ok:false 的"未实现"标记', async () => {
  const res = await fetch(`${origin}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sentence: 'I am using a mug.' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'not_implemented_until_task_8');
});

test('PUT /：未处理的方法 → 405 {"error":"method_not_allowed"}', async () => {
  const res = await fetch(`${origin}/`, { method: 'PUT' });
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
});

// ─────────────────────────────────────────────────────────── 生产入口（直接执行 vs import）

test('import 本模块：不监听、不打印、不校验环境变量（直接执行守卫）', async () => {
  // 子进程 import 成功后自己打个标记再退出。若模块在 import 时 listen 了，进程不会退出
  // （事件循环被监听句柄吊住）→ 走超时分支；若它打印了监听行/读了环境变量，日志就不是这一行。
  const href = pathToFileURL(ENTRY).href;
  const r = await runToExit(
    ['--input-type=module', '-e', `await import(${JSON.stringify(href)}); console.log('imported-ok');`],
    cleanEnv(),
    'import-only',
  );
  assert.notEqual(r.timedOut, true, 'import 后进程没退出——说明 import 时绑了端口');
  assert.equal(r.code, 0, `import 应干净退出，实际 code=${r.code} signal=${r.signal} error=${r.error?.message}`);
  assert.equal(r.text, 'imported-ok\n', 'import 期间不允许有任何输出（含监听行）');
});

test('直接执行：仍按 env.PORT 监听并打印同一行，且不泄露密钥', async () => {
  const p = await freePort();
  const { child, done, read } = spawnLogged(['server/index.mjs'], cleanEnv({
    DEEPSEEK_API_KEY: FAKE_KEY,
    DEEPSEEK_API_BASE: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: 'deepseek-flash',
    PORT: String(p),
  }), 'direct-run');
  try {
    const text = await waitForLog(read, `listening on http://localhost:${p}`, 'direct-run');
    assert.match(text, new RegExp(`^listening on http://localhost:${p}\\s*$`, 'm'), '监听行必须与原来一字不差');
    assert.ok(!text.includes(FAKE_KEY), '密钥绝不能被打印出来');
    const res = await fetch(`http://127.0.0.1:${p}/nope.js`);
    assert.equal(res.status, 404, '直接执行起来的服务要真能应答');
    assert.deepEqual(await res.json(), { error: 'not_found' });
  } finally {
    child.kill('SIGKILL');
    await done;
  }
});

test('直接执行且缺必需变量：仍然 fail-fast（非零退出 + 列全缺项 + 给出启动命令）', async () => {
  const r = await runToExit(['server/index.mjs'], cleanEnv(), 'fail-fast');
  assert.equal(r.code, 1, '缺密钥必须非零退出，而不是绑上端口半路失败');
  assert.match(r.text, /缺少必需的环境变量: DEEPSEEK_API_KEY, DEEPSEEK_API_BASE, DEEPSEEK_MODEL/);
  assert.match(r.text, /node --env-file=\.env server\/index\.mjs/, '启动方式必须写在报错里');
  assert.ok(!/listening on/.test(r.text), 'fail-fast 时不许打印监听行');
});
