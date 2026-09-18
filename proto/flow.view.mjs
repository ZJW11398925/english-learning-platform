// web/proto/flow.view.mjs
//
// 一屏原型的**渲染层**：把 `flow.mjs` 的状态画成一屏「动作面板」。
//
// ===========================================================================
// 形状上的硬约束（用户第 ③ 条指控的界面答案）
// ===========================================================================
// · **不是聊天气泡流**：本文件一个气泡类名都不产出（没有 `say-*` / 对话流）。
//   一屏 = 页头 + 步骤轨 + **恰好一个**动作面板（`[data-panel]`）+ 「我的句子」列表（`ul/li`）。
//   历史**以列表呈现**，不是对话。
// · **除第一步外没有输入框**：`S1`–`S5` 五屏**一个 `textarea` / `input` 都没有**，
//   唯一的输入发生在 `S0`；从 `S1` 起每一步都是**点**出来的（测试对每一屏都断言这一点）。
// · **英文逐词可点**：屏上每一句英文都由 `segmentEnglish` 切成可点单元（`button.w`），
//   点开是词卡（`[data-layer="wordcard"]`）。词卡表里查不到的词退化成**不可点的纯文本**
//   并打上 `data-uncarded`——那个标记是给测试用的：**面板区里这个标记必须为 0**，
//   而词卡层里**必然非 0**（词典自己的例句里就有表外的词），这条不对称正好证明
//   "逐词覆盖率 100%" 的适用范围不是被悄悄放宽的。
//
// ===========================================================================
// 职责边界（与产品里 `dialogue.mjs` 同一条纪律）
// ===========================================================================
// 本文件**不做任何教学判断**：教什么（`pickTeachPoint`）、点对点错（`CHUNKS[].correct`）、
// 流程怎么走（`reduce`）全在 `flow.mjs`。这里只做两件事：把状态画出来、把点击变成事件。
// 唯一的界面局部状态是「哪张词卡开着」（`opened`）——它不改变教学流程，所以**不进状态机**。
//
// ⚠️ 已知未验：真机触屏 / 软键盘 / Firefox / WebKit。词卡的可点英文词是**行内**元素，
//    没有 44px 的触控高度（行内词做成 44px 会把句子排版撑坏）——见报告「明知未验项」。

import {
  BLANK_MARK, BLANK_SENTENCE, CHUNKS, NATURAL_SENTENCE, S4_WHY, STEP_LABELS, STEP_TITLES, STEPS,
  containsWord, createRuntime, fillBlank, lookupCard, progressLine, segmentEnglish, stripMarks,
} from './flow.mjs';

/** `root` 必须是容器（与 `web/dialogue.mjs` / `web/app.mjs` 的 `mount` 同口径）。 */
function assertRoot(root) {
  if (root === null || root === undefined || typeof root.replaceChildren !== 'function') {
    throw new TypeError('mountFlow: 需要传入一个容器元素（web/proto/flow.html 里的容器）');
  }
}

/** 造一个元素（本仓库的假 DOM 只认这几个属性，别用 `style` / `classList` / `dataset`）。 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 造一个按钮。 */
function action(doc, label, onClick, className) {
  const b = el(doc, 'button', className, label);
  b.setAttribute('type', 'button');
  b.addEventListener('click', onClick);
  return b;
}

/**
 * 把一段英文按词切成可点单元，追加到 `host`。
 * 有词卡 ⇒ `button.w[data-word]`（点开词卡）；没有 ⇒ `span[data-uncarded]`（纯文本，**不假装可点**）。
 */
function appendWords(doc, host, text, onWord) {
  for (const unit of segmentEnglish(text)) {
    if (unit.kind === 'text') {
      host.append(el(doc, 'span', '', unit.text));
      continue;
    }
    if (unit.card === null) {
      const plain = el(doc, 'span', 'w-plain', unit.text);
      plain.setAttribute('data-uncarded', unit.text);
      host.append(plain);
      continue;
    }
    const chip = action(doc, unit.text, () => onWord(unit.card), 'w');
    chip.setAttribute('data-word', unit.text.toLowerCase());
    host.append(chip);
  }
}

/**
 * 渲染一段**混排文本**：反引号里的是英文（英文衬线段，逐词可点），其余是中文界面文字。
 * 反引号只是排版标记，字形不出现——`plainText` 与这里是同一个口径。
 */
