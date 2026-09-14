// tests/index-html.test.mjs
//
// 页面骨架的结构检查。Node 里没有 HTML 解析器（零依赖约定），所以这里做的是**结构性**检查，
// 不是浏览器能做的渲染验证——真机渲染见 task-6-report.md 的「待人工真机验证」。
//
// 最值钱的一条是"引用必须落地"：index.html 里 import 的 `./app.mjs`、`src`/`href` 指到的文件
// 若写错一个字母，浏览器里就是**静默白屏**（404 只在 Network 面板里看得见），而这正是
// "本地跑不起来、只有手机上才发现"的那类故障。这里把它变成一条会响的断言。
//
// 本文件**没有**接进 `scripts/mutation-probe.mjs` 的 TEST_FILES：探针的临时工作树只复制
// 模块与测试文件，不带 `web/index.html`，跑进来会因缺文件而假红。理由记在报告里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML_PATH = fileURLToPath(new URL('../web/index.html', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const html = readFileSync(HTML_PATH, 'utf8');

/** 去掉注释与 script/style 的内容：标签配平只关心标记结构。 */
const markupOnly = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '<script></script>')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '<style></style>');

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

test('index.html 是结构完整的 HTML：doctype、lang、标签配平', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN">/);

  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  for (let m = tagRe.exec(markupOnly(html)); m !== null; m = tagRe.exec(markupOnly(html))) {
    const [, closing, rawTag, , selfClosing] = m;
    const tag = rawTag.toLowerCase();
    if (VOID_TAGS.has(tag) || selfClosing === '/') continue;
    if (closing === '/') {
      const open = stack.pop();
      assert.equal(open, tag, `闭合标签 </${tag}> 与最近的开标签 <${open ?? '（空）'}> 不配对`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, [], `还有没闭合的标签：${stack.join(', ')}`);
});

test('移动端必需的三件套：charset / viewport(含 viewport-fit=cover) / 标题', () => {
  assert.match(html, /<meta charset="utf-8">/);
  const viewport = /<meta name="viewport" content="([^"]+)">/.exec(html);
  assert.ok(viewport, '缺少 viewport meta：手机上会按桌面宽度渲染');
  assert.match(viewport[1], /width=device-width/);
  assert.match(viewport[1], /initial-scale=1/);
  assert.match(viewport[1], /viewport-fit=cover/, '刘海屏要 viewport-fit=cover 才敢用 env(safe-area-inset-*)');
  assert.match(html, /<title>[^<]+<\/title>/);
});

test('恰好一个 #app 容器，且被 module 脚本挂载', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['app'], `页面上的 id 应只有 app，实测 ${ids.join(', ')}`);
  assert.match(html, /<script type="module">/);
  assert.match(html, /mount\(document\.getElementById\('app'\)\)/);
  assert.match(html, /\.catch\(/, '挂载失败必须打到控制台，不能白屏且无声');
});

test('页面引用的每个相对路径都真的存在（写错一个字母就是白屏）', () => {
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) refs.add(m[1]);
  for (const m of html.matchAll(/from\s+'([^']+)'/g)) refs.add(m[1]);
  assert.ok(refs.has('./app.mjs'), `index.html 必须 import ./app.mjs，实测引用：${[...refs].join(', ')}`);
  for (const ref of refs) {
    assert.equal(/^(https?:)?\/\//.test(ref), false,
      `不许引用外部资源（${ref}）：内网穿透的 HTTPS 下外站不可达会白屏`);
    assert.equal(ref.startsWith('#'), false, `页内锚点不参与检查：${ref}`);
    const target = new URL(ref, `file:///${WEB_DIR.replace(/\\/g, '/')}`);
    assert.ok(existsSync(fileURLToPath(target)), `引用的文件不存在：${ref}`);
  }
});
