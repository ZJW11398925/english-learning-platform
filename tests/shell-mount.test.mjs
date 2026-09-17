// tests/shell-mount.test.mjs
//
// 阶段 A（应用骨架）的装配层契约：**应用栏 + 底部四页签 + 默认落在首页 + 只渲染当前视图**。
//
// 为什么单开一份（而不是塞进 `tests/app-mount.test.mjs`）：那一份测的是"取词链路怎么落到
// 状态/事件/文字上"，这一份测的是"**壳**"——页签、当前视图、首页/复习页这两屏新内容。
// 两者的失败含义完全不同（链路坏了 vs 导航坏了），混在一起会让"改坏导航"看起来像"链路回归"。
//
// ⚠️ 这一份的核心不是"首页长得对不对"（那是截图与人看的事），而是三条**结构性**判据：
//   1. **默认落在首页**（人裁决）；
//   2. **非活动视图从 DOM 卸载**——不是 `display:none` 藏着。
//      假 DOM 里**没有任何 CSS**，所以"`btn(root,'拍照')` 找得到"只可能意味着
//      "那个按钮真的还在树上"。这条判据因此在结构上等价于"浏览器里没被藏起来"，
//      而浏览器那半边由报告里的实测表另行钉住（两层证据互不替代）。
//   3. **页签与状态机正交**：切页签不动学习现场。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  harness, withFetch, okFetch, realRecognizeWithFallback, gotoLearn,
  disposeAllHarnesses,
} from './helpers/mount-harness.mjs';

afterEach(disposeAllHarnesses);
import { btn, byTag, text } from './helpers/dom.mjs';

const HOUR = 3600000;
const DAY = 86400000;

/** 一个**已到期**的词记录（形状照 `units/store.mjs` 写进去的那份 + `units/scheduler.mjs` 的判据）。 */
const dueWord = (over = {}) => ({
  id: 'mug', word: 'mug', stage: 0, dueAt: 1000, lastScene: 'kitchen', createdAt: 1000, ...over,
});

/** 底部那四枚页签（**精确文案**：`btn()` 是 `includes` 匹配，而「开始学习」包含「学习」）。 */
const tabButtons = (root) => byTag(root, 'NAV')[0]?.children ?? [];
const tab = (root, label) => tabButtons(root).find((b) => b.textContent === label);

/** 当前高亮的那一枚页签（判据是 `aria-current="page"`，不是位置/类名）。 */
const currentTab = (root) => tabButtons(root).find((b) => b.attributes['aria-current'] === 'page');

// ─────────────────────────── 默认落在首页 + 页签本身 ───────────────────────────

test('默认落在「首页」：一挂载就是首页内容，取词入口「拍照」在 DOM 里**不存在**', async () => {
  const h = await harness();
  assert.equal(h.machine.state, 'ready', '状态机不受页签影响（默认页是界面的事，不是状态机的事）');
  assert.ok(btn(h.root, '开始学习'), '首页要有大字入口「开始学习」');
  assert.match(text(h.root), /拍一下，学一个词/, '首页要有品牌的一句话说明');
  // ⚠️ 这条是"非活动视图必须卸载"的**结构判据**：假 DOM 没有 CSS，找不到 = 不在树上。
  // 若实现改成 display:none 藏着，这颗按钮会重新出现在这里 ⇒ 立刻 RED。
  assert.equal(btn(h.root, '拍照'), undefined,
    '首页上不许找得到「拍照」——取词那一条流程属于学习页，非活动视图必须从 DOM 卸载');
  assert.equal(btn(h.root, '快门'), undefined, '首页上同样不该有「快门」');
  assert.equal(byTag(h.root, 'TEXTAREA').length, 0, '首页上不该有造句框');
});

test('底部恰好四枚页签，文案逐个钉住，且当前页签带 aria-current="page"', async () => {
  const h = await harness();
  assert.equal(tabButtons(h.root).length, 4, '底部恰好四枚页签');
  assert.deepEqual(tabButtons(h.root).map((b) => b.textContent), ['首页', '学习', '复习', '设置'],
    '四枚页签的文案是任务书钉死的那四个（顺序即界面顺序）');
  assert.equal(currentTab(h.root)?.textContent, '首页', '默认高亮的是首页');
  // 高亮只有一处（两枚同时亮 = 用户看不出自己在哪儿）
  assert.equal(tabButtons(h.root).filter((b) => b.attributes['aria-current'] === 'page').length, 1);
});

