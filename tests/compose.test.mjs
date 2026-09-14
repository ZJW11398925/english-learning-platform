// tests/compose.test.mjs
//
// 造句反馈链路的单元测试（Task 8）。两个被测单元都在这里，因为它们是**一条**链路的两半：
//   · `web/units/compose.mjs` —— 客户端那一腿（发请求 → 交给 `validateFeedback` → 分档）；
//   · `server/feedback-upstream.mjs` —— 服务端给上游的模型契约（请求体形状 + 上游信封校验）。
//
// 这层要钉住的几件事，每一条都对应一种"改坏了还不报错"：
//   ① **`ok` 的意思是"校验通过、可用"，不是"HTTP 200"**：200 带着一份不可用的响应体是
//      `pending`，不是 `ok`（设计文档 §5.1 的 `feedback_pending` 档）。
//   ② **缺字段绝不猜测填充**：四个字段少一个就整份不可用，且**点名**缺的是哪个
//      （`errors` 会被 `join('; ')` 成 pending 的原因落进事件流，不点名就没法定位）。
//   ③ **原句永不丢**：成功与失败两条路上，返回值里都带着 `sentence`（原句一字不改）——
//      这是"待反馈队列"与"句子语料"两条要求的共同前提。
//   ④ **超时归超时，不归"响应非法"**：上限到点可能发生在 `fetch()` 那一句，也可能发生在
//      `res.json()` 那一句（**响应头到了、body 还在流**）。后者若落进 `response_invalid`，
//      它的处置方向（"改服务端或模型契约"）会把排查的人带偏——Task 7 已吃过一次这个亏。
//   ⑤ **`uncertain` 是合法的判定**，走 `ok` 且带 `uncertain: true`；它与 `error_type` 是
//      两个维度（`uncertain + grammar` 是契约合法的组合），所以任何按 `error_type` 的计数
//      都必须**先按 verdict 分组**（见文件末尾那条用例）。
//
// 全部用例用注入的假 fetch，**不打真模型**（设计文档 §5.2）。真实调用由
// `scripts/probe-feedback-live.mjs` 的实弹探针负责，结果记在 task-8-report.md。
//
// ⚠️ **本文件不 import `server/index.mjs`**（有意）：本文件被 `scripts/mutation-probe.mjs`
// 复制进临时工作树跑，而 `server/index.mjs` 的路由表里写死了 `../web/` 的绝对路径、
// 还牵进 `env`/`recognize-upstream`——在临时树里那会指向另一份 web/，基线会假红
// （假红会让整轮探针结论作废，是本探针最忌讳的假信号）。所以"服务端整体请求上限"那条
// 跨模块用例放在 `tests/feedback-endpoint.test.mjs` 里（那一份本来就不进探针）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { submitSentence, FEEDBACK_FAIL_REASONS, FEEDBACK_TIMEOUT_MS, FEEDBACK_REQUEST_TIMEOUT_MS, feedbackEventFor } from '../web/units/compose.mjs';
import {
  feedbackUpstream, FEEDBACK_PROMPT, UPSTREAM_TIMEOUT_MS as FEEDBACK_UPSTREAM_TIMEOUT_MS,
  UPSTREAM_FAILED, UPSTREAM_INVALID,
  FEEDBACK_RULE_VERDICTS, FEEDBACK_RULE_ERROR_TYPES, FEEDBACK_RULE_CORRECT,
  FEEDBACK_RULE_FLAWED, FEEDBACK_RULE_UNCERTAIN,
} from '../server/feedback-upstream.mjs';
import { recordEvent } from '../web/units/event-log.mjs';
import { validateFeedback } from '../web/units/feedback.mjs';

/** brief 里那份"合法的模型响应"，逐字保留（下面多条用例都以它为基准改一个字段）。 */
const goodBody = { verdict: 'flawed', error_type: 'word_choice', rewrite: 'I use a mug.', note: '词选得更准' };

/** 只回一个 JSON 响应的假 fetch；`seen` 收下每次调用的实参供断言。 */
function fakeFetch(reply) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    return typeof reply === 'function' ? reply(url, init) : reply;
  };
  impl.seen = seen;
  return impl;
}

const okReply = (body, extra = {}) => ({
  ok: true, status: 200, json: async () => body, text: async () => '', ...extra,
});

// ─────────────────────────────── brief Step 1 的五条（逐字保留）───────────────────────────────

