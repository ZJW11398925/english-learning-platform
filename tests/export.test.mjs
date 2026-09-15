// tests/export.test.mjs
//
// Task 10：`scripts/export.mjs` 的口径证据。
//
// 这一份测试的重点**不是**"函数能跑"，而是把 brief §2 的 8 条口径逐条钉住——
// 尤其是四条最容易在两处漂移的：
//
//   1. **造句总数只数 `compose_submitted`**：同一句会在判定事件（`feedback_ok` /
//      `uncertain` / `feedback_pending`）的 `payload.sentence` 里再出现一次，那是"判定结果"
//      那一笔账。两张表相加 = 把每句话数两遍（诊断页已把这句话写在页面上）。
//   2. **`retryRate` 用 `web/units/rounds.mjs` 的口径**，不按"某会话 frame_rejected >= 2"数。
//      两者在"退回 1 次 + 成功 1 次"这类会话上给出**不同**的数，本文件用
//      `retryRateByFrameRejects` 把旧口径的结果并列算出来，让差异在测试里可见
//      （用例 3、4）。
//   3. **`readingMissRate` 的分母不含 `speech_unsupported` / `skipped_reading`**
//      ——那两个是"没判过"，混进分母就是伪造一个更低的失败率（用例 7）。
//   4. **复现两模式分列 + `sceneChanged` 分列 + `storage_full` 单列**（用例 8、9）。
//
// 另有一处**方法学**上的刻意选择（brief §4.4 那一节的判据前身）：`retryRate` 是按
// **轮次**（`roundIndex` 去重）算的，所以"同一轮被重复落了两条结论事件"不会虚增重拍率。
// 这条用**正向用例**（重复记录同轮）钉住，而不是用一条 absence 用例——absence
// 用例在回退后常常仍然全绿（见 task-9b-report.md §8 的分类）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, summarize, toCsv } from '../scripts/export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'scripts', 'export.mjs');

/** 一条事件。`roundIndex` 用 `'roundIndex' in extra` 判——`null` 是有意义的值（不属于任何一轮）。 */
const ev = (type, extra = {}) => ({
  ts: 1, type, wordId: null, sessionId: 's', payload: {}, ...extra,
});

/** 一次快门 = 一轮：`recognize_ok` 等结论事件必须带 `roundIndex`（`rounds.mjs` 会响亮抛错）。 */
const round = (n, payload = {}, sessionId = 's') => ev('recognize_ok', { sessionId, roundIndex: n, payload });

/** 统计某类事件的条数（期望值**手写**，不从实现里抄）。 */
const countOf = (events, type) => events.filter((e) => e.type === type).length;

/** 一份临时目录（用完即删）。 */
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ───────────────────────────────────── 口径 1：造句总数只数 compose_submitted

test('造句总数只数 compose_submitted：同一句的判定事件不再加一次', () => {
  const sentence = 'There is a mug on my desk.';
  const events = [
    ev('compose_submitted', { roundIndex: 1, payload: { sentence, submitCount: 1 } }),
    ev('feedback_ok', { roundIndex: 1, payload: { sentence, verdict: 'flawed' } }),
    ev('uncertain', { roundIndex: 2, payload: { sentence: 'Another try here.' } }),
    ev('feedback_pending', { roundIndex: 3, payload: { sentence: 'No feedback for me.' } }),
    ev('compose_submitted', { roundIndex: 2, payload: { sentence: 'Second sentence.' } }),
  ];
  const s = summarize(events, {});
  // 硬口径：等于 compose_submitted 的条数本身（手写 2，不从实现里抄）。
  assert.equal(s.composeTotal, 2);
  assert.equal(s.composeTotal, countOf(events, 'compose_submitted'));
  // 反面对照：把判定事件一起加进去会得到 5 —— 那个数**不许**成为 composeTotal。
  const naiveSum = countOf(events, 'compose_submitted') + countOf(events, 'feedback_ok')
    + countOf(events, 'uncertain') + countOf(events, 'feedback_pending');
  assert.equal(naiveSum, 5);
  assert.notEqual(s.composeTotal, naiveSum);
  // 判定那两笔账各自单列（不参与 composeTotal）。
  assert.equal(s.feedbackOk, 1);
  assert.equal(s.uncertainCount, 1);
  assert.equal(s.feedbackPending, 1);
});

// ───────────────────────── 口径 5：retryRate 用 rounds.mjs 的口径（按轮次去重）

test('retryRate：三轮 = 需重拍 2 次 = 计入分子（按轮次去重，不是按某类事件的条数）', () => {
  // 三条事件**同一个会话**：一次退回（第 1 轮）+ 两次成功（第 2、3 轮）= 按了三次快门。
  const events = [
    ev('frame_rejected', { sessionId: 'a', roundIndex: 1, payload: { reason: 'too_dark' } }),
    round(2, {}, 'a'),
    round(3, {}, 'a'),
  ];
  const s = summarize(events, {});
  assert.equal(s.sessions, 1);
  assert.equal(s.gate.sessionsCounted, 1);
  assert.equal(s.gate.sessionsNeedingReshoot, 1);
  assert.equal(s.retryRate, 1);
});