test('四个页签逐个点过去：每个都落在自己的那一屏，且高亮跟着走', async () => {
  const h = await harness();
  // 每一档的判据都是**那一屏独有的用户可见文字**
  const CASES = [
    ['学习', /拍一件你身边的东西/, '拍照'],
    ['复习', /^|\u0000/, '去学习'],
    ['设置', /设置 · API Key/, '保存'],
    ['首页', /拍一下，学一个词/, '开始学习'],
  ];
  for (const [label, mark, ownButton] of CASES) {
    await tab(h.root, label).click();
    assert.equal(currentTab(h.root)?.textContent, label, `点了「${label}」之后高亮要跟着走`);
    assert.match(text(h.root), mark, `「${label}」页要渲染出自己那一屏的内容`);
    assert.ok(btn(h.root, ownButton), `「${label}」页上要有自己的按钮「${ownButton}」`);
  }
});

test('切页签 = **换视图**：离开的那一屏的按钮从 DOM 里消失（不是藏起来）', async () => {
  const h = await harness();
  await gotoLearn(h.root);
  assert.ok(btn(h.root, '拍照'), '学习页上有取词入口');
  assert.equal(btn(h.root, '开始学习'), undefined, '学习页上不该有首页的大字入口（首页已卸载）');

  await tab(h.root, '首页').click();
  assert.equal(btn(h.root, '拍照'), undefined, '切回首页后取词入口必须从 DOM 里消失');
  assert.ok(btn(h.root, '开始学习'), '首页自己的内容回来了（是新建的元素，不是把旧的显示出来）');

  await tab(h.root, '复习').click();
  assert.equal(btn(h.root, '开始学习'), undefined, '复习页上不该有首页的入口');
  assert.equal(btn(h.root, '拍照'), undefined, '复习页上不该有取词入口');
});

test('点「开始学习」→ 切到学习页（大字入口是页签的第二种走法）', async () => {
  const h = await harness();
  await btn(h.root, '开始学习').click();
  assert.ok(btn(h.root, '拍照'), '学习页到了');
  assert.equal(currentTab(h.root)?.textContent, '学习', '高亮也要跟着走');
});

test('切走学习页 = **结束这次取词**：关流 + 回 ready，切回来是「可操作」的一屏（不是一块死 video）', async () => {
  // ⚠️ 口径**已被新裁决反转**（2026-09-17，任务书 `TASK-…db.23` ②）。这一条原先钉的是
  // "切页签不许动状态机、取景画面原样还在"（阶段 A 的有意取舍）。新裁决的实操理由：
  // 用户从取景屏切走 → 切回来**面对一块死画面**（video 节点还在、流已经关了/停了），
  // 而那一屏全屏只有「快门」与「再拍一张」，除了按快门或刷新无路可走；摄像头还一直开着。
  // 现在的口径：**取景这一屏不再显示 = 这一次取词结束**（理由与代价写在 `web/app.mjs`
  // 里 `tab` 声明处的 ⚠️）。断言的强度没有降：从"状态与画面原样还在"换成了
  // "流真的停了 + 切回来真的能重新取词"。
  const h = await harness();
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'capturing');
  assert.deepEqual(h.stream.tracks.map((t) => t.stopped), [false, false],
    '取景时流必须是活的——否则这条用例后面"流停了"什么都证明不了');

  await tab(h.root, '首页').click();
  assert.equal(h.machine.state, 'ready', '离开学习页 = 这一次取词结束（状态回 ready）');
  assert.deepEqual(h.stream.tracks.map((t) => t.stopped), [true, true],
    '摄像头必须真的关掉（数的是 track.stop() 有没有落到每一条轨上，不是"调没调 stopStream"）');
  assert.equal(byTag(h.root, 'VIDEO').length, 0, '首页上没有取景画面（capturing 那一屏已卸载）');

  await tab(h.root, '学习').click();
  assert.equal(h.machine.state, 'ready', '切回来落在 ready 这一格');
  assert.ok(btn(h.root, '拍照'), '这一屏是可操作的：重新取词的入口在');
  assert.equal(btn(h.root, '快门'), undefined, '死画面那一屏（快门 + 一块没画面的 video）不许再出现');
  assert.equal(byTag(h.root, 'VIDEO').length, 0, '连 video 节点都没有 = 不存在"流关了画面还挂着"');
  assert.equal(h.calls.openCamera.length, 1, '切回来不许自动重开相机（开相机只能由用户点「拍照」触发）');
});

