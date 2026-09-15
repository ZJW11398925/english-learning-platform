// tests/recurrence-mount.test.mjs
//
// Task 9 的**复现调度接线**测试：设计文档 §4.5（学完即入队、1/3/7 天）与 §3.4（跨场景复现）
// 落到 `mount()` 之后，界面上看得见什么、事件里记了什么、词记录的排期动没动。
//
// 这个文件存在的理由（brief §3.3.1）：`scheduler.mjs` 的 `nextState` / `dueWords` 与
// `store.mjs` 的 `putWord` / `readWords` 在 `web/` 下**从来没有调用点**——"学完即入队"在计划里
// 没有归属任务。它是复现能发生的前提：不入队，`dueAt` 永远不存在，复现永远不会发生。
//
// 三条最容易写错、且写错了测试若不覆盖就看不出来的地方，各有专门用例：
//   1. **回环不许重置排期**（feedback → rewrite → composing → feedback 再提交一次）；
//   2. **两种复现模式不许合并**（识物命中 `recurrence_scene` / 手选 `recurrence_manual`）；
//   3. **不许谎报换了场景**（场景未知或与上次相同时，`sceneChanged` 必须是 false）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  harness, openCameraAndShoot, reachComposing, submitCompose, settleFeedback,
  manualRecognize, okRecognize,
} from './helpers/mount-harness.mjs';
import { btn, byTag, text } from './helpers/dom.mjs';
import { INTERVALS_DAYS } from '../web/units/scheduler.mjs';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

/** 一次合法的反馈（判定为 flawed 的句子）。 */
const FLAWED = { verdict: 'flawed', error_type: 'word_choice', rewrite: 'I use a mug.', note: '词选得更准' };
const okResult = (over = {}) => ({
  status: 'ok',
  feedback: FLAWED,
  uncertain: false,
  sentence: 'I use a cup.',
  word: 'mug',
  scene: 'kitchen',
  ...over,
});

/** 一个"照实返回"的假提交器（加工是被测代码的事，夹具不替它做）。 */
function fakeCompose(result) {
  const calls = [];
  return {
    calls,
    submitSentence: async (input) => {
      calls.push(input);
      return typeof result === 'function' ? result(input) : result;
    },
  };
}

/** 已经学过一次、现在到期（或没到期）的词记录。 */
const dueWord = (over = {}) => ({
  id: 'mug', word: 'mug', lastScene: 'kitchen', stage: 1, dueAt: T0 - 1, lastReviewedAt: T0 - DAY,
  ...over,
});

// ─────────────────────────── 学完即入队（§4.5）───────────────────────────

test('学完即入队：feedback 态拿到结论那一刻就写词记录（不必等「下一个词」）', async () => {
  // 用户可能不点「下一个词」就关掉页面——那一刻这个词已经学完了。
  // 挂在 done 态上就等于"用户必须点到最后一步才作数"，数据会系统性偏向"愿意走完的人"。
  const compose = fakeCompose(okResult());
  const h = await reachComposing({ compose, clock: () => T0 }, { skipReading: true });
  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);

  assert.equal(h.machine.state, 'feedback', '夹具要停在 feedback——本条正是要证明"还没到 done 就已经入队"');
  const rec = h.store.words.mug;
  assert.ok(rec, '词记录必须已经落盘');
  assert.equal(rec.id, 'mug', '词的 id 就是词本身的小写形式（同一个词多次学是同一条记录）');
  assert.equal(rec.word, 'mug');
  assert.equal(rec.lastScene, 'kitchen', '要留本次学习的场景标签（复现提示要用它）');
  assert.equal(rec.stage, 1, '新词刚排上第 1 档');
  assert.equal(rec.dueAt, T0 + INTERVALS_DAYS[0] * DAY, '新词的 dueAt 必须由 nextState 定，不许手写');
  assert.equal(rec.lastReviewedAt, T0);
  assert.ok(Number.isFinite(rec.createdAt), 'createdAt 由 store.putWord 补（它不是本层手写的字段）');
});