function appendRich(doc, host, text, onWord) {
  for (const seg of stripMarks(text)) {
    const wrap = el(doc, 'span', seg.code ? 'en' : 'zh');
    appendWords(doc, wrap, seg.text, onWord);
    host.append(wrap);
  }
  return host;
}

/**
 * 把主操作放进一行（`.row`）。
 * ⚠️ **不许把带 `.primary` 的按钮直接 append 到面板上**：面板是**竖向** flex 容器，
 * 而 `button.primary` 有 `flex: 1`（那是给它所在那一行用的），直接挂上去它会在**竖轴**上
 * 撑满整块面板——实测过一个 365px 高的绿色巨块（这不是猜测，是量出来的）。
 */
function actionRow(doc, ...buttons) {
  const row = el(doc, 'div', 'row');
  for (const b of buttons) row.append(b);
  return row;
}

/** 面板外壳：`[data-panel][data-step]`，每屏**恰好一个**。 */
function panelShell(doc, step) {
  const p = el(doc, 'section', 'panel');
  p.setAttribute('data-panel', '');
  p.setAttribute('data-step', step);
  p.append(el(doc, 'p', 'kicker', `第 ${STEPS.indexOf(step) + 1} 步 · ${STEP_LABELS[step]}`));
  p.append(el(doc, 'h2', 'lead', STEP_TITLES[step]));
  return p;
}

// ── 页头 ────────────────────────────────────────────────────────────────────
function header(doc) {
  const box = el(doc, 'header', 'hdr');
  const top = el(doc, 'div', 'hdr-top');
  top.append(el(doc, 'span', 'title', '今天的一句'));
  top.append(el(doc, 'span', 'badge', '原型 · 一屏'));
  box.append(top);
  box.append(el(doc, 'p', 'sub', '流程与界面由程序管 · 这一屏零模型调用'));
  return box;
}

// ── 步骤轨（"程序管流程"在屏上看得见）────────────────────────────────────────
function rail(doc, state) {
  const box = el(doc, 'div', 'rail');
  const now = STEPS.indexOf(state.step);
  STEPS.forEach((step, i) => {
    const node = el(doc, 'span', 'rail-node');
    node.setAttribute('data-rail', step);
    node.setAttribute('data-rail-state', i < now ? 'done' : (i === now ? 'now' : 'todo'));
    node.append(el(doc, 'span', 'rail-dot', String(i)));
    node.append(el(doc, 'span', 'rail-label', STEP_LABELS[step]));
    box.append(node);
  });
  return box;
}

// ── S0 输入 ─────────────────────────────────────────────────────────────────
function panelS0(doc, state, send) {
  const p = panelShell(doc, 'S0');
  p.append(el(doc, 'p', 'note', '教什么从你的话里长出来，不是从固定表里挑。演示那句话已经填好，直接点「接着说」。'));
  const ta = doc.createElement('textarea');
  ta.className = 'input';
  ta.setAttribute('rows', '3');
  ta.setAttribute('placeholder', '今天想说什么？中文就行。');
  ta.value = state.draft;
  p.append(ta);
  p.append(actionRow(doc, action(doc, '接着说', () => send({ type: 'say', text: ta.value }), 'primary')));
  if (state.notice !== null) p.append(el(doc, 'p', 'notice', state.notice));
  return p;
}

