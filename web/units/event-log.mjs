export const EVENT_TYPES = [
  'session_start',
  'frame_rejected',
  'blocked_permission',
  'recognize_ok',
  'recognize_failed',
  'word_shown',
  'reading_done',
  'skipped_reading',
  'speech_unsupported',
  'compose_submitted',
  'compose_rewrite',
  'feedback_ok',
  'feedback_pending',
  'uncertain',
  'recurrence_scene',
  'recurrence_manual',
  'storage_full',
];

const REQUIRED = ['ts', 'type', 'wordId', 'sessionId', 'payload'];

export function validateEvent(e) {
  const errors = [];
  if (e === null || typeof e !== 'object') return { ok: false, errors: ['event 必须是对象'] };
  for (const k of REQUIRED) {
    if (!(k in e)) errors.push(`缺少字段 ${k}`);
  }
  if ('type' in e && !EVENT_TYPES.includes(e.type)) {
    errors.push(`未登记的 type: ${String(e.type)}`);
  }
  if ('ts' in e && !Number.isFinite(e.ts)) errors.push('ts 必须是有限数字');
  if ('payload' in e && (e.payload === null || typeof e.payload !== 'object')) {
    errors.push('payload 必须是对象');
  }
  return { ok: errors.length === 0, errors };
}

export function recordEvent(store, type, { sessionId, wordId = null, ...payload }, now = Date.now) {
  const e = { ts: now(), type, wordId, sessionId, payload };
  const v = validateEvent(e);
  if (!v.ok) throw new Error(`非法事件: ${v.errors.join('; ')}`);
  store.appendEvent(e);
  return e;
}
