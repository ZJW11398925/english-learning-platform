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