test('取景屏的「返回」= 用户主动放弃：回 ready、关流、**事件流一条都不增**', async () => {
  // 这一条钉的是 `cancelCapture` 与 `frameBad` 的**分界**（任务书 `TASK-…db.23` ① 的红线）。
  // 走 `frameBad` 收尾会留下三样东西：`frameRejections` 加一、`lastRejectReason` 写进一个
  // 用户根本没遇到的失败理由、并落一条 `frame_rejected` —— 那等于**替用户伪造一次拒帧**。
  // 所以这里不满足于"状态回到了 ready"，必须逐条证明那三样都没发生。
  const h = await harness();
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  assert.equal(h.machine.state, 'capturing');
  assert.ok(btn(h.root, '返回'), '取景屏必须有退出口（页签让人能中途走开之后，没它就把用户困住了）');

  const before = h.events.length;
  const beforeRejections = h.machine.snapshot().frameRejections;

  await btn(h.root, '返回').click();

  assert.equal(h.machine.state, 'ready', '放弃之后回到 ready（可以重新取词）');
  assert.deepEqual(h.stream.tracks.map((t) => t.stopped), [true, true], '退出时摄像头必须真的关掉');
  assert.equal(byTag(h.root, 'VIDEO').length, 0, '取景画面已卸载');
  assert.ok(btn(h.root, '拍照'), '回到的是可操作的那一屏');

  // ① 事件流一条都不增（`h.events` 就是夹具的事件数组本身）。
  assert.equal(h.events.length, before,
    '用户主动放弃不落任何事件——它不是拒帧、不是识别失败');
  assert.equal(h.events.some((e) => e.type === 'frame_rejected'), false,
    '尤其不许落 frame_rejected');
  // ② 拒帧计数不动（这是"没借 frameBad 收尾"的另一面证据）。
  assert.equal(h.machine.snapshot().frameRejections, beforeRejections,
    'frameRejections 不许因为一次主动放弃而增加');
  // ③ 不写失败理由：否则界面下次会说"刚才那张太暗/太糊"，而用户根本没拍过那一张。
  assert.equal(h.machine.snapshot().lastRejectReason, null,
    'lastRejectReason 不许被一次主动放弃写进任何值');
});

// ─────────────────────────── 首页内容 ───────────────────────────

test('首页：`今天该复习 N 个词` 只在**真有到期词**时出现，N 数的是到期词', async () => {
  // 没有到期词：这一行**根本不出现**（不写"今天该复习 0 个词"——0 在那儿不是一条信息）
  const none = await harness({ clock: () => 100_000, words: { mug: dueWord({ dueAt: 200_000 }) } });
  assert.doesNotMatch(text(none.root), /今天该复习 \d+ 个词/, '没到期就不许显示那一行');

  // 两个到期（一个已经到期、一个更早到期）+ 一个没到期 → 数出来的必须是 2
  const some = await harness({
    clock: () => 100_000,
    words: {
      mug: dueWord({ dueAt: 90_000, createdAt: 1 }),
      book: dueWord({ id: 'book', word: 'book', dueAt: 50_000, lastScene: 'desk', createdAt: 2 }),
      pen: dueWord({ id: 'pen', word: 'pen', dueAt: 100_000 + HOUR, createdAt: 3 }),
    },
  });
  const shown = text(some.root);
  assert.match(shown, /今天该复习 2 个词/, '到期词数必须来自 dueWords（不是 store.readWords 的总数）');
  assert.doesNotMatch(shown, /今天该复习 3 个词/, '没到期的那个词不算');
});