test('合法响应返回 status=ok 与校验后的值', async () => {
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    { fetchImpl: async () => ({ ok: true, json: async () => goodBody }) },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.feedback.verdict, 'flawed');
});

test('响应缺字段时进 pending，绝不猜测填充', async () => {
  const r = await submitSentence(
    { sentence: 'x', word: 'mug', scene: 'kitchen' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ verdict: 'correct' }) }) },
  );
  assert.equal(r.status, 'pending');
  assert.ok(r.error.includes('rewrite'));
});

test('HTTP 失败时进 pending 并保留原句', async () => {
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.sentence, 'I use a cup.');
});

test('uncertain 是 ok 状态但要带 uncertain 标记（便于单独统计）', async () => {
  const r = await submitSentence(
    { sentence: 'x', word: 'mug', scene: 'kitchen' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ verdict: 'uncertain', error_type: 'none', rewrite: null, note: '拿不准' }) }) },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.uncertain, true);
});

test('空句子在发请求之前就被拒（不消耗调用）', async () => {
  let called = false;
  const r = await submitSentence(
    { sentence: '   ', word: 'mug', scene: 'kitchen' },
    { fetchImpl: async () => { called = true; return { ok: true, json: async () => goodBody }; } },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.error, 'empty_sentence');
  assert.equal(called, false);
});

// ───────────────────────────── 空句拦截的边界：一个字都不到网络那一步 ─────────────────────────────

test('空句只在**一个字都没有**时才算空：纯空白也算空，而带内容的句子一字不改地发出去', async () => {
  // 空白只用来判断"是不是空的"，**不 trim 它**：交付给模型的必须是用户写下的原文
  // （前后的空格是他打的字，不是我们的格式偏好）。
  const f = fakeFetch(okReply(goodBody));
  const sent = '  I use a cup.  ';
  const r = await submitSentence({ sentence: sent, word: 'mug', scene: 'kitchen' }, { fetchImpl: f });
  assert.equal(r.status, 'ok');
  assert.equal(f.seen.length, 1, '有内容的句子必须真的发出去');
  assert.equal(JSON.parse(f.seen[0].init.body).sentence, sent, '原句一字不改地交给服务端');

  for (const blank of ['', '   ', '\n\t ']) {
    const f2 = fakeFetch(okReply(goodBody));
    const r2 = await submitSentence({ sentence: blank, word: 'mug', scene: 'kitchen' }, { fetchImpl: f2 });
    assert.equal(r2.status, 'pending');
    assert.equal(r2.error, FEEDBACK_FAIL_REASONS.EMPTY_SENTENCE);
    assert.equal(f2.seen.length, 0, `${JSON.stringify(blank)} 不该发起请求（每一次调用都要花钱）`);
  }
});

test('sentence 不是字符串（读不到输入框等）同样在发请求之前被拒', async () => {
  for (const bad of [undefined, null, 42, {}, ['I use a cup.']]) {
    const f = fakeFetch(okReply(goodBody));
    const r = await submitSentence({ sentence: bad, word: 'mug', scene: 'kitchen' }, { fetchImpl: f });
    assert.equal(r.status, 'pending');
    assert.equal(r.error, FEEDBACK_FAIL_REASONS.EMPTY_SENTENCE);
    assert.equal(f.seen.length, 0, `${JSON.stringify(bad) ?? String(bad)} 不该发起请求`);
  }
});

// ─────────────────────────────── 请求体形状：服务端契约的唯一决定点 ───────────────────────────────

