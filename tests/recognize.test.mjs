// tests/recognize.test.mjs
//
// Task 7 的客户端识物单元；Task 12A 起传输层改为**浏览器直连** DeepSeek
// （项目转向 DEC-…23/26：服务端代理退役）。本文件钉住的契约分两半：
//   · **直连契约**（12A 新）：请求打到 `https://api.deepseek.com/v1/chat/completions`、
//     `Authorization: Bearer <访问者自己的 Key>`、提示词与候选校验移植自识物上游模块
//     （那份已随 Task 12C 的 server 退役；client 端就是最后一道校验口）；
//   · **取词行为契约**（Task 7 原样保留）：判帧只有一处起源、attempts 口径、绝不假造词、
//     失败 reason 分档、超时闸。
//
// `latencyMs` 的口径在 12A **有意变化**（代码注释同步写明）：旧口径是"服务端自报的
// 处理耗时"（响应信封 latency_ms）；直连后没有服务端了，新口径是**客户端
// performance.now() 实测**"取到词那一次"的耗时（从发出请求到解出可用候选，含网络往返）。
// 时钟不可用时如实 null——"不发明"的红线不变。
//
// 本模块保持"纯逻辑"：不 import 任何浏览器 API，`fetch` / `grab` / 时钟都是注入点。
// 全部用合成钥匙（sk-test-…）与注入的假 fetch，不打真模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import {
  recognize, recognizeWithFallback, RECOGNIZE_FAIL_REASONS, MANUAL_PICK_SCENE_WORDS,
  RECOGNIZE_REQUEST_TIMEOUT_MS, RECOGNIZE_PROMPT, MAX_CANDIDATES,
} from '../web/units/recognize.mjs';
import { DEEPSEEK_API_BASE, chatUrl } from '../web/units/deepseek.mjs';
// 只用于"桩上游会不会无限挂住"的护栏（真 HTTP 用例的看门狗）。
import { settlesWithin } from './helpers/watchdog.mjs';

/** 合成钥匙：形状合法、值是假的（仓库里只允许这种）。 */
const SYNTHETIC_KEY = 'sk-test-recognize-000000000000';
const KEY = { apiKey: SYNTHETIC_KEY };

const OK_CANDIDATES = [{ label: 'mug', score: 0.9, scene: 'kitchen' }];
/** 把候选包进上游信封（OpenAI 形状：choices[0].message.content 里是严格 JSON）。 */
const envelopeOf = (candidates) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] }),
});
const okFetch = async () => envelopeOf(OK_CANDIDATES);
const failFetch = async () => ({ ok: false, status: 502, json: async () => ({}), text: async () => '' });
const OK_STATS = { brightness: 128, laplacianVar: 200 };
const goodGrab = async () => ({ blob: new Blob(['x']), stats: OK_STATS });
/** 候选命中了可接受集之外的东西（模型答的是上位词/别的物体）。 */
const offSetFetch = async () => envelopeOf([{ label: 'container', score: 0.95, scene: 'kitchen' }]);

// ─────────────────────────── 直连契约：请求打到哪儿、带什么 ───────────────────────────

test('直连契约：POST 到 /v1/chat/completions，带 Bearer Key，视觉消息与 JSON 模式都在请求体里', async () => {
  const seen = [];
  const spyFetch = async (url, init) => {
    seen.push({ url, init });
    return okFetch();
  };
  await recognize(new Blob(['x']), { fetchImpl: spyFetch, ...KEY });
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions', '转向契约写死的直连地址');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${SYNTHETIC_KEY}`,
    '直连后 Key 由访问者提供、随请求头发给模型服务——不再有服务端替我们注入');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal, '客户端 fetch 必须带 signal（超时闸）');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'deepseek-flash', '识物必须用支持 Vision 的模型');
  assert.deepEqual(body.response_format, { type: 'json_object' }, 'JSON 模式兜底"必须返回严格 JSON"');
  assert.equal(body.temperature, 0.1, '低温度：这一档要的是"看清是什么"，不是发挥');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user', '图片必须在 user message 的 content 数组里（system/assistant 会 400）');
  const [textPart, imagePart] = body.messages[0].content;
  assert.equal(textPart.type, 'text');
  assert.equal(textPart.text, RECOGNIZE_PROMPT, '提示词就是模块导出的那一份契约');
  assert.equal(imagePart.type, 'image_url');
  assert.match(imagePart.image_url.url, /^data:image\/jpeg;base64,/, '帧以 base64 data URL 上行');
  assert.equal(imagePart.image_url.detail, 'low', 'detail low：缩到 512×512，与端侧长边一致');
});