test('首页：词表为空时给**像样的空状态**（不是一片空白）；有词时给词数与那一列词', async () => {
  const empty = await harness();
  const emptyText = text(empty.root);
  assert.match(emptyText, /还没有学过的词/, '空状态要说清"现在没有"');
  assert.match(emptyText, /开始学习/, '空状态要告诉用户下一步做什么');
  assert.equal(/已学 \d+ 个词/.test(emptyText), false, '没有词就不许报一个数（0 个词是编出来的话）');

  // 一个 8 天前学的、一个 1 天前学的 → 概览里按"最近学的在前"排，且词名来自记录本身
  const some = await harness({
    clock: () => 100_000,
    words: {
      mug: dueWord({ createdAt: 100_000 - 8 * DAY }),
      kettle: dueWord({ id: 'kettle', word: 'kettle', lastScene: 'kitchen', createdAt: 100_000 - DAY }),
    },
  });
  const someText = text(some.root);
  assert.match(someText, /已学 2 个词/, '词数要如实报出来');
  assert.equal(btn(some.root, '开始学习') !== undefined, true, '空状态之外，大字入口当然也还在');
  const chips = byTag(some.root, 'SPAN').filter((e) => e.className === 'word-chip');
  assert.deepEqual(chips.map((c) => c.textContent), ['kettle', 'mug'], '最近学的排前面（createdAt 降序）');
});

// ─────────────────────────── 复习页（阶段 A 最小可用）───────────────────────────

test('复习页：显示待补反馈条数与到期词数，出口能回到**既有**待补抽屉', async () => {
  const priorEvents = [
    {
      ts: 1000,
      type: 'compose_submitted',
      wordId: 'mug',
      sessionId: 's-old',
      roundIndex: 1,
      payload: { sentence: 'She go to school yesterday.', word: 'mug', scene: 'kitchen' },
    },
    {
      ts: 1040,
      type: 'feedback_pending',
      wordId: 'mug',
      sessionId: 's-old',
      roundIndex: 1,
      payload: {
        pendingId: 'p_1',
        sentence: 'She go to school yesterday.',
        word: 'mug',
        scene: 'kitchen',
        reason: 'timeout',
      },
    },
  ];
  const h = await harness({ clock: () => 100_000, words: { mug: dueWord({ dueAt: 90_000 }) }, priorEvents });
  await tab(h.root, '复习').click();
  const shown = text(h.root);
  assert.match(shown, /待补反馈 1 条/, '复习页要把待补条数如实摊出来');
  assert.match(shown, /今天该复习 1 个词/, '到期词数同样如实（与首页同一个起源）');

  // 出口：进既有抽屉（不是另造一套待补界面）
  await btn(h.root, '去补交这几句').click();
  assert.match(text(h.root), /She go to school yesterday\./, '点进去看到的必须是**既有**待补抽屉里的那条原句');
  await btn(h.root, '返回').click();
  assert.equal(currentTab(h.root)?.textContent, '复习', '从抽屉返回要回到打开它的那一页');

  // 另一条出口：去学习页
  await btn(h.root, '去学习').click();
  assert.ok(btn(h.root, '拍照'), '「去学习」把人送到取词那一屏');
  assert.equal(currentTab(h.root)?.textContent, '学习');
});

test('复习页：没有欠账时不出现"去补交"（不造一个必然是空的入口）', async () => {
  const h = await harness();
  await tab(h.root, '复习').click();
  const shown = text(h.root);
  assert.match(shown, /待补反馈 0 条/, '没有欠账就如实说是 0 条');
  assert.equal(btn(h.root, '去补交这几句'), undefined, '没有欠账就不给补交入口（点进去只会看到空列表）');
  assert.ok(btn(h.root, '去学习'), '但"去学习"这条出口永远在');
});

// ─────────────────────────── 设置页签与「返回」的去处 ───────────────────────────

test('设置既是页签也是抽屉：页签进去、返回回到**来处那一页**（不是硬编码回首页）', async () => {
  const h = await harness();
  await tab(h.root, '设置').click();
  assert.match(text(h.root), /设置 · API Key/, '设置页签就是设置那一屏');
  await btn(h.root, '返回').click();
  assert.equal(currentTab(h.root)?.textContent, '首页', '从首页进的设置，返回回首页');

  await tab(h.root, '复习').click();
  await tab(h.root, '设置').click();
  await btn(h.root, '返回').click();
  assert.equal(currentTab(h.root)?.textContent, '复习', '从复习页进的设置，返回回复习页');
});

