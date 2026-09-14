// tests/state-machine.test.mjs
//
// 前 9 条**逐字**来自 `.superpowers/sdd/task-6-brief.md` Step 1（契约本体，用例名不得改——
// 控制器按名字对应）。后面 12 条是本任务补的：brief 那 9 条对"非法动作的返回值、done 是不是
// 终态、停留时长、冻结的转移表"一句话都没说，实测把它们改坏也没有一条会红
// （证据见 `.superpowers/sdd/task-6-report.md` 的变异一节）。
//
// 导入点是 `web/app.mjs`（brief 指定）：这同时钉住"app.mjs 在 Node 里可 import"——
// 它顶层若出现 document/window，本文件会以 ReferenceError 挂在 import 处，一条测试都跑不到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine, TRANSITIONS } from '../web/app.mjs';

test('初始状态是 ready', () => {
  assert.equal(createMachine({ onEnter: () => {} }).state, 'ready');
});

test('完整闭环按序推进到 done', () => {
  const m = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady', 'readDone', 'submit', 'next']) m.send(a);
  assert.equal(m.state, 'done');
});

test('未取到词时不能进入 composing（强制前置）', () => {
  const m = createMachine({ onEnter: () => {} });
  m.send('capture');
  m.send('submit');
  assert.notEqual(m.state, 'composing');
});

test('reading 允许跳过，但状态被记录', () => {
  const m = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady']) m.send(a);
  m.send('skipReading');
  assert.equal(m.state, 'composing');
  assert.equal(m.snapshot().skippedReading, true);
});

test('composing 不可跳过：submit 之前无任何动作能到 done', () => {
  const m = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady', 'readDone']) m.send(a);
  for (const a of ['next', 'finish']) m.send(a);
  assert.equal(m.state, 'composing');
});

test('feedback 可回环到 composing 并累加 rewriteCount', () => {
  const m = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady', 'readDone', 'submit']) m.send(a);
  assert.equal(m.snapshot().rewriteCount, 1);
  m.send('rewrite');
  assert.equal(m.state, 'composing');
  m.send('submit');
  assert.equal(m.snapshot().rewriteCount, 2);
});

test('帧质检不通过时退回收摄态并记录', () => {
  const m = createMachine({ onEnter: () => {} });
  m.send('capture');
  m.send('frameBad');
  assert.equal(m.state, 'ready');
  assert.equal(m.snapshot().frameRejections, 1);
});

test('非法动作被忽略且不改变状态', () => {
  const m = createMachine({ onEnter: () => {} });
  m.send('submit');
  assert.equal(m.state, 'ready');
});

test('onEnter 按序收到全部状态', () => {
  const seen = [];
  const m = createMachine({ onEnter: (s) => seen.push(s) });
  for (const a of ['capture', 'frameOk', 'wordReady', 'readDone', 'submit', 'next']) m.send(a);
  assert.deepEqual(seen, ['ready', 'capturing', 'word', 'reading', 'composing', 'feedback', 'done']);
});

// ───────────────────────── 以下 12 条为本任务补充 ─────────────────────────

test('非法动作返回 false（既不是 true 也不是抛错），且不触发 onEnter', () => {
  // 调用方要靠返回值决定"这次点击到底被接受了没有"；被忽略的动作若返回真值，
  // 界面就会以为机器已经推进（例如 submit 在 ready 态被"接受"）。
  const seen = [];
  const m = createMachine({ onEnter: (s) => seen.push(s) });
  assert.equal(m.send('submit'), false);
  assert.equal(m.send('next'), false);
  assert.equal(m.send('finish'), false);
  assert.equal(m.state, 'ready');
  assert.deepEqual(seen, ['ready']);
});

test('can() 只对当前状态的合法动作返回 true', () => {
  const m = createMachine({ onEnter: () => {} });
  assert.equal(m.can('capture'), true);
  assert.equal(m.can('frameOk'), false);
  assert.equal(m.can('submit'), false);
  m.send('capture');
  assert.equal(m.can('frameOk'), true);
  assert.equal(m.can('frameBad'), true);
  assert.equal(m.can('capture'), false);
  assert.equal(m.can('next'), false);
});

test('done 是终态：10 个动作一个都进不去，状态不变', () => {
  const m = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady', 'readDone', 'submit', 'next']) m.send(a);
  assert.equal(m.state, 'done');
  for (const a of ['capture', 'frameOk', 'frameBad', 'wordReady', 'readDone',
    'skipReading', 'submit', 'rewrite', 'next', 'finish']) {
    assert.equal(m.can(a), false, `${a} 不该在 done 态合法`);
    assert.equal(m.send(a), false, `${a} 不该被 done 态接受`);
  }
  assert.equal(m.state, 'done');
});

test('rewrite 回环无上限：连续 3 轮回改都回到 composing，计数逐轮递增', () => {
  const m = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady', 'readDone', 'submit']) m.send(a);
  assert.equal(m.snapshot().rewriteCount, 1, '第一轮造句提交即 1');
  for (let i = 2; i <= 4; i += 1) {
    assert.equal(m.send('rewrite'), true);
    assert.equal(m.state, 'composing');
    assert.equal(m.send('submit'), true);
    assert.equal(m.snapshot().rewriteCount, i, `第 ${i} 轮提交后计数应为 ${i}`);
  }
  assert.equal(m.send('next'), true);
  assert.equal(m.state, 'done');
  assert.equal(m.snapshot().rewriteCount, 4, '计数 >1 即"用户真的改过"，统计口径要留住它');
});

