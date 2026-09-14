import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback, VERDICTS, ERROR_TYPES } from '../web/units/feedback.mjs';

const good = { verdict: 'flawed', error_type: 'collocation', rewrite: 'I drink from a mug.', note: '搭配更自然' };

test('合法响应通过并原样返回', () => {
  const r = validateFeedback(good);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, good);
});

test('uncertain 是合法判定，不被当作错误', () => {
  const r = validateFeedback({ verdict: 'uncertain', error_type: 'none', rewrite: null, note: '拿不准' });
  assert.equal(r.ok, true);
});

test('缺字段则失败并报出字段名（不猜测填充）', () => {
  const r = validateFeedback({ verdict: 'correct', error_type: 'none' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('rewrite')));
  assert.ok(r.errors.some((m) => m.includes('note')));
});

test('verdict 取值越界则失败', () => {
  const r = validateFeedback({ ...good, verdict: 'bad' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('verdict')));
});

test('error_type 取值越界则失败', () => {
  const r = validateFeedback({ ...good, error_type: 'spelling' });
  assert.equal(r.ok, false);
});

test('correct 与 none 的搭配关系被强制', () => {
  assert.equal(validateFeedback({ ...good, verdict: 'correct', error_type: 'grammar' }).ok, false);
});

test('rewrite 允许 null，但去掉首尾空白后不能是空字符串', () => {
  assert.equal(validateFeedback({ ...good, rewrite: null }).ok, true);
  assert.equal(validateFeedback({ ...good, rewrite: '   ' }).ok, false);
});

test('常量与设计文档一致', () => {
  assert.deepEqual([...VERDICTS], ['correct', 'flawed', 'uncertain']);
  assert.deepEqual([...ERROR_TYPES], ['word_choice', 'collocation', 'grammar', 'none']);
});

// ── 以下为 Task 4 的消歧补强（brief 未覆盖的分支；上面的 8 条逐字照抄 brief）──

test('非对象输入一律判不可用（不抛 TypeError，且消息说明"必须是对象"）', () => {
  // 消歧 #4：null / undefined / 原始值都不是响应对象，属性访问不得把它们炸成 TypeError。
  for (const bad of [null, undefined, 42, 'correct', true, () => {}]) {
    const r = validateFeedback(bad);
    assert.equal(r.ok, false, `入参 ${String(bad)} 应判不可用`);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, '失败必须给出非空 errors');
    assert.ok(r.errors[0].includes('对象'), `消息应说明"必须是对象"，实际：${r.errors[0]}`);
  }
});

test('数组不是合法响应（typeof 是 object，不得被当成"缺四个字段"的对象）', () => {
  // 消歧 #4：不显式拦数组的话，`['correct','none',null,'好']` 会被报成"缺 verdict/error_type/
  // rewrite/note"——虽然同样判失败，但诊断指向了错误的原因，调用方会去查根本不缺的字段。
  const r = validateFeedback(['correct', 'none', null, '好']);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, `数组应只报一条"必须是对象"，实际：${r.errors.join(' / ')}`);
  assert.ok(r.errors[0].includes('对象'));
});