test('请求形状：POST /api/feedback、JSON、字段只带 sentence/word/scene', async () => {
  const f = fakeFetch(okReply(goodBody));
  await submitSentence({ sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' }, { fetchImpl: f });
  assert.equal(f.seen.length, 1, '一次造句 = 一次上游调用（不做隐式重试）');
  const { url, init } = f.seen[0];
  assert.equal(url, '/api/feedback', '路径写死在链路里，调用方改不了它要打哪儿');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' });
});

// ───────────────────────────── ok 的定义：校验通过，不是 HTTP 200 ─────────────────────────────

test('HTTP 200 但响应体不合契约 → pending（200 不等于可用），且点名缺的字段', async () => {
  for (const bad of [
    { verdict: 'correct' },                                     // 缺三个字段
    { verdict: 'great', error_type: 'none', rewrite: null, note: 'n' }, // 判定越界
    { verdict: 'flawed', error_type: 'none', rewrite: 'a', note: 'n' },  // 搭配关系违约
    { verdict: 'correct', error_type: 'grammar', rewrite: 'a', note: 'n' },
    {}, null, [], 'not json',
  ]) {
    const r = await submitSentence(
      { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
      { fetchImpl: fakeFetch(okReply(bad)) },
    );
    assert.equal(r.status, 'pending', `${JSON.stringify(bad)} 不是一份可用反馈，不许报 ok`);
    assert.equal(r.reason, FEEDBACK_FAIL_REASONS.RESPONSE_INVALID);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0, 'pending 必须带一条可定位的诊断');
    assert.equal(r.sentence, 'I use a cup.', '不可用时原句同样不能丢');
  }
});

test('校验用的就是 Task 4 的 validateFeedback，且 value 是**同一个对象**（原样入库）', async () => {
  const body = { ...goodBody, extra_key: '上游多给的键' };
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    { fetchImpl: fakeFetch(okReply(body)) },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.feedback, body, '必须是入参本身（不重建、不规整、不深拷贝）——Task 4 的冻结契约');
  assert.equal(r.feedback.extra_key, '上游多给的键', '多余键原样带下去');
  assert.equal(validateFeedback(r.feedback).ok, true, '被我们判成 ok 的东西，必须真的过得了校验器');
});

test('响应的 choices 信封（服务端形状）也是判据：ok:true 之外的东西一律 pending', async () => {
  // 服务端在信封不合法时回 502 upstream_invalid，客户端按"服务端说的失败形状"落档；
  // 万一它没这么回（回了个 200 但 ok !== true），客户端不能把这种响应当成成功。
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    { fetchImpl: fakeFetch(okReply({ ok: false, error: 'upstream_invalid' })) },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, FEEDBACK_FAIL_REASONS.RESPONSE_INVALID);
  assert.equal(r.sentence, 'I use a cup.');
});

test('响应体不是合法 JSON（网关吐 HTML）→ pending，绝不当成"没有反馈"', async () => {
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    {
      fetchImpl: fakeFetch({
        ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>',
        json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
      }),
    },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, FEEDBACK_FAIL_REASONS.RESPONSE_INVALID);
  assert.match(r.detail, /JSON/, '诊断里要说清"不是合法 JSON"（这一档要改的是服务端/模型契约）');
  assert.equal(r.sentence, 'I use a cup.');
});

// ───────────────────────── 失败分档：每一档指向不同的处置方向 ─────────────────────────

test('HTTP 非 2xx → 独立一档 http_error（不是"响应非法"：要改的是链路或服务）', async () => {
  for (const status of [400, 401, 429, 500, 502, 503]) {
    const r = await submitSentence(
      { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
      { fetchImpl: fakeFetch({ ok: false, status, json: async () => ({ error: 'x' }) }) },
    );
    assert.equal(r.status, 'pending');
    assert.equal(r.reason, FEEDBACK_FAIL_REASONS.HTTP_ERROR);
    assert.match(r.error, new RegExp(String(status)), '诊断里要说清是哪个状态码');
    assert.equal(r.sentence, 'I use a cup.');
  }
});

test('HTTP 504 / 408 → 归 timeout 一档（网关超时不是"响应非法"，也不是泛泛的 http_error）', async () => {
  // 复审 Item 2：这两个分支此前**一个用例都没有**——上面那组 HTTP 分档只跑
  // 400/401/429/500/502/503，把 `gatewayTimeout` 判据整个删掉也不会红。
  // 它们必须与"服务端回了别的非 2xx"分开的理由见 `web/units/compose.mjs` 的那段注释：
  // 真凶是网关/上游慢，处置方向是重试与看上游，而不是"去改端侧输入或模型契约"。
  for (const status of [504, 408]) {
    const r = await submitSentence(
      { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
      { fetchImpl: fakeFetch({ ok: false, status, json: async () => ({ error: 'gateway_timeout' }) }) },
    );
    assert.equal(r.status, 'pending', `HTTP ${status} 是 pending`);
    assert.equal(r.reason, FEEDBACK_FAIL_REASONS.TIMEOUT, `HTTP ${status} 必须归 timeout（不是 http_error）`);
    assert.notEqual(r.reason, FEEDBACK_FAIL_REASONS.HTTP_ERROR, `HTTP ${status} 不许落回泛泛的 http_error`);
    assert.match(r.error, new RegExp(String(status)), '诊断里仍要说清是哪个状态码');
    assert.equal(r.sentence, 'I use a cup.', '原句照旧保留');
  }
});

test('网络层抛错（断网）→ request_failed，带上原始错误信息', async () => {
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, FEEDBACK_FAIL_REASONS.REQUEST_FAILED);
  assert.match(r.error, /Failed to fetch/);
  assert.equal(r.sentence, 'I use a cup.');
});

test('上限到点（fetch 那一句被中止）→ timeout，而不是"请求发不出去"', async () => {
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    {
      timeoutMs: 20,
      // 如实遵守 signal 的 fetch：上限到点时以 TimeoutError 拒绝（与真 fetch 一致）
      fetchImpl: (url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          reject(err);
        });
      }),
    },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, FEEDBACK_FAIL_REASONS.TIMEOUT);
  assert.match(r.error, /超时|timeout/i);
  assert.equal(r.sentence, 'I use a cup.');
});

