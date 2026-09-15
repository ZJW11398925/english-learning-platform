/**
 * 生成本机开发用的自签证书（HTTPS 本机测试用）。
 *
 * 为什么需要脚本而不是一张写死的证书：本机局域网 IP 会变（DHCP 重新分配），
 * 而证书的 `subjectAltName` 必须包含你**当前**要访问的那个地址，否则手机浏览器
 * 会报"证书名称不匹配"。写死 IP 的证书在 IP 一变就失效——实测发生过一次
 * （10.68.199.114 → 10.72.77.185）。所以这里每次自动探测当前所有局域网 IPv4。
 *
 * 用法：node scripts/make-local-cert.mjs
 * 产物：.certs/server.crt（证书）+ .certs/server.key（私钥）+ .certs/手机要装的证书.crt（副本）
 * `.certs/` 在 .gitignore 里，私钥绝不入库。
 */
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = join(ROOT, '.certs');
const OPENSSL_CANDIDATES = [
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\bin\\openssl.exe',
  'openssl',
];

function findOpenssl() {
  for (const candidate of OPENSSL_CANDIDATES) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // 继续试下一个
    }
  }
  throw new Error('找不到 openssl。装了 Git for Windows 即自带（Program Files\\Git\\usr\\bin\\openssl.exe）。');
}

/** 当前所有可用于访问的地址：局域网 IPv4 + 回环 + localhost。 */
function collectAddresses() {
  const ips = new Set(['127.0.0.1']);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) ips.add(a.address);
    }
  }
  return [...ips];
}

const openssl = findOpenssl();
if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true });

const ips = collectAddresses();
const alt = [
  ...ips.map((ip, i) => `IP.${i + 1} = ${ip}`),
  'DNS.1 = localhost',
].join('\n');

const cnf = `[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = local dev (English learning app)
O  = local dev
C  = CN

[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyCertSign,cRLSign
extendedKeyUsage = serverAuth
subjectAltName = @alt

[alt]
${alt}
`;

const cnfPath = join(CERT_DIR, 'openssl.cnf');
const crtPath = join(CERT_DIR, 'server.crt');
const keyPath = join(CERT_DIR, 'server.key');
writeFileSync(cnfPath, cnf, 'utf8');

const common = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', crtPath, '-days', '825',
  '-config', cnfPath, '-extensions', 'v3_ca'];

try {
  execFileSync(openssl, common, { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (err) {
  process.stderr.write(`生成失败：${err?.stderr?.toString() ?? err.message}\n`);
  process.exit(1);
}

// 给手机安装用的副本（名字用中文，方便在手机文件列表里认出来）
const mobileCopy = join(CERT_DIR, '手机要装的证书.crt');
copyFileSync(crtPath, mobileCopy);

// 自检：把 SAN 读回来，确认当前 IP 真的在里面（不靠假设）
const san = execFileSync(openssl, ['x509', '-in', crtPath, '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' });
process.stdout.write('证书已生成。\n');
process.stdout.write(san.trim() + '\n');
const missing = ips.filter((ip) => !san.includes(ip));
if (missing.length > 0) {
  process.stderr.write(`⚠️ 这些地址没进 SAN（异常）：${missing.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`\n覆盖地址：${ips.join(', ')}\n`);
process.stdout.write('手机要装的证书：.certs/手机要装的证书.crt\n');
process.stdout.write('把证书传进手机：见 docs/真机验证清单.md 第 3.5 步。\n');

// 顺手删掉可能存在的旧副本名（避免用户装错文件）
const legacy = join(CERT_DIR, '手机要装的证书.crt.tmp');
if (existsSync(legacy)) unlinkSync(legacy);
