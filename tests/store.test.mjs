import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../web/units/store.mjs';
import { fakeLocalStorage, fakeIndexedDB } from './helpers/fakes.mjs';

// 所有 await 测试都带 { timeout: 2000 }：将来若事务 promise 再次永不 settle，
// 失败的是这条断言（测试超时），而不是整个 node --test 进程静默挂死。
const TIMEOUT = { timeout: 2000 };

/** 建一个可观测的 store：手上的假 IDB 同时记下 transaction / objectStore 的实参 */
const makeStore = () => {
  const idb = fakeIndexedDB();
  return { s: createStore({ localStorage: fakeLocalStorage(), indexedDB: idb }), idb };
};

test('store 只用注入的句柄：注入哨兵会抛错，说明没有任何浏览器全局兜底', TIMEOUT, async () => {
  const touchedGlobal = (name) => () => {
    throw new Error(`store 试图使用浏览器全局 ${name}（应当只用注入的句柄）`);
  };
  const localStorage = {
    getItem: touchedGlobal('localStorage.getItem'),
    setItem: touchedGlobal('localStorage.setItem'),
  };
  const indexedDB = { open: touchedGlobal('indexedDB.open') };
  const s = createStore({ localStorage, indexedDB });

  // 事件、词、meta 三条路径都必须真的走注入的 localStorage（而不是全局）
  // （这几个方法都是先 getItem 读旧值、再 setItem 写回，故首个触点是读取）
  assert.throws(() => s.appendEvent({ ts: 1, type: 'session_start', wordId: null, sessionId: 's', payload: {} }),
    /localStorage\.getItem/);
  assert.throws(() => s.readEvents(), /localStorage\.getItem/);
  assert.throws(() => s.putWord({ id: 'w-1' }), /localStorage\.getItem/);
  assert.throws(() => s.readWords(), /localStorage\.getItem/);
  assert.throws(() => s.putMeta('k', 1), /localStorage\.getItem/);
  assert.throws(() => s.getMeta('k'), /localStorage\.getItem/);
  // 图片路径必须真的走注入的 indexedDB（open 是异步入口，故以 reject 形式暴露注入哨兵的抛错）
  await assert.rejects(() => s.putImage('w-1', new Uint8Array([1])), /indexedDB\.open/);
  await assert.rejects(() => s.getImage('w-1'), /indexedDB\.open/);
});

test('appendEvent/readEvents 往返，无记录时返回空数组', () => {
  const { s } = makeStore();
  assert.deepEqual(s.readEvents(), []);
  const e = { ts: 1, type: 'session_start', wordId: null, sessionId: 's-1', payload: {} };
  s.appendEvent(e);
  s.appendEvent({ ...e, ts: 2 });
  assert.deepEqual(s.readEvents(), [e, { ...e, ts: 2 }]);
});

test('putWord/readWords 按 id 归并，readWords 无记录时返回空对象', () => {
  const { s } = makeStore();
  assert.deepEqual(s.readWords(), {});
  s.putWord({ id: 'w-1', text: 'lamp', createdAt: 100 });
  s.putWord({ id: 'w-2', text: 'mug', createdAt: 200 });
  assert.deepEqual(Object.keys(s.readWords()).sort(), ['w-1', 'w-2']);
  assert.equal(s.readWords()['w-1'].text, 'lamp');
});

test('putWord 缺 createdAt 时补上时间戳（pruneImages 的排序依据）', () => {
  const { s } = makeStore();
  const before = Date.now();
  s.putWord({ id: 'w-1', text: 'lamp' });
  const after = Date.now();
  const w = s.readWords()['w-1'];
  assert.equal(w.id, 'w-1');
  assert.ok(Number.isFinite(w.createdAt), `createdAt 必须是有限数字，实际为 ${w.createdAt}`);
  assert.ok(w.createdAt >= before && w.createdAt <= after);
  // 显式给了 createdAt 就必须原样保留（调用方语义优先）
  s.putWord({ id: 'w-2', createdAt: 12345 });
  assert.equal(s.readWords()['w-2'].createdAt, 12345);
});

