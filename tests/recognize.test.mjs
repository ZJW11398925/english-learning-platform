// tests/recognize.test.mjs
//
// Task 7 的客户端识物单元。brief 给了 5 条用例（下面「brief 原样」一节，逐字保留），
// 控制器另加了四条要求，各自在下面单列一节：
//   · 追加 1「不要判两次帧」——本模块是**唯一**的判帧点，mount() 里那条必须拆掉；
//   · 追加 2「把"配置问题"与"识别失败"分开」——`reason` 要能区分"模型给的候选一个都不在
//     可接受集里"（内容配置问题）/「命中全被 exclude 掉」/「请求本身失败」；
//   · 追加 4「界面绝不假造词」——`mode='manual'` 时 `word` 必须是 null，且**不许**把模型候选
//     当兜底塞进 `word`。
//
// 本模块按 shared-context 的约定保持"纯逻辑"：不 import 任何浏览器 API，`fetch` / `grab`
// 都是注入点，于是整份都能在 Node 里跑（浏览器里 `fetchImpl` 缺省就是全局 `fetch`）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  recognize, recognizeWithFallback, RECOGNIZE_FAIL_REASONS, MANUAL_PICK_SCENE_WORDS,
  RECOGNIZE_REQUEST_TIMEOUT_MS,
} from '../web/units/recognize.mjs';
// 只为了钉住"客户端那条腿必须比服务端那条腿长"这条**跨模块**不变量（见下面的超时用例）。
// 本文件其余部分不碰服务端代码。
import { UPSTREAM_TIMEOUT_MS } from '../server/recognize-upstream.mjs';
// 看门狗：让"该在上限内收口却没有"表现为一次干净的断言失败，而不是把文件挂死。
import { settlesWithin } from './helpers/watchdog.mjs';

const sets = { mug: ['mug', 'cup'], kettle: ['kettle'] };
const okFetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }] }),
});
const failFetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
const OK_STATS = { brightness: 128, laplacianVar: 200 };
const goodGrab = async () => ({ blob: new Blob(['x']), stats: OK_STATS });
/** 候选命中了可接受集之外的东西（模型答的是上位词/别的物体）。 */
const offSetFetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, candidates: [{ label: 'container', score: 0.95, scene: 'kitchen' }] }),
});
/** 服务端 200 但响应结构不是约定的那个（ok !== true / candidates 不是数组）。 */
const malformedFetch = async () => ({
  ok: true,
  json: async () => ({ ok: true, candidates: 'nope' }),
});

// ─────────────────────────────────────────── brief 原样（5 条，逐字）───────────────────────────────────────────

test('recognize 把服务端候选原样返回', async () => {
  const r = await recognize(new Blob(['x']), { fetchImpl: okFetch });
  assert.equal(r.candidates[0].label, 'mug');
});

test('HTTP 失败时抛出，不返回空候选冒充成功', async () => {
  await assert.rejects(() => recognize(new Blob(['x']), { fetchImpl: failFetch }), /502/);
});

test('第一次成功即返回 mode=ok，attempts=1', async () => {
  const r = await recognizeWithFallback({
    grab: async () => ({ blob: new Blob(['x']), stats: { brightness: 128, laplacianVar: 200 } }),
    acceptableSets: sets, exclude: [], fetchImpl: okFetch,
  });
  assert.equal(r.mode, 'ok');
  assert.equal(r.word, 'mug');
  assert.equal(r.attempts, 1);
});

