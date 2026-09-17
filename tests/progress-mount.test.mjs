// tests/progress-mount.test.mjs
//
// 阶段 B（进度面）的装配层契约：**首页每个词都带进度**（排到第几档 + 下次什么时候复习）、
// **到期词在首页被单独标出来且自带出口**、**复习页是「清单 + 出口」而不是只报数**、
// 以及**坏掉的词记录不许被藏起来**（红线 4：缺键不写 0 —— 0 是"合法且极好"的读数，
// 会盖住真凶）。
//
// 为什么单开一份（而不是继续塞进 `tests/shell-mount.test.mjs`）：那一份测的是**壳**
// （页签、默认页、视图卸载、两屏的存在性）。这一份测的是**读数**——每个数来自哪儿、
// 说错了会不会被发现。两者的失败含义完全不同：壳坏了是"导航丢了"，读数坏了是
// "向用户谎报学习进度"，而后者是这个产品最不能出的一类错（`units/scheduler.mjs`
// 的模块头原话）。混在一起会让"改坏读数"看起来像"导航回归"。
//
// ⚠️ 本文件里**每一条读数断言都对应 `units/scheduler.mjs` 的一条明文口径**：
//   · 档位读记录里的 `stage` **原值**（那是"已排上的那一档序号"，1/2/3；4 是 maintained 哨兵）；
//   · 下次复习时间读 `word.dueAt`（权威值），**不许**拿 `stage` 去推算日期；
//   · `maintained` 标志与 `dueAt === null` 是同一件事的两种写法，两处都要说"不再催"；
//   · `dueAt` 既非有限数也非 `null` 的记录会被 `dueWords` **静默略过**（既不到期、
//     也不算已维护）——界面必须把它照实说出来，而不是隐藏或补一个默认值。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { harness, disposeAllHarnesses } from './helpers/mount-harness.mjs';

afterEach(disposeAllHarnesses);
import { btn, byTag, text } from './helpers/dom.mjs';
import { createKeyring } from '../web/units/keyring.mjs';
import { fakeLocalStorage } from './helpers/fakes.mjs';

const HOUR = 3600000;
const DAY = 86400000;
const T0 = 1_700_000_000_000;

/**
 * 相对测试时钟 `T0` 的一个时刻：**正偏移 = 将来，负偏移 = 过去**（`at(DAY)` 就是"一天后"）。
 *
 * 为什么用助手而不是在用例里写 `T0 + 5 * HOUR`：满了半年以后没人一眼看得出 `T0 + 432000000`
 * 到底在过去还是将来，而这一页**每一条**断言都取决于这个方向（"到期"与"下次复习"是相反的两侧）。
 * 助手里那个加法是精确整数运算（`T0 + 6 * DAY` 只有 1.75e12，远在 2^53 以内）。
 *
 * ⚠️ 别把它改成 `T0 - offsetMs` 那种"负号藏在助手里"的写法（本轮首版就是那样）：调用点会写成
 * `at(5 * HOUR)` 表示"5 小时后"，两个负号互相抵消，读的人**每次**都要在脑子里算一遍。
 * 而且当时那条"浮点舍入"的解释是**错的**——真正的 bug 在 `daysRelationText` 的取整方向
 * （见那边的注释），把方向摆正之后这个助手不再背任何锅。**别把一条错的解释留在注释里**：
 * 下一个人会照着它去查一个并不存在的问题。
 */
const at = (offsetMs) => T0 + offsetMs;

/**
 * 一条词记录（形状照 `units/store.mjs` 写进去的那份 + `units/scheduler.mjs` 的判据）。
 *
 * ⚠️ 默认**不带** `dueAt`：要测"缺键"那一档就不能让夹具偷偷补一个默认值
 * （那正是被测代码不许做的事）。要一条正常记录就显式传 `dueAt`。
 */
const word = (over = {}) => ({
  id: 'mug', word: 'mug', stage: 0, lastScene: 'kitchen', createdAt: at(0), ...over,
});

/** 首页/复习页那一列词（`.word-chip`，含到期时多带一个 `word-due` 类的那些）。 */
const chips = (root) => byTag(root, 'SPAN').filter((e) => e.className.startsWith('word-chip'));
/** 一条词行的词名（`.word-name` 那一格——不是整行的 textContent：行里还夹着中文进度）。 */
const chipName = (chip) => byTag(chip, 'SPAN').find((e) => e.className === 'word-name')?.textContent;
/** 一条词行的进度那一段（`.word-meta`，含到期/夹缝时额外带的类名）。 */
const chipMeta = (chip) => byTag(chip, 'SPAN').find((e) => e.className.startsWith('word-meta'))?.textContent;
/** 一条词行是不是被标成"该复习"（类名，不是文案——文案由另一条断言钉）。 */
const chipDue = (chip) => chip.className.includes('word-due');

