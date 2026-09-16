// tests/keyring.test.mjs
//
// Task 12A：API Key 的存取单元（`web/units/keyring.mjs`）。项目转向（DEC-…23/26）之后，
// 服务端代理退役，模型调用改浏览器直连——Key 由访问者自己填、存 localStorage（键 `elp.apiKey`）。
//
// 这一层守的三条线：
//   1. **轻校验**：写入前非空 + `sk-` 前缀（DeepSeek 的 Key 形状）。这是"帮用户发现粘贴不全"
//      的顺手检查，不是安全边界——真正的判定权在模型服务的 401（那条路由直连降级路径管）。
//   2. **可注入**：localStorage 必须是参数，测试绝不碰真存储（与 units/store.mjs 同一条纪律：
//      生产代码不自己读全局，测试里 globalThis.localStorage 保持 undefined）。
//   3. **不发明**：读出来的值形状不对（没有 sk- 前缀、不是字符串）就如实报"未配置"，
//      绝不把垃圾当 Key 发出去，也**不自动删除**它（那不是本单元的职责）。
//
// 全部用合成钥匙（`sk-test-…`），任何真实 Key 都不许进仓库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_KEY_STORAGE_KEY, createKeyring, isValidKeyShape } from '../web/units/keyring.mjs';
import { fakeLocalStorage } from './helpers/fakes.mjs';

/** 一把合成 Key：形状对、值是假的（仓库里只允许这种）。 */
const SYNTHETIC = 'sk-test-synthetic-000000000000';

/** 造一个"已配置"的假存储。 */
const storageWith = (value) => {
  const s = fakeLocalStorage();
  if (value !== undefined) s.setItem(API_KEY_STORAGE_KEY, value);
  return s;
};

// ───────────────────────────── 存（轻校验 + 写入）─────────────────────────────

test('saveKey：合法形状的合成 Key 存进注入的存储，键名固定 elp.apiKey', () => {
  const storage = fakeLocalStorage();
  const r = createKeyring({ storage }).saveKey(SYNTHETIC);
  assert.equal(r.ok, true);
  assert.equal(r.key, SYNTHETIC);
  assert.equal(storage.getItem('elp.apiKey'), SYNTHETIC, '必须存进约定的键（别的模块按它读）');
  assert.equal(API_KEY_STORAGE_KEY, 'elp.apiKey', '键名是跨模块契约，不许悄悄改');
});

test('saveKey：首尾空白在写入前剪掉（粘贴带空格也能用），存的是剪过的值', () => {
  const storage = fakeLocalStorage();
  const r = createKeyring({ storage }).saveKey(`  ${SYNTHETIC}  \n`);
  assert.equal(r.ok, true);
  assert.equal(r.key, SYNTHETIC, '返回的也是剪过的值（调用方要回显"已配置"判断用）');
  assert.equal(storage.getItem(API_KEY_STORAGE_KEY), SYNTHETIC);
});

test('saveKey：空串 / 纯空白 → ok:false 且**不写存储**，错误信息说清是空的', () => {
  for (const blank of ['', '   ', '\n\t ']) {
    const storage = fakeLocalStorage();
    const r = createKeyring({ storage }).saveKey(blank);
    assert.equal(r.ok, false, `${JSON.stringify(blank)} 不是一把 Key`);
    assert.match(r.error, /空/, '错误要告诉用户"Key 是空的"');
    assert.equal(storage.getItem(API_KEY_STORAGE_KEY), null, '校验不过就一个字节都不写');
  }
});

test('saveKey：没有 sk- 前缀 → ok:false 且不写存储（轻校验拦"复制不全"）', () => {
  for (const bad of ['not-a-key', 'sk', 'SK-UPPERCASE-NOPE', 'x sk-later']) {
    const storage = fakeLocalStorage();
    const r = createKeyring({ storage }).saveKey(bad);
    assert.equal(r.ok, false, `${bad} 没有 sk- 前缀，不该被收下`);
    assert.match(r.error, /sk-/, '错误要提到 sk- 前缀（用户才知道正确的形状）');
    assert.equal(storage.getItem(API_KEY_STORAGE_KEY), null);
  }
});

