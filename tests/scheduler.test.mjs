import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERVALS_DAYS, nextState, dueWords, isMaintained } from '../web/units/scheduler.mjs';

const DAY = 86400000;
const t0 = 1757850000000;

test('新词学完后第一次到期为 1 天后', () => {
  const w = { id: 'w1', stage: 0, createdAt: t0, dueAt: t0 };
  const n = nextState(w, t0);
  assert.equal(n.stage, 1);
  assert.equal(n.dueAt, t0 + 1 * DAY);
});

test('1 天档完成推进到 3 天档', () => {
  // 间隔从**本次复习完成时刻** now 起算（不是从旧的 dueAt 起算）：
  // 到期当天完成 → 下次 3 天后；晚几天才完成 → 同样从完成时刻起算 3 天。
  // 若从旧 dueAt 起算，拖到第 3 天才复习的词会被立刻再次排成到期（连环到期），
  // 与设计文档 §4.5"每次到期需在新场景中重新取词"的顺序执行相矛盾。
  const w = { id: 'w1', stage: 1, createdAt: t0, dueAt: t0 };
  assert.equal(nextState(w, t0).dueAt, t0 + 3 * DAY);
  // 晚 2 天才完成的同一个词：间隔同样从完成时刻起算，不能落在过去
  assert.equal(nextState({ ...w, dueAt: t0 - 2 * DAY }, t0).dueAt, t0 + 3 * DAY);
  assert.equal(nextState({ ...w, dueAt: t0 - 2 * DAY }, t0).stage, 2);
});

test('7 天档完成后转 maintained 且不再有 dueAt', () => {
  const w = { id: 'w1', stage: 3, createdAt: t0, dueAt: t0 };
  const n = nextState(w, t0);
  assert.equal(isMaintained(n), true);
  assert.equal(n.dueAt, null);
});

test('INTERVALS_DAYS 就是设计文档写死的 1/3/7', () => {
  assert.deepEqual([...INTERVALS_DAYS], [1, 3, 7]);
});

test('dueWords 只返回已到期且未 maintained 的词', () => {
  const words = {
    a: { id: 'a', stage: 1, dueAt: t0 - 1, createdAt: t0 },
    b: { id: 'b', stage: 1, dueAt: t0 + DAY, createdAt: t0 },
    c: { id: 'c', stage: 3, dueAt: null, createdAt: t0, maintained: true },
  };
  assert.deepEqual(dueWords(words, t0).map((w) => w.id), ['a']);
});

test('dueWords 对 maintained=true 但 dueAt 还在过去的词也必须排除（两个条件各自都要起作用）', () => {
  // brief 的夹具里 c 同时满足 maintained:true 与 dueAt:null，两条判断互相遮蔽：
  // 只看 dueAt!==null 也过滤得掉 c，于是"maintained 标志"这一条其实没被任何测试钉住。
  // 这里单独造一个 maintained 但 dueAt 仍在过去的词——存储层里手改标志、或将来调度改动
  // 都可能留下这种形状；若 dueWords 丢掉 !isMaintained 判断，它会被当待办推出来。
  const words = {
    live: { id: 'live', stage: 1, dueAt: t0 - 1, createdAt: t0 },
    done: { id: 'done', stage: 4, dueAt: t0 - 5 * DAY, createdAt: t0, maintained: true },
  };
  assert.equal(isMaintained(words.done), true);
  assert.deepEqual(dueWords(words, t0).map((w) => w.id), ['live'],
    'maintained 的词即使 dueAt 在过去也不得进入待办');
});

test('自评测难只记录不影响间隔（同样 stage 得到同样 dueAt）', () => {
  const a = { id: 'a', stage: 1, createdAt: t0, dueAt: t0, difficulty: 'hard' };
  const b = { id: 'b', stage: 1, createdAt: t0, dueAt: t0, difficulty: 'easy' };
  assert.equal(nextState(a, t0).dueAt, nextState(b, t0).dueAt);
});

// ── 以下为 Task 3 的消歧补强（brief 未覆盖的分支；上面的用例逐字照抄 brief）──

test('INTERVALS_DAYS 已冻结：调用方改不动排期（固定 1/3/7 是设计文档写死的契约）', () => {
  // 上面的 deepEqual 只钉住"当前内容"，改不动才让那条断言长期有意义。
  assert.equal(Object.isFrozen(INTERVALS_DAYS), true);
  // 严格模式下给冻结数组赋值会抛 TypeError —— 抛错或不抛都必须保持 1/3/7。
  assert.throws(() => { INTERVALS_DAYS[0] = 99; }, TypeError);
  assert.throws(() => { INTERVALS_DAYS.push(99); }, TypeError);
  assert.deepEqual([...INTERVALS_DAYS], [1, 3, 7], '冻结数组的内容不得被调用方污染');
});