test('提示词要求严格 JSON、三候选、具体名词（移植口径的行为面抽查）', () => {
  assert.match(RECOGNIZE_PROMPT, /STRICT JSON/);
  assert.match(RECOGNIZE_PROMPT, /1 to 3 candidates/);
  assert.match(RECOGNIZE_PROMPT, /NEVER a hypernym/, '上位词禁令必须还在（pickWord 只认具体名词）');
  assert.equal(MAX_CANDIDATES, 3);
});

// ─────────────────────────── 响应解析（移植自 server 的校验口径）───────────────────────────

test('recognize 把直连响应里的候选解出来返回（原样，不选词——选词是 pickWord 的事）', async () => {
  const r = await recognize(new Blob(['x']), { fetchImpl: okFetch, ...KEY });
  assert.equal(r.candidates[0].label, 'mug');
  assert.equal(r.candidates[0].scene, 'kitchen');
});

test('score / scene 缺失时归 null，**绝不编 0**（移植 normalizeCandidate）', async () => {
  const r = await recognize(new Blob(['x']), {
    fetchImpl: async () => envelopeOf([{ label: 'mug' }]), ...KEY,
  });
  assert.deepEqual(r.candidates[0], { label: 'mug', score: null, scene: null },
    '服务端时代的口径原样搬到客户端：缺数就是 null，不发明');
});

test('候选超出上限时截到 3 条（设计 §4.1「三候选 + 人工重拍」，移植口径）', async () => {
  const r = await recognize(new Blob(['x']), {
    fetchImpl: async () => envelopeOf([
      { label: 'mug' }, { label: 'cup' }, { label: 'bowl' }, { label: 'kettle' },
    ]), ...KEY,
  });
  assert.deepEqual(r.candidates.map((c) => c.label), ['mug', 'cup', 'bowl']);
});

test('任意一条候选连 label 都给不出来 → 整份判非法（绝不静默剔掉坏条目）', async () => {
  for (const bad of ['  ', 42, null, {}, { label: '' }]) {
    await assert.rejects(
      () => recognize(new Blob(['x']), {
        fetchImpl: async () => envelopeOf([{ label: 'mug' }, bad]), ...KEY,
      }),
      (err) => err.code === RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID,
      `候选 ${JSON.stringify(bad)} 缺 label → 整份非法（把"模型吐了垃圾"说成"模型很确定"是伪造）`,
    );
  }
});

test('content 不是合法 JSON（模型吐了散文）→ 如实失败，绝不"从文本里抠一个词"当成功', async () => {
  await assert.rejects(
    () => recognize(new Blob(['x']), {
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '我觉得这是一个杯子。' } }] }) }),
      ...KEY,
    }),
    (err) => err.code === RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID,
  );
});

test('信封不合法（缺 content / content 纯空白）→ response_invalid，与"请求失败"分开', async () => {
  for (const bad of [{ choices: [] }, { choices: [{ message: { content: '  ' } }] }, {}]) {
    await assert.rejects(
      () => recognize(new Blob(['x']), {
        fetchImpl: async () => ({ ok: true, json: async () => bad }), ...KEY,
      }),
      (err) => err.code === RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID,
    );
  }
});

test('content 是 JSON 但没有 candidates 数组 → response_invalid', async () => {
  await assert.rejects(
    () => recognize(new Blob(['x']), {
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"nope":1}' } }] }) }),
      ...KEY,
    }),
    (err) => err.code === RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID,
  );
});

// ─────────────────────── latencyMs：口径在 12A 有意变化（客户端实测）───────────────────────

test('latencyMs 是客户端实测耗时（注入时钟 100→250 → 150）：从发请求到解出可用候选', async () => {
  let t = 0;
  const ticks = [100, 250];
  const clock = () => ticks[Math.min(t++, ticks.length - 1)];
  const r = await recognize(new Blob(['x']), { fetchImpl: okFetch, nowImpl: clock, ...KEY });
  assert.equal(r.latencyMs, 150, '直连后这个数就是客户端 performance.now() 的实测口径');
});

