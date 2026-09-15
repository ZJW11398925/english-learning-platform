// tests/speak.test.mjs
//
// 跟读判定的纯逻辑测试（设计文档 §4.3）：**只判"有没有说出目标词"**，不做音素级音准评分
// ——那是本切片显式写下的妥协，任何"打分/相似度"的实现都是超出设计的发明。
//
// 本文件的结构：前 5 条是计划里给的测试（**逐字保留**，它们是这份模块的验收基线），
// 后面是 Task 9 补的边界：标点与大小写、空值不抛错、多词目标词、转写原样保留、
// 可用性判定的"必须是函数"这一层，以及"本模块零浏览器 API"。
//
// **一次口径变更**（控制器裁定，见 `task-9-report.md`）：多词目标词从"永远判不出"改成
// "连续 token 子序列"匹配。单词目标词的用例（含计划那 5 条）在变更前后逐字未动、全绿。
//
// 为什么会需要后面那些：本项目已三次被证明"测试全绿 ≠ 算法被锁住"（Task 3 的 18 个变异体里，
// 计划自带的 11 条测试只抓到 4 个）。所以每一条边界都要有用例，否则变异探针只能报 MISSED。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checkSpeech, isSpeechAvailable } from '../web/units/speak.mjs';

// ─────────────────────────── 计划自带的 5 条（逐字保留）───────────────────────────

test('转写里出现目标词即算说出（大小写与标点无关）', () => {
  assert.equal(checkSpeech('mug', 'I see a Mug.').said, true);
});

test('只出现词的一部分不算说出（避免 mug 与 mugshot 混淆）', () => {
  assert.equal(checkSpeech('mug', 'mugshot').said, false);
});

test('完全没念到则 said=false，且原样保留转写', () => {
  const r = checkSpeech('mug', 'I see a cup');
  assert.equal(r.said, false);
  assert.equal(r.transcript, 'I see a cup');
});

test('空转写不抛错', () => {
  assert.equal(checkSpeech('mug', '').said, false);
});

test('没有 SpeechRecognition 时判为不可用（走手动打勾降级）', () => {
  assert.equal(isSpeechAvailable({}), false);
  assert.equal(isSpeechAvailable({ SpeechRecognition: function R() {} }), true);
  assert.equal(isSpeechAvailable({ webkitSpeechRecognition: function R() {} }), true);
});

// ─────────────────────────── Task 9 补的边界 ───────────────────────────

test('词边界按 token 判：标点当分隔符，同一句里出现两次也算说出', () => {
  // brief §3.1 点名的那条：`I see a Mug.` 只覆盖了"句号 + 首字母大写"，
  // 这里把逗号、感叹号、重复出现一次都钉住。
  assert.equal(checkSpeech('mug', 'a mug, and a MUG!').said, true);
  // 但 token 相等仍然是**整个 token**：mugs / mugshot 都不算（英文的复数与合成词是别的词）
  assert.equal(checkSpeech('mug', 'two mugs').said, false);
  assert.equal(checkSpeech('mug', 'a mugshot').said, false);
});

test('目标词的大小写无关（识别链路给的词可能带大写）', () => {
  assert.equal(checkSpeech('MUG', 'I see a mug.').said, true);
  assert.equal(checkSpeech('Mug', 'MUG').said, true);
});

test('多词目标词：按"连续 token 出现"判定（控制器裁定的口径变更）', () => {
  // 背景（task-9-report 有完整记录）：更早的实现把目标词整体当一个 token 去比，于是含空格/连字符的
  // 目标词**永远判不出"说出"**——而这是**可达**的：`web/app.mjs` 的 ACCEPTABLE_SETS 里有
  // `laptop: ['laptop', 'notebook computer']`。用户念对了却被判"没说"、重试永远过不去，
  // 界面还不告诉他这个词判不了（一处用户可见的静默失败）。控制器因此裁定改为
  // **连续 token 子序列**匹配。
  assert.equal(checkSpeech('notebook computer', 'I have a notebook computer at home.').said, true,
    '连续出现即算说出（这次变更要修的就是这一件事）');
  assert.equal(checkSpeech('notebook computer', 'a NOTEBOOK, COMPUTER!').said, true, '大小写与标点仍然无关');
  // 反向：不完整 / 词序颠倒 / 中间插了别的词，都不算——判据不许松成"这些词都出现过"
  assert.equal(checkSpeech('notebook computer', 'I have a notebook.').said, false, '只说了前半截');
  assert.equal(checkSpeech('notebook computer', 'computer notebook').said, false, '词序颠倒不算');
  assert.equal(checkSpeech('notebook computer', 'notebook and computer').said, false, '中间插了别的词不算');
  // 单词目标词的行为在这次变更里**一个字都没变**（计划那 5 条用例就是这条保证）
  assert.equal(checkSpeech('mug', 'two mugs').said, false);
  assert.equal(checkSpeech('mug', 'a mugshot').said, false);
});

test('连字符与空格同形：`ice-cream` 与 `ice cream` 互相都判得出', () => {
  assert.equal(checkSpeech('ice-cream', 'ice cream').said, true, '连字符只是分隔符，不是词的一部分');
  assert.equal(checkSpeech('ice cream', 'ice-cream').said, true);
  assert.equal(checkSpeech('ice-cream', 'icecream').said, false, '连写成一个词仍算别的词（不猜词形）');
});