test('第 2 次尝试仍失败则退到 mode=manual，绝不假造一个词', async () => {
  const r = await recognizeWithFallback({
    grab: async () => ({ blob: new Blob(['x']), stats: { brightness: 128, laplacianVar: 200 } }),
    acceptableSets: sets, exclude: [], fetchImpl: failFetch,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(r.word, null);
  assert.equal(r.attempts, 2);
});

test('帧质检不通过时不发请求，直接要求重拍（省调用也省延迟）', async () => {
  let calls = 0;
  const r = await recognizeWithFallback({
    grab: async () => ({ blob: new Blob(['x']), stats: { brightness: 10, laplacianVar: 10 } }),
    acceptableSets: sets, exclude: [],
    fetchImpl: async () => { calls += 1; return okFetch(); },
  });
  assert.equal(r.mode, 'frame_rejected');
  assert.equal(calls, 0, '太暗的帧不应触发任何模型调用');
});

// ───────────────────────────────────── 追加 4：绝不假造词 + 帧只判一次 ─────────────────────────────────────

test('manual 档的每一次落空都不许把模型候选塞进 word（假造词的唯一入口）', async () => {
  // 这是"绝不假造识别结果"的主用例：模型明明**给了**候选（container），只是不在可接受集里。
  // 把 top-1 塞进 `word` 会让界面显示一个没被任何判定认可的"取到的词"。
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: offSetFetch,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(r.word, null, 'manual 档必须 word === null——绝不退而求其次显示上位词');
  assert.equal(r.attempts, 2, '两次都可能命中，故两次都要真的问过模型');
});

test('落空但响应里有候选时，candidates 如实带出来（诊断/统计用），不等于 word', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: offSetFetch,
  });
  assert.deepEqual(r.candidates.map((c) => c.label), ['container'], '最后一次拿到的候选要如实带出');
  assert.equal(r.word, null, '带出候选 ≠ 选中候选');
});

test('帧质检只做一次：判一次就够，绝不因为要"重试一次请求"而重复判帧', async () => {
  // 追加 1 的另一半：mount() 里那条 judgeFrame 必须拆掉，本模块是唯一判帧点。
  // 若把判帧摆在两次尝试的循环里，同一帧会被判两次——两处判定将来会各自漂移，
  // 而且"这一帧被拒了几次"会凭次数翻倍（retry_rate 的输入）。
  const real = await import('../web/units/frame-qc.mjs');
  let judged = 0;
  const countingQC = {
    judgeFrame(stats) { judged += 1; return real.judgeFrame(stats); },
  };
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: failFetch, frameQC: countingQC,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(judged, 1, `两次尝试共用一帧，判帧只应发生 1 次（实测 ${judged} 次）`);
});

test('一帧只取一次：两次尝试针对同一帧，不重新按一次快门（不做隐式连拍）', async () => {
  // 全局约束 6（识物不做自动连拍兜底）：`grab()` 是"用户按了快门"，一次点击就一次。
  // 两次"尝试"重试的是**网络请求**，不是重新取帧——后者等于偷偷连拍，也白白多花一次调用。
  let grabs = 0;
  const r = await recognizeWithFallback({
    grab: async () => { grabs += 1; return { blob: new Blob(['x']), stats: OK_STATS }; },
    acceptableSets: sets, exclude: [], fetchImpl: failFetch,
  });
  assert.equal(r.attempts, 2);
  assert.equal(grabs, 1, `一次快门只取一帧（实测取了 ${grabs} 帧）——多取就是自动连拍`);
});

// ──────────────────────────────── 追加 2：把「配置问题」与「识别失败」分开记录 ────────────────────────────────

test('reason 区分：候选一个都不在可接受集里 → not_in_acceptable_set（内容配置问题）', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: offSetFetch,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
  assert.equal(r.reason, 'not_in_acceptable_set');
});

test('reason 区分：命中的候选全被 exclude 掉 → all_matched_excluded（与配置问题分开）', async () => {
  // 这条与上一条**必须不同**：可接受集是对的（mug 命中了），只是这一轮把 mug 排除了
  // （复现时"别再把刚学过的词取一遍"）。把它记成 not_in_acceptable_set 会让人去改词表，
  // 而真正该看的是排除规则——Task 3 review 指出的数据质量缺口就在这里。
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: ['mug'], fetchImpl: okFetch,
  });
  assert.equal(r.mode, 'manual');
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.ALL_MATCHED_EXCLUDED);
  assert.equal(r.reason, 'all_matched_excluded');
  assert.notEqual(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
});

test('reason 区分：请求本身失败（HTTP 错）→ request_failed，而不是任何一种"候选不行"', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: failFetch,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.REQUEST_FAILED);
  assert.equal(r.reason, 'request_failed');
});

