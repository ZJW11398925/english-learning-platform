// tests/deepseek.test.mjs
//
// Task 12A：浏览器直连 DeepSeek 的**共享契约单元**（`web/units/deepseek.mjs`）。
// 项目转向（DEC-…23/26）后，识物与造句两条链路都从「本机服务端代理」改为浏览器直连；
// 直连地址、模型名、视觉细节档、上游信封（choices[0].message.content）的解析是**两条链路
// 共用的契约**，收在这里免得各自漂移。
//
// 另外两块移植口径的 parity 也钉在这里：`units/recognize.mjs` 从
// `server/recognize-upstream.mjs` 移植的提示词与候选截断常量，在 server/ 退役（Task 12C）
// 之前必须与原版**逐字一致**——移植时手抖改了一个词，两边就会各判一套。
//
// 全部用合成钥匙与假信封，不打真模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_API_BASE, DEEPSEEK_MODEL, VISION_DETAIL, chatUrl, extractContent } from '../web/units/deepseek.mjs';
import { RECOGNIZE_PROMPT, MAX_CANDIDATES } from '../web/units/recognize.mjs';
import {
  RECOGNIZE_PROMPT as SERVER_RECOGNIZE_PROMPT,
  MAX_CANDIDATES as SERVER_MAX_CANDIDATES,
} from '../server/recognize-upstream.mjs';

// ───────────────────────────── 直连地址与常量口径 ─────────────────────────────

test('chatUrl 默认拼出转向契约里写死的直连地址（/v1/chat/completions）', () => {
  assert.equal(chatUrl(), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(DEEPSEEK_API_BASE, 'https://api.deepseek.com/v1', '缺省 base 带 /v1');
});

test('chatUrl 去掉注入 base 的尾部斜杠（不产生双斜杠——有些网关对 // 很认真）', () => {
  assert.equal(chatUrl('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.equal(chatUrl('https://example.com/v1///'), 'https://example.com/v1/chat/completions');
});

test('模型与视觉细节档：deepseek-flash + detail low（与 .env.example / 设计 §4.6 同源）', () => {
  assert.equal(DEEPSEEK_MODEL, 'deepseek-flash', '识物这条腿必须用支持 Vision 的模型（v4-pro 不支持）');
  assert.equal(VISION_DETAIL, 'low', 'low 缩到 512×512，与端侧 512px 长边一致');
});

// ───────────────────────────── 上游信封解析 ─────────────────────────────

test('extractContent：正常信封取出 choices[0].message.content 的字符串', () => {
  assert.equal(extractContent({ choices: [{ message: { content: '{"a":1}' } }] }), '{"a":1}');
});

test('extractContent：信封不合法（缺 choices / 空 choices / content 非字符串 / 纯空白）→ null', () => {
  for (const bad of [
    undefined, null, {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: 42 } }] },
    { choices: [{ message: { content: '   ' } }] },
  ]) {
    assert.equal(extractContent(bad), null, `${JSON.stringify(bad)} 不是能用的信封`);
  }
});

// ─────────────────────── 移植口径 parity：与 server 原版逐字一致 ───────────────────────

test('客户端移植的识物提示词与 server 原版逐字一致（server 退役前的 parity 闸）', () => {
  assert.equal(RECOGNIZE_PROMPT, SERVER_RECOGNIZE_PROMPT, '提示词是模型契约：移植时一个字都不许改');
});

test('客户端移植的候选截断上限与 server 原版一致（三候选 + 人工重拍，设计 §4.1）', () => {
  assert.equal(MAX_CANDIDATES, SERVER_MAX_CANDIDATES);
  assert.equal(MAX_CANDIDATES, 3);
});