test('两次尝试时 latencyMs 是取到词那一次的实测值（不把两次相加，也不是第一次失败的耗时）', async () => {
  // 第一次尝试 0→10（空候选落空），第二次 100→160（取到词）→ 应带 60。
  // 判据 A 的 p95 问的是"用户等这一轮等了多久"，而这一轮终止于第一次成功。
  let t = 0;
  const ticks = [0, 10, 100, 160];
  const clock = () => ticks[Math.min(t++, ticks.length - 1)];
  let call = 0;
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: async () => {
      call += 1;
      return envelopeOf(call === 1 ? [] : [{ label: 'mug', score: 0.9, scene: 'kitchen' }]);
    },
    nowImpl: clock, ...KEY,
  });
  assert.equal(r.attempts, 2);
  assert.equal(r.latencyMs, 60, '60 = 成功那次（100→160），不是 170（两次之和）也不是 10（第一次）');
});

test('时钟不可用（读数不是有限数）→ latencyMs 如实 null，**绝不补 0**', async () => {
  // 0 是"合法且极好"的读数，用它代替"不知道"会让 latency_p95 看起来完美——
  // 这条"不发明"的红线从服务端时代原样延续到直连时代。
  const r = await recognize(new Blob(['x']), {
    fetchImpl: okFetch, nowImpl: () => Number.NaN, ...KEY,
  });
  assert.equal(r.latencyMs, null);
  assert.notEqual(r.latencyMs, 0);
});

// ─────────────────────────── 失败降级：401 / 429 / 网络错 ───────────────────────────

test('HTTP 失败时抛出，不返回空候选冒充成功', async () => {
  await assert.rejects(() => recognize(new Blob(['x']), { fetchImpl: failFetch, ...KEY }), /502/);
});

test('401（Key 无效）单独归 auth_failed，消息引导回设置页——Key 是访问者自己的，得告诉他去修', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' }),
    ...KEY,
  });
  assert.equal(r.mode, 'manual', 'Key 无效时两轮都救不回来，如实降级');
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.AUTH_FAILED);
  assert.equal(r.reason, 'auth_failed');
  assert.match(r.detail, /设置|Key/, '降级文案要指向设置入口（这是访问者自己能修的一档）');
  await assert.rejects(
    () => recognize(new Blob(['x']), {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' }), ...KEY,
    }),
    (err) => err.code === 'auth_failed' && /401/.test(String(err.message)),
  );
});

test('429（请求太频繁）单独归 rate_limited——处置是"稍等再试"，与"契约不对"和"断网"都不同', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' }),
    ...KEY,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.RATE_LIMITED);
  assert.equal(r.reason, 'rate_limited');
});

test('其他非 2xx（500 等）仍归 request_failed（带状态码的普通请求失败）', async () => {
  await assert.rejects(
    () => recognize(new Blob(['x']), {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }), ...KEY,
    }),
    (err) => err.code === RECOGNIZE_FAIL_REASONS.REQUEST_FAILED && /500/.test(String(err.message)),
  );
});

test('无 Key：recognize 在发请求**之前**就响亮失败（auth_failed），一个请求都不发', async () => {
  let calls = 0;
  await assert.rejects(
    () => recognize(new Blob(['x']), {
      fetchImpl: async () => { calls += 1; return okFetch(); },
    }),
    (err) => err.code === RECOGNIZE_FAIL_REASONS.AUTH_FAILED && /设置|Key/.test(String(err.message)),
  );
  assert.equal(calls, 0, '没有 Key 的请求必然 401，白花一次往返——当场拦下');
  for (const bad of [undefined, null, '', '   ']) {
    await assert.rejects(
      () => recognize(new Blob(['x']), { fetchImpl: okFetch, apiKey: bad }),
      (err) => err.code === RECOGNIZE_FAIL_REASONS.AUTH_FAILED,
    );
  }
});

// ─────────────────────────── 取词行为（Task 7 的契约原样保留）───────────────────────────

test('第一次成功即返回 mode=ok，attempts=1', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug', 'cup'], kettle: ['kettle'] }, exclude: [],
    fetchImpl: okFetch, ...KEY,
  });
  assert.equal(r.mode, 'ok');
  assert.equal(r.word, 'mug');
  assert.equal(r.attempts, 1);
});

test('第 2 次尝试仍失败则退到 mode=manual，绝不假造一个词', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: failFetch, ...KEY,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(r.word, null);
  assert.equal(r.attempts, 2);
});