// ── S1 接住（教点必须看得出是从他那句话里长出来的）──────────────────────────
function panelS1(doc, state, send, onWord) {
  const p = panelShell(doc, 'S1');
  const point = state.point;
  // ① 他的话，**原样**出现，来源片段在句子里被标出来
  const quote = el(doc, 'blockquote', 'said');
  quote.setAttribute('data-said', '');
  const at = state.said.indexOf(point.sourceSpan);
  const span = el(doc, 'mark', 'said-span', point.sourceSpan);
  span.setAttribute('data-source-span', '');
  quote.append(el(doc, 'span', '', state.said.slice(0, at)));
  quote.append(span);
  quote.append(el(doc, 'span', '', state.said.slice(at + point.sourceSpan.length)));
  p.append(quote);
  p.append(el(doc, 'p', 'arrow', '↓ 从这句话里挑一个可教的点'));
  // ② 挑出来的教点 + 它的来源引用
  const card = el(doc, 'div', 'point');
  const l1 = el(doc, 'p', 'point-line');
  l1.append(el(doc, 'span', '', '你说了「'));
  l1.append(el(doc, 'mark', 'said-span', point.sourceSpan));
  l1.append(el(doc, 'span', '', '」'));
  card.append(l1);
  const l2 = el(doc, 'p', 'point-line point-en');
  l2.append(el(doc, 'span', '', '→ 这里用 '));
  appendRich(doc, l2, point.chunk, onWord);
  l2.append(el(doc, 'span', '', `（${point.gloss}）`));
  card.append(l2);
  const meaning = lookupCard(point.chunk);
  card.append(el(doc, 'p', 'note', meaning === null ? '' : meaning.zh));
  p.append(card);
  p.append(actionRow(doc, action(doc, '我自己拼', () => send({ type: 'beginAssembly' }), 'primary')));
  return p;
}

// ── S2 组装（只许点，不许打字）──────────────────────────────────────────────
function panelS2(doc, state, send, onWord) {
  const p = panelShell(doc, 'S2');
  p.append(el(doc, 'p', 'note', '把空位补上——只点词块，不用打字。每句英文里的词都能点开查义。'));
  const sentence = el(doc, 'p', 'sentence');
  const at = BLANK_SENTENCE.indexOf(BLANK_MARK);
  appendRich(doc, sentence, BLANK_SENTENCE.slice(0, at), onWord);
  sentence.append(el(doc, 'span', 'blank', '空位'));
  appendRich(doc, sentence, BLANK_SENTENCE.slice(at + BLANK_MARK.length), onWord);
  p.append(sentence);
  p.append(el(doc, 'p', 'note note-blank', '空位＝照常。四个词块里只有一个对。'));
  const tiles = el(doc, 'div', 'tiles');
  for (const chunk of CHUNKS) {
    const tried = state.tried.includes(chunk.id);
    const tile = action(doc, chunk.text, () => send({ type: 'pickChunk', chunkId: chunk.id }), tried ? 'chunk tried' : 'chunk');
    tile.setAttribute('data-chunk', chunk.id);
    if (tried) tile.setAttribute('data-tried', '');
    tiles.append(tile);
  }
  p.append(tiles);
  if (state.hint !== null) {
    const box = el(doc, 'div', 'hint');
    box.setAttribute('data-hint', '');
    box.append(el(doc, 'p', 'hint-k', '差在哪'));
    const body = el(doc, 'p', 'hint-v');
    appendRich(doc, body, state.hint, onWord);
    box.append(body);
    p.append(box);
  }
  return p;
}

// ── S3 判定（点对：变绿 + 给出更自然的整句）─────────────────────────────────
function panelS3(doc, state, send, onWord) {
  const p = panelShell(doc, 'S3');
  p.append(el(doc, 'p', 'ok', '点对了'));
  const sentence = el(doc, 'p', 'sentence');
  const at = BLANK_SENTENCE.indexOf(BLANK_MARK);
  appendRich(doc, sentence, BLANK_SENTENCE.slice(0, at), onWord);
  const chip = el(doc, 'span', 'chip ok-chip');
  appendRich(doc, chip, state.picked.text, onWord);
  sentence.append(chip);
  appendRich(doc, sentence, BLANK_SENTENCE.slice(at + BLANK_MARK.length), onWord);
  p.append(sentence);
  const nat = el(doc, 'div', 'natural');
  nat.append(el(doc, 'p', 'k', '更自然的整句'));
  const line = el(doc, 'p', 'natural-line');
  line.setAttribute('data-natural', '');
  appendRich(doc, line, NATURAL_SENTENCE, onWord);
  nat.append(line);
  p.append(nat);
  p.append(actionRow(doc, action(doc, '看看差在哪', () => send({ type: 'compare' }), 'primary')));
  return p;
}

