// tests/styles.test.mjs
//
// 样式层的**静态**契约检查。Node 里没有浏览器（也没有 CSS 解析器，零依赖约定），
// 所以这里检查的是"结构性地能不能成立"，不是"看起来好不好看"——
// 真正的视觉验证靠 docs/ui-redesign/ 的前后截图（走查台 web/gallery.html）。
//
// 这些断言每一条都对应一次**真实踩过的坑或一条硬约束**，不是仪式：
//   1. 零外部资源：`tests/index-html.test.mjs` 只查 HTML 的 href/src，**看不到 CSS 内部**；
//      而 CSS 里的 @import / url(http…) 同样会在"外站不可达"的场景下让页面变形，
//      而且更隐蔽（HTML 检查放行、浏览器静默失败）。补上这个缺口。
//   2. 设计令牌必须真的被用：曾经把 #000 之类的值直接写进组件规则里，
//      于是"改一处主题"变成全文件搜索。这里钉住"组件不许写死颜色"。
//   3. 触控目标 ≥44px：设计文档是针对**手机浏览器**的，手指点不中就是不可用。
//   4. 单一重音：多过一个强调色是"像模板"的头号成因。
//   5. **DOM 标记与样式必须对得上**（本轮新增）：`word-title` 与 `primary` 这两个语义类名
//      是 `app.mjs` 与 `styles.css` 之间唯一的耦合面。样式侧写对了、app.mjs 忘了标记，
//      界面**不会报错**、只会静默丢掉衬线与重音——所以这里同时读两份文件对账。
//      口径来源：`DEC-OPI-968b804d-af33-437d-be9b-277ecead51db.6`（两条「重要」的人裁决）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../web/styles.css', import.meta.url));
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../web/app.mjs', import.meta.url));
const css = readFileSync(cssPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');
// `app.mjs`（生产者：谁带语义类名）与 `styles.css`（消费者：类名怎么画）是本文件仅有的两个被测源
const app = readFileSync(appPath, 'utf8');
/** 剥掉注释后的 CSS：注释里可以讨论写法，断言只该看规则本身。 */
const cssBody = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 取 `styles.css` 里某个选择器的规则体（剥注释后）。
 * 找不到就断言失败——"规则被删了"必须报错，不能静默返回空串让后面的 match 蒙混过关。
 *
 * ⚠️ 实现要点（本轮踩了两次才定下来，别退回去用行首锚定）：
 * 遍历**每一个规则块**，并要求它的**整条选择器列表**与 pattern 精确相等（`^\s*…\s*$`）。
 * 不能写成 `^textarea\s*\{` 那种"行首锚定"：多行选择器列表的**最后一行**在文本上与
 * "独占一行的选择器"无法区分——`input[type='password'],\ninput[type='text'],\ntextarea {`
 * 里的 `textarea {` 就正好落在一个行首，而 `^` 在该行匹配、前缀可以为空。
 * 实测后果：`cssBlock('textarea')` 抓到的是那个**合写块**（它没有 `overflow-wrap`），
 * 于是"删掉 textarea 的 overflow-wrap"这条断言永远 RED——一个自己坏掉的助手会被误读成
 * "实现没写"（本轮就是这么误判过一次，白跑一轮）。
 * 现在合写块的 selector 是 `input[…], input[…], textarea`（含逗号、不等于 pattern），天然被排除。
 *
 * `[^{}]*?` 惰性展开 + 引擎"最早起点优先"⇒ 匹配到的 `m[1]` 一定是**从上一个 `}` 之后
 * 到 `{` 之前的完整选择器文本**（中间夹着的换行也包含在内），不会只截到最后一行。
 */
function cssBlock(selectorPattern) {
  const want = new RegExp(`^\\s*${selectorPattern}\\s*$`);
  const re = /(?:^|\n)([^{}]*?)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(cssBody)) !== null) {
    if (want.test(m[1])) return m[2];
  }
  return assert.fail(`styles.css 里没有"选择器恰好等于 /${selectorPattern}/"的规则`
    + '（要求整条选择器列表精确相等；合写块如 `input, textarea {` 会被排除——'
    + '那是有意的：只有独占的选择器才能保证量到的声明属于这个规则）');
}

/**
 * 取 `app.mjs` 的 `viewFor` 里全部 `action(...)` 调用点，解析出参数个数与文案。
 *
 * 为什么值得写这个解析器（而不是在测试里 grep 几个字符串）：本轮的核心断言是
 * **"哪 6 屏有主操作、哪 2 屏一颗都不许有"**——这是一张与屏幕一一对应的表。
 * 只断言"某个文案带 primary"会让"给 pending 也加上 primary"这条真实回归**照样 GREEN**。
 */
