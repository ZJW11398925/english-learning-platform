import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../web/units/store.mjs';
import { fakeLocalStorage, fakeIndexedDB } from './helpers/fakes.mjs';

const makeStore = () => createStore({ localStorage: fakeLocalStorage(), indexedDB: fakeIndexedDB() });

test('createStore 接注入的 localStorage/indexedDB，不接触浏览器全局', () => {
  assert.equal(typeof globalThis.localStorage, 'undefined');
  assert.equal(typeof globalThis.indexedDB, 'undefined');
  assert.equal(typeof createStore({ localStorage: fakeLocalStorage(), indexedDB: fakeIndexedDB() }), 'object');
});

test('appendEvent/readEvents 往返，无记录时返回空数组', () => {
  const s = makeStore();
  assert.deepEqual(s.readEvents(), []);
  const e = { ts: 1, type: 'session_start', wordId: null, sessionId: 's-1', payload: {} };
  s.appendEvent(e);
  s.appendEvent({ ...e, ts: 2 });
  assert.deepEqual(s.readEvents(), [e, { ...e, ts: 2 }]);
});

test('putWord/readWords 按 id 归并，readWords 无记录时返回空对象', () => {
  const s = makeStore();
  assert.deepEqual(s.readWords(), {});
  s.putWord({ id: 'w-1', text: 'lamp', createdAt: 100 });
  s.putWord({ id: 'w-2', text: 'mug', createdAt: 200 });
  assert.deepEqual(Object.keys(s.readWords()).sort(), ['w-1', 'w-2']);
  assert.equal(s.readWords()['w-1'].text, 'lamp');
});

test('putMeta/getMeta 往返，未设置的键返回 null', () => {
  const s = makeStore();
  assert.equal(s.getMeta('missing'), null);
  s.putMeta('sessionId', 's-1');
  assert.equal(s.getMeta('sessionId'), 's-1');
  s.putMeta('n', 0);
  assert.equal(s.getMeta('n'), 0);
});

test('putImage/getImage 往返（IndexedDB 存二进制）', async () => {
  const s = makeStore();
  assert.equal(await s.getImage('w-1'), undefined);
  await s.putImage('w-1', 'BLOB-1');
  assert.equal(await s.getImage('w-1'), 'BLOB-1');
});

test('pruneImages 只保留最近 keep 个词的图，词与事件记录不受影响', async () => {
  const s = makeStore();
  s.putWord({ id: 'w-old', createdAt: 100 });
  s.putWord({ id: 'w-mid', createdAt: 200 });
  s.putWord({ id: 'w-new', createdAt: 300 });
  await s.putImage('w-old', 'BLOB-old');
  await s.putImage('w-mid', 'BLOB-mid');
  await s.putImage('w-new', 'BLOB-new');
  s.appendEvent({ ts: 1, type: 'session_start', wordId: null, sessionId: 's-1', payload: {} });

  assert.equal(await s.pruneImages(2), 1);
  assert.equal(await s.getImage('w-old'), undefined);
  assert.equal(await s.getImage('w-new'), 'BLOB-new');
  assert.equal(Object.keys(s.readWords()).length, 3);
  assert.equal(s.readEvents().length, 1);
});

test('pruneImages 词数不超过 keep 时不删任何图', async () => {
  const s = makeStore();
  s.putWord({ id: 'w-1', createdAt: 100 });
  await s.putImage('w-1', 'BLOB-1');
  assert.equal(await s.pruneImages(20), 0);
  assert.equal(await s.getImage('w-1'), 'BLOB-1');
});