// ─────────────────────── 首页：每个词都带进度（阶段 B 的核心读数）───────────────────────

test('首页每个词都带进度：档位读记录里的 stage 原值，下次复习读 dueAt（三档各一条）', async () => {
  // 三个词各停在不同档、三种时间朝向：**同时**证明"档位"与"下次时间"是两个独立读数
  // （一个从 stage 来、一个从 dueAt 来），而不是同一个数被说了两遍。
  //
  // ⚠️ mug 那一行是这条用例的**核心**，别"顺手改成自洽的数"：
  //    `stage: 1` 而 `dueAt` 是 **6 天后**。按 `INTERVALS_DAYS[0] = 1` 手算，第 1 档该是
  //    1 天，所以"6 天后"这个数**只可能来自记录里的 `dueAt`**。真实世界里这种错位是会发生的
  //    （`units/scheduler.mjs` 的间隔从**本次复习完成时刻**起算，不是从旧 `dueAt` 起算；
  //    加上回环幂等那几条路径），而这正是本阶段最该防的坏法：拿 `stage` 去推算日期。
  //    把实现改成手推（`now + INTERVALS_DAYS[stage - 1] * DAY`），这一条立刻 RED。
  const h = await harness({
    clock: () => T0,
    // createdAt 递降（-3 天 > -2 天 > -1 天）⇒ 界面顺序 = mug / kettle / book（列按 createdAt 降序）
    words: {
      mug: word({ stage: 1, dueAt: at(6 * DAY), createdAt: at(-3 * DAY) }),
      kettle: word({ id: 'kettle', word: 'kettle', stage: 2, dueAt: at(5 * HOUR), createdAt: at(-2 * DAY) }),
      book: word({ id: 'book', word: 'book', stage: 3, dueAt: at(-3 * DAY), createdAt: at(-DAY) }),
    },
  });
  const rows = chips(h.root).map((c) => [chipName(c), chipMeta(c), chipDue(c)]);
  assert.deepEqual(rows, [
    ['book', '第 3 档 · 到期 3 天前', true],          // dueAt 在过去 → 到期（dueWords 的判据是 dueAt <= now）
    ['kettle', '第 2 档 · 下次复习：今天', false],     // 5 小时后（同一日，按 24 小时取整 → 今天）
    ['mug', '第 1 档 · 下次复习：6 天后', false],      // ← 6 天只可能来自 dueAt（第 1 档手推是 1 天）
  ], '每个词一行：词名 + 第几档 + 下次什么时候复习；到期那几个被单独标出来');
  // 档位是**原值**：三个词的 stage 是 1/2/3，界面就报 1/2/3。
  // 若有人"顺手"把它归约成"已完成 N 档"（-1）或"N/3"（另一套口径），上面那条 deepEqual 立刻 RED
  // ——这正是本阶段最容易犯的错（`units/scheduler.mjs` 的模块头点名了这个字段进出含义不同）。
  assert.equal(text(h.root).includes('第 0 档'), false, '没有 stage=0 的词，就不该冒出"第 0 档"');
});

test('首页到期那几个词带「该复习」徽标，未到期的一个都没有（徽标只标"此刻要不要复习"）', async () => {
  const h = await harness({
    clock: () => T0,
    words: {
      mug: word({ stage: 1, dueAt: at(-HOUR) }),
      book: word({ id: 'book', word: 'book', stage: 1, dueAt: at(-2 * HOUR), createdAt: at(-HOUR) }),
      pen: word({ id: 'pen', word: 'pen', stage: 1, dueAt: at(DAY), createdAt: at(-2 * HOUR) }),
    },
  });
  const badges = byTag(h.root, 'SPAN').filter((e) => e.className === 'due-badge');
  assert.equal(badges.length, 2, `恰好两个到期词各一个徽标，实测 ${badges.length} 个`);
  assert.deepEqual(badges.map((b) => b.textContent), ['该复习', '该复习']);
  // 徽标**不报数**（个数在卡片那一行总数里）：同一屏两个同一来源的数迟早会不一致。
  // 若有人把徽标写成"该复习（2 个）"，这一条 RED。
  assert.deepEqual([...new Set(badges.map((b) => b.textContent))], ['该复习'], '徽标只说"该复习"，不带数字');
  // 未到期的那个词既没有徽标、也没有到期行的样式
  const pen = chips(h.root).find((c) => chipName(c) === 'pen');
  assert.equal(chipDue(pen), false, '没到期的词不许被标成"该复习"');
  assert.equal(chipMeta(pen), '第 1 档 · 下次复习：1 天后');
});

