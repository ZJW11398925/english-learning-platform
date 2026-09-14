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

test('recordEvent 写入后可从 store 读回，且时间戳被填上', () => {
  const memory = [];
  const store = { appendEvent: (e) => memory.push(e), readEvents: () => memory };
  const e = recordEvent(store, 'uncertain', { sessionId: 's-1', wordId: 'w-1' }, () => 42);
  assert.equal(e.ts, 42);
  assert.equal(e.type, 'uncertain');
  assert.equal(memory.length, 1);
});
