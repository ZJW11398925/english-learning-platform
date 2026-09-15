/**
 * 本机 HTTPS 服务器（自签证书）——**只为真机测试**，不依赖任何第三方隧道。
 *
 * 为什么需要它：手机浏览器只在**安全上下文**（`https://` 或 `localhost`）下放行
 * `getUserMedia`。隧道方案在本机环境全不可用：
 *   · Cloudflare：本线路到其接口固有延迟约 6 秒，超过 cloudflared 内部约 5 秒超时；
 *   · ngrok：把"代理下运行"列为付费功能，而本机有 monocloud 系统代理（ERR_NGROK_9009）；
 *   · localtunnel：可用但需在手机端过认证页，且会自动断线。
 * 因此改为**手机直连局域网**：本机自签一张证书，手机装一次即可长期使用。
 *
 * 与生产的关系：路由、静态服务、安全边界、**超时**全部复用 `createApp()`。
 * 本文件只做一件事：把 `https.createServer` 作为服务器工厂传进去。
 * 所以在这里测到的行为，与 `node server/index.mjs` 起的那份同源。
 *
 * 用法：
 *   node --env-file=.env server/https-local.mjs
 * 手机访问：https://<本机局域网 IP>:8443
 *
 * 证书：`.certs/server.crt` + `.certs/server.key`（openssl 自签，SAN 含本机 IP）。
 * `.certs/` 已在 .gitignore 中排除——私钥绝不入库。
 */
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createApp } from './index.mjs';
import { loadEnv } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CERT_DIR = join(HERE, '..', '.certs');

/** HTTPS 专用端口：默认 8443，避开 8787（那份 http 服务通常还开着）。 */
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 8443);

let env;
try {
  env = loadEnv();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}

let tls;
try {
  tls = {
    cert: readFileSync(join(CERT_DIR, 'server.crt')),
    key: readFileSync(join(CERT_DIR, 'server.key')),
  };
} catch {
  process.stderr.write(
    `读不到证书（${CERT_DIR}）。先生成一张自签证书，见 docs/真机验证清单.md 的"直连局域网"一节。\n`,
  );
  process.exit(1);
}

/** 列出本机的局域网 IPv4，直接告诉用户手机上该输哪个地址（省掉 ipconfig 一步）。 */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) {
        out.push({ name, address: a.address });
      }
    }
  }
  return out;
}

const app = createApp({ env, createServerImpl: createHttpsServer, serverOptions: tls });

app.listen(HTTPS_PORT, '0.0.0.0', () => {
  process.stdout.write(`HTTPS 已启动，监听 0.0.0.0:${HTTPS_PORT}\n`);
  for (const { name, address } of lanAddresses()) {
    process.stdout.write(`  手机可访问（${name}）: https://${address}:${HTTPS_PORT}\n`);
  }
  process.stdout.write(`  本机自测: https://localhost:${HTTPS_PORT}\n`);
  process.stdout.write('  首次访问会提示证书不受信任——正常（自签证书）。装过证书后即消失。\n');
});
