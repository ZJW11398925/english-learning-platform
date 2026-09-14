import { test } from 'node:test';
import assert from 'node:assert/strict';
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