test('retryRate：两轮 = 只重拍 1 次 = 不计入分子；同一轮重复落两条结论也不虚增轮数', () => {
  const events = [
    round(1), ev('recognize_ok', { roundIndex: 1 }),
    ev('frame_rejected', { roundIndex: 2, payload: { reason: 'too_blurry' } }),
    ev('frame_rejected', { roundIndex: 2, payload: { reason: 'too_blurry' } }),
  ];
  const s = summarize(events, {});
  assert.equal(s.sessions, 1);
  assert.equal(s.gate.sessionsCounted, 1);
  assert.equal(s.retryRate, 0);
  // 四类事件一共 4 条，但**只按了两次快门**（第 2 轮被重复落了三条）。
  assert.equal(events.length, 4);
  assert.equal(s.gate.sessionsNeedingReshoot, 0);
});

test('retryRate 的分母只含"真的走到过结论"的会话（没拍过的会话不稀释它）', () => {
  const events = [
    // 会话 a：3 轮 → 需重拍 2 次 → 进分子
    ev('frame_rejected', { sessionId: 'a', roundIndex: 1, payload: { reason: 'too_dark' } }),
    round(2, {}, 'a'), round(3, {}, 'a'),
    // 会话 b：1 轮 → 不重拍
    ev('recognize_ok', { sessionId: 'b', roundIndex: 1 }),
    // 会话 c：相机被拒，一次快门都没有 → 必须落在分母之外
    ev('blocked_permission', { sessionId: 'c', payload: { error: 'NotAllowedError' } }),
  ];
  const s = summarize(events, {});
  assert.equal(s.sessions, 3);        // 会话 c 在事件流里存在
  assert.equal(s.gate.sessionsCounted, 2); // 但它不进判据 B 的分母
  assert.equal(s.gate.sessionsNeedingReshoot, 1);
  assert.equal(s.retryRate, 0.5);
  // 把没拍过的会话也算进分母会得到 1/3 —— 那是把"压根没拍"混进"没重拍"。
  assert.notEqual(s.retryRate, 1 / 3);
});

test('旧口径（某会话 frame_rejected >= 2）与 rounds.mjs 口径给出不同的数：以后者为准', () => {
  // 会话 a：**退回 1 次 + 成功 1 次** = 2 轮 = 重拍 1 次 → 按 rounds.mjs **不算**需重拍，
  // 但它确实发生过一次重拍。旧口径数"frame_rejected 的条数（1）"也不进分子——两边都是 0，
  // 分不出差别；差别在会话 b 上：退回 2 次 + 成功 1 次 = **3 轮**，而 frame_rejected 只有 2 条。
  const events = [
    ev('frame_rejected', { sessionId: 'a', roundIndex: 1, payload: { reason: 'too_dark' } }),
    ev('recognize_ok', { sessionId: 'a', roundIndex: 2 }),
    ev('frame_rejected', { sessionId: 'b', roundIndex: 1, payload: { reason: 'too_dark' } }),
    ev('frame_rejected', { sessionId: 'b', roundIndex: 2, payload: { reason: 'too_dark' } }),
    ev('recognize_ok', { sessionId: 'b', roundIndex: 3 }),
  ];
  const s = summarize(events, {});
  assert.equal(s.retryRate, 0.5); // 2 个拍过的会话里，b 需重拍 ≥2 次
  // 旧口径：会话 b 的 frame_rejected 恰好也是 2 条 → 也是 0.5。**这个样本分不出两者**，
  // 所以真正的判别样本在下面这条：退回 2 次但**分属两轮之外还有第三轮**……
  // 更干净的判别是"退回 3 次、仅 2 轮"（同一轮重复记录）：
  const dup = [
    ev('frame_rejected', { sessionId: 'a', roundIndex: 1, payload: { reason: 'too_dark' } }),
    ev('frame_rejected', { sessionId: 'a', roundIndex: 2, payload: { reason: 'too_dark' } }),
    ev('frame_rejected', { sessionId: 'a', roundIndex: 2, payload: { reason: 'too_dark' } }),
    ev('frame_rejected', { sessionId: 'a', roundIndex: 2, payload: { reason: 'too_dark' } }),
  ];
  const s2 = summarize(dup, {});
  assert.equal(s2.retryRate, 0);            // rounds.mjs：只有 2 轮 → 未达"需重拍 2 次"
  assert.equal(s2.retryRateByFrameRejects, 1); // 旧口径：4 条 frame_rejected ≥ 2 → 误判成需重拍
  assert.notEqual(s2.retryRate, s2.retryRateByFrameRejects);
});