test('putMeta/getMeta 往返，未设置的键返回 null', () => {
  const { s } = makeStore();
  assert.equal(s.getMeta('missing'), null);
  s.putMeta('sessionId', 's-1');
  assert.equal(s.getMeta('sessionId'), 's-1');
  s.putMeta('n', 0);
  assert.equal(s.getMeta('n'), 0);
});

test('putImage/getImage 往返真实二进制（Uint8Array 与 Blob 保类型、保字节）', TIMEOUT, async () => {
  const { s } = makeStore();
  assert.equal(await s.getImage('w-1'), undefined);

  // 生产写入的是 512px canvas 出来的 Blob；这里两种真实二进制形状都过一遍
  const bytes = new Uint8Array([1, 2, 3]);
  await s.putImage('w-1', bytes);
  const back = await s.getImage('w-1');
  assert.ok(back instanceof Uint8Array, `应以 Uint8Array 取回，实际为 ${Object.prototype.toString.call(back)}`);
  assert.deepEqual(back, bytes);

  const blob = new Blob(['x']);
  await s.putImage('w-2', blob);
  const blobBack = await s.getImage('w-2');
  assert.ok(blobBack instanceof Blob, `应以 Blob 取回，实际为 ${Object.prototype.toString.call(blobBack)}`);
  assert.equal(blobBack.type, blob.type);
  assert.equal(blobBack.size, blob.size);
  assert.equal(await blobBack.text(), await blob.text());
});

test('putImage 走 readwrite / getImage 走 readonly，且都寻址 images 对象仓', TIMEOUT, async () => {
  const { s, idb } = makeStore();

  await s.putImage('w-1', new Uint8Array([1, 2, 3]));
  assert.equal(idb.calls.transactions.length, 1);
  assert.deepEqual(idb.calls.transactions[0], { storeName: 'images', mode: 'readwrite' });
  assert.deepEqual(idb.calls.objectStores, [{ name: 'images' }]);

  await s.getImage('w-1');
  assert.equal(idb.calls.transactions.length, 2);
  assert.deepEqual(idb.calls.transactions[1], { storeName: 'images', mode: 'readonly' });

  // 开库参数只有一条路径：lib 名 + 版本
  assert.deepEqual(idb.calls.opens, [{ name: 'elp-images', version: 1 }]);
});

test('事务失败时 putImage 必须 reject（不静默、不挂起）', TIMEOUT, async () => {
  const { s, idb } = makeStore();
  idb.failNextTransaction(new Error('QuotaExceededError: 注入的写失败'));

  await assert.rejects(() => s.putImage('w-1', new Uint8Array([1])), /注入的写失败/);
  // 失败后缓存不得被污染：下一笔事务仍应正常完成
  await s.putImage('w-1', new Uint8Array([1, 2]));
  assert.deepEqual(await s.getImage('w-1'), new Uint8Array([1, 2]));
});

test('open 被阻塞时 reject 并给出清晰错误；解除阻塞后重试可成功', TIMEOUT, async () => {
  const { s, idb } = makeStore();
  idb.blockNextOpen();

  await assert.rejects(() => s.getImage('w-1'), (err) => {
    assert.ok(err instanceof Error, `应抛 Error，实际为 ${err}`);
    assert.match(err.message, /阻塞|blocked/i, `错误信息应说明被阻塞，实际为「${err.message}」`);
    return true;
  });

  // 阻塞解除后（例如用户关掉了旧标签页）重试必须成功——失败不能被永久缓存
  await s.putImage('w-1', new Uint8Array([7]));
  assert.deepEqual(await s.getImage('w-1'), new Uint8Array([7]));
});

test('open 失败后清掉缓存 promise，下次调用真的重试一次 open', TIMEOUT, async () => {
  const { s, idb } = makeStore();
  idb.failNextOpen(new Error('注入的开库失败'));

  await assert.rejects(() => s.putImage('w-1', new Uint8Array([1])), /注入的开库失败/);
  await s.putImage('w-1', new Uint8Array([1]));
  assert.equal(idb.calls.opens.length, 2, '第二次调用必须重新 open，而不是复用被拒绝的 promise');
  assert.deepEqual(await s.getImage('w-1'), new Uint8Array([1]));
});

