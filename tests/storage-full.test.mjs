// tests/storage-full.test.mjs
//
// `storage_full` 可达路径（设计文档 §5.1「存储写满 → 停止新任务并提示导出，**不丢历史**」+
// Global Constraint 3「失败不得静默降级」）。
//
// 在本任务之前，**全项目没有任何代码发出过 `storage_full`**：`store.mjs` 让
// `QuotaExceededError` 直接冒泡（Task 1 留档的缺口），而 Task 9 又添了两条写路径。
// 这一份测试钉住三件事：
//   1. **配额异常要认得出来**——不同浏览器形状不同（`name` / `code` 都有变体），
//      只认一种就等于"在别的浏览器上这个档位永远不可达"；
//   2. **不许不认账**：判定成立就置起 `isFull()`（界面的"停止派发新任务"靠它），
//      并且**原样重抛**（写失败绝不能被静默吞成写成功）；
//   3. **历史不许被覆盖**：写失败之后，存储里留下的仍是写之前那份完整历史。
//
// ⚠️ 测试**不真的去写满存储**（brief 明令）：用一个会在 `setItem` 上抛配额异常的假
// `localStorage` 制造现场（与 Task 1 的 `failNextTransaction` 替身同一个思路）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, isStoreFullError, STORAGE_FULL_MARK_KEY } from '../web/units/store.mjs';
import { fakeIndexedDB } from './helpers/fakes.mjs';

const QUOTA_NAMES = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'];
const QUOTA_CODES = [22, 1014];

/** 造一个配额异常（形状可按浏览器变体指定）。 */
const quotaError = ({ name = 'QuotaExceededError', code = undefined } = {}) => {
  const err = new Error(`模拟配额满：${name}${code === undefined ? '' : `/${code}`}`);
  err.name = name;
  if (code !== undefined) err.code = code;
  return err;
};

/**
 * 一个会按配额抛错的假 localStorage。
 *
 * @param {object} [options]
 *   - `writesAllowed`：前 N 次写放行，之后一律抛（`0` = 一上来就满）
 *   - `error`：抛什么（默认一个 `QuotaExceededError` 形状）
 *   - `failOn`：`(key, value) => boolean`——**按键**决定这次写失不失败。
 *     真实的浏览器配额是按**来源**算的，但两把键的写入时刻与体积不同，
 *     "事件键写不进去、元数据键写得进去"这种局面是真会出现的；要验证
 *     "标签尽力落一次"就必须造得出它（否则那条路径永远只能靠想象）。
 *   - `seed`：预置的内容
 */
function quotaStorage({ writesAllowed = 0, error = quotaError(), failOn = null, seed = {} } = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const calls = { attempts: 0, succeeded: 0, byKey: {} };
  return {
    data,
    calls,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem(k, v) {
      calls.attempts += 1;
      calls.byKey[k] = (calls.byKey[k] ?? 0) + 1;
      const overQuota = failOn !== null ? failOn(k, v) : calls.succeeded >= writesAllowed;
      if (overQuota) throw error;
      calls.succeeded += 1;
      data.set(k, v);
    },
  };
}

const event = (ts = 1) => ({ ts, type: 'session_start', wordId: null, sessionId: 's-1', payload: {} });

// ─────────────────────────── 配额异常的识别（能力探测）───────────────────────────

test('配额异常认得出：name 与 code 的各种浏览器变体都算，别的异常一个都不算', () => {
  for (const name of QUOTA_NAMES) {
    assert.equal(isStoreFullError(quotaError({ name })), true, `${name} 必须被认成配额满`);
  }
  for (const code of QUOTA_CODES) {
    assert.equal(isStoreFullError(quotaError({ name: 'Error', code })), true, `code=${code} 必须被认成配额满`);
  }
  // 判定过宽的代价：一次普通写失败被记成"存储写满"，用户被引去导出数据，而真凶不是存储
  for (const other of [
    new Error('普通错误'), Object.assign(new Error('x'), { name: 'TypeError' }),
    Object.assign(new Error('x'), { name: 'InvalidStateError', code: 11 }),
    Object.assign(new Error('x'), { code: 21 }),
    null, undefined, 0, '', 'QuotaExceededError', {}, [],
  ]) {
    assert.equal(isStoreFullError(other), false, `${String(other)} 不该被认成配额满`);
  }
});

// ─────────────────────────── 写失败：标记 + 原样重抛 ───────────────────────────

test('一上来就满：appendEvent 原样抛出、置起 isFull()，而且**一个字都没写进去**', () => {
  const localStorage = quotaStorage();
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });
  assert.equal(s.isFull(), false, '初始状态下不该是"满"');

  assert.throws(() => s.appendEvent(event()), /模拟配额满/, '写失败必须原样抛出，不许静默吞掉');
  assert.equal(s.isFull(), true, '配额满必须置起判定（界面停止派发新任务靠它）');
  assert.equal(localStorage.data.has('elp.events'), false, '写失败了就不该有任何事件键留下');
  assert.deepEqual(s.readEvents(), [], '读回来仍然是空的历史');
});

test('走到一半满：**历史一个字都不许被覆盖**，新事件也不许混进去', () => {
  const prior = [event(1), event(2), event(3)];
  // 只放行 1 次写：就是 markStoreFull 落标记那一次之后的都失败（这里先造"已经写过两次"的历史）
  const localStorage = quotaStorage({ writesAllowed: 0, seed: { 'elp.events': prior } });
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });

  assert.throws(() => s.appendEvent(event(4)), /模拟配额满/);
  assert.deepEqual(s.readEvents(), prior, '老事件必须逐字还在（"不丢历史"是设计 §5.1 的原话）');
});

