/**
 * GitHub Pages 部署脚本（Task 12C）：把 `web/` 的内容发布到 `gh-pages` 分支的**根目录**。
 *
 * 零构建：`web/` 本身就是站点（静态 HTML + ES Modules），不需要任何打包步骤——
 * 本脚本只做三件事：
 *   1. `git subtree split --prefix=web`：从本分支历史里切出只含 `web/` 的提交链，
 *      其树根就是 `web/` 的内容（部署的分支当前是什么、工作树脏不脏都无所谓，
 *      **绝不改当前分支、绝不碰工作树**）；
 *   2. 本地自检：split 结果的树根必须含 `index.html`（缺它 = 部出去的是 404 站点，
 *      宁可停下也不推）；
 *   3. 推送到远端 `origin` 的 `gh-pages` 分支（split 是确定性的：同样的 web/ 历史切出
 *      同样的提交，所以重复跑要么"已是最新"要么只推增量——**幂等**）。
 *
 * 用法（在仓库根）：
 *   node scripts/deploy-pages.mjs                 # 正常部署
 *   node scripts/deploy-pages.mjs --force         # 远端 gh-pages 被别人改写（如首次开通
 *                                                 # Actions 自动建了分支）时强推覆盖
 *
 * 前置（一次性）：远端仓库已存在（`git remote add origin …`）；推送凭据可用
 * （`gh auth login` 或已配置的 git 凭证）。Pages 的开通在仓库设置里选
 * 「Deploy from a branch → gh-pages / (root)」，开通后线上地址即 README 里的那个。
 *
 * **不调任何 API、不发任何网络请求（除了 git 自己推代码）**：部署只搬 git 对象，
 * 模型调用永远发生在访问者的浏览器里。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.slice(2).includes('--force');
const BRANCH = 'gh-pages';

const say = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => {
  say(`！！${line}`);
  process.exitCode = 1;
};

/** git 子进程：同步、继承 stderr 的错误直通（失败时抛出，消息带命令原文）。 */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
  } catch (err) {
    throw new Error(`git ${args.join(' ')} 失败：${String(err?.stderr ?? err?.message ?? err).trim()}`);
  }
}

// ── 前置检查（缺什么就说什么，绝不假装部署过）──────────────────────────────────
if (!fs.existsSync(path.join(REPO, 'web', 'index.html'))) {
  fail('web/index.html 不存在——零构建部署的前提是 web/ 即站点，没有它就没东西可发。');
  process.exit(1);
}
let remoteUrl = '';
try {
  remoteUrl = git('remote', 'get-url', 'origin').trim();
} catch {
  fail('没有配置 origin 远端——先 git remote add origin <url>（一次性）。');
  process.exit(1);
}

// ── 1) subtree split：切出只含 web/ 的提交链（不改当前分支、不碰工作树）─────────
say(`=== GitHub Pages 部署（web/ → ${BRANCH} 根目录）===`);
say(`远端：${remoteUrl}`);
const currentBranch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
if (currentBranch === BRANCH) {
  fail(`当前分支就是 ${BRANCH}——本脚本不该在部署分支上运行（它会原样把部署历史再切一遍）。`);
  process.exit(1);
}
// gh-pages 是**本脚本生成的发布分支**，永远不在工作树上检出；split 是确定性的
// （同样的 web/ 历史切出同样的提交），所以先删掉旧的本地 ref 再重切既幂等又免去
// "branch already exists"的麻烦——工作树与其它分支一个字节都不动。
const localRefExists = (() => {
  try {
    git('show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`);
    return true;
  } catch {
    return false; // show-ref --quiet 对不存在的 ref 以非零码退出
  }
})();
if (localRefExists) {
  git('branch', '-D', BRANCH);
}
let splitTip = '';
try {
  splitTip = git('subtree', 'split', '--prefix=web', '-b', BRANCH).trim().split(/\r?\n/).at(-1);
} catch (err) {
  fail(String(err?.message ?? err));
  process.exit(1);
}
if (!/^[0-9a-f]{7,40}$/.test(splitTip)) {
  fail(`subtree split 没有给出提交号（得到：${JSON.stringify(splitTip)}）。`);
  process.exit(1);
}
say(`本地 ${BRANCH} 已切出：${splitTip}`);

// ── 2) 本地自检：split 结果的树根必须含 index.html ────────────────────────────
const rootFiles = git('ls-tree', '--name-only', splitTip).split(/\r?\n/).filter(Boolean);
if (!rootFiles.includes('index.html')) {
  fail(`split 结果的根目录不含 index.html（实际：${rootFiles.join(', ')}）——推出去就是 404 站点，停下。`);
  process.exit(1);
}
say(`自检通过：根目录含 index.html（共 ${rootFiles.length} 个顶层条目：${rootFiles.join(', ')}）`);

// ── 3) 推送（幂等：远端与本地一致时 git 自己会说 up-to-date）──────────────────
const remoteTip = (() => {
  try {
    return git('ls-remote', 'origin', BRANCH).trim().split(/\s+/)[0] ?? '';
  } catch (err) {
    fail(`连不上远端（ls-remote 失败）：${String(err?.message ?? err)}`);
    process.exit(1);
  }
})();

if (remoteTip === splitTip) {
  say(`远端 ${BRANCH} 已是 ${remoteTip}——无需推送（幂等重跑，什么都没发生）。`);
  say('完成。');
  process.exit(0);
}
if (remoteTip !== '' && !FORCE) {
  fail(`远端 ${BRANCH}（${remoteTip.slice(0, 12)}…）与本地 split 结果（${splitTip.slice(0, 12)}…）不一致且无法快进。`
    + '\n  若远端是别人/别的流程写过的旧站点，确认后用 --force 覆盖：node scripts/deploy-pages.mjs --force');
  process.exit(1);
}
try {
  git('push', ...(FORCE ? ['--force'] : []), 'origin', `${BRANCH}:${BRANCH}`);
} catch (err) {
  fail(String(err?.message ?? err));
  process.exit(1);
}
say(`已推送：${splitTip} → origin/${BRANCH}${remoteTip === '' ? '（首次部署：远端此前没有这个分支）' : `（覆盖 ${remoteTip.slice(0, 12)}…）`}`);
say('完成。Pages 开通（Deploy from a branch → gh-pages / root）后，站点即线上地址。');