test('目标词切完没有 token（空串 / 纯符号 / 纯空白）→ 判没说，且不抛错', () => {
  // 这一条钉住的是"空目标词不许命中任何转写"：判定的默认值必须是"没说"，
  // 否则一条配置错误（词表里写了空串）会让所有人**自动**通过跟读。
  for (const bad of ['', '   ', '!!!', '---', '…', null, undefined]) {
    const r = checkSpeech(bad, 'I see a mug.');
    assert.equal(r.said, false, `目标词为 ${JSON.stringify(bad)} 时必须判没说，而不是命中任何转写`);
    assert.equal(r.transcript, 'I see a mug.', '转写仍要原样带回来');
  }
});

test('非字母字符是分隔符，所以 mug2 与 mug 的 2 同形（这条规则如实钉住）', () => {
  // 转写来自语音引擎，可能带数字/中文/标点。当前规则把它们一律当分隔符，
  // 于是 `mug2` 会被判成说出了 `mug`。**这不是"应该如此"，而是这条规则的后果**：
  // 钉住它是为了让将来改分隔符类的人知道自己在改什么（改动会让这条用例红）。
  assert.equal(checkSpeech('mug', 'mug2').said, true);
  assert.equal(checkSpeech('mug', 'mug的').said, true);
});

test('空值不抛错：null / undefined / 非字符串的转写都按"没说出"处理', () => {
  for (const bad of [null, undefined]) {
    const r = checkSpeech('mug', bad);
    assert.equal(r.said, false, `转写为 ${String(bad)} 时不许抛错，也不许判成说出`);
    assert.equal(r.transcript, '');
  }
  assert.equal(checkSpeech('', 'mug').said, false, '目标词为空 → 永不判说出');
  assert.equal(checkSpeech('', 'mug').transcript, 'mug', '目标词为空也要把转写原样带回来');
  assert.equal(checkSpeech(null, 'mug').said, false, '目标词为 null → 永不判说出');
  assert.equal(checkSpeech(undefined, '').said, false);
});

test('转写原样保留：不 trim、不改写、不动大小写（它是"用户到底说了什么"的唯一证据）', () => {
  const said = '  I say Mug ,  twice MUG. ';
  const r = checkSpeech('mug', said);
  assert.equal(r.said, true);
  assert.equal(r.transcript, said, '转写必须逐字带回来（trim 过就再也无法复核引擎到底给了什么）');
  assert.notEqual(r.transcript.length, said.trim().length, '这一条的输入本身带首尾空白，trim 了就会红');
  // 中文/非 ASCII 的转写同样原样带回（引擎识别错语言时，证据要留着）
  assert.equal(checkSpeech('mug', '一个 mug').transcript, '一个 mug');
});

test('返回值形状固定：永远有 said 与 transcript 两个字段', () => {
  for (const [w, t] of [['mug', 'mug'], ['mug', 'cup'], ['mug', ''], ['', '']]) {
    const r = checkSpeech(w, t);
    assert.deepEqual(Object.keys(r).sort(), ['said', 'transcript']);
    assert.equal(typeof r.said, 'boolean');
    assert.equal(typeof r.transcript, 'string');
  }
});

test('可用性判定只认函数：同名字段是对象/字符串/0 都不算可用', () => {
  // `typeof x === 'function'` 与 `x != null` 的差别就在这里：后者会把一个
  // 随便什么占位符当成"浏览器支持转写"，于是界面进到"按住说话"那条路，
  // 而 `new` 一个对象当构造器会在用户点下去的那一刻抛错——一次 UI 崩溃。
  assert.equal(isSpeechAvailable({ SpeechRecognition: {} }), false);
  assert.equal(isSpeechAvailable({ SpeechRecognition: 'yes' }), false);
  assert.equal(isSpeechAvailable({ SpeechRecognition: 0 }), false);
  assert.equal(isSpeechAvailable({ SpeechRecognition: null }), false);
  assert.equal(isSpeechAvailable({ webkitSpeechRecognition: {} }), false);
  assert.equal(isSpeechAvailable({ SpeechRecognition: {}, webkitSpeechRecognition: function R() {} }), true,
    '只要有一个是函数就算可用（Chrome 两个都挂，Safari 只有 webkit 那个）');
});

test('可用性判定不吃坏入参：undefined / null / 数字 / 字符串一律判"不可用"且不抛错', () => {
  for (const bad of [undefined, null, 0, 1, 'window', true, Symbol('w')]) {
    assert.equal(isSpeechAvailable(bad), false, `isSpeechAvailable(${String(bad)}) 必须是 false 而不是抛错`);
  }
});

test('本模块零浏览器 API 依赖（纯逻辑：Node 里可直接测）', () => {
  // 与 frame-qc / pick-word / recognize 同一条纪律。用源码扫描钉住，而不是靠约定：
  // 出现 window / document / navigator 之类就红——一旦有人把 `isSpeechAvailable()` 的默认值
  // 写成内部读浏览器全局，这个模块就不再能在 Node 里直接测（而它正是被 Node 测的那一层）。
  const src = readFileSync(fileURLToPath(new URL('../web/units/speak.mjs', import.meta.url)), 'utf8');
  const importLines = src.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
  assert.deepEqual(importLines, [], '零 import：本模块不依赖任何别的模块');
  // **注释先剥掉再扫**：本模块的文件头正是用这些词解释"为什么这里不许碰它们"，
  // 不剥就等于"注释里提一次就红"——那样这条断言会逼着人把解释删掉，方向是反的。
  // 剥的是行注释与块注释（真代码里没有字符串形式的注释，故不需要更复杂的词法分析）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(document|window|navigator|localStorage|indexedDB|globalThis)\b/,
    '真代码里不许出现浏览器全局（剥掉注释后仍命中即为回归）');
});