test('reason 区分：响应结构非法（HTTP 200 但 candidates 不是数组）→ response_invalid', async () => {
  // 「请求失败」与「回来了但不是我们要的结构」是两件事：前者要重试，后者要改服务端/模型契约。
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: malformedFetch,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.RESPONSE_INVALID);
  assert.equal(r.reason, 'response_invalid');
});

test('reason 区分：候选数组为空 → no_candidates（模型没认出东西，不是词表配错）', async () => {
  const emptyFetch = async () => ({ ok: true, json: async () => ({ ok: true, candidates: [] }) });
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: emptyFetch,
  });
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.NO_CANDIDATES);
  assert.notEqual(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
});

test('reason 是枚举里的一员且四类互不相同（下游按它分列统计，取值不能自由发挥）', () => {
  const values = Object.values(RECOGNIZE_FAIL_REASONS);
  assert.equal(new Set(values).size, values.length, '四类必须互不相同');
  for (const v of values) assert.equal(typeof v, 'string');
  assert.deepEqual([...values].sort(), [
    'all_matched_excluded', 'no_candidates', 'not_in_acceptable_set', 'request_failed', 'response_invalid',
  ].sort());
  assert.ok(Object.isFrozen(RECOGNIZE_FAIL_REASONS), '枚举必须冻结：统计口径不许被运行时改写');
});

test('reason 只反映"最后一次尝试"的失败原因（降级那一刻的实况）', async () => {
  // 第一次因为请求失败、第二次因为候选不在集里：最终记下的必须是**第二次**——
  // 降级是在那一刻发生的，记第一次会让人去查一个已经恢复的故障。
  let call = 0;
  const flakyThenOffSet = async () => {
    call += 1;
    return call === 1 ? failFetch() : offSetFetch();
  };
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: flakyThenOffSet,
  });
  assert.equal(r.attempts, 2);
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.NOT_IN_ACCEPTABLE_SET);
});

test('初次就命中的成功路径不该带失败原因（reason 只在落空时有值）', async () => {
  const r = await recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: okFetch,
  });
  assert.equal(r.mode, 'ok');
  assert.equal(r.reason, undefined, '成功时不要给一个"原因"字段，免得被当成失败读');
});