test('首页到期那一段自带出口：总数 + 「去学习」+ 「开始学习」，三条都在', async () => {
  // 阶段 B 之前首页只有一行"今天该复习 N 个词"和一句场景提示，**出口只有大字入口**。
  // 现在到期那一段自己带一条出口（用户读完"最先到期的是厨房那个词"之后，手不用往下找）。
  const h = await harness({
    clock: () => T0,
    words: { mug: word({ stage: 1, dueAt: at(-HOUR), lastScene: 'kitchen' }) },
  });
  assert.match(text(h.root), /今天该复习 1 个词/, '总数照旧只在真有到期词时出现');
  assert.match(text(h.root), /最先到期的是「kitchen」场景学的那个词/, '场景提示照旧（它是建议不是判定）');
  const go = btn(h.root, '去学习');
  assert.ok(go, '到期那一段要有「去学习」这条出口（复现 = 去学习页重新拍一张）');
  assert.equal(go.className.includes('primary'), false,
    '这条出口**不带** `.primary`：重音只给学习流程里那一颗推进按钮（六屏表是人裁决，不是本阶段能扩的）');
  await go.click();
  assert.ok(btn(h.root, '拍照'), '「去学习」把人送到取词那一屏');
});

test('首页：没有到期词时**不出现**「今天该复习 N 个词」，也不出现「去学习」（不造一个必然是空的入口）', async () => {
  // ⚠️ 这是阶段 A 那条守卫的**加强版**（原文只查"那一行不出现"）。阶段 B 给首页加了
  // 「去学习」这条出口，于是多了一个新的坏法：那一行藏了、出口却还挂着——用户点进去
  // 发现一个词都不欠复习。两个都必须是"没有就不出现"。
  const future = await harness({ clock: () => T0, words: { mug: word({ stage: 1, dueAt: at(DAY) }) } });
  assert.doesNotMatch(text(future.root), /今天该复习 \d+ 个词/, '没到期就不许显示那一行');
  assert.equal(btn(future.root, '去学习'), undefined, '没到期就不许挂"去学习"（那会指向一件不存在的事）');
  assert.ok(btn(future.root, '开始学习'), '但大字入口照旧在（首页永远有出路）');

  const kept = await harness({ clock: () => T0, words: { mug: word({ stage: 4, dueAt: null, maintained: true }) } });
  assert.doesNotMatch(text(kept.root), /今天该复习 \d+ 个词/, '已维护的词不算到期（dueWords 不催它）');
  assert.equal(btn(kept.root, '去学习'), undefined, '已维护的词也不许触发"去学习"');
});

// ─────────────────── 已维护：`maintained` 与 `dueAt === null` 两种写法都要说"不再催" ───────────────────

test('已维护的词显示「已维护 · 不再催复习」，且不进到期那一段（两种写法都认）', async () => {
  // 两种写法必须**都对**：`units/scheduler.mjs` 的 `isMaintained` 明文认这两个
  // （`maintained === true` 或 `dueAt === null`），而界面若只认其中一个，就会出现
  // "跑完 7 天档的词又被催一次"——那是在编一个并不存在的档位（§4.5：第 4 档不存在）。
  const h = await harness({
    clock: () => T0,
    words: {
      oldOne: word({ id: 'oldOne', word: 'oldOne', stage: 4, dueAt: null, maintained: true, createdAt: at(-DAY) }),
      newOne: word({ id: 'newOne', word: 'newOne', stage: 4, dueAt: null, maintained: false, createdAt: at(-2 * DAY) }),
    },
  });
  const rows = chips(h.root).map((c) => [chipName(c), chipMeta(c)]);
  assert.deepEqual(rows, [
    ['oldOne', '已维护 · 不再催复习'],
    ['newOne', '已维护 · 不再催复习'],
  ], '两种"已维护"写法在界面上是同一句话（标志为真 / dueAt 为 null）');
  assert.equal(byTag(h.root, 'SPAN').some((e) => e.className === 'due-badge'), false,
    '已维护的词不许带「该复习」徽标');
  assert.equal(text(h.root).includes('今天该复习'), false, '一个到期词都没有 ⇒ 那一行整段不出现');
});

// ──────────── 坏掉的记录不许被藏起来：`dueAt` 既非有限数也非 null 的那种夹缝 ────────────

