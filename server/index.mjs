// server/index.mjs
//
// 代理服务骨架：静态托管 `web/` + 两个模型端点占位。
//
// 为什么存在这层代理（绑定约束 1）：**密钥绝不进客户端**。浏览器只和本服务说话，
// 密钥由本进程从环境变量持有并注入服务端发起的模型调用。模型调用本身在 Task 8 落地；
// 这里两个端点明确返回 not_implemented，绝不返回看起来成功的空响应
// （绑定约束 3：失败不得静默降级为成功）。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

// 启动即校验：缺密钥就让进程非零退出，而不是绑上端口再在半路失败
let env;
try {
  env = loadEnv();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}

// web/ 绝对路径。用 fileURLToPath 而非手写路径拼接：Windows 上的 /D:/ 前缀与
// 百分号编码（本仓库路径含中文）都要还原，否则下面的前缀检查会误判。
// 去掉尾部分隔符：下面的前缀检查要求"web 根 + 分隔符"才是自己的地盘
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url)).replace(/[/\\]+$/, '');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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
  if (full !== WEB_ROOT && !full.startsWith(WEB_ROOT + sep)) {
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

const server = createServer(async (req, res) => {
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
});

server.listen(env.PORT, () => {
  process.stdout.write(`listening on http://localhost:${env.PORT}\n`);
});
