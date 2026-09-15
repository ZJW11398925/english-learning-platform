// tests/diagnostics-html.test.mjs
//
// 诊断页的**行为**测试（不是文案比对）：把 `web/diagnostics.html` 里那段 module 脚本抽出来，
// 在一份假 DOM + 假 localStorage 上真跑一遍，然后看它渲染出了什么。
//
// 为什么值得这么测：诊断页是**真机走查的唯一入口**——清单第 25/31/37 项、以及 Task 9 新增的
// 复现与落盘各项全靠它。它一旦算错，走查的人（非技术读者）没有任何办法发现，
// 只会把错的数字抄回来。而它此前**一条测试都没有**（`tests/index-html.test.mjs` 只覆盖
// `web/index.html`）。控制器在 Task 9 派发时点名要求给它加测试。
//
// 这里钉住三件最容易退化的事：
//   1. **复现的两种模式分列**（`recurrence_scene` / `recurrence_manual` 各数各的）——
//      合并成一个总数就等于把"手选占比高 = 跨场景没兑现"这个信号抹掉；
//   2. **同一句话不许显示成两行而让人以为写了两句**：判定表与落盘表各记一件事，
//      页面上必须写明这是同一句的两笔账；
//   3. **词表要能看出排期**（档位 + 下次该复习）：判断"回环有没有把排期推回原点"全靠它。
//
// 本文件**不进** `scripts/mutation-probe.mjs` 的 TEST_FILES：探针的临时工作树只复制模块与
// 测试文件，不带 `web/diagnostics.html`，跑进来会因缺文件而假红（与 tests/index-html.test.mjs 同）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML_PATH = fileURLToPath(new URL('../web/diagnostics.html', import.meta.url));
const html = readFileSync(HTML_PATH, 'utf8');

/** 页面里那段 module 脚本（`<script type="module">…</script>`）。 */
const scriptOf = (src) => {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(src);
  assert.ok(m, '诊断页必须有一段 type="module" 的脚本（render 就在里面）');
  return m[1];
};

/** 假 DOM：只要 `getElementById` 与元素上那几个属性/方法。 */
function fakeDoc() {
  const els = new Map();
  const make = (id) => ({
    id,
    innerHTML: '',
    value: '',
    textContent: '',
    handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    select() { this.selected = true; },
  });
  return {
    els,
    getElementById(id) {
      if (!els.has(id)) els.set(id, make(id));
      return els.get(id);
    },
  };
}

/** 假 localStorage：读得回写入的两把键，别的键一律 null。 */
function fakeStorage({ events = null, words = null } = {}) {
  const data = new Map();
  if (events !== null) data.set('elp.events', JSON.stringify(events));
  if (words !== null) data.set('elp.words', JSON.stringify(words));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, v) };
}

/**
 * 跑一遍诊断页的脚本，返回它渲染到各元素上的东西。
 * 用 `new Function` 把脚本包成函数并注入 `document` / `localStorage`——脚本本身是模块语法，
 * 但没有 import/export，所以这样包是安全的（也正是"不引 jsdom"这条零依赖约定的解法）。
 */
function renderDiagnostics({ events = null, words = null } = {}) {
  const document = fakeDoc();
  const localStorage = fakeStorage({ events, words });
  const navigator = { clipboard: { writeText: async () => {} } };
  // eslint-disable-next-line no-new-func
  const run = new Function('document', 'localStorage', 'navigator', 'setTimeout', scriptOf(html));
  run(document, localStorage, navigator, setTimeout);
  const get = (id) => document.getElementById(id);
  return {
    summary: get('summary').innerHTML,
    rounds: get('rounds').innerHTML,
    feedback: get('feedback').innerHTML,
    composed: get('composed').innerHTML,
    recurrence: get('recurrence').innerHTML,
    words: get('words').innerHTML,
    dump: get('dump').value,
  };
}

/** 数一段 HTML 里 `<tr>` 的行数（表头单独一行也计入，故断言用「≥」或减去表头）。 */
const rowCount = (tableHtml) => (tableHtml.match(/<tr>/g) ?? []).length;

const ev = (type, payload, over = {}) => ({
  ts: 1_700_000_000_000, type, wordId: null, roundIndex: 1, sessionId: 's1', payload, ...over,
});

// ─────────────────────────── 结构 ───────────────────────────

test('页面结构：脚本里 getElementById 的每个 id 都真的在 HTML 里（写错就是白屏）', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = [...scriptOf(html).matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 7, `脚本应该渲染 7 个区块，实测 ${wanted.join(', ')}`);
  for (const id of wanted) {
    assert.ok(ids.has(id), `脚本要写进 #${id}，但页面上没有这个 id（浏览器里会静默不显示）`);
  }
});