test('`dueAt` 缺失 / NaN 的词照样列出来，并如实说"缺下次复习时间"（不补默认值、不隐藏）', async () => {
  // 这是 `units/scheduler.mjs` 模块头点名的那个**无声夹缝**：`dueAt` 不是有限数也不是 null
  // 时，`dueWords` 会**静默略过**它——既不算已维护、又永远不到期。少了这一条，这种记录
  // 在界面上就等于不存在（用户永远不知道自己的词表里有一条坏了）。
  //
  // ⚠️ 界面**不许**补一个默认值：红线 4（缺键不写 0）——补出来的数会盖住真凶。
  const h = await harness({
    clock: () => T0,
    words: {
      missing: word({ id: 'missing', word: 'missing', stage: 1, createdAt: at(-DAY) }),          // dueAt 整个缺失
      bad: word({ id: 'bad', word: 'bad', stage: 2, dueAt: Number.NaN, createdAt: at(-2 * DAY) }),   // dueAt 是 NaN
    },
  });
  const rows = chips(h.root).map((c) => [chipName(c), chipMeta(c)]);
  assert.deepEqual(rows, [
    ['missing', '第 1 档 · 缺下次复习时间'],
    ['bad', '第 2 档 · 缺下次复习时间'],
  ], '坏掉的记录要照实说出来（缺键不写 0：不补日期、不假装已维护、也不把它从列表里去掉）');
  // 它们**不是**到期词：`dueWords` 略过它们（这是要如实呈现的事实，不是要"修好"的东西）
  assert.equal(text(h.root).includes('今天该复习'), false, '夹缝记录不算到期词（dueWords 略过它们）');
  assert.equal(byTag(h.root, 'SPAN').some((e) => e.className === 'due-badge'), false, '也不许给它们挂「该复习」徽标');
});

// ─────────────────────────── 空状态的下一步（配了 Key / 没配 Key 是两件事）───────────────────────────

test('首页空词表：配了 Key 时下一步是去拍照（空状态里的那句话与按钮是同一件事）', async () => {
  const h = await harness();
  const empty = byTag(h.root, 'P').find((e) => e.className === 'empty');
  assert.ok(empty, '空词表必须给一个空状态块（不是一片空白）');
  assert.match(empty.textContent, /开始学习/, '空状态要指出下一步走哪条路');
  assert.ok(btn(h.root, '开始学习'), '而且那条路真的在（大字入口）');
  // 反面：配了 Key 的人不该在空状态里被指去设置（他已经配好了）
  assert.equal(empty.textContent.includes('API Key'), false, '配好了 Key 就不许再叫他去配 Key');
});

test('首页空词表：**没配 Key** 时下一步是去设置（不把一个会被拦下的动作当成"下一步"）', async () => {
  // 没配 Key 时点「开始学习」→ 点「拍照」会被拦下（`onCapture` 的守卫）并指回设置。
  // 空状态若照旧说"点上面的「开始学习」"，就是让用户白跑一趟——空状态的职责恰恰是
  // "告诉他下一步做什么"。这一档的用户是**首次访问者**（词表空 + 没 Key），
  // 所以他还没读过 ready 屏那段引导，空状态必须自带"为什么 / 去哪拿 / 存哪"。
  const h = await harness({ keyring: createKeyring({ storage: fakeLocalStorage() }) });
  const empty = byTag(h.root, 'P').find((e) => e.className === 'empty');
  assert.ok(empty, '没配 Key 时也要有空状态块');
  assert.match(empty.textContent, /API Key/, '要说清为什么现在走不通');
  assert.match(empty.textContent, /「设置（API Key）」/, '要指出真正的下一步（去设置里粘贴 Key）');
  assert.match(empty.textContent, /platform\.deepseek\.com/, '并给出拿 Key 的地方（照抄 ready 屏的引导口径）');
  assert.match(empty.textContent, /只保存在这台手机的浏览器里/, '并说清 Key 存在哪（与 NO_KEY_GUIDANCE 同一口径）');
  // ⚠️ 这一条**不能**写成简单的 `includes('开始学习') === false`：那句话里会出现「开始学习」
  // 四个字——因为空状态正是在说"点它会被拦下"。本轮首跑就写成了那一版，被自己的文案骗了一次
  // （探针实测见 `tmp/probes/progress-nokey-probe.mjs`）。
  // 真正要防的是**把那条走不通的路说成下一步**，所以判据落在"有没有叫用户去点上面那颗按钮"
  // 这个**指令句式**上（配了 Key 的那一档才用它），而不是"页面上有没有出现那四个字"。
  assert.equal(empty.textContent.includes('点上面的「开始学习」'), false,
    '没配 Key 时不许叫用户去点「开始学习」（那一步会被拦下；只有配好 Key 的那一档才这么说）');
  assert.ok(btn(h.root, '设置（API Key）'), '而那条出路真的在（入口每屏都挂着）');
});

