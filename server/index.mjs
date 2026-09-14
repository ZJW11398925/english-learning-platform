// server/index.mjs
//
// 代理服务骨架：静态托管 `web/` + 两个模型端点占位。
//
// 为什么存在这层代理（绑定约束 1）：**密钥绝不进客户端**。浏览器只和本服务说话，
// 密钥由本进程从环境变量持有并注入服务端发起的模型调用。模型调用本身在 Task 8 落地；
// 这里两个端点明确返回 not_implemented，绝不返回看起来成功的空响应
// （绑定约束 3：失败不得静默降级为成功）。
//
// 为什么拆成 `createApp()` + 直接执行守卫（Task 5 修复轮）：原先本文件在**顶层**无条件
// `listen()`，于是任何测试都 import 不了它——import 就会绑端口并打印监听行（测试跑不完、
// 挂死），缺密钥时更会直接 `process.exit(1)` 把测试进程带走。现在：
//   · `createApp()` 返回一个**未监听**的 http.Server，路由与生产逐字相同 → 可测（tests/server.test.mjs）；
//   · `import.meta.main` 为真（`node server/index.mjs`）时才 `loadEnv()` + `listen()` + 打印监听行；
//   · 于是 import 本模块**不绑端口、不打印、不读环境变量**，而直接执行的对外行为一字未变。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

// web/ 绝对路径。用 fileURLToPath 而非手写路径拼接：Windows 上的 /D:/ 前缀与
// 百分号编码（本仓库路径含中文）都要还原，否则下面的前缀检查会误判。
// 去掉尾部分隔符：下面的前缀检查要求"web 根 + 分隔符"才是自己的地盘
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url)).replace(/[/\\]+$/, '');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

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

/** 请求处理：路由与拆分前逐字相同。 */
async function handleRequest(req, res) {
  // 路由比较是 `req.url` 与字面量的**字符串相等**，畸形 target 只会不匹配（不解析、不抛异常），
  // 落到最后一行 405——不需要额外守卫。真正解析 target 的只有 serveStatic 一处，已走 parseTarget()。
  try {
    if (req.method === 'POST' && req.url === '/api/recognize') {
      // 密钥只在服务端注入；客户端永远拿不到
      readBody(req).catch(() => {});
      return json(res, 200, { ok: false, error: 'not_implemented_until_task_8' });
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
    process.stderr.write(`request handler error: ${err?.stack ?? err}\n`);
    if (!res.headersSent) return badRequest(res);
    try { res.end(); } catch { /* 连响应都发不出去了，只能就此打住 */ }
  }
}

/** 造一个**未监听**的服务实例。生产入口与测试用同一个工厂，避免"测的不是跑的那份"。 */
export function createApp() {
  return createServer(handleRequest);
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

  createApp().listen(env.PORT, () => {
    process.stdout.write(`listening on http://localhost:${env.PORT}\n`);
  });
}
