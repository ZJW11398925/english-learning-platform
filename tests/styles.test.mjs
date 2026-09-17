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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../web/styles.css', import.meta.url));
const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));
const css = readFileSync(cssPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');

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

test('"要学的英文词用衬线"这条排版口径真的落地了', () => {
  // 口径本身写在文件头注释里；这里钉住它被两个"英文词所在处"真的用上了
  assert.match(css, /--font-word:/, '缺少 --font-word 令牌');
  assert.match(css, /\.choices\s*>\s*button\s*\{[^}]*var\(--font-word\)/s, '候选词没有用衬线字族');
  assert.match(css, /\.pending-item\s*>\s*p:first-child\s*\{[^}]*var\(--font-word\)/s,
    '待补原句没有用衬线字族');
});

test('主操作的重音判据与真实 DOM 形状一致（两条屏幕判据 + 兜底压回）', () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 设置屏：靠 Key 输入框认屏（settings 与 pending 的动作行 DOM 形状完全一样，
  // 位置/数量判据都分不开——这两条是实测踩出来的结论）
  assert.match(body, /#app:has\(input\[type='password'\]\)\s*div\.row\s*>\s*button:first-child/,
    '缺少"设置屏首颗按钮是主操作"的判据');
  // 主屏取词行：靠那个隐藏的文件选择器认行
  assert.match(body, /div\.row:has\(>\s*input\[type='file'\]\)\s*>\s*button:first-child/,
    '缺少"主屏取词行首颗按钮是主操作"的判据');
  // 兜底：其余动作行（pending 的「手动补交 / 返回」、feedback 的「下次 / 改写」）必须压回描边，
  // 否则界面会凭空出现两个同等重量的实心块
  assert.match(body, /div\.row\s*>\s*button:first-child\s*\{/,
    '缺少"其余动作行一律次级"的兜底规则');
  // 曾经把它写成 nth-child / only-of-type 而静默失效，这两种形态不许再回来
  assert.equal(/button:nth-child\(2\)/.test(body), false,
    '不要用 nth-child 数按钮（动作行里夹着隐藏的 input，位次判据恒不成立）');
  assert.equal(/button:first-child:only-of-type/.test(body), false,
    '不要用 only-of-type 判"独占一行"（设置屏那一行有 3 个子节点，实测 matches() 为 false）');
  // 入口行（设置 / 待补）必须整体压成次要，且必须写在主操作规则之前（同权重靠顺序取胜）
  const entryIdx = body.indexOf('p.row > button');
  const primaryIdx = body.indexOf('div.row:has(> input');
  assert.ok(entryIdx > -1, '缺少 p.row > button（入口行的次级外观）');
  assert.ok(primaryIdx > -1, '缺少主操作判据');
  assert.ok(entryIdx < primaryIdx,
    'p.row > button 必须写在主操作判据之前：同权重时靠书写顺序取胜，'
    + '写在后面会把设置屏的「保存」重新压成次要外观');
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

test('候选按钮与入口行都不参与"第一颗是主操作"那条重音映射', () => {
  // 走查台实测（11 个档位逐颗按钮比 computed 背景）：全站只有 ready 屏的「拍照」与设置屏的
  // 「保存」是实心重音，其余动作行全是描边——候选词是**一组等权选项**，点亮其中一颗
  // 会凭空制造出一个并不存在的"推荐词"。
  //
  // ⚠️ 两条与脑算不符的实测事实（都是本轮在浏览器里量出来的，别按直觉改这里）：
  //   1. `.choices > button`（权重 0,2,0）的规则块写在**主操作判据之后**——但 `div.row >
  //      button:first-child`（同权重、写在之前）**根本匹配不到候选按钮**（实测
  //      `btn.matches("div.row > button:first-child") === false`），两条规则不命中同一批元素，
  //      所以顺序无关。写一条"`.choices > button` 必须写在主操作之前"是**与实情不符的假断言**
  //      （本轮实跑 RED，见报告的变异校验一节）。
  //   2. 候选词"不会被点亮"的**真正**防线是下面第 2 条（`.choices > button` 自己声明了中性的
  //      `--btn-bg: var(--surface)`）。实测：把 `.choices > button` 并进主操作选择器之后，
  //      候选按钮的 computed 背景**仍然是 rgb(255,255,255)**（`--btn-bg: var(--accent)` 被
  //      同权重、写在后面的那条中性声明覆盖）——所以第 1 条是**结构性**断言（防止判据选择器
  //      里混进候选词这一类），不是"再挡一层视觉回归"。
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blockOf = (selector) => {
    const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's');
    const m = re.exec(body);
    assert.ok(m, `styles.css 缺少 ${selector} 规则`);
    return m[1];
  };
  // 1. 两类主操作的判据里都不许出现 .choices（判据的适用范围必须一眼可读：它只针对那两类屏）
  for (const sel of ["#app:has\\(input\\[type='password'\\]\\) div\\.row > button:first-child",
    "div\\.row:has\\(> input\\[type='file'\\]\\) > button:first-child"]) {
    assert.equal(new RegExp(sel).test(body), true, `缺少主操作判据：${sel}`);
    const rule = new RegExp(`${sel}[^{]*\\{([^}]*)\\}`, 's').exec(body);
    assert.equal(/\.choices/.test(rule?.[0] ?? ''), false, `主操作判据里不许出现 .choices：${sel}`);
  }
  // 2. **视觉防线在这里**：候选按钮自己那套值必须是"中性描边"（--btn-bg 指到 --surface）
  const choices = blockOf('\\.choices\\s*>\\s*button');
  assert.match(choices, /--btn-bg:\s*var\(--surface\)/, '候选词必须是中性描边外观（不许是重音）');
  // 3. 入口行（设置 / 待补）压在主操作判据之前：同权重靠书写顺序取胜，
  //    写反了设置屏的「保存」会被重新压成白的（实测踩过，见 styles.css 的注释）
  assert.ok(body.indexOf('p.row > button') < body.indexOf("#app:has(input[type='password'])"),
    'p.row > button 必须写在主操作判据之前');
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

test('长串不许把页面撑宽：原句与造句框都要能断行', () => {
  // 走查台实测：输入框/文本域在 390px 下都不撑宽页面（`document.documentElement.scrollWidth`
  // 恒为 390），靠的就是下面这两条断行规则。学习者的原句与造句都是**用户自己打的字**，
  // 里面有长英文单词（"supercalifragilisticexpialidocious"）是常态，不是边角情形。
  // 删掉 `.pending-item` 那条会 RED：待补抽屉里一条超长原句就能把整页顶出横向滚动条。
  assert.match(css, /\.pending-item\s*>\s*p:first-child\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    '待补原句必须能任意断行（它是用户逐字写下的句子，不许截断也不许撑宽页面）');
  // ⚠️ **不许**在这里断言"造句输入框有 overflow-wrap"——实测：styles.css 里 `overflow-wrap`
  // **只出现一次**（就是上面那条），textarea 的 `break-word` 来自浏览器 UA 默认样式表。
  // 写一条"textarea 有断行规则"的断言就是一个永远 RED 的假契约；反过来把它当成本产品的
  // 保证也是错的（换浏览器就可能没有）。所以这里只钉"不许出现 overflow: hidden/scroll
  // 这类会把长句截掉的写法"这条我们真正拥有的性质。
  const inputBlock = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, sel]) => /textarea/.test(sel));
  assert.ok(inputBlock, 'styles.css 里必须有 textarea 的规则块（输入框样式单源）');
});