test('响应头到了、body 还在流时上限到点 → 仍然算 timeout，不是 response_invalid', async () => {
  // Task 7 复审 Important 1 的同一条纪律，在造句这条链路上重演：
  // 这个 catch 里有两种完全不同的成因（body 停滞 vs 响应真的不是 JSON），
  // 混为一谈会把一次网络停滞记进"改服务端或模型契约"那一档。
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    {
      timeoutMs: 20,
      fetchImpl: async (url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            reject(err);
          });
        }),
      }),
    },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, FEEDBACK_FAIL_REASONS.TIMEOUT, 'body 停滞 = 超时那一档，不是 response_invalid');
  assert.match(r.error, /超时|timeout/i);
});

test('调用方主动取消（AbortError）归 timeout 一档：它不是"服务端契约不对"', async () => {
  // 用户离开这一屏时的主动取消，与上限到点在**处置方向**上是同一件事：
  // 都该重试，都不该被写成"模型契约有问题"。两档合并，理由写在常量说明里。
  const r = await submitSentence(
    { sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    {
      fetchImpl: async () => { const e = new Error('The user aborted a request.'); e.name = 'AbortError'; throw e; },
    },
  );
  assert.equal(r.status, 'pending');
  assert.equal(r.reason, FEEDBACK_FAIL_REASONS.TIMEOUT);
});

test('请求带上 signal（没有它，上游半开时这个 Promise 永久 pending）', async () => {
  const f = fakeFetch(okReply(goodBody));
  await submitSentence({ sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' }, { fetchImpl: f });
  const signal = f.seen[0].init.signal;
  assert.ok(signal, '每一次造句请求都要带 signal');
  assert.equal(signal.aborted, false, '正常请求不该一开始就是中止状态');
});

test('每一档都有各自的取值，且都登记在 FEEDBACK_FAIL_REASONS 里（冻结的统计口径）', () => {
  const reasons = Object.values(FEEDBACK_FAIL_REASONS);
  assert.equal(new Set(reasons).size, reasons.length, '档位取值不许重复');
  for (const r of reasons) assert.equal(typeof r, 'string');
  assert.ok(Object.isFrozen(FEEDBACK_FAIL_REASONS), '档位是统计口径的一部分，不许被运行时改写');
  // 关键的一刀：超时与"响应非法"必须是两个不同的档
  assert.notEqual(FEEDBACK_FAIL_REASONS.TIMEOUT, FEEDBACK_FAIL_REASONS.RESPONSE_INVALID);
});

// ───────────────────────────── 原句的归属（A2/A4：句子永不丢）─────────────────────────────

test('pending 的原句一字不改、连空白一起带回去（补交时发出去的必须还是他写的那句）', async () => {
  const sentence = '  I use a cup .  ';
  const f = fakeFetch({ ok: false, status: 500, json: async () => ({}) });
  const r = await submitSentence({ sentence, word: 'mug', scene: 'kitchen' }, { fetchImpl: f });
  assert.equal(r.status, 'pending');
  assert.equal(r.sentence, sentence);
  assert.deepEqual(
    { word: r.word, scene: r.scene },
    { word: 'mug', scene: 'kitchen' },
    'word/scene 也要一起带回去：补交时要重发同一份上下文',
  );
  assert.equal(JSON.parse(f.seen[0].init.body).sentence, sentence, '发给服务端的也是原句');
});

test('ok 的结果同样带着原句（A4：这条路径上没有任何一处丢掉学习者的话）', async () => {
  const sentence = 'I use a cup.';
  const r = await submitSentence(
    { sentence, word: 'mug', scene: 'kitchen' },
    { fetchImpl: fakeFetch(okReply(goodBody)) },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.sentence, sentence);
});

// ───────────────────────── 事件映射：uncertain 单独一条，不进"通过" ─────────────────────────

test('事件映射：ok → feedback_ok，uncertain → uncertain（两条互斥，绝不双记）', () => {
  const ok = feedbackEventFor({ status: 'ok', feedback: goodBody, uncertain: false, sentence: 'I use a cup.' });
  assert.equal(ok.type, 'feedback_ok');
  assert.equal(ok.payload.sentence, 'I use a cup.');
  assert.equal(ok.payload.verdict, 'flawed');
  assert.equal(ok.payload.error_type, 'word_choice');

  const un = feedbackEventFor({
    status: 'ok', uncertain: true, sentence: 'x',
    feedback: { verdict: 'uncertain', error_type: 'none', rewrite: null, note: '拿不准' },
  });
  assert.equal(un.type, 'uncertain', 'uncertain 是**单独一条**事件，不混进 feedback_ok（否则通过率被它污染）');
  assert.equal(un.payload.sentence, 'x');
  assert.equal(un.payload.verdict, 'uncertain');
});

test('事件映射：pending → feedback_pending，把原句与档位一起记下来', () => {
  const e = feedbackEventFor({
    status: 'pending',
    reason: FEEDBACK_FAIL_REASONS.HTTP_ERROR,
    error: 'http_500',
    sentence: 'I use a cup.',
  });
  assert.equal(e.type, 'feedback_pending');
  assert.equal(e.payload.sentence, 'I use a cup.');
  assert.equal(e.payload.reason, FEEDBACK_FAIL_REASONS.HTTP_ERROR);
  assert.equal(e.payload.error, 'http_500');
});

test('映射出来的事件真的能落进事件流：事件类型已登记、原句进 payload（A4）', () => {
  const appended = [];
  const store = { appendEvent: (ev) => appended.push(ev) };
  for (const result of [
    { status: 'ok', feedback: goodBody, uncertain: false, sentence: 'I use a cup.', word: 'mug' },
    { status: 'ok', uncertain: true, sentence: 'blah', word: 'mug', feedback: { verdict: 'uncertain', error_type: 'none', rewrite: null, note: '拿不准' } },
    {
      status: 'pending',
      reason: FEEDBACK_FAIL_REASONS.TIMEOUT,
      error: 'timeout',
      sentence: 'I use a mug.',
      word: 'mug',
    },
  ]) {
    const { type, payload } = feedbackEventFor(result);
    const e = recordEvent(store, type, { sessionId: 's1', wordId: result.word ?? null, roundIndex: 1, ...payload });
    assert.equal(e.sessionId, 's1');
    assert.equal(e.roundIndex, 1);
    assert.equal(e.payload.sentence, result.sentence, '原句必须进 payload：Task 9 的持久化与验证三的语料都从这里读');
  }
  assert.deepEqual(appended.map((e) => e.type), ['feedback_ok', 'uncertain', 'feedback_pending']);
});

// ──────────── 事件顶层字段的保护（Task 8 复审 Important 1 的姊妹形状）────────────
//
// `web/app.mjs` 落反馈事件时写的是 `record(store, ev.type, { sessionId, roundIndex, wordId,
// ...ev.payload }, clock)`。而 `recordEvent` 的第三参形状是
// `{ sessionId, wordId?, roundIndex?, ...payload }`——payload 里一旦出现同名键，它就会**盖掉**
// 真实的会话号与轮次（轮次是判据 B / `retry_rate` 的分组依据，被盖掉等于把这一轮记到别处）。
//
// 当前**够不到**：`feedbackEventFor` 的 payload 是逐个键写出来的白名单，模型多给的键连
// `result.feedback` 都不出。这条用例把这个前提**钉成一个可执行的不变式**——将来谁往 payload
// 里加一个事件顶层字段名，这里立刻红，而不是等到判据 B 的数对不上才发现。
// 姊妹形状的那一处已顺手改成"自己的字段写在展开之后"（`web/app.mjs`），两处一起防。

test('事件映射的 payload 不含 sessionId/wordId/roundIndex（那三个是事件顶层字段，撞名会被 recordEvent 摘走）', () => {
  const eventTopKeys = ['sessionId', 'wordId', 'roundIndex'];
  const results = [
    { status: 'ok', feedback: goodBody, uncertain: false, sentence: 'I use a cup.', word: 'mug', scene: 'kitchen' },
    { status: 'ok', uncertain: true, sentence: 'x', word: 'mug', feedback: { verdict: 'uncertain', error_type: 'none', rewrite: null, note: '拿不准' } },
    { status: 'pending', reason: FEEDBACK_FAIL_REASONS.TIMEOUT, error: 'timeout', sentence: 'I use a mug.', word: 'mug', scene: 'desk' },
  ];
  for (const result of results) {
    const { type, payload } = feedbackEventFor(result);
    for (const k of eventTopKeys) {
      assert.equal(k in payload, false, `${type} 的 payload 出现了事件顶层字段 ${k}（会被 recordEvent 摘走，永远进不了 payload）`);
    }
  }
});

test('姊妹保护：`...ev.payload` 放在事件顶层字段之前时，一个撞名的 payload 会盖掉真实会话号', () => {
  // 这条**故意**把危险形状跑一遍（app.mjs 就是这么写的），证明：
  //   ① 这个坑是真的（撞名的 payload 确实能盖掉 `sessionId`）；
  //   ② 上面那条不变式为什么必须存在。
  const appended = [];
  const store = { appendEvent: (ev) => appended.push(ev) };
  const colliding = recordEvent(store, 'feedback_ok', {
    sessionId: 's1', wordId: null, roundIndex: 1, ...{ sessionId: 'payload 里的假会话号', verdict: 'flawed' },
  });
  assert.equal(colliding.sessionId, 'payload 里的假会话号', '顺序写反时后写的赢——所以自己的字段必须写在展开之后');
  assert.equal(colliding.roundIndex, 1, '这一条没有撞名，仍如实保留');

  // 修正后的顺序（`web/app.mjs` 的现形状）：身份字段写在展开之后 → 谁也盖不掉。
  const fixed = recordEvent(store, 'feedback_ok', {
    ...{ sessionId: 'payload 里的假会话号', verdict: 'flawed' }, sessionId: 's1', wordId: null, roundIndex: 1,
  });
  assert.equal(fixed.sessionId, 's1', '自己的字段写在展开之后 → 权威在调用方');
});

// ───────────────────────── uncertain 与 error_type 是两个维度（A5 的前提）─────────────────────────

test('uncertain + error_type 非 none 是契约合法的组合：按 error_type 计数必须先按 verdict 分组', () => {
  // 这条用例钉的是**计数口径的前提**，不是计数本身：只要 `uncertain` 能与任意 `error_type`
  // 组合，"按 error_type 直方图"就会把拿不准的句子混进"通过/不通过"里，
  // 而设计文档 §4.2 要求 `uncertain` 单独统计、不计入通过率。
  // 谁要按 error_type 统计，必须**先按 verdict 分组**（Task 10 的导出脚本）。
  const raw = { verdict: 'uncertain', error_type: 'grammar', rewrite: 'I use a mug.', note: '这句我拿不准' };
  assert.equal(validateFeedback(raw).ok, true, '契约允许 uncertain 与任何 error_type 并存（不要"收紧"校验器）');
  const r = { status: 'ok', feedback: raw, uncertain: true, sentence: 'x' };
  // 错误的口径（先按 error_type 计数）会把这句算进 grammar 的"发现问题数"里；
  // 正确的口径是先分组：
  const byVerdict = new Map([[r.feedback.verdict, [r.feedback.error_type]]]);
  assert.deepEqual([...byVerdict.keys()], ['uncertain']);
  assert.equal(byVerdict.has('flawed'), false, 'uncertain 不得被当成 flawed（否则通过率被它污染）');
});

// ───────────────────────────── 服务端：模型契约与上游信封校验 ─────────────────────────────

test('提示词要求四个字段、严格 JSON，并要求 uncertain 也给改写建议（设计文档 §4.2）', () => {
  for (const field of ['verdict', 'error_type', 'rewrite', 'note']) {
    assert.ok(FEEDBACK_PROMPT.includes(field), `提示词必须点名 ${field}`);
  }
  assert.match(FEEDBACK_PROMPT, /JSON/, '提示词必须要求严格 JSON');
  // ⚠️ 下面这几条**逐条断言单独成常量的规则**，而不是"整段里出现过某几个字"：
  // 后者拦不住"把其中一条整句删掉"（剩下的部分照样能让一个宽松的正则匹配上）。
  // 各条规则的存在本身就是契约的一部分，所以一条一条钉。
  assert.match(FEEDBACK_RULE_VERDICTS, /correct.*flawed.*uncertain/s, '三个判定档位必须都写进提示词');
  assert.match(FEEDBACK_RULE_ERROR_TYPES, /word_choice.*collocation.*grammar.*none/s, '四个错误类型必须都写进提示词');
  assert.match(FEEDBACK_RULE_CORRECT, /correct.*none/s, 'correct ↔ none 的搭配必须写进提示词');
  assert.match(FEEDBACK_RULE_FLAWED, /flawed/, 'flawed 必须指出问题类型');
  assert.match(FEEDBACK_RULE_FLAWED, /rewrite/, 'flawed 必须给改写建议');
  // §4.2 要求"uncertain 时仍给改写建议"，而 Task 4 的契约允许 uncertain + rewrite: null。
  // 不收紧校验器（控制器的明确要求），改用提示词保证——所以这一条必须真的在提示词里。
  assert.match(FEEDBACK_RULE_UNCERTAIN, /uncertain/, 'uncertain 必须是提示词里的合法答案');
  assert.match(FEEDBACK_RULE_UNCERTAIN, /rewrite/, 'uncertain 也必须给改写建议（§4.2）');
  for (const rule of [FEEDBACK_RULE_VERDICTS, FEEDBACK_RULE_ERROR_TYPES, FEEDBACK_RULE_CORRECT, FEEDBACK_RULE_FLAWED, FEEDBACK_RULE_UNCERTAIN]) {
    assert.ok(FEEDBACK_PROMPT.includes(rule), '每条规则都必须真的进了提示词（拆开写是为了能被单独钉住）');
  }
});

test('上游请求体形状：模型 / system+user 两条消息 / JSON 模式 / 低温度 / Bearer 密钥', async () => {
  const seen = [];
  const env = {
    DEEPSEEK_API_KEY: 'sk-fake-key-for-test',
    DEEPSEEK_API_BASE: 'https://api.deepseek.com',
    DEEPSEEK_MODEL: 'deepseek-flash',
  };
  await feedbackUpstream({
    sentence: 'I use a cup.',
    word: 'mug',
    scene: 'kitchen',
    env,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return okReply({
        choices: [{ message: { content: JSON.stringify(goodBody) } }],
        usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
        model: 'deepseek-flash',
      });
    },
  });
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer sk-fake-key-for-test', '密钥由服务端注入上游');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.response_format, { type: 'json_object' }, 'JSON 模式兜底"必须是 JSON"（语义仍由客户端校验器把关）');
  assert.ok(body.temperature <= 0.3, '这一档要的是判定，不是发挥');
  assert.ok(init.signal, '上游那一腿必须有上限');
  const roles = body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user']);
  const userText = body.messages[1].content;
  const flat = typeof userText === 'string' ? userText : JSON.stringify(userText);
  for (const s of ['I use a cup.', 'mug', 'kitchen']) {
    assert.ok(flat.includes(s), `用户消息里必须带上 ${s}（否则模型无从判定）`);
  }
});

test('上游响应通过校验时**原样**返回四个字段（不做二次加工，多余键也带出去）', async () => {
  const content = { ...goodBody, model_extra: 'x' };
  const { feedback, usage } = await feedbackUpstream({
    sentence: 'I use a cup.',
    word: 'mug',
    scene: 'kitchen',
    env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_API_BASE: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'deepseek-flash' },
    fetchImpl: async () => okReply({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 7 } }),
  });
  assert.deepEqual(feedback, content);
  assert.deepEqual(usage, { prompt_tokens: 7 });
});

