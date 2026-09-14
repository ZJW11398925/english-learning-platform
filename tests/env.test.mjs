import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from '../server/env.mjs';

const full = {
  DEEPSEEK_API_KEY: 'k1', DEEPSEEK_API_BASE: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-flash', PORT: '8787',
};

test('齐全时解析成功并将 PORT 转成数字', () => {
  const env = loadEnv(full);
  assert.equal(env.PORT, 8787);
  assert.equal(env.DEEPSEEK_API_KEY, 'k1');
  assert.equal(env.DEEPSEEK_MODEL, 'deepseek-flash');
});

test('VISION_DETAIL 可选，缺省为 low（512x512 档，与设计文档图片规格一致）', () => {
  assert.equal(loadEnv(full).VISION_DETAIL, 'low');
  assert.equal(loadEnv({ ...full, VISION_DETAIL: 'high' }).VISION_DETAIL, 'high');
});

test('缺任一项必需变量则抛错，并逐一列出缺失项', () => {
  const { DEEPSEEK_MODEL, ...missing } = full;
  assert.throws(() => loadEnv(missing), /DEEPSEEK_MODEL/);
});

test('PORT 缺省为 8787', () => {
  const { PORT, ...noPort } = full;
  assert.equal(loadEnv(noPort).PORT, 8787);
});

test('空字符串等同于缺失（防止 .env 里留空键）', () => {
  assert.throws(() => loadEnv({ ...full, DEEPSEEK_API_KEY: '' }), /DEEPSEEK_API_KEY/);
});

// ── Task 5 修复轮：下面 4 条钉住"改回实现后测试仍然全绿"的三处（实测见 mutation-probe 的 N1–N3）──

test('PORT 必须是正整数：abc / 0 / -1 / 8.5 一律抛错（不让非法 PORT 静默变成 NaN 去 listen）', () => {
  for (const bad of ['abc', '0', '-1', '8.5']) {
    assert.throws(() => loadEnv({ ...full, PORT: bad }), /PORT 非法/, `PORT=${bad} 应被拒绝`);
  }
});

test('PORT 传数字（不是字符串）走同一契约：正整数放行，其余一律抛错', () => {
  // 契约（写在 server/env.mjs 的注释里）：PORT 可以是字符串或数字，经 Number() 后用
  // "正整数"一条尺子裁；返回值里的 PORT 始终是 number。
  const env = loadEnv({ ...full, PORT: 8787 });
  assert.equal(env.PORT, 8787);
  assert.equal(typeof env.PORT, 'number', 'PORT 在返回契约里必须是数字');
  assert.equal(loadEnv({ ...full, PORT: 1 }).PORT, 1);
  for (const bad of [0, -1, 8.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => loadEnv({ ...full, PORT: bad }), /PORT 非法/, `PORT=${String(bad)} 应被拒绝`);
  }
});

test('String() 强制转换：注入非字符串的必需项/VISION_DETAIL 时，返回值仍然是字符串', () => {
  // 真跑时 process.env 的值都是字符串；这条管的是**注入 source** 这条被本函数设计支持的用法
  // （可单测就是靠它）。返回值的形状必须稳定：拿一个 number 回去，下游拼 URL / trim 会静默变形。
  const env = loadEnv({ ...full, DEEPSEEK_API_KEY: 42, VISION_DETAIL: 7 });
  assert.equal(env.DEEPSEEK_API_KEY, '42');
  assert.equal(typeof env.DEEPSEEK_API_KEY, 'string');
  assert.equal(env.VISION_DETAIL, '7');
  assert.equal(typeof env.VISION_DETAIL, 'string');
});

test('缺变量时的报错信息必须包含正确启动命令（否则读者分不清"密钥没填"和".env 没加载"）', () => {
  const { DEEPSEEK_MODEL, ...missing } = full;
  assert.throws(() => loadEnv(missing), (err) => {
    assert.match(err.message, /DEEPSEEK_MODEL/, '缺哪个变量要一并列出来');
    assert.match(
      err.message,
      /node --env-file=\.env server\/index\.mjs/,
      '还要给出正确的启动方式——措辞可以变，这条命令必须在',
    );
    return true;
  });
});

test('loadEnv 不读文件系统：在"只允许读 env.mjs 本身"的权限模型下照样跑完', async () => {
  // 约束：`.env` 由 Node 运行时用 `--env-file` 加载，env.mjs **不许自己解析文件**。
  // 这条原先只是"看代码没 import fs"的推断——变异探针也验不了它（见 task-5-report.md §6 M-B：
  // 变异体没真改动源码，catch {} 吞掉了 ReferenceError，结论已作废）。
  // 这里用 Node 权限模型做**正面验证**：子进程只被允许读 env.mjs 这一个文件，它若去读 .env 或
  // 任何别的路径，都会 ERR_ACCESS_DENIED 当场失败（对照组见 task-5-report.md 修复轮 §3）。
  const envPath = fileURLToPath(new URL('../server/env.mjs', import.meta.url));
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'task5-env-nofs-'));
  const logPath = join(tmp, 'child.log');
  const fd = fs.openSync(logPath, 'w');
  const code = `
    const { loadEnv } = await import(${JSON.stringify(pathToFileURL(envPath).href)});
    const env = loadEnv({ DEEPSEEK_API_KEY: 'k', DEEPSEEK_API_BASE: 'b', DEEPSEEK_MODEL: 'm' });
    console.log('loadEnv-ok ' + env.PORT + ' ' + env.VISION_DETAIL);
  `;
  try {
    const child = spawn(
      process.execPath,
      ['--permission', `--allow-fs-read=${envPath}`, '--input-type=module', '-e', code],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', fd, fd] },
    );
    const { exitCode } = await new Promise((resolve) => child.on('exit', (c) => resolve({ exitCode: c })));
    fs.closeSync(fd);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.equal(exitCode, 0, `子进程失败（若含 ERR_ACCESS_DENIED 就说明 loadEnv 读了文件）：${log}`);
    assert.equal(log, 'loadEnv-ok 8787 low\n');
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