function actionCallSites() {
  const sites = [];
  // 逐字符扫描参数，遇到顶层逗号才切分（文案里含全角括号、参数里含箭头函数与三元表达式，
  // 所以不能用简单 split）。
  const re = /action\(/g;
  let m;
  while ((m = re.exec(app)) !== null) {
    let i = m.index + 'action('.length;
    let depth = 0;
    let inString = null;
    const args = [];
    let cur = '';
    for (; i < app.length; i += 1) {
      const ch = app[i];
      if (inString !== null) {
        cur += ch;
        if (ch === '\\') { cur += app[i + 1]; i += 1; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0 && ch === ')') break;
        depth -= 1;
      }
      if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    args.push(cur.trim());
    const first = args[0] ?? '';
    const label = /^'(.*)'$/.exec(first)?.[1] ?? null;
    sites.push({ label, argCount: args.length, isPrimary: args[3] === 'true' });
  }
  assert.ok(sites.length >= 18, `app.mjs 里应能解析出全部 action 调用点，实测 ${sites.length} 个`);
  return sites;
}

/**
 * 文案 → 该文案的**全部**调用点是否都被标成主操作。
 *
 * 为什么按文案索引是成立的：全站每一颗动作按钮的文案都只出现一次，**唯一例外是
 * 「再写一次」「下一个词」**——它们在 `feedback` 屏有**两处**调用点（等判定的那一格
 * 与判定回来后的那一格）。这两颗本来就必须**都不是** primary，所以"全部调用点"这个口径
 * 对我们关心的判断没有失真；反过来，如果哪天给其中一处标了 primary，
 * `assert.deepEqual([...].filter(v => v))` 那条会立刻 RED。
 */
function primaryByLabel() {
  const map = new Map();
  for (const s of actionCallSites()) {
    if (s.label === null) continue;         // 动态文案（`演示播放中 ? … : …`）不参与
    map.set(s.label, (map.get(s.label) ?? []).concat(s.isPrimary));
  }
  return map;
}

/** 该文案的**所有**调用点都是主操作。 */
const allPrimary = (map, label) => {
  const v = map.get(label);
  assert.ok(v, `app.mjs 里找不到文案为「${label}」的 action 调用点`);
  return v.every(Boolean);
};
/** 该文案的**所有**调用点都不是主操作。 */
const nonePrimary = (map, label) => {
  const v = map.get(label);
  assert.ok(v, `app.mjs 里找不到文案为「${label}」的 action 调用点`);
  return v.every((x) => x === false);
};

/** 本轮裁决里**必须有**主操作的那 6 屏（`DEC-…db.6`）。 */
const PRIMARY_LABELS = ['拍照', '保存', '快门', '我会读了（开始跟读）', '提交造句', '我读过了（自评打勾）'];
/** 本轮裁决里**一颗都不许有**主操作的那 2 屏：对等选项，点亮其一 = 凭空造出优先级。
 *  这张表里**只放走 `action()` 造的按钮**，且文案必须是静态字面量：
 *   ·「从相册选图」与候选词一样是手写 `createElement('button')`（`ready` 屏里排在「拍照」之后）
 *     ⇒ 不在 `action()` 调用点里，由另一条测试（"候选按钮是一组等权选项"那条）钉住；
 *   ·「听示范」走的是动态文案 `demoBusy ? '正在播放…' : '听示范'`（解析器读不到字面量）
 *     ⇒ 由下面单独一条断言按"带 disabled 参数、不带 primary"钉住。 */
const NO_PRIMARY_LABELS = ['手动补交', '再写一次', '下一个词', '跳过跟读', '清除 Key', '再拍一张'];

test('样式表存在且被 index.html 链接（链接断了就是无样式白板）', () => {
  assert.ok(existsSync(cssPath), 'web/styles.css 不存在');
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css">/);
  // 内联 <style> 必须彻底退场：两处样式源会各自漂移（本项目的样式口径只有一份）
  assert.equal(/<style[\s>]/.test(html), false, 'index.html 里不该再有内联 <style>');
});

test('零外部资源：CSS 内不许 @import 或引用 http(s) 资源', () => {
  // 注释里可以讨论这件事，所以先剥掉注释再查
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/@import/.test(body), false, 'CSS 里不许 @import（外站不可达会让页面变形）');
  const urls = [...body.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1].trim());
  for (const u of urls) {
    assert.equal(/^(https?:)?\/\//.test(u), false, `CSS 引用了外部资源：${u}`);
  }
});

test('设计令牌齐备（组件规则依赖这些变量，缺一个就是静默降级）', () => {
  for (const token of [
    '--bg', '--surface', '--ink', '--ink-soft', '--line',
    '--accent', '--on-accent', '--danger',
    '--r-sm', '--r', '--r-lg', '--r-xl',
    '--s-1', '--s-7', '--font-ui', '--font-word', '--dur', '--ease',
  ]) {
    assert.ok(css.includes(`${token}:`), `styles.css 缺少设计令牌 ${token}`);
  }
});

test('组件规则不写死颜色（只允许令牌 + 极少数说明性例外）', () => {
  // 令牌定义的 :root 块内部允许出现字面色值，块外不允许
  const withoutRoot = css.replace(/:root\s*\{[\s\S]*?\n\}/g, '');
  const body = withoutRoot.replace(/\/\*[\s\S]*?\*\//g, '');
  const hexes = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  const rgbs = [...body.matchAll(/rgba?\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(hexes, [], `组件规则里出现了写死的十六进制颜色：${hexes.join(', ')}`);
  // rgb()/rgba() 只允许出现在阴影令牌里——阴影是本文件唯一需要字面 alpha 的地方
  for (const v of rgbs) {
    assert.ok(
      /rgba?\(0,\s*0,\s*0|rgba?\(60,\s*46,\s*30/.test(v),
      `组件规则里出现了非阴影的字面色值：${v}`,
    );
  }
});

test('单一重音色：不允许第二个强调色混进来', () => {
  const accents = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--accent:\s*([^;]+);/g)]
    .map((m) => m[1].trim());
  // 浅色一份、暗色一份，就这两份
  assert.equal(accents.length, 2, `--accent 应只在浅色/暗色各声明一次，实测 ${accents.length} 次`);
  assert.equal(new Set(accents).size, 2, '浅色与暗色应是两个不同的值');
  // 反例守卫：曾经用过的紫蓝渐变是典型"AI 味"，明确禁止
  assert.equal(/linear-gradient/.test(css), false, '不使用渐变（本产品的层级靠底色与发丝边，不靠渐变）');
});

test('移动端触控目标 ≥44px，且底部留出安全区', () => {
  assert.match(css, /min-height:\s*44px/, '可点元素必须有 ≥44px 的触控目标');
  assert.match(css, /env\(safe-area-inset-bottom\)/, '底部必须让开 safe-area（否则被小白条压住）');
});

test('键盘可达性：有焦点环，且尊重"减少动态"', () => {
  assert.match(css, /:focus-visible\s*\{/, '缺少 :focus-visible 焦点环（可访问性硬要求）');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, '缺少 prefers-reduced-motion 分支');
});

test('"要学的英文词用衬线"这条排版口径真的落地了（含 word 屏那个词）', () => {
  // 口径本身写在文件头注释里；这里钉住它落在**三个**"英文词所在处"：
  // 候选词、待补原句，以及 `word` 屏那个**用户来拿的那个词**。
  assert.match(css, /--font-word:/, '缺少 --font-word 令牌');
  assert.match(cssBlock('\\.choices\\s*>\\s*button'), /var\(--font-word\)/, '候选词没有用衬线字族');
  assert.match(cssBlock('\\.pending-item\\s*>\\s*p:first-child'), /var\(--font-word\)/,
    '待补原句没有用衬线字族');
  // `word` 屏的标题：它是整屏的视觉主角，所以衬线之外还要**大一号**。
  // 两条一起断言（而不是只断言"用了衬线"）：只改衬线不改字号的话，这个"主角"仍然
  // 与周围中文标题同号，"那个词就是用户来拿的东西"这层意思没有落到视觉上。
  const wordTitle = cssBlock('h2\\.word-title');
  assert.match(wordTitle, /font-family:\s*var\(--font-word\)/, 'word 屏的标题没有用衬线字族');
  const wSize = /font-size:\s*([\d.]+)rem/.exec(wordTitle);
  assert.ok(wSize, 'word 屏的标题没有显式 font-size');
  const h2Size = /font-size:\s*([\d.]+)rem/.exec(cssBlock('h2'));
  assert.ok(h2Size, '通用 h2 没有显式 font-size');
  assert.ok(Number(wSize[1]) > Number(h2Size[1]),
    `word 屏标题必须比通用 h2 大（它是整屏主角）：实测 ${wSize[1]}rem vs 通用 ${h2Size[1]}rem`);
  // ⚠️ 反向守卫：**不许**把衬线挂到通用 `h2` 上——中文标题（「用这个词写一句你自己的话」…）
  // 必须保持系统无衬线，那是文件头的明文口径。这条是本轮唯一"加类名而不是改 h2"的理由，
  // 必须钉住，否则下一个人"顺手简化"就把中文标题一起变成衬线了。
  assert.equal(/font-family/.test(cssBlock('h2')), false,
    '通用 h2 不许声明 font-family（中文标题必须用系统无衬线；衬线只给 .word-title）');
  // 生产者那一半：`word` 屏的标题必须真的带上这个类名。
  // 只查样式侧会漏掉最隐蔽的一种坏法——CSS 写对了、`app.mjs` 忘了标记，界面**不报错**，
  // 只是"要学的那个词"静默变回无衬线（这正是本轮要修的那条「重要 1」）。
  assert.match(app, /title\(shownWord\?\.word \?\? '', 'word-title'\)/,
    'app.mjs 的 word 屏标题没有声明 word-title 类名');
});

test('主操作的重音由 `.primary` 显式声明（类名 + 6 屏表，不猜 DOM 形状）', () => {
  // ── 背景（四轮踩坑换来的，别按直觉改这里）──────────────────────────────────
  // 上一版靠 `:has()` 从"屏幕独有元素"反推主操作（`#app:has(input[type=password])` 认设置屏、
  // `div.row:has(> input[type=file])` 认主屏取词行）。它覆盖不到 `capturing` / `word` /
  // `composing`——那三屏**唯一的推进按钮一颗重音都没有**。根因是结构性的：
  // `settings` 与 `pending` 的动作行 DOM 形状**完全一样**（同为 `#app > div > div.row`），
  // 位置/数量判据（`nth-child` / `only-of-type` / 按钮个数）三次实测全败。
  //
  // ── 新判据 = 生产者显式声明，这张表就是契约本身 ──────────────────────────────
  const prim = primaryByLabel();
  // 1. 六屏各有一颗：缺一颗 = 那一屏的主操作静默变成描边（就是本轮要修的「重要 2」）
  for (const label of PRIMARY_LABELS) {
    assert.equal(allPrimary(prim, label), true, `「${label}」必须是主操作（primary=true）`);
  }
  // 2. `pending` 与 `feedback` **一颗都不许有**：它们是对等选项，点亮其一 = 凭空造出优先级。
  //    这一半是"回证没被误点亮"，比第 1 条更容易被漏——只断言"该亮的亮了"会让
  //    "顺手把「手动补交」也标成 primary"照样 GREEN。
  for (const label of NO_PRIMARY_LABELS) {
    assert.equal(nonePrimary(prim, label), true, `「${label}」不许是主操作（它是与同级按钮对等的选项）`);
  }
  // 3. "一屏至多一颗"的结构性保证：全站被标成 primary 的调用点恰好就是那 6 个
  //    （同屏出现两颗实心块是"层级失灵"最直观的形态；多出来的那颗一定是标错了屏）。
  //    注意 `feedback` 的两处「再写一次 / 下一个词」共 4 个调用点，全部必须是 false——
  //    它们不在下面这张表里，所以只要有一处被点亮，这条 deepEqual 立刻 RED。
  const primSites = actionCallSites().filter((s) => s.isPrimary);
  assert.deepEqual(primSites.map((s) => s.label).sort(), [...PRIMARY_LABELS].sort(),
    '全站被标成主操作的 action 调用点必须恰好是那六屏各一颗');
  // 4. `ready` 屏那一行里有两颗按钮（`[拍照, input[type=file], 从相册选图]`）：
  //    **第一颗是主操作，第二颗是中性的**——这正是旧版靠 `nth-child(2)` 想表达、
  //    却因为中间夹着那个隐藏 input 而恒不成立的那件事。现在它由显式标记决定：
  //    「拍照」在 PRIMARY_LABELS 里，「从相册选图」不在，且后者是手写 createElement，
  //    结构上拿不到 `.primary`。
  assert.match(app, /albumButton\.textContent = '从相册选图';/, '相册按钮必须仍是手写创建的（不参与 action 标记）');
  assert.equal(prim.has('从相册选图'), false, '「从相册选图」不许出现在 action 调用点里（它与拍照并列，不是主操作）');
  // 「听示范」的文案是动态的（`demoBusy ? '正在播放…' : '听示范'`），按文案索引读不到，
  // 所以按"调用点形状"钉：它带 disabled 参数（第 3 个）但**不带** primary（第 4 个）。
  // 这一颗是 `reading` 屏的辅助动作（播示范音），主操作是「我读过了（自评打勾）」。
  const demoSites = actionCallSites().filter((s) => s.label === null && s.argCount === 3);
  assert.equal(demoSites.some((s) => s.isPrimary), false,
    '动态文案的辅助动作（「听示范」）不许被标成主操作');
  // 5. 标记形态：只有 `primary` 这一条路径能给按钮加重音（裸 `.primary` 以外不许表达）
  assert.match(app, /if \(primary\) b\.className = 'primary';/,
    'app.mjs 的 action 必须用 `if (primary) b.className = \'primary\';` 这一个形态打标记');

  // ── 样式侧：`.primary` 是**唯二**的 accent 声明（另一处是 `.choices > button` 的中性描边）──
  assert.match(cssBody, /button\.primary\s*\{/, '缺少 `button.primary` 的重音规则');
  const accentBg = [...cssBody.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /--btn-bg:\s*var\(--accent\)/.test(body))
    .map(([, sel]) => sel.trim().replace(/\s+/g, ' '));
  assert.equal(accentBg.length, 1,
    `给按钮上重音底色（--btn-bg: var(--accent)）的位置必须恰好一处，实测 ${accentBg.length} 处：${accentBg.join(' | ')}`);
  assert.match(accentBg[0], /\.primary/, `重音规则必须靠 .primary 类名，实测选择器：${accentBg[0]}`);
  // 候选词仍是中性描边（它是"一组等权选项"）；"不会被点亮"的第一道防线是它自己那条声明，
  // 第二道是下面第 5 条——它拿不到 `.primary` 类（见 NO_PRIMARY_LABELS + PRIMARY_LABELS 那张表）。
  assert.match(cssBlock('\\.choices\\s*>\\s*button'), /--btn-bg:\s*var\(--surface\)/,
    '候选词必须是中性描边外观（不许是重音）');

  // 5. **旧判据不许回流**。三种形态各自对应一次真实事故，全部实测过：
  //    · `:has()` 屏幕判据：分不开 settings / pending，且覆盖不到三屏（本轮删掉的原因）；
  //    · `:nth-child(2)`：`ready` 的动作行第 2 个子节点是隐藏的 `input[type=file]`，位次判据恒不成立；
  //    · `:first-child:only-of-type`：假设"保存独占一行"，实为 3 个子节点，`matches()` 恒为 false。
  //    再加上"任何针对按钮的位置判据"一起去查（`button:first-child` 这类）：
  //    只要重音还能被位置决定，本文件就又会回到"猜 DOM 形状"的老路。
  for (const [re, why] of [
    [/\.row:has\(/, ':has() 屏幕判据分不开 settings 与 pending（同为 #app > div > div.row）'],
    [/:has\(input\[type='password'\]\)/, ':has() 认设置屏已被类名声明取代'],
    [/button:nth-child\(2\)/, 'nth-child 数按钮恒不成立（动作行里夹着隐藏的 input）'],
    [/button:first-child:only-of-type/, 'only-of-type 判"独占一行"恒不成立（设置屏那行有 3 个子节点）'],
  ]) {
    assert.equal(re.test(cssBody), false, `styles.css 里不许再出现这种猜屏/猜位次的判据：${why}`);
  }
  // 6. 入口行（「设置（API Key）」与「待补反馈（n 条）」）恒次级，且**结构上**不可能被点亮：
  //    它们的按钮由 `p.row` 包着，而主操作用的类名只打在「动作行」的按钮上。
  assert.match(cssBody, /p\.row\s*>\s*button\s*\{/, '缺少 p.row > button（入口行的次级外观）');
  assert.equal([...cssBody.matchAll(/p\.row\s*>\s*button[^{]*\{([^}]*)\}/g)]
    .some(([, body]) => /--btn-bg:\s*var\(--accent\)/.test(body)), false,
  '入口行不许声明重音底色（「设置（API Key）」每屏都挂着，点亮它等于每屏两个实心块）');
});

test('禁用态压过主操作重音：两条互为冗余的防线 + 一个真正的脆点', () => {
  // 背景（总控提出、我实测核对过）：`ready` 屏的「拍照」在 `storageFull()` 时会被禁用
  // （`action('拍照', onCapture, storageFull(), true)`）。如果禁用后它还是满血实心，
  // 用户会看到一个"看起来能点、点了没反应"的按钮——而这一档的 UX 口径是"停止派发新任务"。
  //
  // ⚠️ **实测结论：现在没有这个缺陷**（`tmp/probes/disabled-settled-check.mjs`）：
  // 给 `button.primary` 设 `disabled` 并**等 180ms 过渡结束**后，computed 背景
  // 浅色 `rgb(243,240,235)`（= `--surface-sunken`）、深色 `rgb(26,25,23)`，都不是重音。
  // 一开始量到"没变"是**测量假象**：`button` 基础规则有 `transition: background 180ms`，
  // 设完 `disabled` **立刻**读 `getComputedStyle` 拿到的是**过渡起点**（旧颜色）。
  // 这条坑值得留在注释里——它会让"禁用失效"这种缺陷看起来成立（也会让真缺陷看起来不成立）。
  //
  // ── 为什么禁用能压过重音（机制，别再按"顺序"想）────────────────────────────
  // `button.primary` 只设 `--btn-*` **变量**，不声明 `background` 本身；于是这颗按钮的
  // `background` 只由两条声明竞争：基础 `button`（0,0,1）与 `button:disabled`（0,1,1）。
  // **权重分胜负、与书写顺序无关** ⇒ `button:disabled` 的直接 `background` 赢。
  // 加上 `button.primary:disabled`（0,2,1）把变量也钉成沉底灰，两条**互为冗余**：
  // 删任一条外观都不变（测试两条都钉住，删任一条都会 RED——这是回归防线，不是冗余断言）。
  const baseDisabled = cssBlock('button:disabled');
  // ① 承重墙：基础禁用规则必须**直接声明 background**（不能只设变量）
  assert.match(baseDisabled, /(^|[;{\s])background(-color)?\s*:\s*var\(--surface-sunken\)/,
    'button:disabled 必须直接声明 background: var(--surface-sunken)'
    + '（只设 --btn-* 变量的话，主操作的 accent 会从基础 button 规则漏出来）');
  // ② 第二条独立防线：主操作的禁用态显式规则必须在，且把变量也钉成沉底灰
  assert.match(cssBlock('button\\.primary:disabled'), /--btn-bg:\s*var\(--surface-sunken\)/,
    'button.primary:disabled 必须把 --btn-bg 钉成 var(--surface-sunken)');
  // ③ 入口行的禁用态也要有（三类按钮的禁用外观必须一致）
  assert.match(cssBlock('p\\.row\\s*>\\s*button:disabled'), /--btn-bg:\s*var\(--surface-sunken\)/,
    'p.row > button:disabled 必须把 --btn-bg 钉成 var(--surface-sunken)');
  // ④ **真正的脆点**（这一条才是"别再让顺序说话"的正确写法）：
  //    `button.primary` 不许**直接**声明 `background`。现在它走变量，变量与
  //    `button:disabled` 直接声明的属性不冲突 ⇒ 顺序无关、禁用态稳。
  //    但若有人"顺手"把它写成 `button.primary { background: var(--accent) }`：
  //    那条是 0,1,1、与 `button:disabled` **同权重**，而 `.primary` 写在后面
  //    ⇒ **靠书写顺序赢** ⇒ 禁用按钮重新变成满血实心（真缺陷）。
  assert.equal(/(^|[;{\s])background(-color)?\s*:/.test(cssBlock('button\\.primary')), false,
    'button.primary 不许直接声明 background（必须走 --btn-* 变量；直接声明会与 button:disabled '
    + '同权重、靠书写顺序分胜负，禁用态就会随"谁写在后面"而静默失效）');
  // ⑤ 第二层保险（**不是机制本身**，如实说明）：`button:disabled` 必须写在 `button.primary` **之后**。
  //    机制是 ①+④（两者不争同一个属性 ⇒ 顺序无关；实测禁用后为沉底灰）。
  //    但把"禁用"写在后面，等于万一有人同时破坏了 ④（把重音写成直属性），
  //    顺序仍然站在"禁用"这一边。这是**与书写顺序绑定的冗余**，所以要用结构断言钉住它——
  //    否则有人把两块挪一下，这层保险会静默消失，而 ①④ 照样全绿（测不出来）。
  const iPrimary = cssBody.indexOf('button.primary {');
  const iDisabled = cssBody.indexOf('button:disabled {');
  assert.ok(iPrimary > -1 && iDisabled > -1, 'styles.css 缺少 button.primary 或 button:disabled 规则');
  assert.ok(iDisabled > iPrimary,
    'button:disabled 必须写在 button.primary 之后（同权重 0,1,1；这条顺序是"禁用压过重音"的第二层保险）');
});

test('深色模式由系统偏好驱动，且是暖黑而非纯黑', () => {
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(dark, '缺少 prefers-color-scheme: dark 分支');
  assert.equal(/#000000\b|#000\b/.test(dark[1]), false, '深色背景不许用纯黑（纯黑廉价且丢层次）');
  assert.match(dark[1], /--bg:\s*#/, '深色分支必须重定义 --bg');
});

// ── 下面四条来自「剩余档位」那一轮走查（TASK-…b3.54）：`word` / `composing` / `feedback`
// 等屏此前**没有截图证据**，走查台上的客观量暴露了三处真实回归入口。每条都做了变异校验
// （改坏 → RED → 恢复 → GREEN），两次输出见 `docs/ui-redesign/剩余档位验证-2026-09-17.md`。

test('候选按钮（.choices）是竖排一整列，不许被压成横排', () => {
  // 手选档一屏有 15 个候选词、整页高 1346px（390x844 实测）。改成 row 之后 15 颗按钮会挤成
  // 一条横向滚动的带子：既没有换行规则、也没有滚动容器，词会直接被切掉。
  const block = /\.choices\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'styles.css 缺少 .choices 规则');
  assert.match(block[1], /flex-direction:\s*column/, '.choices 必须是竖向一整列');
  assert.match(block[1], /gap:\s*var\(--s-2\)/, '.choices 的词间距必须走令牌');
});

test('候选按钮是"大一号的衬线块"，且触控区比普通按钮更高', () => {
  // 口径（设计 §"要学的英文词用系统衬线"）：候选词是本产品唯一的排版个性——衬线 + 1.25rem + 56px。
  // 三个值各有一条实测理由：衬线是身份/语义提示；1.25rem 让它在 15 个词里一眼可读；
  // 56px 比普通按钮的 44px 更宽裕（手选档是"全屏都是按钮"的一屏，误触代价高）。
  const btn = /\.choices\s*>\s*button\s*\{[^}]*\}/s.exec(css);
  assert.ok(btn, 'styles.css 缺少 `.choices > button` 规则');
  assert.match(btn[0], /--font-word/, '候选词必须用衬线字族令牌（--font-word）');
  assert.match(btn[0], /font-size:\s*1\.25rem/, '候选词字号必须是 1.25rem');
  assert.match(btn[0], /min-height:\s*56px/, '候选词触控高度必须是 56px（高于普通按钮的 44px）');
});

test('候选按钮是一组等权选项：既不是重音外观，也拿不到 .primary', () => {
  // 候选词（手选档那 15 颗）是**一组等权选项**，点亮其中一颗会凭空制造出一个并不存在的
  // "推荐词"。本轮改成显式 `.primary` 声明之后，这条防线有**两道**，两道都要钉住：
  //
  // ⚠️ 一条与脑算不符的实测事实（上一轮在浏览器里量出来的，别按直觉改这里）：
  //   候选词"看起来不亮"**不是**因为书写顺序赢了。实测：把 `.choices > button` 并进当时
  //   那条主操作选择器之后，候选按钮的 computed 背景**仍然是 rgb(255,255,255)**——
  //   `--btn-bg: var(--accent)` 被同权重、写在后面的中性声明覆盖了。
  //   所以"候选按钮自己声明中性外观"才是**视觉**防线；"它拿不到 `.primary` 类名"是
  //   另一道**结构性**防线（两道都留着，任何一道单独都不够）。
  //
  // 1. 视觉防线：候选按钮自己那套值必须是中性描边（--btn-bg 指到 --surface）
  const choices = cssBlock('\\.choices\\s*>\\s*button');
  assert.match(choices, /--btn-bg:\s*var\(--surface\)/, '候选词必须是中性描边外观（不许是重音）');
  assert.equal(/--btn-bg:\s*var\(--accent\)/.test(choices), false, '候选词不许自己被点亮');
  // 2. 结构防线（与第 1 条互相独立）：候选词按钮**不是** `action()` 造的
  //    （`case 'capturing'` 里手写 `doc.createElement('button')` + `list.append(b)`），
  //    所以它结构上**根本拿不到** `.primary` 这个类名——`action()` 是唯一打标记的地方。
  //    这里把"唯一性"钉住：`action()` 的调用点里不许出现候选词文案（否则说明有人把
  //    候选词改成走 action 造了，那道结构防线就没了）。
  //    ⚠️ 这条的杀伤力在**变异**上：真把候选按钮打上 primary 之后，
  //    第 4 条测试里"全站被标成主操作的调用点恰好是那六屏各一颗"会立刻 RED。
  const prim = primaryByLabel();
  for (const w of ['mug', 'cup', 'bottle', 'bowl', 'kettle', 'umbrella']) {
    assert.equal(prim.has(w), false, `候选词「${w}」不该出现在 action 调用点里（它必须由 .choices 自己造）`);
  }
  // 3. 候选词的容器仍是 `.choices`（竖排一整列，见下面那条测试），不是 `.row`
  assert.match(app, /list\.className = 'choices';/, '候选词容器必须仍是 .choices');  // 3. 入口行（「设置（API Key）」/「待补反馈（n 条）」）的次级外观也一并钉住：
  //    它们每屏都挂着，一旦被点亮就是"每屏两个实心块"。
  assert.match(cssBody, /p\.row\s*>\s*button\s*\{/, '缺少 p.row > button（入口行恒次级）');
  assert.equal([...cssBody.matchAll(/p\.row\s*>\s*button[^{]*\{([^}]*)\}/g)]
    .some(([, body]) => /--btn-bg:\s*var\(--accent\)/.test(body)), false, '入口行不许被点亮');
});

test('动作行的按钮可以换行，且不许被压窄成一条', () => {
  // 390px 下有两个真实的多按钮场景，都不许靠横向滚动解决：
  //   · 跟读屏 3 颗（听示范 90 + 我读过了 202 + 跳过跟读 106）→ 实测折成 2 行；
  //   · 设置屏 3 颗（保存 74 + 清除 Key 108 + 返回 151）→ 实测折成 2 行。
  // 而 `.row` 若没有 flex-wrap，它们要么被压扁要么直接溢出（实测两者都没发生）。
  const block = /\.row\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'styles.css 缺少 .row 规则');
  assert.match(block[1], /flex-wrap:\s*wrap/, '.row 必须允许换行（窄屏上多按钮不许溢出）');
  // 按钮的横向内边距走令牌：它决定"一颗按钮最窄能有多窄"，是换行点计算的一部分。
  // 实测最窄的一颗是 ready 屏的「拍照」= 74px（文字 34px + 2×20px padding）。
  const btn = /^button\s*\{([^}]*)\}/m.exec(css);
  assert.ok(btn, 'styles.css 缺少 button 规则');
  assert.match(btn[1], /padding:\s*0\s+var\(--s-5\)/, '按钮横向内边距必须走 --s-5 令牌');
  assert.match(btn[1], /min-height:\s*44px/, '按钮触控高度必须 ≥44px');
});

test('长串不许把页面撑宽：原句与造句框都显式声明了断行', () => {
  // 走查台实测：输入框/文本域在 390px 下都不撑宽页面（`document.documentElement.scrollWidth`
  // 恒为 390）。学习者的原句与造句都是**用户自己打的字**，里面有长英文单词
  // （"supercalifragilisticexpialidocious"）是常态，不是边角情形。
  // 删掉 `.pending-item` 那条会 RED：待补抽屉里一条超长原句就能把整页顶出横向滚动条。
  assert.match(cssBlock('\\.pending-item\\s*>\\s*p:first-child'), /overflow-wrap:\s*anywhere/,
    '待补原句必须能任意断行（它是用户逐字写下的句子，不许截断也不许撑宽页面）');
  // ── textarea 这一条是本轮新增的**口径变化**，说明为什么它现在可以是一条真断言 ──────
  // 上一轮这里写的是"**不许**断言 textarea 有 overflow-wrap"——当时的实测事实是
  // `styles.css` 里 `overflow-wrap` 只出现一次（待补原句那条），textarea 的
  // `break-word` 来自**浏览器 UA 默认样式表**。那时写这条断言就是个永远 RED 的假契约，
  // 而且会把"浏览器的行为"错当成"本产品的保证"。**本轮已把这行显式写进产品样式**（零风险清理 3），
  // 于是它从"借来的默认值"变成"我们的声明"——断言的对象随之变成产品自己的声明。
  // ⚠️ 别把它改回"只断言存在 textarea 规则块"：那样删掉这行也不会有人响，
  // 而在 Firefox/WebKit 上 UA 默认值未必相同（本机没装那两个引擎，未验）。
  const ta = cssBlock('textarea');      // 锚定行首：只命中那条独立规则，不吃 `input, textarea` 合写块
  assert.match(ta, /overflow-wrap:\s*break-word/,
    'textarea 必须显式声明 overflow-wrap: break-word（长串不撑宽页面不许靠浏览器默认值兜着）');
  // 反面：不许用 `overflow: hidden` 之类把长句**截掉**（用户看不见自己写的后半句）
  assert.equal(/(^|[^-])overflow:\s*(hidden|scroll|auto|clip)/.test(ta), false,
    'textarea 不许用 overflow: hidden/scroll 截断长句（截掉用户自己写的字比撑宽更坏）');
});

test('深色分支的 --bg 只声明一次（唯一一行死代码曾被下一行救回）', () => {
  // 曾经这里是两条：
  //     --bg: #16151300;   /* 8 位十六进制，alpha=00 ⇒ 全透明 */
  //     --bg: #161513;     /* 下一行立刻覆盖成不透明 */
  // 最终值是对的（实测 rgb(22,21,19)），所以**没有任何测试会响**——而真正的风险是
  // "将来有人删掉下面那行"：整个深色底会变全透明，用户看到浏览器白底，全站没有一条测试拦得住。
  // 断言"恰好声明一次"同时防住两种坏法：残留死代码、以及删掉那行（次数会变成 0）。
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(dark, '缺少 prefers-color-scheme: dark 分支');
  const bgDecls = [...dark[1].matchAll(/--bg:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(bgDecls.length, 1,
    `深色分支里 --bg 必须恰好声明一次（多条会互相覆盖，删错一条就是全透明底），实测 ${bgDecls.length} 次：${bgDecls.join(' | ')}`);
  // 8 位十六进制在这里必然意味着"带 alpha"，而深色底色不能透（会露出浏览器白底）
  assert.equal(/#[0-9a-fA-F]{8}\b/.test(dark[1]), false, '深色分支里不许出现 8 位十六进制颜色（带 alpha 会让底色透明）');
});

// ═══════════════════ 阶段 B（进度面）：DOM 标记 ↔ 样式规则的接线 ═══════════════════
//
// 这一组测的是**同一件事的两半**：`app.mjs` 造的标记（`.site` / `.word-name` / `.word-meta` /
// `.word-meta-due` / `.word-meta-gap` / `.word-due` / `.due-badge`）与 `styles.css` 里
// 给它们画的规则。只查样式侧的话，"CSS 写对了、app.mjs 忘了标记"这一类坏法**不会报错**
// ——首页会静默变回一排没有进度的药丸（阶段 B 要修的就是它）。
// 反过来只查 app.mjs 也一样：标记打对了、规则被删了，界面同样静默降级。
// 所以两边必须**在同一个文件里对账**（与上面 `word-title` / `primary` 那两条同一种做法）。
//
// 机制：全部走 `cssBlock`（那条助手要求"整条选择器列表精确相等"，所以它抓到的规则体
// 一定属于这个选择器，不会被合写块或前缀相同的另一条骗到）。

test('阶段 B 的进度面：标记与规则成对存在（少任何一半都是静默降级）', () => {
  // ── ① 生产者那一半：app.mjs 必须真的打出这几个标记 ─────────────────────────────
  // `bodyEl.className = 'site'`（页签视图的容器）——样式侧那几条 `.site > .word-list`
  // 全靠它；少了它，整列词会退回"一屏流式小药丸"，**没有任何测试会报错**。
  assert.match(app, /bodyEl\.className = 'site';/, 'app.mjs 必须给视图容器打上 site 类');
  assert.match(app, /name\.className = 'word-name';/, '词名那一格必须带 word-name');
  assert.match(app, /meta\.className = 'word-meta';/, '进度那一格必须带 word-meta');
  // 两种形态是**追加**在 word-meta 之后的（下面那条顺序断言也依赖这个写法）
  assert.match(app, /meta\.className \+= ' word-meta-due';/, '到期那一档的类名必须追加 word-meta-due');
  assert.match(app, /meta\.className \+= ' word-meta-gap';/, '夹缝那一档的类名必须追加 word-meta-gap');
  assert.match(app, /chip\.className = states\.includes\('due'\) \? 'word-chip word-due' : 'word-chip';/,
    '到期那一行的整行标记是 word-chip word-due');
  assert.match(app, /badge\.className = 'due-badge';/, '到期徽标必须带 due-badge');
  // ⚠️ 反面守卫：这一列的词**不是按钮**——用户点一个词不该发生任何事
  //（"点某个词直接进 word 屏"要动被冻结的状态机转移表，那是用户明确排除的范围）。
  // 判据取"这一族函数里有没有 createElement('button')"：加了一颗按钮就会 RED。
  const chipFn = /function wordChip\([\s\S]*?\n  \}/.exec(app);
  assert.ok(chipFn, 'app.mjs 里找不到 wordChip 函数（进度行的唯一生产者）');
  assert.equal(/createElement\('button'\)/.test(chipFn[0]), false,
    '进度行里不许造按钮（点词直接进 word 屏要动冻结的转移表，超出本阶段范围）');

  // ── ② 消费者那一半：每条标记都要有自己的规则，而且值走令牌 ────────────────────
  // 一列（不是一屏流式小药丸）：纵向 + 令牌间距
  const list = cssBlock('\\.site\\s*>\\s*\\.word-list');
  assert.match(list, /flex-direction:\s*column/, '.site > .word-list 必须是竖排一列（一行一个词）');
  assert.match(list, /gap:\s*var\(--s-2\)/, '.site > .word-list 的间距必须走令牌');
  // 一行：可换行 + 满宽 + 44px 触控/读行高
  const chip = cssBlock('\\.site\\s*>\\s*\\.word-list\\s*>\\s*\\.word-chip');
  assert.match(chip, /display:\s*flex/, '一条词行必须是 flex（词名与进度要能分列）');
  assert.match(chip, /flex-wrap:\s*wrap/, '一条词行必须允许换行（窄屏上词名+进度放不下时要折行）');
  assert.match(chip, /width:\s*100%/, '一条词行要占满整宽（它是一行，不是一颗药丸）');
  assert.match(chip, /min-height:\s*44px/, '一条词行的最小高度是 44px');
  // 词名：**衬线**（要学的英文词）+ 不小的一号
  const name = cssBlock('\\.site\\s*>\\s*\\.word-list\\s+\\.word-name');
  assert.match(name, /font-family:\s*var\(--font-word\)/, '词名必须用衬线字族（要学的英文词）');
  assert.match(name, /font-size:\s*1\.125rem/, '词名要比正文大一档（1.125rem）');
  assert.match(name, /min-width:\s*0/, '词名必须 min-width: 0（否则长词会把这一行顶宽）');
  // 进度：次级色 + 等宽数字位
  const meta = cssBlock('\\.site\\s*>\\s*\\.word-list\\s+\\.word-meta');
  assert.match(meta, /color:\s*var\(--ink-soft\)/, '进度那一段用次级文字色令牌');
  assert.match(meta, /font-variant-numeric:\s*tabular-nums/, '进度里的数字要等宽（上下几行才对得齐）');
  assert.match(meta, /font-size:\s*0\.8125rem/, '进度的字号比词名小一档');
  // 到期：整行重音 + 那一格重音字
  const dueRow = cssBlock('\\.site\\s*>\\s*\\.word-list\\s*>\\s*\\.word-chip\\.word-due');
  assert.match(dueRow, /background:\s*var\(--accent-wash\)/, '到期那一行要有浅青底（"需要你处理"的既有语汇）');
  assert.match(dueRow, /border-color:\s*var\(--accent\)/, '到期那一行要有重音描边');
  const dueMeta = cssBlock('\\.site\\s*>\\s*\\.word-list\\s+\\.word-meta-due');
  assert.match(dueMeta, /color:\s*var\(--accent\)/, '到期那一行的进度文字要走重音色');
  // 夹缝：告警色（它是"你自己的记录坏了"，不是"还没到期"）
  const gapMeta = cssBlock('\\.site\\s*>\\s*\\.word-list\\s+\\.word-meta-gap');
  assert.match(gapMeta, /color:\s*var\(--danger\)/, '夹缝记录要走告警色（那是一件需要处理的事）');
  // 徽标
  const badge = cssBlock('\\.due-badge');
  assert.match(badge, /background:\s*var\(--accent-wash\)/, '徽标要有浅青底');
  assert.match(badge, /color:\s*var\(--accent\)/, '徽标文字走重音色');
  assert.match(badge, /white-space:\s*nowrap/, '徽标不许被折成两行（三个字要在一格里）');

  // ── ③ 顺序：那两条覆写必须写在 `.word-meta` **之后** ──────────────────────────
  // 三者前缀相同、各多一个类 ⇒ **同权重**（0,3,0）⇒ 靠书写顺序分胜负。
  // 本文件的惯例是"权重分胜负"（见 `button:disabled` 那一大段），这里是有意破例的
  // 一处形态变体族——破例就要有断言兜着：把顺序改反，到期/夹缝两档会静默退回次级色
  //（界面不报错，只是"该复习"不再显眼）。
  const iMeta = cssBody.indexOf('.site > .word-list .word-meta {');
  const iDue = cssBody.indexOf('.site > .word-list .word-meta-due {');
  const iGap = cssBody.indexOf('.site > .word-list .word-meta-gap {');
  assert.ok(iMeta > -1 && iDue > -1 && iGap > -1,
    'styles.css 缺少 .word-meta / .word-meta-due / .word-meta-gap 三条规则之一');
  assert.ok(iDue > iMeta && iGap > iMeta,
    '.word-meta-due / .word-meta-gap 必须写在 .word-meta 之后（同权重，靠顺序取胜）');
});