// ── S4 对照（左「你拼的」/ 右「更自然的」+ 一句为什么改）────────────────────
function panelS4(doc, state, send, onWord) {
  const p = panelShell(doc, 'S4');
  const cols = el(doc, 'div', 'cols');
  const left = el(doc, 'div', 'col');
  left.append(el(doc, 'p', 'k', '你拼的'));
  for (const id of state.tried) {
    const chunk = CHUNKS.find((c) => c.id === id);
    if (chunk === undefined) continue;
    const line = el(doc, 'p', chunk.correct ? 'col-line ok-line' : 'col-line bad-line');
    appendRich(doc, line, fillBlank(chunk.text), onWord);
    left.append(line);
  }
  const right = el(doc, 'div', 'col');
  right.append(el(doc, 'p', 'k', '更自然的'));
  const good = el(doc, 'p', 'col-line');
  appendRich(doc, good, NATURAL_SENTENCE, onWord);
  right.append(good);
  cols.append(left, right);
  p.append(cols);
  if (state.tried.length <= 1) p.append(el(doc, 'p', 'note', '你一次就点对了——左右两边是同一句。'));
  const why = el(doc, 'div', 'why');
  why.append(el(doc, 'p', 'k', '为什么改'));
  const whyLine = el(doc, 'p', 'why-line');
  whyLine.setAttribute('data-why', '');
  appendRich(doc, whyLine, S4_WHY, onWord);
  why.append(whyLine);
  p.append(why);
  p.append(actionRow(doc, action(doc, '收进我的句子', () => send({ type: 'collect' }), 'primary')));
  return p;
}

// ── S5 收录（进「我的句子」+ 渐进痕迹）───────────────────────────────────────
function panelS5(doc, state, send, onWord) {
  const p = panelShell(doc, 'S5');
  p.append(el(doc, 'p', 'ok', '收好了'));
  const last = state.sentences[state.sentences.length - 1];
  if (last !== undefined) {
    const box = el(doc, 'div', 'collected');
    box.append(el(doc, 'p', 'collected-zh', last.zh));
    const en = el(doc, 'p', 'collected-en');
    appendRich(doc, en, last.en, onWord);
    box.append(en);
    p.append(box);
  }
  const prog = el(doc, 'p', 'progress');
  prog.setAttribute('data-progress', '');
  appendRich(doc, prog, progressLine(state.sentences), onWord);
  p.append(prog);
  p.append(el(doc, 'p', 'note', '这一条已经进下面的「我的句子」，下次说还会用它。'));
  p.append(actionRow(doc, action(doc, '再来一句', () => send({ type: 'again' }), 'primary')));
  return p;
}

/** 六个动作面板的派发表（`S0`–`S5` 各一个）。 */
const PANELS = Object.freeze({ S0: panelS0, S1: panelS1, S2: panelS2, S3: panelS3, S4: panelS4, S5: panelS5 });

/**
 * 每一步的**前置条件**：有些"步骤 + 字段"的组合是不该存在的
 * （比如"走到了判定那一步，却没有拼好的那个词块"）。
 *
 * 为什么要在渲染前响亮抛错，而不是让 `state.picked.text` 自己去崩：
 * 后者报出来的是 **`Cannot read properties of null (reading 'text')`**——那句话指向
 * `picked` 这个局部变量，而真因是**状态机的不变式被破坏了**（`step` 与 `picked` 不同步）。
 * 同族先例：`web/dialogue.mjs` 的 `assertRoot`（容器没找到时不许报"DOM 内部"的错）。
 * 这条守卫是变异校验逼出来的：把 `reduce` 改坏成"点错也推进到 S3"时，
 * 六条测试全死在同一句 null 解引用上——**RED 是真的，但归因不可读**（红线 17b）。
 */
const PRECONDITIONS = Object.freeze({
  S1: (s) => s.point !== null,
  S2: (s) => s.point !== null,
  S3: (s) => s.picked !== null,
  S4: (s) => s.picked !== null,
  S5: (s) => s.sentences.length > 0,
});