test('reading 的两条出口都进 composing，但只有 skipReading 置 skippedReading', () => {
  const done = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady', 'readDone']) done.send(a);
  assert.equal(done.state, 'composing');
  assert.equal(done.snapshot().skippedReading, false, 'readDone 不是跳过');

  const skipped = createMachine({ onEnter: () => {} });
  for (const a of ['capture', 'frameOk', 'wordReady', 'skipReading']) skipped.send(a);
  assert.equal(skipped.state, 'composing');
  assert.equal(skipped.snapshot().skippedReading, true);
});

test('帧被拒：退回 ready 并逐次累加 frameRejections；通过的帧不计数', () => {
  const m = createMachine({ onEnter: () => {} });
  m.send('capture');
  m.send('frameBad');
  assert.equal(m.state, 'ready');
  m.send('capture');
  m.send('frameBad');
  assert.equal(m.state, 'ready');
  assert.equal(m.snapshot().frameRejections, 2);
  m.send('capture');
  m.send('frameOk');
  assert.equal(m.state, 'word');
  assert.equal(m.snapshot().frameRejections, 2, 'frameOk 不该被算成一次拒帧');
});

test('lastRejectReason 只接受枚举内的两种理由，重新拍照即清空', () => {
  // 界面要用它告诉用户"这张太暗/太糊"；把脏值或不认识的值透传给界面等于编理由。
  const m = createMachine({ onEnter: () => {} });
  m.send('capture');
  m.send('frameBad', { reason: 'too_dark' });
  assert.equal(m.snapshot().lastRejectReason, 'too_dark');

  m.send('capture');
  assert.equal(m.snapshot().lastRejectReason, null, '重新拍照必须清掉上一次的拒帧理由');

  m.send('frameBad', { reason: 'too_blurry' });
  assert.equal(m.snapshot().lastRejectReason, 'too_blurry');
  m.send('capture');
  m.send('frameBad', { reason: 'ok' });
  assert.equal(m.snapshot().lastRejectReason, null, 'reason="ok" 不是拒帧理由');

  m.send('capture');
  m.send('frameBad');
  assert.equal(m.snapshot().lastRejectReason, null, '没给 payload 时记 null');
  assert.equal(m.snapshot().frameRejections, 4, '四次 frameBad 逐次计数（含理由非法的那次）');
});

test('停留时长按状态累计（注入时钟），快照含当前状态尚未结算的那一段', () => {
  let t = 1000;
  const m = createMachine({ onEnter: () => {}, now: () => t });
  t = 1500; m.send('capture');      // ready 结算 500
  t = 2000; m.send('frameBad');     // capturing 结算 500，退回 ready
  t = 2600; m.send('capture');      // ready 再结算 600（合计 1100）
  t = 2700;                         // capturing 里又待了 100，尚未结算
  const s = m.snapshot();
  assert.equal(s.dwellMs.ready, 1100);
  assert.equal(s.dwellMs.capturing, 600, '当前状态的部分停留时间也要算进去');
  assert.equal(s.dwellMs.composing, 0);
  assert.equal(s.frameRejections, 1);
});

test('snapshot() 返回副本：调用方改它改不到机器内部账本', () => {
  const m = createMachine({ onEnter: () => {} });
  const s1 = m.snapshot();
  s1.dwellMs.ready = 99999;
  s1.rewriteCount = 42;
  s1.skippedReading = true;
  const s2 = m.snapshot();
  assert.notEqual(s2.dwellMs.ready, 99999);
  assert.equal(s2.rewriteCount, 0);
  assert.equal(s2.skippedReading, false);
});

test('契约违约响亮抛错：onEnter / now 不是函数时抛 TypeError（不是默默用个默认值）', () => {
  // 这两个是**编程错误**，不是用户操作：悄悄兜底会让"忘了传渲染回调"变成"页面永远不渲染"。
  assert.throws(() => createMachine(), TypeError);
  assert.throws(() => createMachine({}), TypeError);
  assert.throws(() => createMachine({ onEnter: null }), TypeError);
  assert.throws(() => createMachine({ onEnter: () => {}, now: 42 }), TypeError);
  assert.throws(() => createMachine({ onEnter: () => {}, now: null }), TypeError);
});

test('TRANSITIONS 是冻结的，且 composing 的唯一出口是 submit', () => {
  assert.equal(Object.isFrozen(TRANSITIONS), true);
  assert.equal(Object.isFrozen(TRANSITIONS.composing), true);
  assert.throws(() => { TRANSITIONS.ready = {}; }, TypeError);
  assert.throws(() => { TRANSITIONS.composing.submit = 'done'; }, TypeError);
  assert.deepEqual(Object.keys(TRANSITIONS.composing), ['submit'],
    'composing 一旦多出别的出口，强制前置就没了');
});

test('状态机是纯逻辑：app.mjs 在 Node 中导入即可用', () => {
  assert.equal(typeof createMachine, 'function');
  // 本文件能跑到这一行本身就是主证据：顶层若碰到 document/window，import 处就挂了。
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
});