test('满之后 putWord / putMeta 同样抛出并保持"满"的判定（三条写路径一个口径）', () => {
  const localStorage = quotaStorage();
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });
  const words = { mug: { id: 'mug', word: 'mug', stage: 1, createdAt: 1 } };
  localStorage.data.set('elp.words', JSON.stringify(words));

  assert.throws(() => s.putWord({ id: 'book', word: 'book' }), /模拟配额满/);
  assert.throws(() => s.putMeta('k', 1), /模拟配额满/);
  assert.equal(s.isFull(), true);
  assert.deepEqual(s.readWords(), words, '词表也是历史：写不进去时一个字都不许变');
});

test('**非配额**的写失败照样抛出，但**不许**把应用置成"存储满"', () => {
  // 判定过宽会把一次普通故障伪装成"存储满"，用户被引去导出数据，而真凶根本不是配额。
  const localStorage = quotaStorage({ error: Object.assign(new Error('键名非法'), { name: 'SyntaxError' }) });
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });
  assert.throws(() => s.appendEvent(event()), /键名非法/);
  assert.equal(s.isFull(), false, '不是配额问题就不许说"存储满"');
});

// ─────────────────────────── 自反悖论：标签本身也要写存储 ───────────────────────────

test('自反悖论：落 storage_full 标签那一次写也失败时，判定仍然成立、且只试一次', () => {
  // 现场：存储已满 → appendEvent 失败 → markStoreFull 试着落标记 → 那次写**也**失败。
  const localStorage = quotaStorage();
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });

  assert.throws(() => s.appendEvent(event()), /模拟配额满/);
  assert.equal(s.isFull(), true, '标签写不进去**不影响**判定：界面提示才是主出口');
  const attemptsAfterFirst = localStorage.calls.attempts;

  // 第二次、第三次写失败：不许再重试落标签（那会把"写满"变成一处自激循环）
  assert.throws(() => s.appendEvent(event(2)), /模拟配额满/);
  assert.throws(() => s.appendEvent(event(3)), /模拟配额满/);
  assert.equal(localStorage.calls.attempts, attemptsAfterFirst + 2,
    '每次失败的写入 = 它自己那一次尝试，不该额外多出"重试落标签"的写入');
  assert.equal(s.isFull(), true);
});

test('配额允许时，标记会落在元数据里（数据里留下"曾经满过"的一句话）', () => {
  // 现场：事件那条键写不进去，元数据那条写得进去——两把键的配额压力本来就可以不同。
  // 这正是"标签尽力而为"的含义：**能落就落**，落不下也不影响判定。
  const localStorage = quotaStorage({ failOn: (k) => k === 'elp.events' });
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });
  assert.throws(() => s.appendEvent(event()), /模拟配额满/);

  const meta = JSON.parse(localStorage.data.get('elp.meta'));
  assert.ok(Number.isFinite(meta[STORAGE_FULL_MARK_KEY]),
    `尽力落下的标记要能被诊断页读到（实测 ${localStorage.data.get('elp.meta')}）`);
  assert.equal(s.isFull(), true);
});

test('**标签确实是尽力而为**：两把键都写不进去时，数据里就什么都没有（如实钉住这条边界）', () => {
  // brief §2.2 要求写清"标签写不进去时用户看到什么、数据里留下什么"。
  // 答案是：**数据里什么都不会留下**——只能靠"事件流没有继续增长"这一条间接证据。
  // 这条用例把这句话钉成可执行的事实，免得报告里写成"已记录"。
  const localStorage = quotaStorage();
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });
  assert.throws(() => s.appendEvent(event()), /模拟配额满/);
  assert.equal(localStorage.data.size, 0, '存储里一个字都没留下（这就是那种最坏情况）');
  assert.equal(s.isFull(), true, '但内存里的判定成立 → 界面仍然会停止派发新任务并提示导出');
  assert.equal(localStorage.calls.byKey['elp.meta'], 1, '标签只试一次，不重试');
});

test('markStoreFull 幂等：连标三次，只写一次元数据', () => {
  const localStorage = quotaStorage({ writesAllowed: 999 });
  const s = createStore({ localStorage, indexedDB: fakeIndexedDB() });
  assert.equal(s.markStoreFull(), true, '第一次标记返回 true');
  const after = localStorage.calls.attempts;
  assert.equal(s.markStoreFull(), false, '第二次返回 false（已经标过了）');
  assert.equal(s.markStoreFull(), false);
  assert.equal(localStorage.calls.attempts, after, '幂等的含义就是不再发生写入');
  assert.equal(s.isFull(), true);
});

// ─────────────────────────── IndexedDB 那半边 ───────────────────────────

test('图片写失败（IndexedDB 报配额）同样置起"存储满"——那一档不该只覆盖 localStorage', () => {
  const idb = fakeIndexedDB();
  const s = createStore({ localStorage: quotaStorage({ writesAllowed: 999 }), indexedDB: idb });
  assert.equal(typeof idb.failNextTransaction, 'function', '替身要支持"下一次事务失败"（Task 1 已具备）');
  idb.failNextTransaction(quotaError());
  return assert.rejects(() => s.putImage('mug', new Uint8Array([1])), /模拟配额满/)
    .then(() => assert.equal(s.isFull(), true, '图片写不进去也是"存储写满"，界面同样要停派发'));
});
