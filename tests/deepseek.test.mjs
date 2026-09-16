// tests/deepseek.test.mjs
//
// Task 12A：浏览器直连 DeepSeek 的**共享契约单元**（`web/units/deepseek.mjs`）。
// 项目转向（DEC-…23/26）后，识物与造句两条链路都从「本机服务端代理」改为浏览器直连；
// 直连地址、模型名、视觉细节档、上游信封（choices[0].message.content）的解析是**两条链路
// 共用的契约**，收在这里免得各自漂移。
//
// 移植口径的落定也在这一份里：`units/recognize.mjs` 的提示词与候选截断常量是从
// 识物上游模块整体搬来的（那份模块已随 Task 12C 的 server 退役删除）。
// 原来的 parity 闸（客户端与原版逐字比对）随被比对方一起退役——现在**只剩这一份**契约，
// 它的承重点（严格 JSON、候选形状、上位词禁令、空候选出口）就地钉住，改一个字都会响。
//
// 全部用合成钥匙与假信封，不打真模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_API_BASE, DEEPSEEK_MODEL, VISION_DETAIL, chatUrl, extractContent } from '../web/units/deepseek.mjs';
import { RECOGNIZE_PROMPT, MAX_CANDIDATES } from '../web/units/recognize.mjs';

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

// ─────────────────────── 移植口径落定：唯一一份模型契约就地钉住 ───────────────────────

test('识物提示词的承重点：严格 JSON、候选形状示例、上位词禁令、空候选出口', () => {
  // 原来的 parity 闸（与识物上游原版逐字比对）随 Task 12C 的 server 退役一起撤销；
  // 提示词从此是唯一一份契约，这几条是它"改一个字模型行为就可能变"的承重梁。
  assert.ok(RECOGNIZE_PROMPT.includes('Return STRICT JSON only'), '必须要求严格 JSON（response_format 只是兜底）');
  assert.ok(
    RECOGNIZE_PROMPT.includes('{"candidates":[{"label":"mug","score":0.9,"scene":"kitchen"}]}'),
    '候选形状示例在提示词里（客户端校验器按这个形状判）',
  );
  assert.ok(RECOGNIZE_PROMPT.includes('NEVER a hypernym'), '上位词禁令在提示词里（pickWord 只认具体名词）');
  assert.ok(RECOGNIZE_PROMPT.includes('{"candidates":[]}'), '认不出时的空候选出口在提示词里（不许硬编）');
});

test('候选截断上限：三候选 + 人工重拍（设计 §4.1）', () => {
  assert.equal(MAX_CANDIDATES, 3);
});
