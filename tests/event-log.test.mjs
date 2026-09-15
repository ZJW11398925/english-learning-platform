import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, EVENT_TYPES, recordEvent } from '../web/units/event-log.mjs';

test('validateEvent 接受一条完整合法事件', () => {
  const e = {
    ts: 1757850000000,
    type: 'frame_rejected',
    wordId: null,
    sessionId: 's-1',
    payload: { reason: 'too_dark', brightness: 22 },
  };
  assert.deepEqual(validateEvent(e), { ok: true, errors: [] });
});

test('validateEvent 缺字段时报出具体字段名', () => {
  const r = validateEvent({ ts: 1, type: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('sessionId')));
  assert.ok(r.errors.some((m) => m.includes('payload')));
});

test('validateEvent 拒绝未登记的 type', () => {
  const r = validateEvent({ ts: 1, type: 'not_a_type', wordId: null, sessionId: 's', payload: {} });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((m) => m.includes('type')));
});

test('EVENT_TYPES 覆盖设计文档 §5.1 的全部降级标签', () => {
  for (const t of ['blocked_permission', 'frame_rejected', 'recognize_failed',
                   'feedback_pending', 'uncertain', 'speech_unsupported', 'storage_full']) {
    assert.ok(EVENT_TYPES.includes(t), `缺少事件类型 ${t}`);
  }
});

test('EVENT_TYPES 含 reading_missed，且与 reading_done 是两条并存的登记项', () => {
  // Task 9B / `DEC-OPI-…73` 显式授权的契约变更：没有它，"用户念了却被判没说"的失败率
  // 在事件流里完全看不见（`reading_done` 只在通过时落）。
  assert.ok(EVENT_TYPES.includes('reading_missed'), '缺少 reading_missed');
  assert.ok(EVENT_TYPES.includes('reading_done'), '念对了那一条照旧要在');
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length, '事件表里不许有重名（重名会让口径悄悄合并）');
});

test('reading_missed 能被 recordEvent 正常落盘（它不只是表里的一个字符串）', () => {
  const memory = [];
  const store = { appendEvent: (e) => memory.push(e), readEvents: () => memory };
  const e = recordEvent(store, 'reading_missed', {
    sessionId: 's-1', wordId: null, roundIndex: 2, word: 'mug', transcript: 'I see a cup',
  }, () => 99);
  assert.equal(e.type, 'reading_missed');
  assert.equal(e.roundIndex, 2);
  assert.equal(e.payload.transcript, 'I see a cup', '原样转写必须进事件（它是复核引擎的唯一证据）');
  assert.equal(memory.length, 1);
});

test('recordEvent 写入后可从 store 读回，且时间戳被填上', () => {
  const memory = [];
  const store = { appendEvent: (e) => memory.push(e), readEvents: () => memory };
  const e = recordEvent(store, 'uncertain', { sessionId: 's-1', wordId: 'w-1' }, () => 42);
  assert.equal(e.ts, 42);
  assert.equal(e.type, 'uncertain');
  assert.equal(memory.length, 1);
});

test('recordEvent 第三参形状为 {sessionId, wordId?, ...payload}：后两者被提到顶层，不留在 payload', () => {
  const memory = [];
  const store = { appendEvent: (e) => memory.push(e), readEvents: () => memory };
  const e = recordEvent(store, 'compose_submitted', {
    sessionId: 's-1',
    wordId: 'w-1',
    sentence: 'The lamp is on.',
  }, () => 7);
  assert.equal(e.sessionId, 's-1');
  assert.equal(e.wordId, 'w-1');
  assert.deepEqual(e.payload, { sentence: 'The lamp is on.' });
});