test('上游信封不合法一律 UPSTREAM_INVALID，绝不让垃圾长得像成功', async () => {
  const cases = [
    { name: '非 JSON 响应体', reply: { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } },
    { name: 'HTTP 200 但 content 不是 JSON 字符串', reply: okReply({ choices: [{ message: { content: '当然可以！这句话很好。' } }] }) },
    { name: '缺少 choices[0].message.content', reply: okReply({ choices: [] }) },
    { name: 'content 是空串', reply: okReply({ choices: [{ message: { content: '   ' } }] }) },
    { name: 'content 解析出来是数组', reply: okReply({ choices: [{ message: { content: '[1,2,3]' } }] }) },
    { name: 'content 解析出来是字符串', reply: okReply({ choices: [{ message: { content: '"correct"' } }] }) },
  ];
  for (const c of cases) {
    await assert.rejects(
      () => feedbackUpstream({
        sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
        env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_API_BASE: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'm' },
        fetchImpl: async () => c.reply,
      }),
      (err) => {
        assert.equal(err.code, UPSTREAM_INVALID, `${c.name} 应判 UPSTREAM_INVALID`);
        return true;
      },
    );
  }
});

test('上游 4xx/5xx 与抛错 → UPSTREAM_FAILED（与"形状不对"分开报）', async () => {
  for (const reply of [
    { ok: false, status: 500, text: async () => '{"error":"boom"}' },
    { ok: false, status: 401, text: async () => '{"error":"bad key"}' },
  ]) {
    await assert.rejects(
      () => feedbackUpstream({
        sentence: 'x', word: 'mug', scene: 'kitchen',
        env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_API_BASE: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'm' },
        fetchImpl: async () => reply,
      }),
      (err) => {
        assert.equal(err.code, UPSTREAM_FAILED);
        assert.match(err.message, new RegExp(String(reply.status)));
        return true;
      },
    );
  }
  await assert.rejects(
    () => feedbackUpstream({
      sentence: 'x', word: 'mug', scene: 'kitchen',
      env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_API_BASE: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'm' },
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    }),
    (err) => { assert.equal(err.code, UPSTREAM_FAILED); return true; },
  );
});