test('saveKey：非字符串（null / 数字）→ ok:false，不当成空串糊弄过去', () => {
  for (const bad of [null, undefined, 42, {}]) {
    const r = createKeyring({ storage: fakeLocalStorage() }).saveKey(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  }
});

// ───────────────────────────── 取（形状不对就不当已配置）─────────────────────────────

test('loadKey：存的是合法合成 Key → 原样读回', () => {
  const kr = createKeyring({ storage: storageWith(SYNTHETIC) });
  assert.equal(kr.loadKey(), SYNTHETIC);
});

test('loadKey：存的值形状不对（无 sk- 前缀 / 非字符串）→ null，**不自动删除**', () => {
  for (const garbage of ['garbage-without-prefix', '', '   ']) {
    const storage = storageWith(garbage);
    const kr = createKeyring({ storage });
    assert.equal(kr.loadKey(), null, `${JSON.stringify(garbage)} 不能被当成已配置的 Key`);
    assert.equal(
      storage.getItem(API_KEY_STORAGE_KEY), garbage,
      '读不认它，但也不许顺手删——删除是 clearKey 的显式职责，读路径不发明副作用',
    );
  }
});

test('loadKey：存储里没有这个键 → null（未配置，不是空串）', () => {
  assert.equal(createKeyring({ storage: fakeLocalStorage() }).loadKey(), null);
});

test('hasKey：与 loadKey 同源——有合法 Key 才是 true', () => {
  const withKey = createKeyring({ storage: storageWith(SYNTHETIC) });
  assert.equal(withKey.hasKey(), true);
  const without = createKeyring({ storage: fakeLocalStorage() });
  assert.equal(without.hasKey(), false);
  const garbage = createKeyring({ storage: storageWith('no-prefix') });
  assert.equal(garbage.hasKey(), false, '形状不对的存储值不算"已配置"');
});

// ───────────────────────────── 清除 ─────────────────────────────

test('clearKey：删掉键，之后 loadKey 是 null、hasKey 是 false', () => {
  const storage = storageWith(SYNTHETIC);
  const kr = createKeyring({ storage });
  assert.equal(kr.hasKey(), true);
  kr.clearKey();
  assert.equal(storage.getItem(API_KEY_STORAGE_KEY), null, '键要真的从存储里消失');
  assert.equal(kr.loadKey(), null);
  assert.equal(kr.hasKey(), false);
});

test('clearKey：本来就没有 Key 时清除也不许炸（幂等的退出路径）', () => {
  const kr = createKeyring({ storage: fakeLocalStorage() });
  assert.doesNotThrow(() => kr.clearKey());
  assert.equal(kr.hasKey(), false);
});

// ───────────────────────────── 注入与环境边界 ─────────────────────────────

test('不传 storage（Node 里没有 localStorage）→ 读是"未配置"，存给一句响亮的错误，绝不炸', () => {
  // 这条同时守住"生产代码不自己摸全局"的红线在 Node 下的行为：缺存储是**可报告的状态**，
  // 不是一次崩溃——浏览器里 localStorage 总在，这个分支只有测试与异常环境会走到。
  const kr = createKeyring();
  assert.equal(kr.loadKey(), null);
  assert.equal(kr.hasKey(), false);
  const r = kr.saveKey(SYNTHETIC);
  assert.equal(r.ok, false, '没有存储就存不了——必须说清楚，不能假装保存成功');
  assert.match(r.error, /存储|localStorage/);
  assert.doesNotThrow(() => kr.clearKey());
});

test('存储抛错（隐私模式等）→ 读退回"未配置"、存报 ok:false，异常不许冒到调用方手里炸', () => {
  const throwing = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  const kr = createKeyring({ storage: throwing });
  assert.equal(kr.loadKey(), null, '读不到就当未配置（诊断页与引导路径都认这个语义）');
  const r = kr.saveKey(SYNTHETIC);
  assert.equal(r.ok, false);
  assert.match(r.error, /没|失败|错误/);
  assert.doesNotThrow(() => kr.clearKey(), '清除失败也不该把界面带崩');
});

test('isValidKeyShape：非空 + sk- 前缀的一条尺子（saveKey 与 loadKey 用同一把）', () => {
  assert.equal(isValidKeyShape(SYNTHETIC), true);
  assert.equal(isValidKeyShape(`  ${SYNTHETIC}  `), true, '带空白也算形状对（写入时会剪）');
  assert.equal(isValidKeyShape(''), false);
  assert.equal(isValidKeyShape('   '), false);
  assert.equal(isValidKeyShape('no-prefix'), false);
  assert.equal(isValidKeyShape(null), false);
  assert.equal(isValidKeyShape(42), false);
  assert.equal(isValidKeyShape(undefined), false);
});

test('本模块不自己摸全局 DOM/存储（shared-context 的注入纪律）', () => {
  // 与 recognize / frame-qc 同一条：源码里不得出现直接读 localStorage 的语句——
  // 存储只能从参数进来（缺省在**调用时**解析 globalThis，且那次解析有 try 兜底）。
  const src = readFileSync(fileURLToPath(new URL('../web/units/keyring.mjs', import.meta.url)), 'utf8');
  assert.match(src, /globalThis\.localStorage/, '缺省存储必须写明来自 globalThis（可追溯）');
  assert.doesNotMatch(src, /^\s*import\s/m, '零依赖：keyring 不 import 任何模块');
});