test('页面上的可见文字不许出现 markdown 强调符（页面上不会渲染 markdown，星号会照原样显示）', () => {
  // 这条例外检查覆盖**静态文案**（脚本里的模板串由下面那条用例覆盖渲染结果）。
  const staticText = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(staticText, /\*\*/, '静态文案里出现了字面 `**`（Task 9 顺手清掉的那一类）');
});

// ─────────────────────────── 复现：两种模式分列 ───────────────────────────

test('复现两种模式**分列**计数：识物命中与手选各数各的，不合并成一个总数', () => {
  const events = [
    ev('recognize_ok', { word: 'mug', attempts: 1, candidates: ['mug'] }),
    ev('recurrence_scene', { word: 'mug', scene: 'desk', expectedScene: 'kitchen', sceneChanged: true }),
    ev('recurrence_manual', { word: 'book', scene: '手动选择', expectedScene: 'desk', sceneChanged: false }),
    ev('recurrence_manual', { word: 'pen', scene: '手动选择', expectedScene: 'desk', sceneChanged: false }),
  ];
  const out = renderDiagnostics({ events });

  // 会话卡片里两个数各自出现
  assert.match(out.summary, /识物命中 <b>1<\/b> 条 \/ 自己手选 <b>2<\/b> 条/,
    `摘要必须把两种模式分列（实测：${out.summary.replace(/<[^>]+>/g, ' ').slice(0, 400)}）`);
  assert.match(out.dump, /复现: 识物命中=1 手选=2/, '可复制摘要里也要分列');
  // 明细表：一行一次复现（表头 1 行 + 3 行）
  assert.equal(rowCount(out.recurrence), 4, '复现明细表应有一次复现一行');
  assert.match(out.recurrence, /识物命中/);
  assert.match(out.recurrence, /自己手选/);
  assert.match(out.recurrence, /换了场景/);
  // 没换场景的那两次必须如实标出来（不许含糊成"复现了"）
  assert.match(out.recurrence, /否（没换场景，仍记了一次复现）/);
});

test('没有复现记录时给一句人话（而不是空白表）', () => {
  const out = renderDiagnostics({ events: [ev('recognize_ok', { word: 'mug', attempts: 1, candidates: ['mug'] })] });
  assert.match(out.recurrence, /还没有复现记录/);
});

// ─────────────────── 同一句：两笔账，不许看起来像写了两句 ───────────────────

test('同一句话同时出现在判定表与落盘表：各表各记一件事，且页面上写明不是写了两句', () => {
  const sentence = 'I use a cup.';
  const events = [
    ev('recognize_ok', { word: 'mug', attempts: 1, candidates: ['mug'] }),
    ev('compose_submitted', {
      sentence, word: 'mug', scene: 'kitchen', submitCount: 1, revisions: 0, dwellMs: 4000, skippedReading: true,
    }),
    ev('feedback_ok', { sentence, word: 'mug', scene: 'kitchen', verdict: 'flawed', error_type: 'word_choice', rewrite: 'I use a mug.', note: '词选得更准' }),
  ];
  const out = renderDiagnostics({ events });

  // 两张表各一行数据（各加一行表头）——**不是**把两类事件铺进同一张表变成两行
  assert.equal(rowCount(out.feedback), 2, '判定表：一次判定一行');
  assert.equal(rowCount(out.composed), 2, '落盘表：一次提交一行');
  assert.match(out.composed, /I use a cup\./);
  assert.match(out.composed, /4\.0 秒/, '停留时长按秒显示（§3.2 的敷衍样本判据要用它）');
  assert.match(out.composed, /提交次数<\/th>/, '表头要说清是"提交次数"而不是"改写次数"');
  assert.match(out.summary, /提交造句 <b>1<\/b> 次/, '"提交 1 次"是按落盘表数的');

  // 页面正文里必须有那句说明（否则读者会以为用户写了两句）
  const note = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(note, /同一句话在本页会出现两次/, '页面必须解释这两张表的关系');
  assert.match(note, /不是写了两次/, '要把"不是写了两次"说白');
  assert.match(out.dump, /造句提交 原句="I use a cup\." 提交次数=1 改写次数=0 停留=4000ms 跳过跟读=是/,
    '可复制摘要里也要带齐口径字段');
});

test('落盘表用 `submitCount`/`revisions` 两个字段，不认那个名字骗人的 `rewriteCount`', () => {
  const events = [
    ev('compose_submitted', {
      sentence: 'I use a mug.', word: 'mug', scene: 'kitchen', submitCount: 2, revisions: 1, dwellMs: 9000, skippedReading: false,
    }),
  ];
  const out = renderDiagnostics({ events });
  assert.match(out.composed, />2</, '提交次数照实显示');
  assert.match(out.composed, />1</, '改写次数照实显示');
  assert.match(out.dump, /提交次数=2 改写次数=1/);
  assert.doesNotMatch(out.dump, /rewriteCount/, '采集口径里不该再出现这个名字');
});