test('manual 档必须给出可用的手选词包（不然界面只能显示"失败"，用户无路可走）', () => {
  // 场景词包（设计文档 §5.1 的"退到场景词包手选"）。它是**预声明**的，不是模型候选的兜底——
  // 后者会把上位词放回来，正是 pick-word 明确拒绝的事。
  assert.ok(Array.isArray(MANUAL_PICK_SCENE_WORDS));
  assert.ok(MANUAL_PICK_SCENE_WORDS.length >= 2, '至少要有两个可挑的词');
  for (const w of MANUAL_PICK_SCENE_WORDS) {
    assert.equal(typeof w, 'string');
    assert.match(w, /^[a-z][a-z '-]*$/, `手选词必须是小写英文词：${w}`);
  }
  assert.ok(Object.isFrozen(MANUAL_PICK_SCENE_WORDS), '词包冻结：手选词表不许被运行时改写');
});

// ──────────────────────────────────────── 接口契约与纯逻辑约束 ────────────────────────────────────────

test('recognize 用 multipart 发到 /api/recognize，字段名固定为 image', async () => {
  // 字段名/路径是客户端与服务端之间的契约：改一处不改另一处，端到端就静默失联
  // （服务端只会说"没带图片"，看起来像用户没拍）。
  const seen = [];
  const spyFetch = async (url, init) => {
    seen.push({ url, init });
    return okFetch();
  };
  await recognize(new Blob(['x']), { fetchImpl: spyFetch });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/recognize');
  assert.equal(seen[0].init.method, 'POST');
  assert.ok(seen[0].init.body instanceof FormData, '必须用 FormData（服务端按 multipart 解析）');
  assert.ok(seen[0].init.body.get('image') !== null, 'FormData 里必须有 image 字段');
});

test('请求被拒（res.ok 为假）时抛出，且错误信息带上状态码', async () => {
  // 断言必须落在**消息里带 502** 上，而不是"抛了就行"：少了 `if (!res.ok) throw` 这一句，
  // 代码会接着调 `res.json()`，假响应没有 json() → 抛的是 TypeError（"res.json is not a function"），
  // 于是"抛了"依然成立、测试依然绿，而 HTTP 状态码这条诊断信息已经丢了。
  await assert.rejects(
    () => recognize(new Blob(['x']), { fetchImpl: async () => ({ ok: false, status: 502 }) }),
    (err) => /502/.test(String(err?.message)) && err.code === 'request_failed',
  );
});

test('res.json() 自身抛异常（响应不是 JSON）→ 抛出，不返回空候选', async () => {
  await assert.rejects(
    () => recognize(new Blob(['x']), {
      fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    }),
    /JSON|Unexpected/i,
  );
});

test('帧太暗/太糊分别如实带出自己的 reason（不得一律报太暗）', async () => {
  for (const [stats, expected] of [
    [{ brightness: 10, laplacianVar: 200 }, 'too_dark'],
    [{ brightness: 128, laplacianVar: 1 }, 'too_blurry'],
  ]) {
    const r = await recognizeWithFallback({
      grab: async () => ({ blob: new Blob(['x']), stats }),
      acceptableSets: sets, exclude: [], fetchImpl: okFetch,
    });
    assert.equal(r.mode, 'frame_rejected');
    assert.equal(r.reason, expected);
  }
});

test('被拒的帧不消耗尝试次数：attempts 记的是"真的问过模型几次"', async () => {
  // brief 的用例只钉了 calls === 0；attempts 若记成 1，下游"重拍了几次"的统计算法就偏了。
  const r = await recognizeWithFallback({
    grab: async () => ({ blob: new Blob(['x']), stats: { brightness: 10, laplacianVar: 10 } }),
    acceptableSets: sets, exclude: [], fetchImpl: okFetch,
  });
  assert.equal(r.mode, 'frame_rejected');
  assert.equal(r.attempts, 0, '没送到模型就不算一次尝试');
});

test('帧被拒时 candidates 是空数组而不是 undefined（调用方不必区分两种"没有"）', async () => {
  const r = await recognizeWithFallback({
    grab: async () => ({ blob: new Blob(['x']), stats: { brightness: 10, laplacianVar: 10 } }),
    acceptableSets: sets, exclude: [], fetchImpl: okFetch,
  });
  assert.deepEqual(r.candidates, []);
});

test('grab() 抛错时原样往上冒（VIDEO_NOT_READY 是用户情形，不许被本模块吞成 manual）', async () => {
  const notReady = Object.assign(new Error('grabFrame: 视频还没出画'), { code: 'VIDEO_NOT_READY' });
  await assert.rejects(
    () => recognizeWithFallback({
      grab: async () => { throw notReady; },
      acceptableSets: sets, exclude: [], fetchImpl: okFetch,
    }),
    /视频还没出画/,
  );
});

test('judgeFrame 抛的 RangeError 原样往上冒：绝不 catch 成一次"这张照片不行"', async () => {
  // 编程错误（契约违约）不是用户情形。catch 掉它会让 frame_rejected 落一条假记录、
  // 把缺陷记到用户头上，并污染 retry_rate（共享上下文全局约束 3 的反面）。
  await assert.rejects(
    () => recognizeWithFallback({
      grab: async () => ({ blob: new Blob(['x']), stats: { brightness: NaN, laplacianVar: 10 } }),
      acceptableSets: sets, exclude: [], fetchImpl: okFetch,
    }),
    RangeError,
  );
});

// ───────────────────────────────── 超时闸（Task 7 修复轮 · Critical 2）─────────────────────────────────
//
// `fetch` 默认**没有**超时：上游连接半开（不回、也不断）时这个 Promise 永久 pending，
// 界面卡在 capturing、每多点一次快门就多挂一个请求，而且**一条事件都不会落**（判据 B 连这一轮
// 都统计不到）。下面两条钉的就是"必须在注入的上限内收口成一次普通失败"。

/**
 * 一个永远不回话、但**如实遵守 signal 契约**的 fetch —— 真实 `fetch` 在半开连接上就是这个行为。
 * （只让 Promise 永久 pending 而不理 signal 的假 fetch 无法被任何调用方中止，测不出这条性质。）
 */
const stalledFetch = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});

