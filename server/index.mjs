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

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
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
  if (req.method === 'POST' && req.url === '/api/recognize') {
    // 密钥只在服务端注入；客户端永远拿不到
    readBody(req).catch(() => {});
    return json(res, 200, { ok: false, error: 'not_implemented_until_task_8' });
  }
  if (req.method === 'POST' && req.url === '/api/feedback') {
    readBody(req).catch(() => {});
    return json(res, 200, { ok: false, error: 'not_implemented_until_task_8' });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return json(res, 405, { error: 'method_not_allowed' });
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