// ───────────────────────────── 口径 2：补交的判定单独数（Task 9B 的四个字段）

test('补交判定单列：按 payload.retried 分组，并用 retriedPendingId 判断补没补上', () => {
  const events = [
    // 原始判定（不是补交）
    ev('feedback_ok', { roundIndex: 1, payload: { sentence: 'First one.' } }),
    // 补交成功：带 retriedPendingId
    ev('feedback_ok', {
      roundIndex: 1,
      payload: { sentence: 'Retried ok.', retried: true, attempt: 1, retriedAt: 2, retriedPendingId: 'p1' },
    }),
    // 补交又失败：带 retried 但**不带** retriedPendingId（那条指针的语义是"这条把它勾掉了"）
    ev('feedback_pending', {
      roundIndex: 1,
      payload: { sentence: 'Retried again.', retried: true, attempt: 2, retriedAt: 3, pendingId: 'p2' },
    }),
    // 显式 `retried: false`（界面/上游原样带出的杂值）：**不许**被算成补交来的判定。
    ev('feedback_ok', {
      roundIndex: 2,
      payload: { sentence: 'Not a retry.', retried: false, pendingId: '' },
    }),
    // 真值的**非布尔写法**（`retried: 'yes'` / `1`）：字段的契约是"`retried: true` 才算补交"
    // （见 units/pending.mjs 的 `retryEventFor`），所以只有字面 `true` 计数。
    // 这一条是补出来的：加上它之前，把判据改成 `Boolean(payload.retried)` 全仓测试仍全绿
    // （变异体 X2 首跑 MISSED）——`undefined` 与 `false` 在两种写法下同为假，分不出差别。
    ev('feedback_ok', {
      roundIndex: 3,
      payload: { sentence: 'Truthy but not true.', retried: 'yes' },
    }),
    // `retried: true` 但指针是**空串**：指针的语义是"这条把它勾掉了"，空串勾不掉任何东西
    // （`pending.mjs` 里所有指针判据都写成 `typeof x === 'string' && x !== ''`）。
    // 这一条也是补出来的：没有它时"只判键存在"（`!== undefined`）照样全绿（X10 首跑 MISSED）。
    ev('feedback_ok', {
      roundIndex: 4,
      payload: { sentence: 'Empty pointer.', retried: true, attempt: 3, retriedPendingId: '' },
    }),
  ];
  const s = summarize(events, {});
  assert.equal(s.feedbackOk, 5);              // 原始 1 + 补交成功 1 + false 那条 + 'yes' 那条 + 空指针那条
  assert.equal(s.retriedAttempts, 3);         // 6 条里带 `retried === true` 的有 3 条
  assert.equal(s.retriedJudged, 2);           // 这 3 条里有 2 条拿到了判定
  assert.equal(s.retriedResolved, 1);         // 但**只有带非空指针的那 1 条**真补上了
  assert.equal(s.retriedFailed, 1);           // 补交又失败的那条
  assert.equal(s.retriedRate, 0.4);           // 拿到判定的 5 条里有 2 条是补交来的
  assert.equal(s.retrySuccessRate, 1 / 3);    // 3 次补交里补上 1 条
});

// ───────────────────────────── 口径 6：uncertain 的分母只含"真的拿到了判定"

test('uncertaintyRate 的分母不含 feedback_pending（pending 是"没拿到判定"）', () => {
  const events = [
    ev('uncertain', { roundIndex: 1, payload: { sentence: 'a' } }),
    ev('feedback_ok', { roundIndex: 2, payload: { sentence: 'b' } }),
    ev('feedback_pending', { roundIndex: 3, payload: { sentence: 'c' } }),
    ev('feedback_pending', { roundIndex: 4, payload: { sentence: 'd' } }),
  ];
  const s = summarize(events, {});
  assert.equal(s.uncertaintyRate, 0.5);  // 1 / (1 + 1)：分母是"真的拿到了判定"的两条
  assert.equal(s.feedbackJudged, 2);     // pending **不**进这个分母
  assert.equal(s.feedbackPending, 2);    // 但它自己单列，不许消失
  // plan 示例（分母含 pending）会得到 1/4 —— 那是把"没拿到"算成"判定没问题"。
  assert.notEqual(s.uncertaintyRate, 1 / 4);
});

test('一条判定都没拿到时 uncertaintyRate 是 0（不返回 NaN）', () => {
  const s = summarize([ev('feedback_pending', { roundIndex: 1, payload: { sentence: 'x' } })], {});
  assert.equal(s.uncertaintyRate, 0);
  assert.equal(s.feedbackJudged, 0);
});

// ───────────────────────── 口径 4：跟读失败率的分母不含"没判过"的两档