test('无 Key 时 recognizeWithFallback 在取帧**之前**就降级：attempts=0、不取帧、不发请求', async () => {
  let grabs = 0;
  let calls = 0;
  const r = await recognizeWithFallback({
    grab: async () => { grabs += 1; return { blob: new Blob(['x']), stats: OK_STATS }; },
    acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: async () => { calls += 1; return okFetch(); },
  });
  assert.equal(r.mode, 'manual');
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.AUTH_FAILED, '无 Key 是 auth_failed，不是"没认出来"');
  assert.equal(r.attempts, 0, '一个请求都没发——"真的问过模型几次"的口径不许虚记');
  assert.equal(grabs, 0, '没有 Key 连帧都不必取');
  assert.equal(calls, 0);
});

test('帧质检不通过时不发请求，直接要求重拍（省调用也省延迟）', async () => {
  let calls = 0;
  const r = await recognizeWithFallback({
    grab: async () => ({ blob: new Blob(['x']), stats: { brightness: 10, laplacianVar: 10 } }),
    acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: async () => { calls += 1; return okFetch(); }, ...KEY,
  });
  assert.equal(r.mode, 'frame_rejected');
  assert.equal(calls, 0, '太暗的帧不应触发任何模型调用');
  // 被 R4 变异体钉住的口径：attempts 是"真的问过模型几次"——被端侧拦下的帧一次都没问，
  // 记成 1 会把"按了几次快门"混进调用成本与 retry_rate 的输入里。
  assert.equal(r.attempts, 0, '被拒的帧不消耗尝试次数');
});

test('帧被拒时 candidates 是空数组而不是 undefined（调用方不必区分两种"没有"）', async () => {
  const r = await recognizeWithFallback({
    grab: async () => ({ blob: new Blob(['x']), stats: { brightness: 10, laplacianVar: 10 } }),
    acceptableSets: { mug: ['mug'] }, exclude: [], fetchImpl: okFetch, ...KEY,
  });
  assert.deepEqual(r.candidates, []);
});

test('manual 档的每一次落空都不许把模型候选塞进 word（假造词的唯一入口）', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug', 'cup'], kettle: ['kettle'] }, exclude: [],
    fetchImpl: offSetFetch, ...KEY,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(r.word, null, 'manual 档必须 word === null——绝不退而求其次显示上位词');
  assert.equal(r.attempts, 2, '两次都可能命中，故两次都要真的问过模型');
});

test('落空但响应里有候选时，candidates 如实带出来（诊断/统计用），不等于 word', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [], fetchImpl: offSetFetch, ...KEY,
  });
  assert.deepEqual(r.candidates.map((c) => c.label), ['container'], '最后一次拿到的候选要如实带出');
  assert.equal(r.word, null, '带出候选 ≠ 选中候选');
});

test('帧质检只做一次：判一次就够，绝不因为要"重试一次请求"而重复判帧', async () => {
  const real = await import('../web/units/frame-qc.mjs');
  let judged = 0;
  const countingQC = {
    judgeFrame(stats) { judged += 1; return real.judgeFrame(stats); },
  };
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [], fetchImpl: failFetch, frameQC: countingQC, ...KEY,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(judged, 1, `两次尝试共用一帧，判帧只应发生 1 次（实测 ${judged} 次）`);
});

test('一帧只取一次：两次尝试针对同一帧，不重新按一次快门（不做隐式连拍）', async () => {
  let grabs = 0;
  const r = await recognizeWithFallback({
    grab: async () => { grabs += 1; return { blob: new Blob(['x']), stats: OK_STATS }; },
    acceptableSets: { mug: ['mug'] }, exclude: [], fetchImpl: failFetch, ...KEY,
  });
  assert.equal(r.attempts, 2);
  assert.equal(grabs, 1, `一次快门只取一帧（实测取了 ${grabs} 帧）——多取就是自动连拍`);
});

// ───────────────────── 追加 2：把「配置问题」与「识别失败」分开记录 ─────────────────────

test('reason 区分：候选一个都不在可接受集里 → not_in_acceptable_set（内容配置问题）', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug', 'cup'], kettle: ['kettle'] }, exclude: [],
    fetchImpl: offSetFetch, ...KEY,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
  assert.equal(r.reason, 'not_in_acceptable_set');
});

test('reason 区分：命中的候选全被 exclude 掉 → all_matched_excluded（与配置问题分开）', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug', 'cup'], kettle: ['kettle'] }, exclude: ['mug'],
    fetchImpl: okFetch, ...KEY,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.ALL_MATCHED_EXCLUDED);
  assert.equal(r.reason, 'all_matched_excluded');
  assert.notEqual(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
});

test('reason 区分：请求本身失败（HTTP 错）→ request_failed，而不是任何一种"候选不行"', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [], fetchImpl: failFetch, ...KEY,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.REQUEST_FAILED);
  assert.equal(r.reason, 'request_failed');
});

