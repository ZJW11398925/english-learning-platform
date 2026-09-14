import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWord } from '../web/units/pick-word.mjs';

const sets = { mug: ['mug', 'cup'], kettle: ['kettle'] };

test('命中可接受集时返回该词', () => {
  const r = pickWord({ candidates: [{ label: 'mug', score: 0.9 }], acceptableSets: sets, exclude: [] });
  assert.equal(r.word, 'mug');
});

test('上位词不命中可接受集，被跳过', () => {
  const r = pickWord({
    candidates: [{ label: 'container', score: 0.95 }, { label: 'cup', score: 0.6 }],
    acceptableSets: sets,
    exclude: [],
  });
  assert.equal(r.word, 'cup', 'container 不在任何可接受集内，应跳到下一个候选');
});

test('同分时按候选顺序取第一个', () => {
  const r = pickWord({
    candidates: [{ label: 'kettle', score: 0.5 }, { label: 'mug', score: 0.5 }],
    acceptableSets: sets,
    exclude: [],
  });
  assert.equal(r.word, 'kettle');
});

test('exclude 中的词被跳过（复现时避免重复取同一个词）', () => {
  const r = pickWord({
    candidates: [{ label: 'mug', score: 0.9 }, { label: 'kettle', score: 0.4 }],
    acceptableSets: sets,
    exclude: ['mug'],
  });
  assert.equal(r.word, 'kettle');
});

test('无可接受候选时返回 null，绝不退而求其次返回上位词', () => {
  const r = pickWord({ candidates: [{ label: 'container', score: 0.9 }], acceptableSets: sets, exclude: [] });
  assert.equal(r, null);
});

// ── 以下为 Task 3 的消歧补强（brief 未覆盖的分支；上面的用例逐字照抄 brief）──

test('同一对象有几个可接受词时，取候选顺序里最先命中的那个（不是分数最高）', () => {
  // 设计文档 §5.2：PickWord 的用例含"可接受词集有 3 词时选哪个"。
  // 判定只认"是否在可接受集内"，故 0.3 的 mug 先出现就赢过 0.99 的 cup。
  const r = pickWord({
    candidates: [{ label: 'mug', score: 0.3 }, { label: 'cup', score: 0.99 }],
    acceptableSets: sets,
    exclude: [],
  });
  assert.ok(r, '有两个可接受候选时必须返回结果，不得为 null');
  assert.equal(r.word, 'mug', '同属可接受集时按候选顺序取先出现的，不按 score 重排');
});

test('exclude 默认为空：不传 exclude 时不得抛错（调用方不该被迫传空数组）', () => {
  const r = pickWord({ candidates: [{ label: 'kettle', score: 0.5 }], acceptableSets: sets });
  assert.ok(r, '未传 exclude 时应按空排除集处理');
  assert.equal(r.word, 'kettle');
});

test('应跳过不在可接受集内的候选，即使它分数最高且排在最后（不被最高分左右）', () => {
  // 上位词/无关词混在候选里、且排在末尾时，仍必须选可接受的那个。
  // 若实现改成"先取最高分再看是否可接受"，这条会返回 null。
  const r = pickWord({
    candidates: [{ label: 'cup', score: 0.2 }, { label: 'vessel', score: 0.99 }],
    acceptableSets: sets,
    exclude: [],
  });
  assert.ok(r);
  assert.equal(r.word, 'cup');
});

test('候选全部被 exclude 拦掉时返回 null（不绕过排除集，也不回退到上位词）', () => {
  const r = pickWord({
    candidates: [{ label: 'mug', score: 0.9 }, { label: 'container', score: 0.8 }],
    acceptableSets: sets,
    exclude: ['mug'],
  });
  assert.equal(r, null, '可接受的词都被排除时必须返回 null');
});

test('返回的 reason 必须指出命中可接受集（不得只返回词、丢掉判定依据）', () => {
  const r = pickWord({ candidates: [{ label: 'mug', score: 0.9 }], acceptableSets: sets, exclude: [] });
  assert.ok(r);
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0, 'reason 不能是空字符串');
  assert.match(r.reason, /mug/, 'reason 里应能看出是哪个候选命中的');
});