test('入队幂等：回环再提交一次，排期**不许**被推回原点', async () => {
  // brief §3.3.1 点名的那个坑：不做幂等，`feedback → rewrite → composing → feedback` 每次回环
  // 都会把词的排期推回原点，`dueAt` 永远到不了期——**复现永远不会发生**，
  // 而且测试若不覆盖回环就看不出来（单次提交的用例照样全绿）。
  let t = T0;
  const compose = fakeCompose(okResult());
  const h = await reachComposing({ compose, clock: () => t }, { skipReading: true });

  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);
  const first = { ...h.store.words.mug };

  t += 30_000;                              // 回改一版，30 秒后再次提交
  await btn(h.root, '再写一次').click();
  await submitCompose(h, 'I use a mug.');
  await settleFeedback(h);
  const second = h.store.words.mug;

  assert.equal(compose.calls.length, 2, '这一轮确实是两次提交（回环真的走了）');
  assert.equal(second.dueAt, first.dueAt, '回环不许把 dueAt 推到新的 now（推了它就永远到不了期）');
  assert.equal(second.stage, first.stage, 'stage 同样不许被推回第 1 档');
  assert.equal(second.lastReviewedAt, first.lastReviewedAt, 'lastReviewedAt 也不许被这次回环改写');
  assert.equal(second.createdAt, first.createdAt, 'createdAt 必须保留原值（pruneImages 靠它排序）');
});

test('没拿到反馈（pending）也算学完：词照样入队（入队看的是词，不是模型那边成没成）', async () => {
  const compose = fakeCompose({
    status: 'pending', reason: 'timeout', error: 'timeout', detail: '超时',
    sentence: 'I use a cup.', word: 'mug', scene: 'kitchen',
  });
  const h = await reachComposing({ compose, clock: () => T0 }, { skipReading: true });
  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);

  assert.equal(h.machine.state, 'feedback');
  assert.ok(h.store.words.mug, '反馈失败不代表这个词没学过——不入队就等于这次练习不算数');
  assert.equal(h.store.words.mug.dueAt, T0 + INTERVALS_DAYS[0] * DAY);
});

test('入队复用同一个 id：同一个词学第二次不会裂成两条记录', async () => {
  const compose = fakeCompose(okResult());
  // 预置一条"上一次学过、还没到期"的记录（stage 3，dueAt 在未来）：
  // 这次学习既不该新建记录，也不该改写它的排期（复现由 dueWords 那条路推进，这里够不着）。
  const seed = dueWord({ stage: 3, dueAt: T0 + DAY });
  const h = await reachComposing(
    { compose, clock: () => T0, words: { mug: seed } },
    { skipReading: true },
  );
  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);

  assert.deepEqual(Object.keys(h.store.words), ['mug'], '不许出现第二条记录');
  assert.equal(h.store.words.mug.stage, 3, '已存在的记录：入队**什么都不做**（保持既有 stage/dueAt）');
  assert.equal(h.store.words.mug.dueAt, T0 + DAY, 'dueAt 也不许被这次学习改写');
  assert.equal(h.events.filter((e) => e.type.startsWith('recurrence')).length, 0,
    '还没到期 → 这次取词不是复现（复现那条路由 dueWords 判定，不在这里）');
});

test('词的 id 是词本身的小写形式：识物给出 `Mug` 也归并到 `mug` 这条记录上', async () => {
  // brief §3.3.1 的裁决：id 用词本身的小写形式，同一个词多次学是**同一条记录**。
  // 少了小写归一，`Mug` 与 `mug` 会变成两条记录，复现各推各的档、`dueWords` 也会重复派发。
  const compose = fakeCompose(okResult());
  const h = await reachComposing(
    { compose, clock: () => T0, recognize: okRecognize({ word: 'Mug', candidates: [{ label: 'Mug', score: 0.9, scene: 'kitchen' }] }) },
    { skipReading: true },
  );
  await submitCompose(h, 'I use a Mug.');
  await settleFeedback(h);

  assert.deepEqual(Object.keys(h.store.words), ['mug'], `id 必须是小写形式，实测 ${Object.keys(h.store.words).join('/')}`);
  assert.equal(h.store.words.mug.word, 'Mug', '记录里保留界面显示的那个词（大小写按识别结果原样）');
  assert.equal(h.store.words.mug.dueAt, T0 + INTERVALS_DAYS[0] * DAY);
});

// ─────────────────────────── ready 态的到期提示（§3.3.2）───────────────────────────

