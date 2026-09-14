// server/index.mjs
//
// 代理服务：静态托管 `web/` + 两个模型端点（识物已实现，反馈仍是占位）。
//
// 为什么存在这层代理（绑定约束 1）：**密钥绝不进客户端**。浏览器只和本服务说话，
// 密钥由本进程从环境变量持有并注入服务端发起的模型调用。识物于 Task 7 落地
// （模型契约在 `server/recognize-upstream.mjs`）；反馈端点仍明确返回 not_implemented，
// 绝不返回看起来成功的空响应（绑定约束 3：失败不得静默降级为成功）。
//
// 为什么拆成 `createApp()` + 直接执行守卫（Task 5 修复轮）：原先本文件在**顶层**无条件
// `listen()`，于是任何测试都 import 不了它——import 就会绑端口并打印监听行（测试跑不完、
// 挂死），缺密钥时更会直接 `process.exit(1)` 把测试进程带走。现在：
//   · `createApp()` 返回一个**未监听**的 http.Server，路由与生产逐字相同 → 可测（tests/server.test.mjs）；
//   · `import.meta.main` 为真（`node server/index.mjs`）时才 `loadEnv()` + `listen()` + 打印监听行；
//   · 于是 import 本模块**不绑端口、不打印、不读环境变量**，而直接执行的对外行为一字未变。
//
// Task 7 起 `createApp({ env, fetchImpl })` 还接两个**注入点**：`env` 让测试给一套假配置
// （生产仍由 `loadEnv()` 提供），`fetchImpl` 让测试把上游指向本地桩服务——于是路由层可被
// 完整自动测，而不必让测试去打真模型（设计文档 §5.2：真实模型调用不写自动测）。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { recognizeUpstream, UPSTREAM_FAILED, UPSTREAM_INVALID } from './recognize-upstream.mjs';

// web/ 绝对路径。用 fileURLToPath 而非手写路径拼接：Windows 上的 /D:/ 前缀与
// 百分号编码（本仓库路径含中文）都要还原，否则下面的前缀检查会误判。
// 去掉尾部分隔符：下面的前缀检查要求"web 根 + 分隔符"才是自己的地盘
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url)).replace(/[/\\]+$/, '');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * 上传体积上限。端侧一帧是 512px 长边的 JPEG（几十 KB），1 MiB 已是两个数量级的余量，
 * 而它挡住的是"用一个大 body 把内存吃干"这条最省事的远程打法（服务要经隧道挂在公网）。
 */
const MAX_UPLOAD_BYTES = 1024 * 1024;

/**
 * 越界守卫：解析出的绝对路径是否落在 `web/` 之内。
 *
 * 两处都必须判 —— 只写 `startsWith(WEB_ROOT)` 会把同前缀的兄弟目录（`web-evil`）误判成
 * "在 web/ 里"；只写 `=== WEB_ROOT` 则放不过任何文件。web 根本身算"在里"（目录读取会失败成 404）。
 *
 * 导出是为了能直接对谓词做单元测试：URL 解析链（`new URL` 的 WHATWG 归一化 + `normalize`）
 * 已经把 `..` 段折叠掉了，越界输入到不了这条判断，只能单独钉住谓词语义（见 tests/server.test.mjs）。
 */
export function isInsideWebRoot(fullPath) {
  return fullPath === WEB_ROOT || fullPath.startsWith(WEB_ROOT + sep);
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
};

/**
 * request-target → URL 的**唯一**解析入口，解析失败返回 `null`。
 *
 * 为什么必须有这层：`req.url` 完全由对端控制，而 `new URL` 对某些 target 会**抛异常**。
 * 已验证（Node v24.13.0）：`GET // HTTP/1.1` 的 target `//`（空 host）抛
 * `TypeError [ERR_INVALID_URL]`；`///`、`http://` 同样抛。修复前 `serveStatic` 直接
 * `new URL(req.url, 'http://localhost')`，异常从 async listener 逃出去成为 unhandled
 * rejection，Node 默认按 throw 处理 → **整个进程退出（code 1）**，而这条请求还留在
 * 半空中（从未 `res.end`），对端看到的是挂死/ECONNRESET。
 *
 * 这是远程 DoS：Task 6 起本服务要经内网穿透暴露到公网 HTTPS（getUserMedia 要求安全上下文），
 * 任何扫描器一条请求就能打死全部在线用户的服务。所以畸形 target 的结局是 400，不是崩溃。
 *
 * 只抛出型失败返回 `null`——解析成功但语义古怪的 target（如 `/..%2f..%2f.env`）仍走原路，
 * 由既有的越界检查处理，行为一字不变。
 */
function parseTarget(url) {
  try {
    return new URL(url, 'http://localhost');
  } catch {
    return null;
  }
}

/** 畸形 request-target 的统一应答：400，形状与既有 JSON 错误体一致。 */
const badRequest = (res) => json(res, 400, { error: 'bad_request' });