test('reason 区分：响应结构非法（content 不是 JSON）→ response_invalid', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'no json' } }] }) }),
    ...KEY,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID);
  assert.equal(r.reason, 'response_invalid');
});

test('reason 区分：候选数组为空 → no_candidates（模型没认出东西，不是词表配错）', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: async () => envelopeOf([]), ...KEY,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.NO_CANDIDATES);
  assert.notEqual(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
});

test('reason 是枚举里的一员且互不相同（下游按它分列统计，取值不能自由发挥）', () => {
  const values = Object.values(RECOGNIZE_FAIL_REASONS);
  assert.equal(new Set(values).size, values.length, '各类必须互不相同');
  for (const v of values) assert.equal(typeof v, 'string');
  assert.deepEqual([...values].sort(), [
    'all_matched_excluded', 'auth_failed', 'no_candidates', 'not_in_acceptable_set',
    'rate_limited', 'request_failed', 'response_invalid',
  ].sort(), '12A 最小扩展：新增 auth_failed（401）与 rate_limited（429），其余五档原样');
  assert.ok(Object.isFrozen(RECOGNIZE_FAIL_REASONS), '枚举必须冻结：统计口径不许被运行时改写');
});

test('reason 只反映"最后一次尝试"的失败原因（降级那一刻的实况）', async () => {
  let call = 0;
  const flakyThenOffSet = async () => {
    call += 1;
    return call === 1 ? failFetch() : offSetFetch();
  };
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [], fetchImpl: flakyThenOffSet, ...KEY,
  });
  assert.equal(r.attempts, 2);
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
});

test('初次就命中的成功路径不该带失败原因（reason 只在落空时有值）', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [], fetchImpl: okFetch, ...KEY,
  });
  assert.equal(r.mode, 'ok');
  assert.equal(r.reason, undefined, '成功时不要给一个"原因"字段，免得被当成失败读');
});

test('manual 档必须给出可用的手选词包（不然界面只能显示"失败"，用户无路可走）', () => {
  assert.ok(Array.isArray(MANUAL_PICK_SCENE_WORDS));
  assert.ok(MANUAL_PICK_SCENE_WORDS.length >= 2, '至少要有两个可挑的词');
  for (const w of MANUAL_PICK_SCENE_WORDS) {
    assert.equal(typeof w, 'string');
    assert.match(w, /^[a-z][a-z '-]*$/, `手选词必须是小写英文词：${w}`);
  }
  assert.ok(Object.isFrozen(MANUAL_PICK_SCENE_WORDS), '词包冻结：手选词表不许被运行时改写');
});

// ─────────────────────────── 12A：场景词包来源核实 ───────────────────────────
// 任务书要求核实"手选场景词包是否来自服务端接口"：**不是**。它一直是客户端静态的
// 冻结数组（本模块的 MANUAL_PICK_SCENE_WORDS），不依赖任何接口，无需改为静态 JSON。
test('场景词包是客户端静态声明（不是接口下发）：数组的形状就是数据源', () => {
  assert.equal(Object.isFrozen(MANUAL_PICK_SCENE_WORDS), true);
  assert.ok(MANUAL_PICK_SCENE_WORDS.includes('mug'));
});

// ─────────────────────────── 超时闸（Task 7 原样保留，直连版）───────────────────────────

/** 永不回话、但如实遵守 signal 契约的 fetch（真实 fetch 在半开连接上就是这个行为）。 */
const stalledFetch = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});

test('识物请求有上限：模型服务永不回话时必须在上限内抛 request_failed，绝不永久挂住', async () => {
  const started = Date.now();
  await assert.rejects(
    () => settlesWithin(
      recognize(new Blob(['x']), { fetchImpl: stalledFetch, timeoutMs: 30, ...KEY }),
      2000, '识物请求',
    ),
    (err) => err.code === RECOGNIZE_FAIL_REASONS.REQUEST_FAILED && /超时|timeout/i.test(String(err.message)),
    '超时要按"请求失败"报，且消息里说清是超时（不是"响应结构非法"）',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `必须在注入的上限（30ms）内收口，实测 ${elapsed}ms——挂住就等于界面卡死`);
});

/**
 * 复审 Important 1 用的桩：先回响应头 + 半截 body，然后挂住不结束（中止发生在 res.json() 里）。
 * 直连版通过 `apiBase` 注入把请求指向本地桩——同一契约，只是地址换了。
 */