test('有到期词时 ready 屏显示复现提示：上次的场景 + 换一个地方重拍', async () => {
  const h = await harness({ clock: () => T0, words: { mug: dueWord() } });
  const shown = text(h.root);
  assert.match(shown, /该复习了/, '要到期的词必须让用户看见');
  assert.match(shown, /kitchen/, '要说清这个词上次是在哪个场景学的');
  assert.match(shown, /居家 \/ 通勤 \/ 职场 \/ 餐饮/, '给几个"换个地方"的例子（这几个词不参与任何判定）');
  assert.ok(btn(h.root, '拍照'), '拍照与识物流程不变（复现走同一条识物链路）');
});

test('到期提示的文案里不许有 markdown 强调符（hint() 走 textContent，星号会一字不差显示）', async () => {
  const h = await harness({ clock: () => T0, words: { mug: dueWord() } });
  assert.doesNotMatch(text(h.root), /\*\*/, '这一屏与手选那一屏（brief §3.5 项 0）一起被这条钉住');
});

test('多个词同时到期：一次只提示一个，并说明还有几个在等', async () => {
  const h = await harness({
    clock: () => T0,
    words: { mug: dueWord(), book: dueWord({ id: 'book', word: 'book', lastScene: 'desk', dueAt: T0 - 500 }) },
  });
  const shown = text(h.root);
  // 先到期的是 book（dueAt 更早，dueWords 已排好序）
  assert.match(shown, /desk/, '提示的是最先到期的那个词上次的场景');
  assert.match(shown, /还有 1 个|另有 1 个/, '其余的要说清还有几个在等（别让用户以为只有一个）');
});

test('没有到期词时不提示；已维护（maintained）的词也不提示', async () => {
  const future = await harness({ clock: () => T0, words: { mug: dueWord({ dueAt: T0 + 1 }) } });
  assert.doesNotMatch(text(future.root), /该复习了/, '没到期就不许催（催了就是编一个待办）');

  const kept = await harness({
    clock: () => T0,
    words: { mug: dueWord({ stage: 4, dueAt: null, maintained: true }) },
  });
  assert.doesNotMatch(text(kept.root), /该复习了/, '7 天档跑完转 maintained：不再主动推送（§4.5）');
});

// ────────────────────── 复现命中：两种模式各自落事件（§3.3.3）──────────────────────

test('复现命中（识物）：落 recurrence_scene，并推进 stage/dueAt/lastScene', async () => {
  const h = await harness({
    clock: () => T0,
    words: { mug: dueWord({ createdAt: 111 }) },
    recognize: okRecognize({ word: 'mug', candidates: [{ label: 'mug', score: 0.9, scene: 'desk' }] }),
  });
  await openCameraAndShoot(h);

  const scenes = h.events.filter((e) => e.type === 'recurrence_scene');
  assert.equal(scenes.length, 1, '到期词被识物取到 → 落且只落一条 recurrence_scene');
  assert.equal(h.events.filter((e) => e.type === 'recurrence_manual').length, 0,
    '两种模式分列：识物命中不许同时记一条手选（合并了就看不出"跨场景"是不是靠用户自己挑出来的）');
  assert.equal(scenes[0].payload.word, 'mug');
  assert.equal(scenes[0].payload.scene, 'desk', '记实际场景');
  assert.equal(scenes[0].payload.expectedScene, 'kitchen', '记上次的场景（对比才有意义）');
  assert.equal(scenes[0].payload.sceneChanged, true);
  assert.equal(scenes[0].wordId, 'mug', '事件要能按词 id 与词记录对上');

  const rec = h.store.words.mug;
  assert.equal(rec.stage, 2, '复现完成 → 排上第 2 档（入参 stage 是已完成档数，返回是刚排上的那一档）');
  assert.equal(rec.dueAt, T0 + INTERVALS_DAYS[1] * DAY);
  assert.equal(rec.lastScene, 'desk', 'lastScene 更新为这次的场景（下次提示要说"上次是在 desk"）');
  assert.equal(rec.createdAt, 111, 'createdAt 原样保留（store.putWord 的契约：写回不许重新盖时间戳）');
  assert.match(text(h.root), /重新取到/, '界面上如实说明这次是在新场景重新取到的');
});