test('跟读没通过率的分母不含 speech_unsupported 与 skipped_reading', () => {
  const events = [
    ev('reading_done', { roundIndex: 1, payload: { word: 'mug', transcript: 'a mug' } }),
    ev('reading_done', { roundIndex: 2, payload: { word: 'mug', transcript: 'mug' } }),
    ev('reading_missed', { roundIndex: 3, payload: { word: 'mug', transcript: 'a cup' } }),
    // 下面两条都是"没判过"，谁进分母谁就是在伪造一个更低的失败率
    ev('speech_unsupported', { roundIndex: 4, payload: { reason: 'no_speech_api' } }),
    ev('skipped_reading', { roundIndex: 5, payload: { word: 'mug' } }),
    ev('speech_unsupported', { roundIndex: 6, payload: { reason: 'engine_error' } }),
  ];
  const s = summarize(events, {});
  assert.equal(s.readingDone, 2);
  assert.equal(s.readingMissed, 1);
  assert.equal(s.readingJudged, 3);
  assert.equal(s.readingMissRate, 1 / 3);
  // 分母混进那两档会得到 1/6（注水一半）。这个数**不许**出现。
  assert.notEqual(s.readingMissRate, 1 / 6);
  assert.equal(s.speechUnsupported, 2);  // 它自己单列
  assert.equal(s.skippedReading, 1);
});

// ───────────────────────── 口径 3：复现两模式分列 + sceneChanged 分列

test('复现两模式分列，且 sceneChanged true/false 各自成列（合并就把信号抹掉了）', () => {
  const events = [
    ev('recurrence_scene', { roundIndex: 1, payload: { word: 'mug', scene: '厨房', expectedScene: '办公桌', sceneChanged: true } }),
    ev('recurrence_scene', { roundIndex: 2, payload: { word: 'cup', scene: '办公桌', expectedScene: '办公桌', sceneChanged: false } }),
    ev('recurrence_manual', { roundIndex: 3, payload: { word: 'mug', scene: '办公桌', expectedScene: '办公桌', sceneChanged: false } }),
    ev('recurrence_manual', { roundIndex: 4, payload: { word: 'mug', scene: '书架', expectedScene: '办公桌', sceneChanged: true } }),
    ev('recurrence_manual', { roundIndex: 5, payload: { word: 'mug', scene: '书架' } }), // 拿不准 → 记否
  ];
  const s = summarize(events, {});
  assert.equal(s.sceneRecurrence, 2);
  assert.equal(s.manualRecurrence, 3);
  assert.equal(s.recurrenceSceneChangedTrue, 2);   // scene 1 + manual 1
  assert.equal(s.recurrenceSceneChangedFalse, 3);  // scene 1 + manual 2（含缺字段那一条）
  assert.equal(s.recurrenceTotal, 5);
  // 分列之后不许再有一个"合并总数"把它抹掉：两个数的和必须等于总数本身。
  assert.equal(s.recurrenceSceneChangedTrue + s.recurrenceSceneChangedFalse, s.recurrenceTotal);
});

// ───────────────────────── 口径 7：storage_full 单列

test('storage_full 单列（不混进别的桶）', () => {
  const s = summarize([
    ev('storage_full', { payload: { phase: 'events' } }),
    ev('recognize_failed', { roundIndex: 1, payload: { reason: 'no_candidates' } }),
  ], {});
  assert.equal(s.storageFull, 1);
  assert.equal(s.recognizeFailed, 1);
});

// ───────────────────────── 边角：空数据 / 词表 / 轮次口径缺失要响亮

test('空数据不抛错，比例返回 0', () => {
  const s = summarize([], {});
  assert.equal(s.retryRate, 0);
  assert.equal(s.uncertaintyRate, 0);
  assert.equal(s.readingMissRate, 0);
  assert.equal(s.composeTotal, 0);
  assert.equal(s.gate.sessionsCounted, 0);
  assert.equal(s.wordsTracked, 0);
});

test('words 里的词按排期单列（已维护 / 未维护分开数）', () => {
  const words = {
    mug: { id: 'mug', word: 'mug', stage: 1, dueAt: 1000, lastScene: '办公桌' },
    cup: { id: 'cup', word: 'cup', stage: 4, dueAt: null, maintained: true, lastScene: '厨房' },
  };
  const s = summarize([], words);
  assert.equal(s.wordsTracked, 2);
  assert.equal(s.wordsMaintained, 1);
});

test('结论事件缺 roundIndex 时响亮抛错（不静默少算重拍）', () => {
  assert.throws(
    () => summarize([ev('recognize_ok')], {}), // 没有 roundIndex
    /roundIndex/,
  );
});

// ───────────────────────── 口径 8：CSV 与中文（Excel 打开不乱码）

test('toCsv 输出表头与行数正确，且对逗号做转义', () => {
  const csv = toCsv([ev('recognize_ok', { payload: { note: 'a,b' } })]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2); // 1 行表头 + 1 行数据
  assert.ok(lines[0].includes('ts'));
  assert.ok(lines[1].includes('"a,b"'));
});