/**
 * 读请求体（Buffer），顺便挡住超大 body。
 *
 * 与拆分前的一处**行为修正**（Task 7）：原来只挂 `req.on('error', reject)` 而调用方是
 * `readBody(req).catch(() => {})`——body 传输中断时连接就半开着挂着、没有任何收尾。
 * 现在中断即 reject，调用方按 400 收尾。超过上限则停止累积并 reject，
 * 不把整个 body 读进内存再判断（服务要挂在公网上，这是最省事的远程打法）。
 */
const readBody = (req, limit = MAX_UPLOAD_BYTES) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let settled = false;
  const fail = (err) => {
    if (settled) return;
    settled = true;
    reject(err);
  };
  req.on('data', (c) => {
    if (settled) return;
    size += c.length;
    if (size > limit) {
      // 不 destroy 连接：让调用方还能把 400 写回去（对端要收到话，而不是一个被掐断的连接）。
      fail(new Error(`请求体过大（> ${limit} 字节）`));
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    resolve(Buffer.concat(chunks));
  });
  req.on('error', (err) => fail(err));
});

/**
 * multipart/form-data → `{ fields, files }` 的最小解析器，只认客户端实际会发的形状：
 * 单个 `boundary` 分界、`Content-Disposition: form-data; name="..."; filename="..."` 头、
 * 头部与内容之间一个空行、首个 `\r\n--boundary` 之前是内容。
 *
 * **刻意保持最小**（不引依赖、不追求 RFC 完备）：本服务对两者的容忍度不同——
 * 解析失败一律响亮退化成"没带图片"（400），而 400 是**安全的**结局。真正的风险不是
 * "解析不了"，而是"解析错了还当成图片送出去"，所以这里宁少不多：拿不准就当没收到。
 *
 * 用 `latin1` 切片而不是 `utf8`：分隔符与头部都是 ASCII，而 `toString('utf8')` 会把内容里的
 * 非法字节变成 U+FFFD——那会给上游送去一张**被改坏**的图（比解析失败更糟）。
 *
 * @param {Buffer} body 原始请求体
 * @param {string} contentType `req.headers['content-type']`（含 boundary）
 * @returns {{ fields: Map<string,string>, files: Map<string,{mime:string, data:Buffer}> }}
 */
export function parseMultipart(body, contentType) {
  const fields = new Map();
  const files = new Map();
  const type = String(contentType ?? '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!m || !/^multipart\/form-data/i.test(type)) return { fields, files };
  const boundary = (m[1] ?? m[2]).trim();
  if (boundary === '') return { fields, files };

  const delim = Buffer.from(`--${boundary}`, 'latin1');
  let pos = body.indexOf(delim);
  if (pos === -1) return { fields, files };
  pos += delim.length;

  while (pos < body.length) {
    // 分隔符后紧跟 `--` 表示结束；否则必须先吃掉 CRLF
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else break;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n', 'latin1'), pos);
    if (headerEnd === -1) break;
    const headers = body.toString('latin1', pos, headerEnd);
    const nextDelim = body.indexOf(delim, headerEnd + 4);
    if (nextDelim === -1) break;
    // 内容到下一个分隔符为止，去掉紧挨着它的那个 CRLF
    let contentEnd = nextDelim;
    if (body[contentEnd - 2] === 0x0d && body[contentEnd - 1] === 0x0a) contentEnd -= 2;
    const data = body.subarray(headerEnd + 4, contentEnd);

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    if (nameMatch) {
      const filenameMatch = /filename="([^"]*)"/i.exec(headers);
      if (filenameMatch) {
        const mime = /content-type:\s*([^\r\n;]+)/i.exec(headers);
        files.set(nameMatch[1], { mime: mime ? mime[1].trim() : '', data });
      } else {
        fields.set(nameMatch[1], data.toString('utf8'));
      }
    }
    pos = nextDelim + delim.length;
  }
  return { fields, files };
}

async function serveStatic(req, res) {
  const url = parseTarget(req.url);
  // 畸形 target 是**客户端的错**，不是 500、更不是崩进程
  if (url === null) return badRequest(res);
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = join(WEB_ROOT, normalize(rel).replace(/^([/\\])+/, ''));
  // 目录穿越属于拒绝，不是 500：web/ 之外的文件一律不给
  if (!isInsideWebRoot(full)) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not_found' });
  }
}

/**
 * `POST /api/recognize`：收一帧，转发给视觉模型，回候选 + 耗时。
 *
 * 三件必须做的事（brief Step 5）：① 上游响应非法即 `{ ok: false, error: 'upstream_invalid' }`；
 * ② 候选最多 3 个（在上游模块里裁）；③ 回 `latency_ms` 供判据计算。
 *
 * 另外两条安全性质：
 *   · 响应里**绝不**出现密钥或上游原文（上游原文只进服务端日志）；
 *   · 任何畸形输入（无图、乱码 body、超大体）都只坏这一个请求，进程继续服务
 *     ——Task 5 已经吃过一次"一条请求换一条命"的亏，不再引入第二个无守卫的解析点。
 */