test('verdict 与 error_type 的搭配关系只在两者各自合法时才判（越界只报越界，不叠加误导消息）', () => {
  // 消歧 #5：error_type 已越界时再补一句"correct 必须配 none"会把诊断带偏——真正的问题是
  // 取值不在枚举里，而不是搭配错了。
  const r = validateFeedback({ verdict: 'correct', error_type: 'spelling', rewrite: null, note: '好' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, `应只报越界这一条，实际：${r.errors.join(' / ')}`);
  assert.ok(r.errors[0].includes('error_type'));
  assert.ok(r.errors[0].includes('spelling'), '消息要带上实际取值，便于诊断');
});

test('flawed 必须指出 error_type（搭配关系的另一半，brief 只覆盖了 correct 一侧）', () => {
  const r = validateFeedback({ ...good, error_type: 'none' });
  assert.equal(r.ok, false, 'flawed 配 none 等于"判定有错却说不清错在哪"，不可用');
  assert.ok(r.errors.some((m) => m.includes('error_type')));
});

test('rewrite 非字符串（数字）被拒——不靠隐式转换把脏数据洗成合法', () => {
  const r = validateFeedback({ ...good, rewrite: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('rewrite')));
});

test('note 是空白串时被拒（brief 只覆盖了"缺 note"这一种）', () => {
  const r = validateFeedback({ ...good, note: '   ' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('note')));
});

test('四个字段各自的问题一次报全，每条消息都点名出错字段（不在第一条错误上短路）', () => {
  // 消歧 #1 + #2：调用方把 errors 拼成诊断原因，既要"哪个字段错"也要"一共有哪些错"。
  const r = validateFeedback({ verdict: 'bad', error_type: 'spelling', rewrite: 42, note: '' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4, `四个字段各一条，实际：${r.errors.join(' / ')}`);
  const fields = ['verdict', 'error_type', 'rewrite', 'note'];
  for (const m of r.errors) {
    assert.ok(fields.some((f) => m.includes(f)), `消息未点名出错字段：${m}`);
  }
});

test('成功时 value 就是入参本身（原样返回：不 trim、不规整、不深拷贝）', () => {
  // 消歧 #3：入库记录必须是模型原话，校验器只是闸门，不是规整器。
  const payload = { verdict: 'correct', error_type: 'none', rewrite: '  I drink from a mug.  ', note: ' 用词准确 ' };
  const r = validateFeedback(payload);
  assert.equal(r.ok, true);
  assert.equal(r.value, payload, '必须是同一个对象引用，不得返回副本或规整后的新对象');
  assert.equal(r.value.rewrite, '  I drink from a mug.  ', '首尾空白不得被 trim 掉');
});

test('返回结构是二选一的联合：成功时没有 errors，失败时没有 value', () => {
  // Task 8 的调用方在 !ok 时读 v.errors、ok 时读 v.value；两者不得同时存在。
  const okRes = validateFeedback(good);
  assert.equal(okRes.ok, true);
  assert.equal('errors' in okRes, false, '成功结果里不得夹带 errors');
  const badRes = validateFeedback({ ...good, verdict: 'bad' });
  assert.equal(badRes.ok, false);
  assert.equal(badRes.value, undefined, '失败结果里不得夹带半成品 value');
});

test('多余的键一律放行并原样保留（校验器是闸门，不是封闭 schema）', () => {
  const payload = { ...good, model: 'deepseek-flash', usage: { tokens: 12 } };
  const r = validateFeedback(payload);
  assert.equal(r.ok, true);
  assert.equal(r.value, payload);
});

test('uncertain 通过时 value 仍是 uncertain——不得被改写成"有错"或"没错"（全局约束 4）', () => {
  // 这条挡的是最坏的一种"静默降级"：校验器把"拿不准"偷偷改成 flawed/correct 再报成功，
  // 统计口径（uncertain 单独计数、不计入通过率）会被污染，而调用方看不出任何异常。
  const payload = { verdict: 'uncertain', error_type: 'none', rewrite: null, note: '拿不准' };
  const r = validateFeedback(payload);
  assert.equal(r.ok, true);
  assert.equal(r.value.verdict, 'uncertain', '不得把"拿不准"伪装成判定');
  assert.equal(r.value, payload);
});

test('空对象只报四个字段缺失，不叠加"取值越界: undefined"的噪音', () => {
  // 字段缺失时不该再按"取值越界"报一遍 undefined：那是同一件事的第二种说法，会把诊断翻倍。
  const r = validateFeedback({});
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4, `四个字段各一条，实际：${r.errors.join(' / ')}`);
  for (const m of r.errors) {
    assert.ok(m.includes('缺少字段'), `不该出现"缺少字段"以外的诊断：${m}`);
  }
});