test('toCsv 以 UTF-8 BOM 开头（Excel 打开中文 JSON 不乱码）', () => {
  const csv = toCsv([ev('compose_submitted', { payload: { sentence: '桌上有一个马克杯。' } })]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('桌上有一个马克杯。'));
  // 表头里要有轮次列：判据 B 要按 roundIndex 复算，CSV 是给人看的第三只眼。
  const header = csv.slice(1).split('\n')[0];
  assert.ok(header.split(',').includes('roundIndex'), `表头缺 roundIndex：${header}`);
});

test('toCsv 转义双引号与换行（payload 的 JSON 串必须一行装得下）', () => {
  const payload = { sentence: 'He said "hi"\nnext line' };
  const csv = toCsv([ev('compose_submitted', { payload })]);
  const [header, dataRow] = csv.slice(1).trim().split('\n');
  // 表头必须**不含引号**：它没有需要转义的字符（含引号说明转义规则是无条件加引号）。
  assert.equal(header, 'ts,type,roundIndex,sessionId,wordId,payload');
  // payload 是最后那一格（它本身含逗号，所以从第 5 个逗号之后取到行尾）。
  const cell = dataRow.split(',').slice(5).join(',');
  // 规则：整体加引号 + **内部引号翻倍**。期望值按同一条规则现算，不手写转义字面量
  // （手写的那版把 `\"` 的层数搞错了三次，才改成现算——引号层数不值得人眼核对）。
  const expected = `"${JSON.stringify(payload).replace(/"/g, '""')}"`;
  assert.equal(cell, expected);
  // 反向验证：按 CSV 规则解回来必须逐字等于原 payload 的 JSON 文本（翻倍是可逆的）。
  assert.deepEqual(JSON.parse(cell.slice(1, -1).replace(/""/g, '"')), payload);
  // payload 里的真换行在 JSON 里是 `\n`（两个字符），不会撑破行结构。
  assert.equal(csv.slice(1).trim().split('\n').length, 2, '一条事件必须只占一行');
});

// ───────────────────────── 可执行入口（Task 11 不必写代码）

test('parseArgs：--words / --expect / --out / --csv 都能解析', () => {
  const a = parseArgs(['events.json', '--words', 'words.json', '--expect', 'sets.json',
    '--out', 'o.json', '--csv', 'o.csv']);
  assert.equal(a.input, 'events.json');
  assert.equal(a.wordsPath, 'words.json');
  assert.equal(a.expectPath, 'sets.json');
  assert.equal(a.outPath, 'o.json');
  assert.equal(a.csvPath, 'o.csv');
  assert.throws(() => parseArgs([]), /用法/);
  assert.throws(() => parseArgs(['events.json', '--不存在']), /未知参数/);
});

test('命令行入口：读事件与词表 → 出 JSON 摘要与 CSV（CSV 带 BOM）', () => {
  const { dir, done } = tmpDir();
  try {
    const events = [
      ev('recognize_ok', { sessionId: 'a', roundIndex: 1, payload: { word: 'mug' } }),
      ev('frame_rejected', { sessionId: 'a', roundIndex: 2, payload: { reason: 'too_dark' } }),
      ev('frame_rejected', { sessionId: 'a', roundIndex: 3, payload: { reason: 'too_dark' } }),
      ev('compose_submitted', { sessionId: 'a', roundIndex: 4, payload: { sentence: '桌上有一个马克杯。' } }),
      ev('reading_missed', { sessionId: 'a', roundIndex: 5, payload: { transcript: 'a cup' } }),
    ];
    const evPath = path.join(dir, 'events.json');
    const wdPath = path.join(dir, 'words.json');
    const outPath = path.join(dir, 'summary.json');
    const csvPath = path.join(dir, 'events.csv');
    fs.writeFileSync(evPath, JSON.stringify(events), 'utf8');
    fs.writeFileSync(wdPath, JSON.stringify({ mug: { id: 'mug', word: 'mug', stage: 1, dueAt: 1, lastScene: '厨房' } }), 'utf8');

    const stdout = execFileSync(process.execPath, [
      CLI, evPath, '--words', wdPath, '--out', outPath, '--csv', csvPath,
    ], { encoding: 'utf8' });

    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(written.retryRate, 1);       // 会话 a：3 轮 → 需重拍 2 次
    assert.equal(written.composeTotal, 1);
    assert.equal(written.readingMissed, 1);
    assert.equal(written.wordsTracked, 1);
    // 入口必须**同时**把判据映射报出来（Task 11 要照抄进 validation_submit）
    assert.ok(written.gate, 'gate（判据 B）映射缺失');
    assert.ok('VAL-OPI-ecb3037d-1a56-46d3-b931-4d482dcc668f.50' in written.measurementsMap,
      'measurements 映射里必须有判据 B 的对象 id');
    assert.ok('VAL-OPI-ecb3037d-1a56-46d3-b931-4d482dcc668f.38' in written.measurementsMap,
      'measurements 映射里必须有判据 A 的对象 id');

    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.ok(csv.includes('桌上有一个马克杯。'), 'CSV 必须原样含中文句子');
    assert.equal(csv.slice(1).trim().split('\n').length, 6); // 表头 + 5 条事件
    // 人要看得到关键数（Task 11 的人工步骤不打开 JSON 也能读）
    assert.ok(stdout.includes('retryRate'), `stdout 应含摘要：${stdout}`);
  } finally {
    done();
  }
});

