// web/proto/style.js
//
// 视觉打样：**同一屏 · 同一份内容 · 三种版式结构**（`?variant=A|B|C`）。
//
// ── 这一份为什么是「三个渲染器」而不是「一套 DOM 换皮」────────────────────────
// 本任务的判据是**结构必须真的不同**。所以 A / B / C 各有一个独立的模板函数，
// 产出的 DOM 骨架互不相同（A 是单栏流式；B 是 编号网格 + 贴底工具区；C 是两块
// 等重的 flex 分屏 + 一条中轴）。共用的是**内容与词表**，不是结构。
//
// ── 怎么做到「切换后没有上一版的残留节点」────────────────────────────────────
// 换版 = `#app.innerHTML = <新版模板>` 的**整体替换**（不是隐藏、不是加类名）。
// 因此任何时刻 DOM 里只有一个 `[data-variant]` 根。
//
// ── 设计约束（与 style.css 的分工）──────────────────────────────────────────
// **布局与配色一律在 CSS 里**；这份 JS 只管三件事：
//   ① 把内容按三套骨架铺开（含逐词可点）；
//   ② 改写状态机（step / hint）——动效只在「改写」这一处，且尊重 reduce；
//   ③ 切换条（写 `?variant=`、←/→、循环）。
// 文件里**没有一句教学判断**：不调模型、不发请求、不读 Key、不碰 localStorage。

/* ─────────────────────────────────────────────────────────────────────────────
   内容（**逐字照用**：这些字串是任务书给定的，不许改写）
   ───────────────────────────────────────────────────────────────────────────── */
const C = {
  // 他的中文原话 —— 只当「出处」
  src: '今天没什么特殊的，我正常上了半天课',
  // 他写的英文（第 6、7 个词 = 被标出的那一处）
  v1: 'Nothing special today. I had class as usually for half a day.',
  // 只改被标出的那一处之后
  v2: 'Nothing special today. I had class as usual for half a day.',
  // 再往地道走一层（复数 classes：have classes = 上课）
  v3: 'Nothing special today. I had classes as usual for half a day.',

  note: '这一处再想想', // 系统批注：只指一处，不说为什么
  effort: '自己写的 · 提示 0 次', // 靠了多大力
  effort1: '自己写的 · 提示 1 次',
  done: '改好了',
  hintBtn: '给点提示',
  again: '再改一版', // C 的中轴按钮
  foldS: '我的句子 (3)',
  foldW: '我的词 (7)',
  empty: '这里会长出更地道的说法', // C 的下块一开始只有这一句灰字

  // ⚠️ 以下两条是**为原型自撰的文案**（任务书没给）：提示语与 B 的第三行空态。
  // 提示语刻意**不给答案**（只提问），与「给答案会杀死学习」一致。
  hint: '你写的这句里，as 后面跟的是什么词？',
  pending: '· 还没改',
};

// 「我的句子 (3)」——第一句是本屏这一句，另两句是**演示数据**（见报告「明知未验」）
const MINE_S = [
  ['今天', C.v1],
  ['昨天', 'I went to the market with my mother.'],
  ['前天', 'I stayed at home and read a book.'],
];

// 「我的词 (7)」——都取自本屏这一句，不凭空造词
const MINE_W = ['nothing', 'special', 'class', 'as', 'usually', 'half', 'day'];

/* ─────────────────────────────────────────────────────────────────────────────
   词表：屏上**每一个英文词**都有一张卡（词性 + 中文 + 这一句里的用法）。
   这是上一轮踩过的坑（13 张卡却有 3 个词无卡）——本轮的探针会**逐词点一遍**，
   任何 `[data-w]` 取不到卡就是红的。
   ⚠️ 词卡内容是自撰的教学数据，**无人背书**（登记在报告的「明知未验」里）。
   ⚠️ 刻意**不给答案**：`usually` 那张只说「它跟在 as 后面」，不写「应该换成 usual」。
   ───────────────────────────────────────────────────────────────────────────── */