function startStallingBodyStub() {
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":[{"message":{"content":"{\\"candidates\\":[{\\"label\\":\\"mug\\"'); // 半截 JSON
      // 有意不 res.end()：body 就停在这里
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      async close() {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      },
    }));
  });
}

test('响应头到了、body 还在流：上限到点算"超时"（request_failed），不是"响应非法"', async () => {
  const stub = await startStallingBodyStub();
  const t0 = Date.now();
  let caught = null;
  try {
    await settlesWithin((async () => {
      try {
        await recognize(new Blob(['x']), {
          fetchImpl: (url, init) => fetch(url, init),
          apiBase: stub.origin,
          timeoutMs: 80,
          ...KEY,
        });
      } catch (err) { caught = err; }
    })(), 3000, '停滞的响应体');
  } finally {
    await stub.close();
  }
  const elapsed = Date.now() - t0;
  assert.ok(caught !== null, '上限到点必须抛错，不许静默返回空候选冒充"模型没认出"');
  assert.equal(caught.code, RECOGNIZE_FAIL_REASONS.REQUEST_FAILED,
    '响应头已到、body 停滞被上限中止 = 请求失败（超时），不是 response_invalid');
  assert.match(String(caught.message), /超时/, '消息里必须说清是超时（否则看日志的人会去怀疑契约）');
  assert.doesNotMatch(String(caught.message), /不是合法 JSON/, '不许再落进"响应非法"那套措辞');
  assert.ok(elapsed < 2000, `必须在注入的上限（80ms）附近收口，实测 ${elapsed}ms`);
});

test('超时在降级链路上也是一档普通失败：mode=manual + reason=request_failed（attempts 如实为 2）', async () => {
  const r = await settlesWithin(recognizeWithFallback({
    grab: goodGrab, acceptableSets: { mug: ['mug'] }, exclude: [],
    fetchImpl: stalledFetch, timeoutMs: 30, ...KEY,
  }), 3000, '降级链路');
  assert.equal(r.mode, 'manual');
  assert.equal(r.word, null, '超时同样不许假造词');
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.REQUEST_FAILED);
  assert.equal(r.attempts, 2, '两次尝试都在上限内收口（不是第一次挂到天荒地老）');
});

test('客户端这条腿的请求上限是正整数毫秒（直连后这是唯一的腿——原「客户端必须大于服务端」的跨模块关系随代理退役）', () => {
  assert.ok(Number.isInteger(RECOGNIZE_REQUEST_TIMEOUT_MS) && RECOGNIZE_REQUEST_TIMEOUT_MS > 0);
  assert.equal(RECOGNIZE_REQUEST_TIMEOUT_MS, 12000, '首轮设定值不变：标定依据见该常量的注释');
});

// ─────────────────────────── 图片大小与纯逻辑约束 ───────────────────────────

test('图片过大（data URL 超过 32 MiB 上限）→ 在发请求**之前**响亮失败（移植口径）', async () => {
  let calls = 0;
  const bigBlob = new Blob([new Uint8Array(26 * 1024 * 1024)]); // data URL ≈ 34.7M 字符 > 32 MiB
  await assert.rejects(
    () => recognize(bigBlob, {
      fetchImpl: async () => { calls += 1; return okFetch(); }, ...KEY,
    }),
    (err) => err.code === RECOGNIZE_FAIL_REASONS.REQUEST_FAILED && /过大|上限/.test(String(err.message)),
  );
  assert.equal(calls, 0, '明知会被上游拒绝的请求不发出去——省一次往返（移植自 server 的守卫）');
});

test('本模块不 import 任何浏览器 API（shared-context 的纯逻辑约定）', () => {
  // 纯逻辑模块要能在 Node 里直接测。12A 新增的对 ./deepseek.mjs 的依赖也是纯逻辑模块。
  const src = fs.readFileSync(fileURLToPath(new URL('../web/units/recognize.mjs', import.meta.url)), 'utf8');
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
  assert.deepEqual(
    importLines.map((l) => l.trim()),
    [
      "import { judgeFrame } from './frame-qc.mjs';",
      "import { pickWord } from './pick-word.mjs';",
      "import { DEEPSEEK_API_BASE, DEEPSEEK_MODEL, VISION_DETAIL, chatUrl, extractContent } from './deepseek.mjs';",
    ],
    '只允许 import 这三个纯逻辑模块（Key 从参数进来，本模块永不碰 localStorage）',
  );
  assert.doesNotMatch(src, /\b(document|window|navigator|localStorage|indexedDB)\b/);
});