test('pruneImages 只保留最近 keep 个词的图，词与事件记录不受影响', TIMEOUT, async () => {
  const { s } = makeStore();
  s.putWord({ id: 'w-old', createdAt: 100 });
  s.putWord({ id: 'w-mid', createdAt: 200 });
  s.putWord({ id: 'w-new', createdAt: 300 });
  await s.putImage('w-old', new Uint8Array([1]));
  await s.putImage('w-mid', new Uint8Array([2]));
  await s.putImage('w-new', new Uint8Array([3]));
  s.appendEvent({ ts: 1, type: 'session_start', wordId: null, sessionId: 's-1', payload: {} });

  assert.equal(await s.pruneImages(2), 1);
  assert.equal(await s.getImage('w-old'), undefined);
  assert.deepEqual(await s.getImage('w-new'), new Uint8Array([3]));
  assert.equal(Object.keys(s.readWords()).length, 3);
  assert.equal(s.readEvents().length, 1);
});

test('pruneImages 词数不超过 keep 时不删任何图', TIMEOUT, async () => {
  const { s } = makeStore();
  s.putWord({ id: 'w-1', createdAt: 100 });
  await s.putImage('w-1', new Uint8Array([1]));
  assert.equal(await s.pruneImages(20), 0);
  assert.deepEqual(await s.getImage('w-1'), new Uint8Array([1]));
});

test('pruneImages 对历史遗留（无/非法 createdAt）的词按最旧处理，不误伤最新', TIMEOUT, async () => {
  // 修复之前写入的词没有 createdAt；直接投毒 localStorage，模拟词表里的历史数据。
  // 这也是 at() 兜底分支唯一可达的输入（putWord 已保证新写入的词必带有限 createdAt）。
  const ls = fakeLocalStorage();
  ls.setItem('elp.words', JSON.stringify({
    'w-legacy-a': { id: 'w-legacy-a' },                    // 无 createdAt
    'w-legacy-b': { id: 'w-legacy-b', createdAt: 'oops' }, // 非法 createdAt
    'w-new': { id: 'w-new', createdAt: 1_000_000 },
  }));
  const s2 = createStore({ localStorage: ls, indexedDB: fakeIndexedDB() });
  for (const id of ['w-legacy-a', 'w-legacy-b', 'w-new']) {
    await s2.putImage(id, new Uint8Array([1]));
  }

  // 只留 1 个：两个 createdAt 缺失/非法的历史词都按"最旧"先淘汰，最新词必须留下
  assert.equal(await s2.pruneImages(1), 2);
  assert.equal(await s2.getImage('w-legacy-a'), undefined);
  assert.equal(await s2.getImage('w-legacy-b'), undefined);
  assert.deepEqual(await s2.getImage('w-new'), new Uint8Array([1]), '最新词的图不得被淘汰');
});

test('pruneImages() 默认 keep=20 的边界：21 个词只淘汰最旧的 1 个，且是最旧的那个', TIMEOUT, async () => {
  const { s } = makeStore();
  const ids = [];
  for (let i = 1; i <= 21; i += 1) {
    const id = `w-${String(i).padStart(2, '0')}`; // w-01 最旧 … w-21 最新
    ids.push(id);
    s.putWord({ id, createdAt: i });
    await s.putImage(id, new Uint8Array([i]));
  }

  assert.equal(await s.pruneImages(), 1, '21 个词、默认 keep=20：应恰好淘汰 1 个（默认值被改坏就会在这里失败）');
  assert.equal(await s.getImage(ids[0]), undefined, '被淘汰的必须是 createdAt 最小的 w-01');
  for (const id of ids.slice(1)) {
    assert.ok(await s.getImage(id), `最近 20 个词的图必须保留：${id}`);
  }
  // 「词与事件记录永久保留」不受图片淘汰影响
  assert.equal(Object.keys(s.readWords()).length, 21);
});