test('复现命中（手选）：落 recurrence_manual，与识物命中分列统计', async () => {
  const h = await harness({
    clock: () => T0,
    words: { mug: dueWord() },
    recognize: manualRecognize(),                 // 两轮都没认出可接受词 → 手选档
  });
  await openCameraAndShoot(h);
  assert.equal(h.machine.state, 'capturing', '两轮落空 → 停在手选那一屏');
  await btn(h.root, 'mug').click();               // 用户自己挑了 mug（= 到期词）

  const manual = h.events.filter((e) => e.type === 'recurrence_manual');
  assert.equal(manual.length, 1, '手选到到期词 → 落 recurrence_manual');
  assert.equal(h.events.filter((e) => e.type === 'recurrence_scene').length, 0, '不许同时记识物命中');
  assert.equal(manual[0].payload.word, 'mug');
  assert.equal(manual[0].payload.expectedScene, 'kitchen');
  assert.equal(manual[0].wordId, 'mug');
  assert.equal(h.store.words.mug.stage, 2, '手选同样推进排期（复现确实发生了）');
});

test('场景未知时不谎报"换了场景"：手选档的 sceneChanged 必须是 false，但复现照记', async () => {
  // 手选那一档没有场景可言（界面自己写的是"手动选择"）。系统并不知道用户站在哪儿，
  // 所以**不许**声称他换了地方——数据与界面都不许。
  const h = await harness({
    clock: () => T0, words: { mug: dueWord() }, recognize: manualRecognize(),
  });
  await openCameraAndShoot(h);
  await btn(h.root, 'mug').click();

  const e = h.events.find((x) => x.type === 'recurrence_manual');
  assert.equal(e.payload.sceneChanged, false, '拿不准场景就不许声称换了场景');
  assert.equal(e.payload.scene, '手动选择');
  assert.equal(h.store.words.mug.lastScene, 'kitchen',
    '场景未知时 lastScene 保持上一次的真实场景（写"手动选择"进去会让下次提示说一句没意义的话）');
  assert.doesNotMatch(text(h.root), /换一个地方|换了个地方/, '界面上也不许说"换了场景"');
});

test('同一场景再次取到：sceneChanged 为 false，复现照记（重新取词确实发生了）', async () => {
  const h = await harness({
    clock: () => T0,
    words: { mug: dueWord() },
    recognize: okRecognize({ word: 'mug', candidates: [{ label: 'mug', score: 0.9, scene: 'kitchen' }] }),
  });
  await openCameraAndShoot(h);

  const e = h.events.find((x) => x.type === 'recurrence_scene');
  assert.equal(e.payload.sceneChanged, false, '还是厨房：不许声称换了场景');
  assert.equal(e.payload.expectedScene, 'kitchen');
  assert.equal(h.store.words.mug.stage, 2, '即便没换场景，这次复现也要记（数据不许丢）');
  assert.match(text(h.root), /没能确认与上次不同|没有换/, '界面上如实说明"这次没能确认换了场景"');
});

test('手选了一个"不是到期词"的词：同样不落复现事件、排期不动', async () => {
  const h = await harness({
    clock: () => T0, words: { mug: dueWord() }, recognize: manualRecognize(),
  });
  await openCameraAndShoot(h);
  await btn(h.root, 'book').click();            // 手选包里挑的是 book，不是到期的 mug

  assert.equal(h.events.filter((e) => e.type.startsWith('recurrence')).length, 0);
  assert.equal(h.store.words.mug.stage, 1);
  assert.equal(h.store.words.mug.dueAt, T0 - 1, '到期词没被取到 → 排期不动（它还欠着这次复现）');
});