// ─────────────────────────────── 词多到需要折叠（12 + 一句话）───────────────────────────────

test('已学词超过 12 个时只铺 12 行，剩下的用一句话交代（折叠不丢数）', async () => {
  const many = {};
  for (let i = 1; i <= 14; i += 1) {
    const id = `w${String(i).padStart(2, '0')}`;
    many[id] = word({ id, word: id, stage: 1, dueAt: at(DAY), createdAt: at(-i * 1000) });
  }
  const h = await harness({ clock: () => T0, words: many });
  assert.equal(chips(h.root).length, 12, '最多铺 12 行（LEARNED_PREVIEW_MAX）');
  assert.match(text(h.root), /已学 14 个词/, '总数照实报（折叠的只是显示）');
  assert.match(text(h.root), /另有 2 个词/, '被折叠的那几个要说清有几个（不许静默吞掉）');
  assert.deepEqual(chips(h.root).map(chipName), [
    'w01', 'w02', 'w03', 'w04', 'w05', 'w06', 'w07', 'w08', 'w09', 'w10', 'w11', 'w12',
  ], '铺的是最近学的 12 个（createdAt 降序），被折叠的是最老的');
});

// ─────────────────────────── 复习页：清单 + 出口（页面语义已由用户裁决）───────────────────────────

test('复习页清单每行给词名 / 档位 / 上次场景 / 到期多久，且按到期时间从早到晚', async () => {
  const h = await harness({
    clock: () => T0,
    words: {
      // dueWords 按 dueAt 升序：newest 最晚到期 ⇒ 排在最后（界面不重排）
      oldest: word({ id: 'oldest', word: 'oldest', stage: 1, dueAt: at(-5 * DAY), lastScene: 'street', createdAt: at(-3 * DAY) }),
      middle: word({ id: 'middle', word: 'middle', stage: 2, dueAt: at(-2 * DAY), lastScene: 'desk', createdAt: at(-2 * DAY) }),
      newest: word({ id: 'newest', word: 'newest', stage: 3, dueAt: at(-HOUR), lastScene: 'kitchen', createdAt: at(-DAY) }),
      // 没到期的那个**不许**出现在清单里（清单 = 到期待办，不是词表）
      later: word({ id: 'later', word: 'later', stage: 1, dueAt: at(DAY), createdAt: at(0) }),
    },
  });
  await btn(h.root, '复习').click();       // 底部页签（精确文案那一枚）
  const rows = chips(h.root).map((c) => [chipName(c), chipMeta(c)]);
  assert.deepEqual(rows, [
    ['oldest', '第 1 档 · 上次「street」场景 · 到期 5 天前'],
    ['middle', '第 2 档 · 上次「desk」场景 · 到期 2 天前'],
    ['newest', '第 3 档 · 上次「kitchen」场景 · 到期 今天'],
  ], '清单按到期时间从早到晚，每行给档位 / 上次场景 / 这笔欠账有多旧');
  assert.equal(rows.some(([n]) => n === 'later'), false, '没到期的词不进清单');
  // 每行都标成"该复习"（这一页列的就是到期词）
  assert.equal(chips(h.root).every(chipDue), true, '复习页清单里的每一行都是到期词');
});

test('复习页：上次场景没记到时说「未知」，不编一个场景', async () => {
  const h = await harness({
    clock: () => T0,
    words: { mug: word({ stage: 1, dueAt: at(-HOUR), lastScene: null }) },
  });
  await btn(h.root, '复习').click();
  assert.equal(chipMeta(chips(h.root)[0]), '第 1 档 · 上次「未知」场景 · 到期 今天',
    '场景缺失时说着实情（与 ready 屏的 `lastScene ?? \'未知\'` 同一口径），不编一个场景出来');
});

test('复习页没有到期词时：空状态 + 「去学习」照旧（不是一屏死路）', async () => {
  const h = await harness({ clock: () => T0, words: { mug: word({ stage: 1, dueAt: at(DAY) }) } });
  await btn(h.root, '复习').click();
  const shown = text(h.root);
  assert.match(shown, /现在没有到期的词/, '空状态要说清这一页为什么是空的');
  assert.equal(chips(h.root).length, 0, '没有到期词就没有清单（不是一张空表格）');
  assert.ok(btn(h.root, '去学习'), '出口照旧在');
  assert.equal(btn(h.root, '去补交这几句'), undefined, '没有欠账就不给补交入口（不造一个必然是空的入口）');
});