test('命令行入口：事件文件是空的也不崩，退 0 且写出 0 值摘要', () => {
  const { dir, done } = tmpDir();
  try {
    const evPath = path.join(dir, 'events.json');
    const outPath = path.join(dir, 'summary.json');
    fs.writeFileSync(evPath, '[]', 'utf8');
    execFileSync(process.execPath, [CLI, evPath, '--out', outPath], { encoding: 'utf8' });
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(written.retryRate, 0);
    assert.equal(written.gate.sessionsCounted, 0);
  } finally {
    done();
  }
});

test('命令行入口：事件文件不存在时响亮退出（不写出一个假的 0 值摘要）', () => {
  const { dir, done } = tmpDir();
  try {
    const outPath = path.join(dir, 'summary.json');
    let threw = false;
    try {
      execFileSync(process.execPath, [path.join(dir, '不存在.json'), '--out', outPath], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      threw = true;
      assert.notEqual(err.status, 0);
    }
    assert.equal(threw, true, '读不到输入文件必须非零退出');
    assert.equal(fs.existsSync(outPath), false, '失败时不许留下一个看起来正常的摘要文件');
  } finally {
    done();
  }
});

test('命令行入口：--expect 给出可接受词集时能算 top1/top3（逐条对齐 recognize_ok）', () => {
  const { dir, done } = tmpDir();
  try {
    const events = [
      // 第 1 轮：top1 命中（mug ∈ {mug, cup}）
      ev('recognize_ok', { sessionId: 'a', roundIndex: 1, payload: { word: 'mug', candidates: ['mug', 'cup', 'glass'], latencyMs: 900 } }),
      // 第 2 轮：这一轮拍的物体预先声明的可接受集与候选**完全不重叠** → top1 与 top3 都不命中
      ev('recognize_ok', { sessionId: 'a', roundIndex: 2, payload: { word: 'glass', candidates: ['glass', 'cup', 'bottle'], latencyMs: 1100 } }),
      // 第 3 轮：top1 未命中、top3 命中（bowl 在第 2 位）
      ev('recognize_ok', { sessionId: 'a', roundIndex: 3, payload: { word: 'plate', candidates: ['plate', 'bowl', 'dish'], latencyMs: 1300 } }),
    ];
    const evPath = path.join(dir, 'events.json');
    const exPath = path.join(dir, 'expect.json');
    const outPath = path.join(dir, 'summary.json');
    fs.writeFileSync(evPath, JSON.stringify(events), 'utf8');
    // 判定表：按事件流顺序对齐（第 N 条 recognize_ok ↔ 第 N 个可接受词集）；
    // 每个集合都是该**物体**预声明的，不是从候选里抄的（抄了就恒命中，等于自证）。
    fs.writeFileSync(exPath, JSON.stringify({ acceptable: [['mug', 'cup'], ['thermos', 'flask'], ['bowl']] }), 'utf8');
    execFileSync(process.execPath, [CLI, evPath, '--expect', exPath, '--out', outPath], { encoding: 'utf8' });
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(written.top1Hits, 1);
    assert.equal(written.top3Hits, 2);
    assert.equal(written.recognizedRounds, 3);
    assert.equal(written.top1Rate, 1 / 3);
    assert.equal(written.top3Rate, 2 / 3);
    assert.equal(written.latencyP95, 1300);
    assert.equal(written.latencySamples, 3);
  } finally {
    done();
  }
});

test('没有 --expect 时 top1/top3 报为缺口（不假装算出了准确率）', () => {
  const s = summarize([round(1, { word: 'mug', candidates: ['mug'] })], {});
  assert.equal(s.top1Hits, null);
  assert.equal(s.top3Hits, null);
  assert.ok(s.gaps.some((g) => g.includes('expect')), `缺口清单里必须说明缺判定表：${JSON.stringify(s.gaps)}`);
});

// ── 耗时：写入口径落定（`DEC-OPI-…87`）之后，缺口只在**真的缺**时才报 ─────────

test('recognize_ok 带 latencyMs → 算出 p50/p95，且不报耗时缺口', () => {
  const events = Array.from({ length: 20 }, (_, i) => ev('recognize_ok', {
    roundIndex: i + 1, payload: { word: 'mug', candidates: ['mug'], latencyMs: (i + 1) * 100 },
  }));
  const s = summarize(events, {});
  assert.equal(s.latencySamples, 20);
  assert.equal(s.latencyP50, 1000);
  assert.equal(s.latencyP95, 1900, '最近秩法：ceil(0.95×20) = 19 → 升序第 19 个 = 1900');
  assert.equal(s.gaps.some((g) => g.includes('latency')), false, '有数据就不许再报缺口');
});

test('有 recognize_ok 却一条耗时都没有 → 报缺口（两种成因与处置都写清）', () => {
  const s = summarize([round(1, { word: 'mug', candidates: ['mug'] })], {});
  assert.equal(s.latencyP95, null);
  assert.equal(s.latencySamples, 0);
  const gap = s.gaps.find((g) => g.includes('latency'));
  assert.ok(gap, `必须有耗时缺口：${JSON.stringify(s.gaps)}`);
  assert.match(gap, /加字段之前/, '要说明"这份流可能是加字段之前落的（旧代码）"');
  assert.match(gap, /服务端没回 latency_ms/, '要给出第二种成因');
  assert.match(gap, /不要.*填进判据 A/, '要写明不许用 0 或估算值填判据 A');
});

test('一条 recognize_ok 都没有 → **不算**耗时缺口（那是还没数据，不是数据源坏了）', () => {
  const s = summarize([
    ev('frame_rejected', { roundIndex: 1, payload: { reason: 'too_dark' } }),
    ev('blocked_permission', { sessionId: 'b', payload: { error: 'NotAllowedError' } }),
  ], {});
  assert.equal(s.latencySamples, 0);
  assert.equal(s.gaps.some((g) => g.includes('latency')), false,
    '只跑过相机那几步的流不该被报成"缺耗时字段"——两者对 Task 11 的处置完全不同');
});

test('耗时不看 recognize_failed（判据 A 的样本数与 p95 的样本数必须同源）', () => {
  const s = summarize([
    ev('recognize_failed', { roundIndex: 1, payload: { reason: 'no_candidates', latencyMs: 5000 } }),
  ], {});
  assert.equal(s.latencySamples, 0, 'recognize_failed 的耗时不算进来');
  assert.equal(s.latencyP95, null);
});

test('top1/top3 只看前 3 个候选：可接受词排在第 4 位不算 top3 命中', () => {
  const events = [
    ev('recognize_ok', { roundIndex: 1, payload: { word: 'bowl', candidates: ['plate', 'glass', 'dish', 'bowl'] } }),
  ];
  const s = summarize(events, {}, { acceptable: [['bowl']] });
  assert.equal(s.top3Hits, 0, '第 4 位的候选不算 top-3 命中（否则 top3 就退化成"候选里有没有"）');
  assert.equal(s.top1Hits, 0);
});

// ───────────────────────── 模块定位（这些数只能来自 units/rounds.mjs，不许另写一套）

test('export.mjs 复用 units/rounds.mjs 的公式，而不是自己重写一套', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /from '\.\.\/web\/units\/rounds\.mjs'/, '必须 import units/rounds.mjs');
  assert.match(src, /needsReshoot|roundCountOfSession/, '必须调用 rounds.mjs 的公式');
  // 自己拍一个 `>= 2` 或 `>= 3` 的比较就是在另立一套口径。
  assert.doesNotMatch(src, /rejects\s*>=\s*2/, '不许自己数 frame_rejected 的条数当判据 B');
  // 红线（brief §3）：Node 里跑、还要能被变异探针驱动 → 只许 import 这两样。
  // 注：这里查的是**真的 import 语句**，不是源码里出现过哪些词——注释里出现
  // `localStorage` 是在说明输入从哪来，不是在用它。
  const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:fs', '../web/units/rounds.mjs'],
    `export.mjs 的 import 只许是这两条，实际：${JSON.stringify(imports)}`);
});