test('有多个到期词时，取到**任何一个**到期词都算复现（提示只展示最先到期的那个）', async () => {
  // 这条钉的是一个**口径选择**（task-9-report 有记录）：到期提示只说"该复习了：这个词上次是在「…」学的"，
  // **不报词名**——用户被要求"换个地方随便拍一个"。若他只认提示里那一个词，那么"恰好拍中另一个
  // 同样到期的词"就会被静默丢掉：排期不动、他下次还会被同一个词再催一遍，而这次取词白跑。
  // 所以命中集合是**当前全部到期词**，不是只有被展示的那一个。
  const h = await harness({
    clock: () => T0,
    words: {
      mug: dueWord({ dueAt: T0 - 1_000 }),                                   // 先到期（提示展示它）
      book: dueWord({ id: 'book', word: 'book', lastScene: 'desk', dueAt: T0 - 500 }),
    },
    recognize: okRecognize({ word: 'book', candidates: [{ label: 'book', score: 0.9, scene: 'kitchen' }] }),
  });
  await openCameraAndShoot(h);

  const scenes = h.events.filter((e) => e.type === 'recurrence_scene');
  assert.equal(scenes.length, 1, '拍到的是另一个到期词，同样是一次真实的复现');
  assert.equal(scenes[0].payload.word, 'book');
  assert.equal(scenes[0].payload.expectedScene, 'desk', '上次的场景取自**这个词自己的**记录，不是提示里那个');
  assert.equal(scenes[0].payload.sceneChanged, true, 'desk → kitchen 确实换了地方');
  assert.equal(h.store.words.book.stage, 2, '被取到的那个词推进');
  assert.equal(h.store.words.mug.stage, 1, '没被取到的那个词排期一动不动');
  assert.equal(h.store.words.mug.dueAt, T0 - 1_000);
});

test('取到的不是到期词：不落复现事件，排期一动不动', async () => {
  const h = await harness({
    clock: () => T0,
    words: { mug: dueWord() },
    recognize: okRecognize({ word: 'book', candidates: [{ label: 'book', score: 0.9, scene: 'desk' }] }),
  });
  await openCameraAndShoot(h);

  assert.equal(h.events.filter((e) => e.type.startsWith('recurrence')).length, 0,
    '没复现就是没复现，别记一笔"来过"');
  assert.equal(h.store.words.mug.stage, 1, '排期不许动');
  assert.equal(h.store.words.mug.dueAt, T0 - 1);
});

// ───────────────────── 造句落盘 compose_submitted（§3.4）─────────────────────

test('提交成功那一刻落 compose_submitted：提交次数与改写次数两个都给，口径不含糊', async () => {
  let t = T0;
  const compose = fakeCompose(okResult());
  const h = await reachComposing({ compose, clock: () => t }, { skipReading: true });
  t += 4_000;                                   // 在造句这一格停了 4 秒
  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);

  const events = h.events.filter((e) => e.type === 'compose_submitted');
  assert.equal(events.length, 1, '一次提交 = 一条 compose_submitted（它是"产出成本"那一笔）');
  const p = events[0].payload;
  assert.equal(p.sentence, 'I use a cup.', '原句一字不改地落盘（它是产品赌注的证据本身）');
  assert.equal(p.word, 'mug', '词与场景从显示中的词取，不另存一份');
  assert.equal(p.scene, 'kitchen');
  assert.equal(p.submitCount, 1, '零改写会话的提交次数是 1（不是 0）');
  assert.equal(p.revisions, 0, '改写次数 = 提交次数 - 1');
  assert.equal(p.dwellMs, 4_000, 'dwellMs = 进入 composing 到提交的毫秒数（§3.2 筛敷衍样本要用它）');
  assert.equal(p.skippedReading, true);
  assert.equal('rewriteCount' in p, false,
    '采集数据里不许再出现名为 rewriteCount、含义却是"提交次数"的字段（progress 必办 1）');
  assert.equal(events[0].roundIndex, 1, '它属于取词那一轮（造句不是一次新的快门）');
});

test('回环第二次提交：submitCount=2 / revisions=1，dwellMs 是**这一轮**的停留（不是累计）', async () => {
  // 若把快照里的累计 dwellMs 直接落盘，第二次提交会记成 13000ms（两轮之和），
  // 而"这一句到底花了多久"这个数就永远拿不到了——§3.2 要的正是后者。
  let t = T0;
  const compose = fakeCompose(okResult());
  const h = await reachComposing({ compose, clock: () => t }, { skipReading: false });
  t += 4_000;
  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);
  t += 500;
  await btn(h.root, '再写一次').click();
  t += 9_000;
  await submitCompose(h, 'I use a mug.');
  await settleFeedback(h);

  const submitted = h.events.filter((e) => e.type === 'compose_submitted');
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].payload.submitCount, 1);
  assert.equal(submitted[0].payload.revisions, 0);
  assert.equal(submitted[0].payload.dwellMs, 4_000);
  assert.equal(submitted[1].payload.submitCount, 2, '第二次提交后是 2');
  assert.equal(submitted[1].payload.revisions, 1);
  assert.equal(submitted[1].payload.dwellMs, 9_000, '只算第二轮造句那一趟（累计值会是 13000）');
  assert.equal(submitted[1].payload.skippedReading, false, '这一轮没跳过跟读（手动打勾进造句）');
});