// ── 「我的句子」列表（历史**以列表呈现**，不是对话气泡）──────────────────────
function mine(doc, state, onWord) {
  const wrap = el(doc, 'section', 'mine-wrap');
  const head = el(doc, 'div', 'mine-head');
  head.append(el(doc, 'span', 'mine-title', '我的句子'));
  head.append(el(doc, 'span', 'mine-count', String(state.sentences.length)));
  wrap.append(head);
  if (state.sentences.length === 0) {
    // 空的时候是一块**虚线留白**（"这里将来会长出东西"），不是一大块死气沉沉的米色。
    wrap.className = 'mine-wrap is-empty';
    wrap.append(el(doc, 'p', 'mine-empty', '说一句，这里就会长出一条。'));
    return wrap;
  }
  const ul = el(doc, 'ul', 'mine');
  const lastIndex = state.sentences.length - 1;
  state.sentences.forEach((item, i) => {
    const li = el(doc, 'li', 'mine-item');
    li.setAttribute('data-mine', String(i));
    if (i === lastIndex && state.step === 'S5') li.append(el(doc, 'span', 'new-tag', '新'));
    li.append(el(doc, 'p', 'mine-zh', item.zh));
    const en = el(doc, 'p', 'mine-en');
    appendRich(doc, en, item.en, onWord);
    li.append(en);
    const tag = el(doc, 'p', 'mine-chunk');
    appendRich(doc, tag, `用法：${item.chunk}（${item.chunkZh}）`, onWord);
    li.append(tag);
    ul.append(li);
  });
  wrap.append(ul);
  return wrap;
}

// ── 词卡层（关着的时候是**空的**：这样"面板区没有表外词"的断言才不是被它污染的）──
function wordCard(doc, card, onClose, onWord) {
  const layer = el(doc, 'div', 'wc-layer');
  layer.setAttribute('data-layer', 'wordcard');
  if (card === null) return layer;
  const sheet = el(doc, 'div', 'wc');
  const head = el(doc, 'div', 'wc-head');
  head.append(el(doc, 'span', 'wc-word', card.word));
  head.append(action(doc, '收起词卡', onClose, 'wc-close'));
  sheet.append(head);
  const rows = [
    ['词性', card.pos],
    ['中文', card.zh],
    ['搭配 · 例句', card.use === '' ? '—' : card.use],
  ];
  const line = [NATURAL_SENTENCE, BLANK_SENTENCE].find((s) => containsWord(s, card.word));
  if (line !== undefined) rows.push(['你这句里', line]);
  for (const [k, v] of rows) {
    const row = el(doc, 'div', 'wc-row');
    row.append(el(doc, 'span', 'wc-k', k));
    const val = el(doc, 'span', 'wc-v');
    appendRich(doc, val, v, onWord);
    row.append(val);
    sheet.append(row);
  }
  layer.append(sheet);
  return layer;
}

/**
 * 把这一屏挂到容器上。
 *
 * @param {HTMLElement} root 容器（`web/proto/flow.html` 里的 `#app`）
 * @param {{doc?: object, runtime?: object}} [deps]
 *   `doc`：DOM 工厂，缺省取运行环境的 `document`（与 `web/dialogue.mjs` 的 `mountDialogue` 同一做法）。
 *   `runtime`：状态机外壳，缺省新建（测试用它注入一个预置状态；生产不传）。
 * @returns {{send: Function, state: object, events: Array<object>}} 运行时把手
 *   ——`events` 是这一路发过的事件，测试靠它断言"除第一步外没有任何事件携带自由文本"。
 */
export function mountFlow(root, deps = {}) {
  assertRoot(root);
  const doc = deps.doc ?? globalThis.document;
  if (doc === null || doc === undefined || typeof doc.createElement !== 'function') {
    throw new TypeError('mountFlow: 需要一个 DOM 工厂（`deps.doc` 形状 { createElement }）');
  }
  const runtime = deps.runtime ?? createRuntime();
  /** 界面局部状态：开着的那张词卡（**不进流程状态机**：它不改变教学流程）。 */
  let opened = null;
  const openCard = (card) => { opened = card; render(); };
  const closeCard = () => { opened = null; render(); };
  const send = (event) => { const next = runtime.send(event); render(); return next; };

  function render() {
    const state = runtime.state;
    const need = PRECONDITIONS[state.step];
    if (need !== undefined && !need(state)) {
      throw new TypeError(`mountFlow: 状态不自洽——第 ${state.step} 步缺了它必须有的字段（step 与字段的状态不变式被破坏）`);
    }
    const build = PANELS[state.step] ?? panelS0;
    root.replaceChildren(
      header(doc),
      rail(doc, state),
      build(doc, state, send, openCard),
      mine(doc, state, openCard),
      wordCard(doc, opened, closeCard, openCard),
    );
  }

  render();
  return {
    send,
    get state() { return runtime.state; },
    get events() { return runtime.events; },
  };
}