test('export.mjs 不在模块顶层碰浏览器全局（import 后在 Node 里就能用）', () => {
  assert.equal(typeof summarize, 'function');
  assert.equal(typeof toCsv, 'function');
  assert.equal(typeof parseArgs, 'function');
  // 浏览器全局在本进程里根本不存在；上面的 import 能成功 ⇒ 模块顶层没碰它们。
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
});

// ───────────────────────── 自洽：一份覆盖全部事件类型的样本不炸
//
// 末两例（第 4 轮的四候选、纯被拒会话 d）是**为了能分辨两处错法**才加的，不是为了凑数：
//   · 四候选而可接受词排在第 4 位：`top3` 取前 3 位必须**不命中**；不切前 3 位就会命中。
//   · 纯被拒会话 d：`sessions` 必须比"进了判据 B 分母的会话数"多一个。
// 两处都属于"另一条机制也能产生同样结果"的那类（见 progress.md 的贯穿性观察），
// 所以必须由正向样本把它们区分开。

test('覆盖全部事件类型的样本流：每个计数都对得上', () => {
  const events = [
    ev('session_start', { sessionId: 'a', payload: {} }),
    ev('blocked_permission', { sessionId: 'b', payload: { error: 'NotAllowedError' } }),
    ev('frame_rejected', { sessionId: 'a', roundIndex: 1, payload: { reason: 'too_dark' } }),
    ev('recognize_ok', { sessionId: 'a', roundIndex: 2, payload: { word: 'mug', candidates: ['mug', 'cup'], attempts: 1 } }),
    ev('recognize_failed', { sessionId: 'c', roundIndex: 1, payload: { reason: 'no_candidates', attempts: 2 } }),
    ev('word_shown', { sessionId: 'a', roundIndex: 2, payload: { word: 'mug' } }),
    ev('reading_done', { sessionId: 'a', roundIndex: 2, payload: { word: 'mug', transcript: 'mug' } }),
    ev('reading_missed', { sessionId: 'a', roundIndex: 2, payload: { word: 'mug', transcript: 'mug mug' } }),
    ev('skipped_reading', { sessionId: 'a', roundIndex: 2, payload: { word: 'mug' } }),
    ev('speech_unsupported', { sessionId: 'a', roundIndex: 2, payload: { reason: 'no_api' } }),
    ev('compose_submitted', { sessionId: 'a', roundIndex: 2, payload: { sentence: 'A mug.', submitCount: 1, revisions: 0, dwellMs: 12000 } }),
    ev('compose_rewrite', { sessionId: 'a', roundIndex: 2, payload: { submitCount: 2 } }),
    ev('feedback_ok', { sessionId: 'a', roundIndex: 2, payload: { sentence: 'A mug.' } }),
    ev('feedback_pending', { sessionId: 'c', roundIndex: 1, payload: { sentence: 'A cat.' } }),
    // 第 3 次快门：确实按了（`recognize_ok`），会话 a 的轮数因此是 3 = 需重拍 2 次。
    // **注意**：`uncertain` / `compose_submitted` 这类事件**不是一次快门**，给它们一个
    // roundIndex 也不会让轮数 +1（`rounds.mjs` 只认三类结论事件）——下面那条 uncertain
    // 带 roundIndex 3 是「同一轮里的反馈」，不是第三次快门。
    ev('recognize_ok', { sessionId: 'a', roundIndex: 3, payload: { word: 'mug', candidates: ['mug', 'cup'], attempts: 1 } }),
    ev('uncertain', { sessionId: 'a', roundIndex: 3, payload: { sentence: 'A mug maybe.' } }),
    ev('recurrence_scene', { sessionId: 'a', roundIndex: 3, payload: { word: 'mug', sceneChanged: true } }),
    ev('recurrence_manual', { sessionId: 'a', roundIndex: 3, payload: { word: 'mug', sceneChanged: false } }),
    ev('storage_full', { sessionId: 'a', payload: { phase: 'events' } }),
    // 第 4 个会话：只落了一条相机未授权，**一次快门都没有**。
    // 它必须让 `sessions` 与"进了判据 B 分母"的会话数分开——否则"把没拍过的会话算进分母"
    // 这个错法在测试里看不出来（这个样本是补出来的：原本只有 3 个会话，其中没有这种"纯被拒会话"）。
    ev('blocked_permission', { sessionId: 'd', payload: { error: 'NotAllowedError' } }),
  ];
  const s = summarize(events, {});
  assert.equal(s.composeTotal, countOf(events, 'compose_submitted'));
  assert.equal(s.feedbackOk, 1);
  assert.equal(s.feedbackPending, 1);
  assert.equal(s.uncertainCount, 1);
  assert.equal(s.readingDone, 1);
  assert.equal(s.readingMissed, 1);
  assert.equal(s.skippedReading, 1);
  assert.equal(s.speechUnsupported, 1);
  assert.equal(s.sceneRecurrence, 1);
  assert.equal(s.manualRecurrence, 1);
  assert.equal(s.storageFull, 1);
  assert.equal(s.composeRewrite, 1);
  assert.equal(s.wordShown, 1);
  assert.equal(s.blockedPermission, 2);
  assert.equal(s.sessions, 4);              // a / b / c / d
  assert.equal(s.gate.sessionsCounted, 2);  // 只有 a 与 c 真的拍过并走到了结论
  assert.equal(s.retryRate, 0.5);           // a 有 3 轮（需重拍 2 次），c 只有 1 轮
  assert.equal(typeof s.retryRate, 'number');
  assert.ok(Number.isFinite(s.retryRate));
});

// 反向守卫：import 的路径必须落在仓库里（写错相对路径时给一条人话，而不是 ENOENT）。
test('测试通过相对路径 import 的 export.mjs 与 CLI 用的是同一个文件', () => {
  assert.equal(fs.realpathSync(CLI), fs.realpathSync(path.join(REPO, 'scripts', 'export.mjs')));
  assert.ok(fs.existsSync(path.join(REPO, 'web', 'units', 'rounds.mjs')));
});