test('空句被拦下时不落 compose_submitted（没提交成功就没有产出成本这一笔）', async () => {
  const compose = fakeCompose(okResult());
  const h = await reachComposing({ compose, clock: () => T0 }, { skipReading: true });
  await submitCompose(h, '   ');

  assert.equal(h.machine.state, 'composing', '空句把用户留在造句屏（那一屏才有"回去改"的入口）');
  assert.equal(h.events.filter((e) => e.type === 'compose_submitted').length, 0);
  assert.equal(compose.calls.length, 0);
});

test('同一句话在事件流里是"两条不同用途的记录"，各数各的（不许相加）', async () => {
  // compose_submitted 记产出成本（一句一份），feedback_ok 记判定结果（一次提交一份判定）。
  // 两者都带 payload.sentence，**这不是写了两次**；Task 10 统计造句总数时只数 compose_submitted。
  const compose = fakeCompose(okResult());
  const h = await reachComposing({ compose, clock: () => T0 }, { skipReading: true });
  await submitCompose(h, 'I use a cup.');
  await settleFeedback(h);

  const submitted = h.events.filter((e) => e.type === 'compose_submitted');
  const judged = h.events.filter((e) => ['feedback_ok', 'uncertain', 'feedback_pending'].includes(e.type));
  assert.equal(submitted.length, 1);
  assert.equal(judged.length, 1);
  assert.equal(submitted[0].payload.sentence, judged[0].payload.sentence,
    '同一句话出现在两处**是有意的**：一张记产出成本、一张记判定结果');
  assert.equal(submitted[0].roundIndex, judged[0].roundIndex, '同一条记录的两笔，按轮次能对上');
});

test('造句屏的提示不再说"改写次数"（那是提交次数）——完成页与落盘口径一致', async () => {
  const compose = fakeCompose(okResult());
  const h = await reachComposing({ compose, clock: () => T0 }, { skipReading: true });
  const shown = text(h.root);
  assert.match(shown, /停留时长与提交次数|提交次数/, '造句屏要说清记的是什么（"改写次数"在下游是错的名字）');
  assert.doesNotMatch(shown, /停留时长与改写次数/, '同一个屏幕上说两个口径（提交 vs 改写）会让人按错的那个去算');
});

test('跟读被跳过这件事随 compose_submitted 一起落盘（不另开事件）', async () => {
  const compose = fakeCompose(okResult());
  const skipped = await reachComposing({ compose, clock: () => T0 }, { skipReading: true });
  await submitCompose(skipped, 'I use a cup.');
  await settleFeedback(skipped);
  assert.equal(skipped.events.find((e) => e.type === 'compose_submitted').payload.skippedReading, true);

  const compose2 = fakeCompose(okResult());
  const read = await reachComposing({ compose: compose2, clock: () => T0 }, { skipReading: false });
  await submitCompose(read, 'I use a cup.');
  await settleFeedback(read);
  assert.equal(read.events.find((e) => e.type === 'compose_submitted').payload.skippedReading, false);
});

// ─────────────────── 到期词与显示中的词一致（防止两处各算一套）───────────────────

test('到期提示基于词表算：入队后重新进入 ready 时，到期的词会被提示（不靠内存标志）', async () => {
  const h = await harness({ clock: () => T0 });
  assert.doesNotMatch(text(h.root), /该复习了/, '一开始词表是空的');
  // 学完一个词（入队），再把时间推到 1 天后 → 刷新页面（重新 mount）时应该提示它
  const compose = fakeCompose(okResult());
  const h2 = await reachComposing({ compose, clock: () => T0 }, { skipReading: true });
  await submitCompose(h2, 'I use a cup.');
  await settleFeedback(h2);
  const words = h2.store.words;

  const later = await harness({ clock: () => T0 + INTERVALS_DAYS[0] * DAY + 1, words });
  assert.match(text(later.root), /该复习了/, '过了 1 天，这个词到期了');
  assert.match(text(later.root), /kitchen/);
  assert.equal(byTag(later.root, 'button').length > 0, true);
  // 而 h 那份（空词表）从头到尾都不该被 h2 影响
  assert.deepEqual(h.store.words, {});
});