test('nextState 返回新对象，绝不就地改写入参（调用方要留旧状态做对比与日志）', () => {
  const w = { id: 'w1', stage: 1, createdAt: t0, dueAt: t0 };
  const snapshot = { ...w };
  const n = nextState(w, t0);
  assert.notEqual(n, w, '必须是新对象');
  assert.deepEqual(w, snapshot, '入参的 stage/dueAt 等字段一个都不能被改');
  assert.equal(n.stage, 2, '新对象带上推进后的 stage');
  assert.equal(n.id, 'w1', '其余字段（id/createdAt…）应被复制过来');
  assert.equal(n.createdAt, t0, 'nextState 不创建也不改 createdAt，只原样带过');
});

test('stage 字段缺失时按 0 处理（新词可能只写 id 与 dueAt）', () => {
  const n = nextState({ id: 'w1', dueAt: t0 }, t0);
  assert.equal(n.stage, 1);
  assert.equal(n.dueAt, t0 + 1 * DAY);
});

test('stage 3 完成 7 天档后 stage 推进到 4 且 maintained=true（stage 数的是已完成的间隔档）', () => {
  const n = nextState({ id: 'w1', stage: 3, dueAt: t0 }, t0);
  assert.equal(n.stage, 4, '4 = 已跑完 1/3/7 三档，不再有第四个间隔');
  assert.equal(n.maintained, true);
  assert.equal(n.dueAt, null);
});

test('isMaintained：maintained 标志为 true 即视为已维护（即使 dueAt 还有值）', () => {
  assert.equal(isMaintained({ id: 'w', stage: 4, dueAt: t0 + DAY, maintained: true }), true);
});

test('isMaintained：dueAt 为 null 视为已维护，未维护的词为 false', () => {
  assert.equal(isMaintained({ id: 'w', stage: 4, dueAt: null, maintained: true }), true);
  assert.equal(isMaintained({ id: 'w', stage: 1, dueAt: t0 }), false, '还在排期中的词不是 maintained');
});

test('isMaintained 里 dueAt=null 这一条必须与 nextState/dueWords 一致，不得各自漂移', () => {
  // maintained 标志缺失、只有 dueAt=null 的词：nextState 的产物就是这种形状（见上一条），
  // 若 isMaintained 忽略 dueAt===null，那么"已维护的词"会被 dueWords 当成待办。
  const onlyNullDueAt = { id: 'w', stage: 4, dueAt: null };
  assert.equal(isMaintained(onlyNullDueAt), true, 'isMaintained 必须认 dueAt=null');
  assert.deepEqual(dueWords({ w: onlyNullDueAt }, t0 + 100 * DAY).map((x) => x.id), [],
    'dueAt=null 的词不得出现在待办里');
  assert.equal(isMaintained(nextState({ id: 'w', stage: 3, dueAt: t0 }, t0)), true,
    'nextState 产出的终态必须被 isMaintained 认作已维护');
});

test('difficulty 被原样记录（自评测难要能留下来），且 hard/easy 的间隔完全相同', () => {
  // 设计文档 §4.5：自评"这次难/一般/顺"首版只记录、不影响间隔。
  const hard = nextState({ id: 'a', stage: 2, createdAt: t0, dueAt: t0, difficulty: 'hard' }, t0);
  const easy = nextState({ id: 'b', stage: 2, createdAt: t0, dueAt: t0, difficulty: 'easy' }, t0);
  assert.equal(hard.difficulty, 'hard', 'difficulty 不得在推进状态时被丢掉');
  assert.equal(easy.difficulty, 'easy');
  assert.equal(hard.stage, 3);
  assert.equal(easy.stage, 3);
  assert.equal(hard.dueAt, 7 * DAY + t0, 'stage 2 → 第三档 7 天');
  assert.equal(hard.dueAt, easy.dueAt, '难度不同，间隔必须一样');
});

test('dueWords 的到期边界：dueAt <= now 即到期（now 当场算到期），晚 1ms 不算', () => {
  // 设计文档 §5.2：DueScheduler 的用例含"跨天边界"。
  const words = {
    'due-now': { id: 'due-now', stage: 2, dueAt: t0, createdAt: t0 },
    'due-later': { id: 'due-later', stage: 2, dueAt: t0 + 1, createdAt: t0 },
    'due-past': { id: 'due-past', stage: 2, dueAt: t0 - 1, createdAt: t0 },
  };
  assert.deepEqual(dueWords(words, t0).map((w) => w.id), ['due-past', 'due-now']);
});

test('dueWords 只按到期时间排序返回，与词表键的插入顺序无关', () => {
  // 先插入晚到期的、再插入早到期的：若实现只靠 Object.values 的插入顺序，这条会失败。
  const words = {
    late: { id: 'late', stage: 1, dueAt: t0 - 1 * DAY, createdAt: t0 },
    early: { id: 'early', stage: 1, dueAt: t0 - 5 * DAY, createdAt: t0 },
  };
  assert.deepEqual(dueWords(words, t0).map((w) => w.id), ['early', 'late']);
});

test('dueWords 返回的是原词对象（不复制、不改写），且空词表返回空数组', () => {
  const w = { id: 'a', stage: 1, dueAt: t0 - 1, createdAt: t0 };
  const out = dueWords({ a: w }, t0);
  assert.equal(out.length, 1);
  assert.equal(out[0], w, '待办里应是原记录本身，存储层才好按 id 写回');
  assert.deepEqual(dueWords({}, t0), []);
});