test('识物请求有上限：上游永不回话时必须在上限内抛 request_failed，绝不永久挂住', async () => {
  const started = Date.now();
  await assert.rejects(
    () => settlesWithin(
      recognize(new Blob(['x']), { fetchImpl: stalledFetch, timeoutMs: 30 }),
      2000, '识物请求',
    ),
    (err) => err.code === RECOGNIZE_FAIL_REASONS.REQUEST_FAILED && /超时|timeout/i.test(String(err.message)),
    '超时要按"请求失败"报，且消息里说清是超时（不是"响应结构非法"）',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `必须在注入的上限（30ms）内收口，实测 ${elapsed}ms——挂住就等于界面卡死`);
});

test('超时在降级链路上也是一档普通失败：mode=manual + reason=request_failed（attempts 如实为 2）', async () => {
  // 看门狗：把超时闸拆掉时这条会**干净地失败**，而不是把整个测试文件挂死
  // （挂死会被变异探针记成 TIMEOUT，读不出"没被抓到"）。
  const r = await settlesWithin(recognizeWithFallback({
    grab: goodGrab, acceptableSets: sets, exclude: [], fetchImpl: stalledFetch, timeoutMs: 30,
  }), 3000, '降级链路');
  assert.equal(r.mode, 'manual');
  assert.equal(r.word, null, '超时同样不许假造词');
  assert.equal(r.reason, RECOGNIZE_FAIL_REASONS.REQUEST_FAILED);
  assert.equal(r.attempts, 2, '两次尝试都在上限内收口（不是第一次挂到天荒地老）');
});

test('识物请求带上 signal（没有它，客户端这一腿根本无从收口）', async () => {
  const seen = [];
  await recognize(new Blob(['x']), {
    fetchImpl: async (url, init) => { seen.push(init); return okFetch(); },
  });
  assert.ok(seen[0].signal instanceof AbortSignal, '客户端 fetch 必须带 signal');
});

test('两条腿的上限关系：客户端 > 服务端（上游慢但活着时，由服务端先如实报自己的失败）', () => {
  // 若客户端先超时，我们只会知道"我等烦了"，永远分不清是模型慢、服务端挂了还是网络断了；
  // 服务端先超时则会回它自己的错误形状（502 upstream_failed）→ 客户端看到 HTTP 错误
  // → recognize_failed{reason:'request_failed'}。这条不变量跨两个模块，只有断言能拦住。
  assert.ok(Number.isInteger(RECOGNIZE_REQUEST_TIMEOUT_MS) && RECOGNIZE_REQUEST_TIMEOUT_MS > 0);
  assert.ok(Number.isInteger(UPSTREAM_TIMEOUT_MS) && UPSTREAM_TIMEOUT_MS > 0);
  assert.ok(
    RECOGNIZE_REQUEST_TIMEOUT_MS > UPSTREAM_TIMEOUT_MS,
    `客户端上限 ${RECOGNIZE_REQUEST_TIMEOUT_MS}ms 必须 > 服务端上游上限 ${UPSTREAM_TIMEOUT_MS}ms`,
  );
});

test('本模块不 import 任何浏览器 API（shared-context 的纯逻辑约定）', () => {
  // 与 frame-qc / pick-word 同一条纪律：纯逻辑模块要能在 Node 里直接测，且不得自己碰 DOM/相机。
  // 用源码扫描钉住（不是靠约定）：出现 document/window/navigator 之类即失败。
  const src = fs.readFileSync(fileURLToPath(new URL('../web/units/recognize.mjs', import.meta.url)), 'utf8');
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
  assert.deepEqual(
    importLines.map((l) => l.trim()),
    ["import { judgeFrame } from './frame-qc.mjs';", "import { pickWord } from './pick-word.mjs';"],
    '只允许 import 这两个纯逻辑模块',
  );
  assert.doesNotMatch(src, /\b(document|window|navigator|localStorage|indexedDB)\b/);
});