// ─────────────────────────── 词表（排期看得见）───────────────────────────

test('词表显示档位与下次该复习的时间：回环有没有把排期推回原点靠它看', () => {
  const T = 1_700_000_000_000;
  const words = {
    mug: { id: 'mug', word: 'mug', stage: 1, dueAt: T + 86_400_000, lastReviewedAt: T, lastScene: 'kitchen', createdAt: T },
    book: { id: 'book', word: 'book', stage: 4, dueAt: null, maintained: true, lastReviewedAt: T, lastScene: 'desk', createdAt: T },
  };
  const out = renderDiagnostics({ events: [ev('recognize_ok', { word: 'mug', attempts: 1, candidates: ['mug'] })], words });

  assert.match(out.words, /mug/);
  assert.match(out.words, /第 1 档/);
  assert.match(out.words, /已维护（不再推送）/, '跑完 7 天档的词要显示成"不再推送"，不是空白');
  assert.match(out.words, /kitchen/, '要显示上次学的场景（复现提示就用它）');
  assert.match(out.dump, /词表（复现排期）：/);
  assert.match(out.dump, /词=mug 档位=1 下次该复习=\d{4}-/, '摘要里给 ISO 时间，方便逐字对比两次读数');
  assert.match(out.dump, /词=book 档位=已维护 下次该复习=（不再推送）/);
});

// ─────────────────── 走查辅助：把到期时间改成"现在"（计划 Step 6）───────────────────

test('走查辅助按钮：把未维护的词改成"现在到期"，已维护的词不给这个按钮', () => {
  // 计划 Step 6 要求真机走查时"把 dueAt 手动改到过去再刷新"，而手机上没有开发者工具。
  // 这个按钮就是那一步的落地方式——它必须真的写回 elp.words，否则走查根本没法做。
  const T = 1_700_000_000_000;
  const words = {
    mug: { id: 'mug', word: 'mug', stage: 1, dueAt: T + 86_400_000, lastReviewedAt: T, lastScene: 'kitchen' },
    book: { id: 'book', word: 'book', stage: 4, dueAt: null, maintained: true, lastReviewedAt: T, lastScene: 'desk' },
  };
  const document = fakeDoc();
  const store = new Map([['elp.words', JSON.stringify(words)]]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  // eslint-disable-next-line no-new-func
  const run = new Function('document', 'localStorage', 'navigator', 'setTimeout', scriptOf(html));
  run(document, localStorage, { clipboard: { writeText: async () => {} } }, setTimeout);

  const wordsEl = document.getElementById('words');
  assert.match(wordsEl.innerHTML, /data-word="mug"/, '未维护的词要给"改成现在到期"按钮');
  assert.doesNotMatch(wordsEl.innerHTML, /data-word="book"/, '已维护的词不许"复活"（那会伪造一个不存在的档位）');

  // 走查辅助的点击（事件委托在容器上，测试直接把事件喂给那个回调）
  wordsEl.handlers.click({ target: { dataset: { word: 'mug' } } });

  const saved = JSON.parse(store.get('elp.words'));
  assert.ok(saved.mug.dueAt <= Date.now(), `点完之后 dueAt 必须是过去（实测 ${saved.mug.dueAt}）`);
  assert.equal(saved.mug.stage, 1, '只改到期时间，不动档位（走查不该伪造学习进度）');
  assert.equal(saved.mug.lastScene, 'kitchen', '也不动场景');
  assert.equal(saved.book.dueAt, null, '别的词一点都不许动');
  assert.match(document.getElementById('words').innerHTML, /第 1 档/, '点完要重绘（否则走查的人以为没生效）');

  // 点了不存在的词：什么都不做（不能凭空造一条记录出来）
  const before = store.get('elp.words');
  wordsEl.handlers.click({ target: { dataset: {} } });
  wordsEl.handlers.click({ target: { dataset: { word: 'nope' } } });
  assert.equal(store.get('elp.words'), before, '未知的词 id 不许写回任何东西');
});

test('完全没有记录时：词表也给一句人话，摘要不写空串', () => {
  const out = renderDiagnostics({});
  assert.match(out.summary, /还没有任何记录/);
  assert.match(out.words, /词表还是空的/);
  assert.equal(out.dump, '（无记录）');
});

test('坏数据不吃掉整页：elp.words 不是对象时不抛错', () => {
  const document = fakeDoc();
  const localStorage = {
    getItem: (k) => (k === 'elp.events' ? JSON.stringify([ev('recurrence_scene', { word: 'mug' })]) : '[]'),
  };
  // eslint-disable-next-line no-new-func
  const run = new Function('document', 'localStorage', 'navigator', 'setTimeout', scriptOf(html));
  run(document, localStorage, { clipboard: { writeText: async () => {} } }, setTimeout);
  assert.match(document.getElementById('words').innerHTML, /词表还是空的|mug/);
});