test('每屏都挂的「设置（API Key）」入口同样切到设置页，返回时回来处（学习页 ready 那一格不变）', async () => {
  // ⚠️ 这条原先走的是"从 capturing 那一屏进设置"（断言"学习现场一点没动"）。新裁决之后
  // 那条路**会结束这次取词**（离开学习页 = 关流 + 回 ready），"现场一点没动"不再成立。
  // 「从取景屏离开 = 这次取词结束」那一趟由本文件上面那两条（`cancelCapture` 的账、
  // 切页签关流）钉住——**别在这里指向一份从未被写出来的测试文件**：上一轮这里留过一条
  // "该路径由另一份专门测试钉住"的注释，而那份文件根本不存在，于是"有专门测试覆盖"
  // 这句话是假的（那条路径的真实覆盖就在本文件上面两条里）。
  // 这里留下的是**不受新裁决影响**的那一半：入口每屏可达 + 返回回到来处那一页。
  const h = await harness();
  await gotoLearn(h.root);
  // 入口按钮在**每一屏**都挂着（12A 的底线：Key 可能在任何一屏失效）
  assert.ok(btn(h.root, '设置（API Key）'), 'ready 这一屏也要有设置入口');
  await btn(h.root, '设置（API Key）').click();
  assert.match(text(h.root), /设置 · API Key/);
  assert.equal(currentTab(h.root)?.textContent, '设置', '入口按钮与页签是同一个去向（高亮要一致）');

  await btn(h.root, '返回').click();
  assert.equal(currentTab(h.root)?.textContent, '学习', '返回回到点入口时待着的那一页');
  assert.equal(h.machine.state, 'ready', '而且学习现场没动（ready 还是 ready）');
  assert.ok(btn(h.root, '拍照'));
});

test('待补抽屉打开时点页签：抽屉关掉、落在那一页（不会出现"页签亮着、内容却是抽屉"）', async () => {
  const h = await harness({
    clock: () => 100_000,
    priorEvents: [{
      ts: 1040,
      type: 'feedback_pending',
      wordId: 'mug',
      sessionId: 's-old',
      roundIndex: 1,
      payload: { pendingId: 'p_1', sentence: 'She go to school yesterday.', word: 'mug', scene: 'kitchen', reason: 'timeout' },
    }],
  });
  await btn(h.root, '待补反馈').click();
  assert.match(text(h.root), /She go to school yesterday\./);
  await tab(h.root, '学习').click();
  assert.equal(text(h.root).includes('She go to school yesterday.'), false, '抽屉必须关掉（换页签 = 换屏）');
  assert.ok(btn(h.root, '拍照'), '落在学习页');
  assert.equal(currentTab(h.root)?.textContent, '学习');
});

// ─────────────────────────── 应用栏 ───────────────────────────

test('应用栏：品牌 + 一行状态；状态行是"今天到期的词数"，且随词表如实变', async () => {
  const empty = await harness();
  const bar = (root) => byTag(root, 'HEADER')[0];
  assert.ok(bar(empty.root), '界面顶部必须有一个应用栏');
  const brand = byTag(bar(empty.root), 'SPAN').find((s) => s.className === 'brand');
  assert.equal(brand?.textContent, '场景取词', '应用栏要有品牌名');
  const status = (root) => byTag(bar(root), 'SPAN').find((s) => s.className === 'appstatus')?.textContent;
  assert.match(status(empty.root), /今天没有到期的词/, '没有到期词时应用栏如实说"没有到期的词"');

  const some = await harness({ clock: () => 100_000, words: { mug: dueWord({ dueAt: 90_000 }) } });
  assert.match(status(some.root), /今天该复习 1 个词/, '有到期词时应用栏报的是那几个（与首页同一个起源）');
});

test('应用栏与页签是**壳**：切页签换掉的是内容，应用栏与四枚页签一直在', async () => {
  const h = await harness();
  for (const label of ['学习', '复习', '设置', '首页']) {
    await tab(h.root, label).click();
    assert.ok(byTag(h.root, 'HEADER')[0], `在「${label}」页时应用栏也在`);
    assert.equal(tabButtons(h.root).length, 4, `在「${label}」页时四枚页签也在`);
  }
});

test('识物链路的真实路径仍然通：学习页 → 拍照 → 快门 → word（页签没有把链路切断）', async () => {
  const h = await withFetch({ fetchImpl: okFetch, recognize: realRecognizeWithFallback });
  await gotoLearn(h.root);
  await btn(h.root, '拍照').click();
  await btn(h.root, '快门').click();
  assert.equal(h.machine.state, 'word');
  assert.ok(btn(h.root, '我会读了（开始跟读）'), 'word 那一屏照旧（三百多行的线性流程原样搬过来的验收点）');
  h.restoreFetch();
});