test('上游 body 停滞到上限 → UPSTREAM_FAILED + 说清是超时（不是"契约不对"）', async () => {
  await assert.rejects(
    () => feedbackUpstream({
      sentence: 'x', word: 'mug', scene: 'kitchen',
      env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_API_BASE: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'm' },
      timeoutMs: 20,
      fetchImpl: async (url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            reject(err);
          });
        }),
      }),
    }),
    (err) => {
      assert.equal(err.code, UPSTREAM_FAILED, '上游停滞 = 上游失败（超时），不是 upstream_invalid');
      assert.match(err.message, /超时|timeout/i);
      return true;
    },
  );
});

// ───────────────────────── 两条腿的上下限关系（硬要求，跨模块钉住）─────────────────────────

test('服务端上游上限 < 客户端这一腿的上限：服务端要先超时、先把它自己的失败形状写回来', async () => {
  assert.ok(
    FEEDBACK_UPSTREAM_TIMEOUT_MS < FEEDBACK_REQUEST_TIMEOUT_MS,
    `服务端上游上限 ${FEEDBACK_UPSTREAM_TIMEOUT_MS}ms 必须 < 客户端这条腿 ${FEEDBACK_REQUEST_TIMEOUT_MS}ms`
    + '——顺序反过来的话，"模型慢"在数据里只会长成"客户端自己等烦了"，而服务端什么都没记',
  );
  assert.equal(FEEDBACK_TIMEOUT_MS, FEEDBACK_REQUEST_TIMEOUT_MS, '导出的别名必须指同一个值');
  for (const v of [FEEDBACK_UPSTREAM_TIMEOUT_MS, FEEDBACK_REQUEST_TIMEOUT_MS]) {
    assert.ok(Number.isInteger(v) && v > 0, '上限必须是正整数毫秒');
  }
  // 两条腿之间留的余量：上游到点后，服务端还要把 502 写回来、客户端还要读完它。
  const gap = FEEDBACK_REQUEST_TIMEOUT_MS - FEEDBACK_UPSTREAM_TIMEOUT_MS;
  assert.ok(gap >= 2000, `两条腿之间只留了 ${gap}ms；上游到点后服务端还需要时间把 502 写回来`);
  // 上界：这条腿不能长过服务端整个请求的上限（30s），否则服务端会先把连接收掉，
  // 客户端只看到一次网络中断，分不清模型慢、服务端挂了还是网络断。
  // （跨模块那一条——`SERVER_REQUEST_TIMEOUT_MS > FEEDBACK_REQUEST_TIMEOUT_MS`——在
  //  `tests/feedback-endpoint.test.mjs` 里，理由见文件头。）
  assert.ok(
    FEEDBACK_REQUEST_TIMEOUT_MS < 30_000,
    `客户端这条腿 ${FEEDBACK_REQUEST_TIMEOUT_MS}ms 必须留在服务端整体请求上限（30s）之内`,
  );
});