async function handleRecognize(req, res, { env, fetchImpl, log }) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: 'bad_request', detail: `请求体读取失败：${String(err?.message ?? err)}` });
  }

  let image = null;
  try {
    image = parseMultipart(body, req.headers?.['content-type']).files.get('image') ?? null;
  } catch (err) {
    log(`recognize: multipart 解析失败：${String(err?.stack ?? err)}`);
    return json(res, 400, { error: 'bad_request', detail: '无法解析上传内容' });
  }

  if (image === null || image.data.length === 0) {
    // 没带图就是客户端的问题：400，且说清缺的是什么（不然看起来像"识物失败"）
    return json(res, 400, { error: 'bad_request', detail: '缺少 image 字段（multipart/form-data，字段名 image）' });
  }

  const startedAt = Date.now();
  let result;
  try {
    result = await recognizeUpstream({
      image: image.data,
      // 客户端说是图片就用它的类型，否则按 JPEG（端侧固定产 JPEG）。绝不原样回显客户端给的串。
      mime: /^image\//.test(image.mime) ? image.mime : 'image/jpeg',
      env,
      fetchImpl,
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    // 上游原文只进服务端日志（诊断用），不进响应：响应由对端控制，不给它任何回显面。
    log(`recognize 失败（${String(err?.code ?? 'unknown')}, ${latencyMs}ms）：${String(err?.message ?? err)}`);
    if (err?.code === UPSTREAM_INVALID) {
      return json(res, 502, { ok: false, error: 'upstream_invalid', latency_ms: latencyMs });
    }
    if (err?.code === UPSTREAM_FAILED) {
      return json(res, 502, { ok: false, error: 'upstream_failed', latency_ms: latencyMs });
    }
    // 其余（例如 data URL 超限）如实报出来，不假装成上游的问题
    return json(res, 500, { ok: false, error: 'recognize_failed', latency_ms: latencyMs });
  }

  const latencyMs = Date.now() - startedAt;
  return json(res, 200, {
    ok: true,
    candidates: result.candidates,
    latency_ms: latencyMs,
    // usage 只回三类 token 计数（成本核算只认真实计数，不用估算），不带上游任何原文
    usage: result.usage === null ? null : {
      prompt_tokens: result.usage?.prompt_tokens ?? null,
      completion_tokens: result.usage?.completion_tokens ?? null,
      total_tokens: result.usage?.total_tokens ?? null,
    },
  });
}

/**
 * 请求处理工厂：路由与拆分前逐字相同（`/api/recognize` 由占位变成真实调用）。
 *
 * `log` 是 stderr 写入的注入点：默认写 `process.stderr`，测试可注入收集器断言"走了哪条路径"。
 */
function makeHandler({ env, fetchImpl, log }) {
  return async function handleRequest(req, res) {
    // 路由比较是 `req.url` 与字面量的**字符串相等**，畸形 target 只会不匹配（不解析、不抛异常），
    // 落到最后一行 405——不需要额外守卫。真正解析 target 的只有 serveStatic 一处，已走 parseTarget()。
    try {
      if (req.method === 'POST' && req.url === '/api/recognize') {
        // 密钥只在服务端注入；客户端永远拿不到
        return await handleRecognize(req, res, { env, fetchImpl, log });
      }
      if (req.method === 'POST' && req.url === '/api/feedback') {
        readBody(req).catch(() => {});
        return json(res, 200, { ok: false, error: 'not_implemented_until_task_8' });
      }
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
      return json(res, 405, { error: 'method_not_allowed' });
    } catch (err) {
      // 纵深防御（兜底，不是本次崩溃的修复路径）：本函数是 async listener，任何逃出去的异常
      // 都是 unhandled rejection = 进程退出。具体输入的修复在 parseTarget()；这层保证
      // **将来**新加的代码即使抛了，也只坏这一个请求，不会打死全世界。
      // 打印到 stderr：绝不做"静默吞掉"，否则下一次真故障会没有线索。
      log(`request handler error: ${err?.stack ?? err}`);
      if (!res.headersSent) return badRequest(res);
      try { res.end(); } catch { /* 连响应都发不出去，只能就此打住 */ }
    }
  };
}

/**
 * 造一个**未监听**的服务实例。生产入口与测试用同一个工厂，避免"测的不是跑的那份"。
 *
 * @param {object} [options]
 *   - `env`：模型配置（默认取 `process.env`，与"直接执行"路径一致；测试给一套假配置）
 *   - `fetchImpl`：上游 fetch 注入点（默认全局 `fetch`；测试指向本地桩服务）
 * @returns {import('node:http').Server}
 */
export function createApp({ env = process.env, fetchImpl = fetch } = {}) {
  return createServer(makeHandler({ env, fetchImpl, log: (line) => process.stderr.write(`${line}\n`) }));
}

// 只有直接执行（`node server/index.mjs`）才启动：import 本模块不绑端口、不打印、不读环境变量。
// Node ≥ 24.2 提供 import.meta.main；本仓库运行环境是 Node v24.13.0。
if (import.meta.main) {
  // 启动即校验：缺密钥就让进程非零退出，而不是绑上端口再在半路失败
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  createApp({ env }).listen(env.PORT, () => {
    process.stdout.write(`listening on http://localhost:${env.PORT}\n`);
  });
}