const LEX = {
  nothing: { pos: 'pron.', zh: '没有什么', use: '这句里作主语：Nothing special today.' },
  special: { pos: 'adj.', zh: '特别的', use: '放在 nothing 后面修饰它：nothing special（没什么特别的）' },
  today: { pos: 'adv.', zh: '今天', use: '时间状语，句首句尾都可以；这句放在句首' },
  i: { pos: 'pron.', zh: '我', use: '主语用主格；英文里 I 永远大写' },
  had: { pos: 'v.', zh: '有；上（课）', use: 'have 的过去式；have class = 上课' },
  class: { pos: 'n.', zh: '课', use: 'have class 是固定搭配，泛指上课时不加冠词' },
  as: { pos: 'prep.', zh: '像；作为', use: '这句里它和后面的词连起来用，表示「像……一样」' },
  usually: { pos: 'adv.', zh: '通常', use: '副词，一般放在动词前（I usually walk）；这句里它跟在 as 后面' },
  for: { pos: 'prep.', zh: '（持续）达', use: 'for + 一段时间 = 持续多久：for half a day' },
  half: { pos: 'det.', zh: '一半的', use: 'half a day = 半天；half 后面接 a + 名词' },
  a: { pos: 'art.', zh: '一个', use: '冠词；half a day 里 a 固定在 half 与名词之间' },
  day: { pos: 'n.', zh: '天', use: '可数名词单数，前面要有限定词（half a day）' },
  usual: { pos: 'adj.', zh: '平常的', use: 'as usual = 像平常一样；形容词，跟在 as 后面' },
  classes: { pos: 'n.', zh: '课（复数）', use: 'class 的复数；have classes = 上课（多节或泛指）' },
  went: { pos: 'v.', zh: '去', use: 'go 的过去式：went to the market' },
  to: { pos: 'prep.', zh: '到；向', use: 'go to + 地点 = 去某地' },
  the: { pos: 'art.', zh: '这个；那个', use: '特指双方都知道的那个：the market' },
  market: { pos: 'n.', zh: '市场；菜场', use: '可数名词，前面要有限定词（the market）' },
  with: { pos: 'prep.', zh: '和……一起', use: 'with + 人 = 和某人一起' },
  my: { pos: 'det.', zh: '我的', use: '形容词性物主代词，后面必须接名词（my mother）' },
  mother: { pos: 'n.', zh: '妈妈', use: '可数名词单数，前面要有限定词（my mother）' },
  stayed: { pos: 'v.', zh: '待着；留下', use: 'stay 的过去式：stayed at home' },
  at: { pos: 'prep.', zh: '在（某处）', use: 'at + 地点 = 在某处：at home' },
  home: { pos: 'n.', zh: '家', use: 'at home = 在家；固定搭配里 home 前面不加 the' },
  and: { pos: 'conj.', zh: '和；然后', use: '连接两个并列的动作：stayed … and read …' },
  read: { pos: 'v.', zh: '读', use: 'read 的过去式拼写不变，读音变成 /red/' },
  book: { pos: 'n.', zh: '书', use: '可数名词单数，前面要有限定词（a book）' },
};

/* ─────────────────────────────────────────────────────────────────────────────
   渲染零件
   ───────────────────────────────────────────────────────────────────────────── */
const ORDER = ['A', 'B', 'C', 'D'];
const NAME = { A: 'A（手稿）', B: 'B（工作台）', C: 'C（对照）', D: 'D（暖笔记本）' };

// 被标出的那一处 = v1 的第 6、7 个词（0 基）：「as usually」
const FLAG_FROM = 6;
const FLAG_TO = 7;

const H = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const key = (t) => t.toLowerCase().replace(/[^a-z']/g, '');

// 品牌标记：改稿符号里的「插入号」（一个尖 + 一道短横）。
// 三版共用**同一个**标记与同一个字标，只换站位 —— 这样它才是「一眼认得出的标记」。
const BMK =
  '<svg class="bmk" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
  '<path d="M3.4 13.2 L10 3.8 L16.6 13.2" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M6.6 17 H13.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '</svg>';
const mast = () => `<header class="mast">${BMK}<span class="wordmark">今天的一句</span></header>`;

// 逐词可点：每个词都是一个**看起来只是文字**的按钮。`data-i` 是渲染内序号，
// 只用于「哪一个是当前打开的那一个」（词卡用过一次就不再重渲染，见 openCard）。
let seq = 0;
const wbtn = (t) => `<button type="button" class="w" data-w="${key(t)}" data-i="${seq++}">${H(t)}</button>`;

/** 一句话铺成逐词按钮；`flag=true` 时把「as usually」包成一个可点整体。 */
function line(s, flag) {
  const t = s.split(' ');
  if (!flag) return t.map(wbtn).join(' ');
  return [
    ...t.slice(0, FLAG_FROM).map(wbtn),
    `<span class="flag">${t.slice(FLAG_FROM, FLAG_TO + 1).map(wbtn).join(' ')}</span>`,
    ...t.slice(FLAG_TO + 1).map(wbtn),
  ].join(' ');
}

/** 词卡（极简三件）。取不到词表就**返回空**——探针会把这种词判红。 */
function cardHTML(surface, k) {
  const e = LEX[k];
  if (!e) return '';
  return (
    `<span class="wc"><b class="wc-w">${H(surface)}</b>` +
    `<i class="wc-pos">${H(e.pos)}</i><span class="wc-zh">${H(e.zh)}</span>` +
    `<span class="wc-use">${H(e.use)}</span></span>`
  );
}

function foldBlock(kind) {
  const isS = kind === 's';
  const body = isS
    ? MINE_S.map(([d, s]) => `<p class="mine-s"><span class="mine-d">${H(d)}</span> ${line(s, false)}</p>`).join('')
    : `<div class="chips">${MINE_W.map((w) => `<button type="button" class="w chip" data-w="${w}" data-i="${seq++}">${H(w)}</button>`).join('')}</div>`;
  return (
    `<button type="button" class="fold" data-fold="${kind}" aria-expanded="false">${H(isS ? C.foldS : C.foldW)}</button>` +
    `<div class="fold-body" data-body="${kind}" hidden>${body}</div>`
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   状态
   ───────────────────────────────────────────────────────────────────────────── */
const blank = () => ({ v: 'A', step: 0, hint: false, anim: false, seg: 's' });
let state = blank();

const motionOk = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// D 的 LargeTitle 是**当天日期**（笔记本的「这一页是哪天」）。
// 由 `new Date()` 现算，不是写死的字串 —— 写死会在明天变成假话。
const todayLabel = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1)}月${String(d.getDate())}日`;
};

/* ═════════════════════════════════════════════════════════════════════════════
   A ──「手稿」：单栏 · 零容器 · 留白 + 极细规则线
   ═════════════════════════════════════════════════════════════════════════════ */
function viewA(st) {
  const old = st.step > 0;
  const anim = old && st.anim ? ' rw-anim' : '';
  return `
  <div class="v v-a" data-variant="A">
    <div class="col">
      ${mast()}
      <hr class="hair">
      <section class="seg-src"><p class="src">${H(C.src)}</p></section>
      <hr class="hair">
      <section class="seg-say">
        <div class="say" data-line="1">
          <p class="en${old ? ` is-old${anim}` : ''}">${line(C.v1, true)}</p>
        </div>
        ${old ? `<div class="say" data-line="2"><p class="en is-new${anim}">${line(C.v2, false)}</p></div>` : ''}
      </section>
      <div class="notes">
        <p class="note" data-layer="note">${H(C.note)}</p>
        ${st.hint ? `<p class="note note-hint" data-layer="hint">${H(C.hint)}</p>` : ''}
        <div class="cardwrap" data-layer="wordcard" hidden></div>
      </div>
      <p class="eff">${H(st.hint ? C.effort1 : C.effort)}</p>
      <div class="acts">
        <button type="button" class="do do-main" data-act="done"${old ? ' disabled' : ''}>${H(C.done)}</button>
        <button type="button" class="do do-alt" data-act="hint"${st.hint ? ' disabled' : ''}>${H(C.hintBtn)}</button>
      </div>
      <hr class="hair">
      <section class="folds">${foldBlock('s')}${foldBlock('w')}</section>
    </div>
  </div>`;
}

/* ═════════════════════════════════════════════════════════════════════════════
   B ──「工作台」：上下两区 · 编号 + 等宽标签 · 常驻底部工具区
   ═════════════════════════════════════════════════════════════════════════════ */
function viewB(st) {
  const old = st.step > 0;
  const anim = old && st.anim ? ' rw-anim' : '';
  return `
  <div class="v v-b" data-variant="B">
    <div class="sheet">
      ${mast()}
      <section class="row" data-row="01">
        <span class="num">01</span>
        <div class="rbody"><span class="tag">你说的</span><p class="src">${H(C.src)}</p></div>
      </section>
      <section class="row" data-row="02">
        <span class="num">02</span>
        <div class="rbody">
          <span class="tag">你写的</span>
          <p class="en${old ? ` is-old${anim} is-old-log` : ''}">${line(C.v1, true)}</p>
          <div class="gutter"><p class="note" data-layer="note">${H(C.note)}</p></div>
          ${st.hint ? `<div class="gutter"><p class="note note-hint" data-layer="hint">${H(C.hint)}</p></div>` : ''}
        </div>
      </section>
      <section class="row${old ? ' is-filled' : ''}" data-row="03">
        <span class="num">03</span>
        <div class="rbody">
          <span class="tag">系统版</span>
          <p class="pending" data-layer="pending">${H(C.pending)}</p>
          ${old ? `<p class="en-sys is-new${anim}">${line(C.v2, false)}</p>` : ''}
          <div class="blank" aria-hidden="true"></div>
        </div>
      </section>
    </div>
    <div class="tool">
      <div class="trow"><span class="tlab">用力</span><span class="tval">${H(st.hint ? C.effort1 : C.effort)}</span></div>
      <div class="trow foldrow">${foldBlock('s')}</div>
      <div class="trow foldrow">${foldBlock('w')}</div>
      <div class="cardrow" data-layer="wordcard" hidden></div>
      <div class="btnbar">
        <button type="button" class="btn btn-main" data-act="done"${old ? ' disabled' : ''}>${H(C.done)}</button>
        <button type="button" class="btn btn-alt" data-act="hint"${st.hint ? ' disabled' : ''}>${H(C.hintBtn)}</button>
      </div>
    </div>
  </div>`;
}

/* ═════════════════════════════════════════════════════════════════════════════
   C ──「对照」：恒定的两块（上=他写的 · 下=更地道的，一开始是空的）+ 一条细轴
   ═════════════════════════════════════════════════════════════════════════════ */
function viewC(st) {
  const anim = st.step > 0 && st.anim ? ' rw-anim' : '';
  const ver = (n) =>
    `<p class="ver${n === 2 ? ' ver-2' : ''} is-new${anim}" data-ver="${n}">${line(n === 1 ? C.v2 : C.v3, false)}</p>`;
  return `
  <div class="v v-c" data-variant="C">
    ${mast()}
    <section class="blk blk-up" data-block="yours">
      <span class="blab">他写的</span>
      <p class="src">${H(C.src)}</p>
      <p class="en">${line(C.v1, true)}</p>
    </section>
    <div class="axis">
      <div class="rail"><span class="axis-eff">${H(st.hint ? C.effort1 : C.effort)}</span></div>
      <div class="axis-mid">
        <button type="button" class="again" data-act="again"${st.step >= 2 ? ' disabled' : ''}>${H(C.again)}</button>
      </div>
      <div class="axis-note">
        <p class="note" data-layer="note">${H(C.note)}</p>
        ${st.hint ? `<p class="note note-hint" data-layer="hint">${H(C.hint)}</p>` : ''}
      </div>
    </div>
    <section class="blk blk-down" data-block="native">
      <span class="blab">更地道的</span>
      ${st.step === 0 ? `<p class="empty" data-layer="empty">${H(C.empty)}</p>` : ver(1)}
      ${st.step >= 2 ? ver(2) : ''}
    </section>
    <div class="cfoot">
      <button type="button" class="qbtn qbtn-main" data-act="done"${st.step > 0 ? ' disabled' : ''}>${H(C.done)}</button>
      <button type="button" class="qbtn" data-act="hint"${st.hint ? ' disabled' : ''}>${H(C.hintBtn)}</button>
    </div>
    <div class="cfolds">${foldBlock('s')}${foldBlock('w')}</div>
    <div class="pop cardwrap" data-layer="wordcard" hidden></div>
  </div>`;
}

/* ═════════════════════════════════════════════════════════════════════════════
   D ──「暖笔记本」：一张浮在暖台面上的圆角纸 · Apple 字阶 · 分段控件
   ═════════════════════════════════════════════════════════════════════════════ */
function viewD(st) {
  const old = st.step > 0;
  const anim = old && st.anim ? ' rw-anim' : '';
  const segBtn = (kind) => {
    const on = st.seg === kind;
    return (
      `<button type="button" class="dsegbtn" data-seg="${kind}" role="tab" ` +
      `aria-selected="${String(on)}">${H(kind === 's' ? C.foldS : C.foldW)}</button>`
    );
  };
  const segBody = (kind) => {
    const isS = kind === 's';
    const inner = isS
      ? MINE_S.map(([d, s]) => `<p class="mine-s"><span class="mine-d">${H(d)}</span> ${line(s, false)}</p>`).join('')
      : `<div class="chips">${MINE_W.map((w) => `<button type="button" class="w chip" data-w="${w}" data-i="${seq++}">${H(w)}</button>`).join('')}</div>`;
    return (
      `<div class="dsegbody" data-segbody="${kind}" role="tabpanel"` +
      `${st.seg === kind ? '' : ' hidden'}>${inner}</div>`
    );
  };
  return `
  <div class="v v-d" data-variant="D">
    <div class="paper">
      <header class="dhead">
        <span class="dbrand">${BMK}<span class="dbrand-t">${H(todayLabel())}</span></span>
        <h1 class="dtitle">今天的一句</h1>
        <p class="dmeta">${H(st.hint ? C.effort1 : C.effort)}</p>
      </header>
      <hr class="dhair">
      <div class="dbody">
        <p class="src">${H(C.src)}</p>
        <div class="say" data-line="1"><p class="en${old ? ` is-old${anim}` : ''}">${line(C.v1, true)}</p></div>
        ${old ? `<div class="say" data-line="2"><p class="en is-new${anim}">${line(C.v2, false)}</p></div>` : ''}
        <p class="note" data-layer="note">${H(C.note)}</p>
        ${st.hint ? `<p class="note note-hint" data-layer="hint">${H(C.hint)}</p>` : ''}
      </div>
      <div class="dseg" role="tablist" aria-label="我的句子 / 我的词">${segBtn('s')}${segBtn('w')}</div>
      ${segBody('s')}${segBody('w')}
      <div class="dacts">
        <button type="button" class="pill pill-alt" data-act="hint"${st.hint ? ' disabled' : ''}>${H(C.hintBtn)}</button>
        <button type="button" class="pill pill-main" data-act="done"${old ? ' disabled' : ''}>${H(C.done)}</button>
      </div>
    </div>
    <div class="pop dcard cardwrap" data-layer="wordcard" hidden></div>
  </div>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   渲染 + 事件
   ───────────────────────────────────────────────────────────────────────────── */
const app = document.getElementById('app');

function render() {
  seq = 0; // 逐词按钮的序号从 0 重排（每次整体替换，序号必须与 DOM 一致）
  app.innerHTML =
    state.v === 'A'
      ? viewA(state)
      : state.v === 'B'
        ? viewB(state)
        : state.v === 'C'
          ? viewC(state)
          : viewD(state);
  document.getElementById('swLabel').textContent = NAME[state.v];
}

/** C 的词卡是浮层：贴在被点的那个词下方，四边夹在视口内（不撑宽页面）。 */
function placePop(root, btn) {
  const layer = root.querySelector('[data-layer="wordcard"]');
  if (!layer) return;
  const r = btn.getBoundingClientRect();
  const w = layer.offsetWidth;
  const h = layer.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
  let top = r.bottom + 8;
  if (top + h > vh - 12) top = Math.max(8, r.top - h - 8);
  layer.style.left = `${String(left)}px`;
  layer.style.top = `${String(top)}px`;
}

function closeCard(root) {
  const layer = root.querySelector('[data-layer="wordcard"]');
  if (layer) {
    layer.hidden = true;
    layer.innerHTML = '';
    delete layer.dataset.i;
  }
  for (const b of root.querySelectorAll('.w[aria-expanded="true"]')) b.removeAttribute('aria-expanded');
}

/** 点一个词：就地开/关词卡。**不重渲染**——重渲染会把改写过的行重播动画。 */
function openCard(root, btn) {
  const layer = root.querySelector('[data-layer="wordcard"]');
  if (!layer) return;
  if (layer.dataset.i === btn.dataset.i && !layer.hidden) {
    closeCard(root);
    return;
  }
  closeCard(root);
  const surface = (btn.textContent ?? '').replace(/[^A-Za-z']+$/, '');
  layer.innerHTML = cardHTML(surface, btn.dataset.w ?? '');
  layer.dataset.i = btn.dataset.i ?? '';
  layer.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  if (state.v === 'C') placePop(root, btn);
}

function toggleFold(fold) {
  const body = fold.nextElementSibling;
  if (!body) return;
  const open = fold.getAttribute('aria-expanded') === 'true';
  fold.setAttribute('aria-expanded', open ? 'false' : 'true');
  body.hidden = open;
}

function doAct(a) {
  if (a === 'hint') {
    if (state.hint) return;
    state.hint = true;
    state.anim = false; // 提示是**直接出现**的，不做动画（动效只留给改写）
  } else if (a === 'done' || a === 'again') {
    if (state.step >= 2) return;
    state.step += 1;
    state.anim = motionOk(); // prefers-reduced-motion: reduce ⇒ 不加动画类，直接切换
  } else {
    return;
  }
  render();
  state.anim = false; // 动画类只在插入的那一帧需要；留着会让后续每次重渲染重播
}

/** D 的分段控件：一次只亮一个面板（与 A/B/C 的「可折叠」不同语义）。 */
function setSeg(kind) {
  if (state.seg === kind) return;
  state.seg = kind;
  state.anim = false;
  render();
}

app.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const w = t.closest('.w');
  if (w) {
    openCard(app, w);
    return;
  }
  const seg = t.closest('[data-seg]');
  if (seg) {
    setSeg(seg.dataset.seg ?? 's');
    return;
  }
  const fold = t.closest('.fold');
  if (fold) {
    toggleFold(fold);
    return;
  }
  const act = t.closest('[data-act]');
  if (act && !(act instanceof HTMLButtonElement && act.disabled)) {
    doAct(act.dataset.act ?? '');
    return;
  }
  closeCard(app); // 点空白处 = 收起词卡
});

/* ─────────────────────────────────────────────────────────────────────────────
   切换条：三件构成（◀ / 标签 / ▶）· 循环 · ←/→ · `?variant=` 写回 URL
   ⚠️ 这一块**不属于被评的设计**（样式见 style.css 第 4 节：纯黑胶囊 + 虚线外框）。
   ⚠️ 有意偏离上游 prototype skill 的「生产构建里隐藏切换条」——本项目没有 dev/prod
      构建，而且用户要在手机上翻着看，所以**不隐藏**。理由写在报告里。
   ───────────────────────────────────────────────────────────────────────────── */
function variantFromUrl() {
  const u = String(new URLSearchParams(window.location.search).get('variant') ?? '').toUpperCase();
  return ORDER.includes(u) ? u : 'A';
}

function writeVariant(v) {
  const params = new URLSearchParams(window.location.search);
  params.set('variant', v);
  try {
    // 用相对形式（只写 path + query）：不碰 origin，也不产生跨源 URL
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  } catch {
    // 少数沙箱 / file:// 下 replaceState 会被拒。此时**切换照常发生**，只是 URL 不跟着动。
    // 刻意不在这里报错：原型能不能翻页，比地址栏对不对更重要。
  }
}

function setVariant(v) {
  state = { ...blank(), v }; // 换版 = 完全重置（改写态 / 提示 / 词卡 / 折叠全清）
  writeVariant(v);
  render();
}

function step(delta) {
  const i = ORDER.indexOf(state.v);
  setVariant(ORDER[(i + delta + ORDER.length) % ORDER.length]);
}

document.querySelector('.sw-prev').addEventListener('click', () => step(-1));
document.querySelector('.sw-next').addEventListener('click', () => step(1));

window.addEventListener('keydown', (e) => {
  const t = e.target;
  // input / textarea / contenteditable 聚焦时**不拦截**方向键
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable], [contenteditable="true"]')) return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    step(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    step(1);
  }
});

// 载入：把 `?variant=` 归一（缺省或非法值都写回 A）——刷新与分享都不丢
setVariant(variantFromUrl());
