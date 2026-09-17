# AGENTS.md — 英语学习平台（**2026-09-17 形态重写**：引导式英语学习对话）

## 项目一句话

**⚠️ 2026-09-17：产品形态已整体重写，下面是新形态。** 手机浏览器可用的**引导式英语学习对话**：学习者把自己的生活（或系统给的情境）说成英文，系统按「回忆叙述 / 角色扮演 / 情境猜词 / 扩展与升格」四种方法引导，逐层把他的表达说好（词语 → 句子 → 语法 → 故事 → 风格）；**全程引导推荐为主，不替学习者决定下一步**。目的是回答：成人愿不愿意每天花几分钟把自己的生活用英语说一遍。产品边界 EVOLUTIONARY_MVP（不变）。

> **旧形态（已废）**：拍照识物取词 → 跟读 → 造句 → 结构化反馈 → 跨场景复现，路线 `SCENE_FIRST`。用户 2026-09-17 当场否掉：**识物解决的不是用户的问题**（他知道那叫"马克杯"，难的是说不出英文），且**给答案会杀死学习**（学习发生在检索而非接收）。相机自中心退居次要。
> **注意**：下面「当前状态」里带 <sub>历史</sub> 标记的段落描述的是**旧形态的建成史**，仍有价值（资产清算、红线、验收记录都在里面），但**不再代表产品方向**。

## 当前状态（2026-09-17 形态重写；下方旧段落为第一版建成史）

- **🔴 形态重写（本轮，`DEC-OPI-968b804d-…db.56`）——已改契约，未写实施计划**：
  - **触发**：用户裁决「现有界面太过简陋；现在是重构之时，准备重新设计逻辑」→ 层级选**产品形态重做** → **全面重写契约与形态**。
  - **一次要写下来的认知修正**：我按 `SCENE_FIRST` 推出了一个**相机中心**的形态，被用户否掉。他的原话是判据：*「软件应当引导用户自己去看，自己去想，而不是一味借助相机识别。大多数时候，用户知道他看见的东西用中文怎么说，需要拍照识别的东西很少，而且那部分现有的产品预期做不到。重要的是英语学习本身，不是各种花里胡哨的假装 nb 的功能。」*
  - **另一件必须记下的事实**：`docs/superpowers/specs/2026-09-14-…-design.md`（第一版设计 spec）里**从来没有界面设计**——无屏幕清单、无信息架构、无导航形态、无版式、无视觉方向。1659 行实施计划对界面的全部投入 = Task 6 里 **6 行内联 `<style>`**。所谓「早期设计需要后续重构」，实际是**从来没有设计过**，界面是在实现里长出来的。全仓 `简陋`/`首版从简`/`设计稿` 各 **0 次命中**。
  - **权威设计稿**：`docs/superpowers/specs/2026-09-17-形态重做-教学引擎-design.md`（提交 `02502c8`；sha256 `878b8d16…`，**LF 归一口径**，已作为 ASSUMPTIONS 绑在契约载体上）。2026-09-14 那份的契约段（§1 目标 / §3.1 七态表 / §4.5 复现调度）**已被它逐段取代**（见契约载体的假设 2）。
  - **契约已重写**（`DEC-OPI-ecb3037d-…19`，`object_revision` 4→6）：GOAL / CORE_JOURNEY / IN_SCOPE / TECHNICAL_CONSTRAINTS 全部改写；NON_GOALS 从 3 条扩到 7 条；OUT_OF_SCOPE 从 4 条扩到 9 条；**新增 `COST_CONSTRAINTS`（本项目首次）**；**新增 `FUTURE_SCOPE`**（识物降级为"主动求助时的一条查询路径"，带重估条件）。
  - **`design_sync` REBUILD_DERIVED → CHECK = SYNCED，零告警**（rev 76，68 个对象）。
  - **新形态的要害（下会话先读这段）**：①中枢是**一次对话**，不是识物也不是翻卡；②**教学内容来自学习者自己的表达**，不是预设课程（这也是"不替用户规定世界"的落地）；③**引导纪律写死**：给选项不替决定 / 默认配合而非纠正 / 不审讯 / 不制造焦虑；④**提问方法是有库的**（九种，MVP 只做四种：回忆叙述 + 角色扮演 + 情境猜词 + 扩展与升格），且有**换挡判据**；⑤**框架约束是护城河**：提示词六槽位 + 行为约束四类，其中「焦点词泄漏 / 长度超档 / 评分词」三条**机械可校验 ⇒ 可写测试断言**（这是"提示词工程"在本项目第一次变成可验证工程）；⑥**复现改为对话内自然复现**，不再发"该复习了"。
  - **仍未决 / 下一步**：实施计划未写（writing-plans）；三个风险未摆平——**自带 Key 在对话形态下的成本结构未标定**、`NON_GOALS` 与"每日任务"形态的潜在撞车、**长期语料无账号（清浏览器数据即清空全部积累）**；另有一条最容易被低估的：**内容资产（词库/语法库/优化库）的正确性无人背书**，需内容审校流程。
- <sub>历史</sub>**「可推广应用形式」四阶段（`DEC-OPI-968b804d-…db.21`）**——A/A+ 已完成并上线，B 已完成并上线；**C（视觉）与 D（传播面）随形态重写作废**（C 被新形态的界面需求取代，D 与新形态一并重新考虑）：
  - **A 应用骨架**（`TASK-OPI-968b804d-…db.19`）—— **✅ 已完成**：应用栏 + 底部四页签（首页/学习/复习/设置），`viewFor` 的 338 行 switch 拆成「壳 + 视图」，**默认落在首页**。裸 `node --test` **528/0**。已提交 `f1624f3` 并推送（`gh-pages = c29a382`）。
  - **A+ 取词退出路径**（`TASK-OPI-968b804d-…db.23`，`DEC-…db.25`）—— **✅ 已完成**：总控复核时发现阶段 A 引入一个真陷阱（取词屏无退出口 + 切页签不关流 ⇒ 切回来面对死画面、无路可走）。已修：状态机加 `cancelCapture`（与 `frameBad` **严格分开**，不计数不记理由）、取景屏加「返回」= 主动放弃（**事件流一条不增**）、离开学习页 = 这次取词结束。**变异校验**：`cancelCapture`→`frameBad` 让新用例 RED。
  - **A 上线核验**——**✅ 已闭合（本轮补跑）**：上一轮因本机到 `github.com` / `*.github.io` 全部超时，只做了 git 侧核验（`DEC-…db.27` 如实登记"HTTP 层未验"）。本轮网络恢复，跑 `VAL-…db.32` → **`VR-…db.36` = PASS**：线上 22 个文件对 `origin/gh-pages` 树 **`mismatched_files = 0` / `http_failed_files = 0`**（口径 = HTTP 原始字节 → CRLF 归一为 LF → git blob SHA-1 → 与 `git ls-tree -r origin/gh-pages` 逐条比对；**不是** `.Content` 字符串比对，见红线 5）。**"Pages 正在服务新版"这一截现已为真。**
  - **B 进度面**（`TASK-OPI-968b804d-…db.38`；开工口径 `DEC-…db.42`；收尾裁决 `DEC-…db.49`）—— **✅ 已完成并核验**：首页从「一行 `已学 N 个词` + 一排**只有词名**的 chips」变成真进度面；复习页从「只报数」变成「清单 + 出口」。裸 `node --test` **543/0**（528 → +15）。接受 `VAL-…db.45` → **`VR-…db.47` = PASS**（7 项逐条）。
    - **B 已上线**（`VAL-…db.51` → **`VR-…db.53` = PASS**）：提交 `9695e25` → `node scripts/deploy-pages.mjs` **快进** `c29a382..720ace5`（非强推）→ 等 Pages 构建落地（`app.mjs` 的 `Last-Modified` 09:54:36 → **11:26:23 GMT**，本轮只等了约 1 分钟）→ 线上 **22 文件 `mismatched_files = 0`**。
    - **读数口径（本阶段最容易说谎的地方，复核过）**：①档位直接读记录里的 `stage` **原值**，界面显示「第 N 档」——**不**重算成"已完成 N 档"或 N/3（`units/scheduler.mjs` 是唯一权威；在界面里再算一遍等于给同一件事造第二个出处，两处一旦不一致就**静默谎报学习进度**；且与诊断页同口径）；②下次复习时间**直接读 `dueAt`**，绝不拿 `stage` 手推日期；③`dueAt` 缺失/`NaN` 的记录**不补默认值、不隐藏**，如实报「缺下次复习时间」并用告警色标出（那种记录正是 `scheduler.dueWords` 会静默略过的"无声夹缝"）；④首页到期卡与复习页清单**同一起源**（`dueList()` / `dueIds`），故总数与每行徽标不可能互相矛盾。
    - **用户当场裁决三条**（`DEC-…db.49`）：①首页大字入口**保留现状、不加 `.primary`**（理由：`primary` 的语义是"流程里推进那一步"，首页入口是**导航**，语义不同）；②首页「去学习」与「开始学习」**两颗都保留**（位置与时机不同：前者紧跟"今天该复习 N 个词"，后者是永远在的通用入口）；③**提交后上线**。
    - **登记但未改**：「第 N 档」的代价是"新词学完第一次显示第 1 档、而已完成 0 档"（要改成 N/3 需新裁决，且要连带改诊断页）；`--ink-faint` 2.93:1 仍未修。
    - **本阶段新增的核验工具**（`tmp/probes/`，名字不含 `test`）：`phase-b-review-check.mjs`（红线机械比对：文案字面量 / `primary` 调用点 / 事件类型 / `web/units/**` / 内联 style / 外部资源）、`phase-b-controller-browser-check.mjs`（真实浏览器 DOM 计数，**专证"非活动视图卸载"**）、`phase-b-mutation-check.mjs`（19 条变异）。三个都由总控**独立**跑过，不采信子代理报告数字。
  - **C 视觉再升级**（待做）：页签过渡、卡片入场、掌握度可视化、骨架加载态
  - **D 传播面**（**建议延后单独裁决**）：落地/引导页。⚠️ 与已定的「自带 Key」形态有真实张力——陌生人点进来第一件事是「你得自己弄个 DeepSeek API Key」，落地页能让它不难堪但改不了这个事实
  - **本次升级最关键的 recon 事实**：所有 mount 类测试用 `btn(root,'精确文案')` **按按钮文案匹配**，全仓 `querySelector` **0 次** ⇒ **DOM 结构可自由重组，但改任何按钮文案会弄红测试**。这条既是自由度也是护栏。
  - **红线（已写进任务书）**：只有 **mount 类**测试可改成「先导航再断言」；**单元类测试（state-machine/store/scheduler/pending/rounds/recognize/compose/feedback）一条不许改**（它们不碰 DOM）。**非活动视图必须卸载，不许 `display:none` 藏**（藏着会让 `btn(root,'拍照')` 在首页也找得到，且对屏幕阅读器是坏的）。

- **项目已转向（`DEC-…23`/`DEC-…26`）**：人工契约级验收（验证一/二/三，`VAL-…36/38/42/50`）**挂起不再调度**（保持 pending 如实呈现——它们绑定的旧设计假设已被用户推翻）。下一阶段 = **核心功能重构 + GitHub 公开部署**，三项形态已定：
  1. **部署 = GitHub Pages + 访问者自带 API Key**（localStorage 不入库；前端直连 api.deepseek.com，CORS 已实测放行）；**服务端代理（server/）退役**——Task 12 重构的主项
  2. **录音 = TTS 示范替代**（speechSynthesis 本地免费；SpeechRecognition 依赖退役，`aborted` 类平台限制不再影响主流程）
  3. **拍照 = 相册导入**（识物链路不变，输入源加相册选图）
  - 部署期契约断言（DEPLOYMENT/RUNTIME）已首次登记在 `DEC-…26` 载体上——runbook：漂移时 readiness 可查
- 执行层现状：**公测站点已上线**：`https://zjw11398925.github.io/english-learning-platform/`（GitHub Pages，gh-pages 分支根，实测 200）；仓库 `https://github.com/ZJW11398925/english-learning-platform`（公开，gh 已登录）。**Task 12A/12B/12C 全部完成并验收**（`VR-…6/15/20` 三连 PASS，裁决 `DEC-…d5d39b50.8/16/21`）：①浏览器直连 + Key 管理（localStorage `elp.apiKey`）；②相册导入 + TTS 示范替代跟读（SpeechRecognition 退役）；③server/ 整体退役 + `scripts/deploy-pages.mjs` 部署脚本 + README。测试基线 494/494，探针 155/155。
- **readiness 之谜已查清 = 结构性不可达（`DEC-…b3.10`，2026-09-17 会话）**：结论「不是找漏了入口」。证据链（读 `D:\MCP\apps\mcp-server` 源 + 实调）：①闸门行只能按**每个 FINDING 对象恰一行**铸造（`resolveHostGatePolicy`，main.ts:273-302 只遍历 `payload.kind==='FINDING'`），零 FINDING ⇒ 行空数组 ⇒ 域面既有 `READINESS_BASIS_INCOMPLETE`；②FINDING 只能由 `review_submit` 的 `finding_proposals` 物化（callToolDispatcher.ts:1272-1282）；③它要求一个**已存在的 ReviewPacket**，而铸造函数 `createHostReviewBasisPreparer`（review-basis.ts:170）在 src 全库**只有定义、零调用点**，`dmcp.host.review_basis_prepare` 无宿主接线（profile 只给 5 个 `DMCP_*` 变量）；④`review_prepare` 名字有欺骗性——本构建里是 **QUERY 纯读**（callToolDispatcher.ts:1052-1087），只按 id 找已存在的 REVIEW_REQUIREMENT，**不铸造**；实测 `review_prepare(ref=RRQ-OPI-probe-1)` → `OBJECT_NOT_FOUND`；⑤副证：canonical 里零 FINDING、零 REVIEW_REQUIREMENT。**故 `plan_build` 不是闸门铸造路径**（ENABLER 的 `gate_requirement_refs` 只**引用**闸门；真产源是 host 注入的 readiness policy bundle = 第六变量路线）。**处置：不伪造**（拒绝手改 canonical、拒绝拿 ACCEPTANCE/ASSUMPTIONS 冒充闸门）；RELEASE 推进路用等价口径（`DEC-…d5.21` 清单）。**解封路径（择一，需宿主/服务端侧动作）**：(a) 把已实现的 `createHostReviewBasisPreparer` 接到 LOCAL_RUNTIME；(b) 允许 `DMCP_READINESS_POLICY_FILE` 策略模板按**非 FINDING** 来源铸行（如 VAL 的 `REQUIRED_BEFORE_RELEASE` 时序——本工作区已有 12 个 VAL 可立即成行）。
- **公测前清单**（`DEC-…d5d39b50.21` 钉住）：①直连实弹探针跑一轮并标定超时——**已完成**（见下）；②无 Key 线上引导路径走查——**已完成**（`VAL-…b3.33` → `VR-…b3.35` = **PASS**，5/5 评分项；Playwright + Edge 无头移动仿真 390x844 直打线上，证据 `docs/evidence-2026-09-17/`）；③改 web/ 后手动 `node scripts/deploy-pages.mjs`（无 CI）——**本轮已实跑一次并修好脚本的误拦**（见下）；④本机 `.env` 建议手删（已无代码引用）——**已核实 `.env` 在 `.gitignore:8`、未被 git 跟踪**，且探针要用它，故保留。**四项全清。**
- **无 Key 走查结论（`VAL-…b3.33` PASS）**：首次访问者**不需要先撞墙**——ready 屏当场就给出完整引导段（为什么需要 Key / `platform.deepseek.com` 去哪拿 / `sk-` 形状 / 只存本机不上传 / 清浏览器数据会连 Key 一起删）；点「拍照」与「从相册选图」都被拦下并指向设置，且**状态保持 ready、未发起相机调用**（守卫先于能力）；设置屏含未配置声明 + 创建指引 + `sk-` 输入框 + 保存/清除/返回三键，可返回 ready。唯一控制台报错是 `favicon.ico` 404（装饰性）。**未覆盖**：桌面 Edge 的移动仿真**非真机**，触屏与软键盘未测。
- **⚠️ HUMAN_RUBRIC 出不了机读 verdict（`DEC-…b3.36`）**：本运行时 `validation_submit` 对 `criterion.type = HUMAN_RUBRIC` 以 `VALIDATION_REQUIREMENT_INVALID`（「only METRIC_COMPARATOR criteria are evaluable at attestation depth」）诚实拒绝——`validation_define` 会接受、submit 不认。**以后要机读 verdict 的验收一律写成 `METRIC_COMPARATOR`**（把评分表转成 `rubric_items_passed == N`），评分项全文写进 proposition/measurements 保留语义。**未定性为缺陷**（无法区分「刻意信任边界」与「实现缺口」，只登记不报缺陷）。
- **界面已重做（`DEC-…b3.44`，rev 53）**：从「浏览器默认外观」改成有设计系统的界面。**样式单源 = `web/styles.css`**（`index.html` 里已无内联 `<style>`，有测试钉住不许回流），**`app.mjs` 一行未改**（DOM 契约零改动，494 个既有测试的语义未动）。口径：安静的效率工具 + 一个暖调重音；颜色/圆角/间距/时长全部令牌化（组件规则不许写死颜色）；暖纸 `#faf8f5` / 暖黑 `#161513`；单一深青重音 `#0f766e`；**要学的英文词用系统衬线、中文界面用系统无衬线**（零外部字体，因为零外部资源是硬约束）；深色模式走系统偏好。
  - **动 UI 前先看这里**：① `web/gallery.html` 是**界面走查台**（注入假依赖 + 把生产那份 app.mjs 挂起来，`?scenario=ready|ready-due|pending|pending-empty|settings|capturing|capturing-manual|word|reading|composing|feedback|done`，`?key=unset` 看不配 Key 那一屏；带 `ARRIVED` 判据，截图不会截到过渡态）；起服务：`node tmp/serve-web.mjs 4189`；驱动脚本在 `tmp/probes/` 与 `tmp/gallery-shots.mjs`。② `tests/styles.test.mjs` **15** 条样式契约（已做变异校验）。③ 改 web/ 后别忘了重新部署。
  - **主操作重音 = 显式 `.primary` 类名**（`DEC-OPI-968b804d-…db.6` 的人裁决，已修已验）。历史：位置/数量判据**四次实测全败**（`nth-child`——动作行里夹着隐藏 input；`only-of-type`——"保存独占一行"实为 3 个子节点；`.muted 祖先`——实为普通 div；两条 `:has()` 屏幕判据）。根因是 `settings` 与 `pending` 的动作行 DOM 形状**完全一样**（同为 `#app > div > div.row`），纯 CSS 原理上分不开。现在由 `app.mjs` 的 `action(label, onClick, disabled, primary)` **显式声明**，`styles.css` 只认类名。**有主操作的六屏**：ready / settings / capturing / word / composing / reading；**`pending` 与 `feedback` 一颗都没有**（对等选项）。`nth-child` 与 `only-of-type` 仍被测试禁止回归。
  - **`word` 屏要学的词用衬线**（同一个裁决）：`app.mjs` 的 `title(t, cls)` 给它打 `word-title`，`styles.css` 用 `--font-word` + 2rem。**中文标题保持无衬线**（不许把 `--font-word` 挂到通用 `h2`）。
  - **禁用态与过渡**：`button:disabled`（权重 0,1,1）压过 `.primary`（设变量）——**权重分胜负、与书写顺序无关**；另有 `button.primary:disabled` 作第二层保险。⚠️ 量禁用态 computed 值**必须等过渡结束**（基础 `button` 有 `transition: background 180ms`，立刻读拿到的是动画起点）——见红线 8/9。
  - 验证：`node --test` **511/0**（**17** 条样式断言，8/8 变异体全 RED）；截图证据 `docs/ui-redesign/`（`primary-*.png` + 11 档 `state-*.png`）。**仍未验**：Firefox / WebKit（本机没装）、真机（触屏热区 / 软键盘 / 真视频流）、`:hover`/`:disabled`/`::placeholder` 状态色的 WCAG 比值、`pending-empty` 无 `ARRIVED` 判据、`reading` 的 `ttsOk===false` 分支不标 primary 是**判断不是实测**。
  - **`--ink-faint` 浅色对比度 2.93:1 仍未修**（人裁决只清零风险三项）——在册未消。
  - **已上线**（`VAL-…b3.51` → `VR-…b3.53` = **PASS**）：`node scripts/deploy-pages.mjs` 快进 `e982789..83d827d`（非强推），线上 22 文件在 LF 归一字节口径下 **0 不一致**，首页已引用 `styles.css` 且无内联 `<style>`。⚠️ 部署后 **GitHub Pages 构建 + CDN** 需要几分钟：期间新文件会 404、首页 `Last-Modified` 还是上一次的（本次等了约 7 分钟）。
- **实弹标定已完成（`DEC-…b3.7`，2026-09-17，5 次真实计费调用全 200、零超时）**：识物腿 `latencyMs=1860.4ms`（返 mug 0.95 / cup 0.4）；造句反馈腿端到端 1718/1291/1681/1683 ms，usage 完整，`validateFeedback` 四条全过；另 1 次零计费空句 `status=pending reason=empty_sentence`（一次请求都没发）。**结论：三条常量原样保留**（`RECOGNIZE_REQUEST_TIMEOUT_MS=12000` / `FEEDBACK_REQUEST_TIMEOUT_MS=24000` / `PLAY_WORD_TIMEOUT_MS=15000`，余量 6.5x/14x/8.9x），不收紧（本机有线≠弱网，假超时比多等更坏）也不抬高（无弱网证据）。**真实瓶颈已定位不在网络而在模型侧 reasoning token 生成**（completion 144-239，其中 reasoning 100-177）。上传腿有界：相机/相册同口径先缩后编（长边 512 / JPEG 0.8），base64 后约 40-80KB，对 32MiB 上限有 3 个数量级余量。**如实登记两处未验**：`uncertain` 一档本轮 4 条语料 **0 次命中**（探针如实报不一致）；`--degenerate` 三条退化语料**未跑**（3 次计费调用，未授权）。
- **线上已与仓库对齐（`VAL-…b3.13` 二次跑 `VR-…b3.38` = PASS）**：首跑 `VR-…b3.17` = **FAIL**（19 文件中 3 处不一致，**全部只在注释**——线上仍在注释里点名已退役的 `server/*-upstream.mjs`，HEAD 已改为「旧服务端代理（已退役）」，可执行代码逐字节一致、功能性漂移 = 0；线上落后 HEAD 恰 1 个提交）。已按 `DEC-…b3.19` 跑 `node scripts/deploy-pages.mjs` 把 gh-pages 从 `f9d73d4` **快进**到 `e982789`，复跑得 **mismatched_files=0 / in-sync=19/19**。
  - **部署脚本已修**（`scripts/deploy-pages.mjs`）：原逻辑只要远端 SHA ≠ split SHA 就报「不一致且无法快进」并要人 `--force`，但它**从不检查祖先关系**——而 split 是确定性的，远端是本地结果的祖先时本应是一次普通快进（`--force` 反而会丢掉远端那个祖先提交，把增量部署变成历史改写）。现改为先问 `merge-base --is-ancestor`，只有真分叉才拦。首次触发场景：上一次部署后又有只改注释的提交（`e476063`）没发上去。
  - ⚠️ **CDN 缓存会造成假阴性**：推送成功后线上最长 **10 分钟**（`Cache-Control: max-age=600`）仍服务旧内容，此时比对会假报 MISMATCH。
  - ⚠️ **复验判据已更正（2026-09-17 第二次部署实测）**：**看响应的 `Last-Modified`**——它仍是上一次部署的时间 ⇒ GitHub Pages 构建**尚未完成**，此时等多久读都是旧的。**`?cb=<随机>` 这个 cache-buster 不可靠**：上一轮它在"边缘 CDN 陈旧"时有效，这一轮在"构建未完成"时**无效**（带 cb 仍返回旧 CSS，且 `x-origin-cache` 为空、`Age` 很小）。**正确姿势：先看 `Last-Modified` 是否已更新，再谈内容比对**；不要靠加随机 query 硬闯。
  - **第二次部署记录**（界面修复上线）：gh-pages `83d827d..f1d3350` 快进（非强推）；构建落地后复验 **mismatched_files=0 / in-sync=22**，且线上 `styles.css` 实测含 `button.primary` / `word-title` / `textarea overflow-wrap`、深色 `16151300` 死代码已清。
- **文档摘要核验必须先归一（`DEC-…b3.24`）**：`DEC-…d5.5` 登记的三份文档摘要**按「工作树 LF 归一后的字节」计算**，**不是**盘上原始字节、也不是 git blob。核验证明：LF 归一口径下三个摘要**逐位相等（零漂移）**；用原始字节算则 CRLF 的两份会假报 DRIFT（spec 是 LF 文件故两种口径同值）。**以后复验一律先 `-replace "`r`n","`n"` 再 sha256**，否则会重踩本轮踩过的假漂移。
- Task 1–10 + Task 9B：代码资产仍在（551/551 绿，`6758e44`）；分支 `feat/first-value-slice`，master 停在计划提交
- **Task 11 契约级验收 = 挂起**（`docs/真机验证清单.md` 57 步清单与两份实验方案保留在册，重构后若重启验证可复用）
- **预验收冒烟轮已完成**（`docs/预验收冒烟报告-2026-09-15.md`，决策 `DEC-OPI-5c134c67-9bdd-46d2-b9bc-7d51bfde8585.10`）：电脑侧步骤（1/2A/27/28）+ 导出链路干跑（54–57 命令格式）全部通过。**本机模拟器不可行**（固件 VT-x 关闭，硬门槛；软件模式 5 组参数全部崩溃）；**真机路线 = USB 真机 + `adb reverse tcp:8787 tcp:8787`**（localhost 即安全上下文，getUserMedia 免证书），android 插件按 serial 驱动可半自动跑清单 4–53 步。JDK 17 + Android SDK 已装在 `D:\android-sdk`，换 VT-x 可用机器即可起模拟器。
- **真机实弹已跑两轮**（决策 `DEC-…13`/`DEC-…15`/`DEC-…21`，摘要副本 `tmp/实机测试-2026-09-15/`）：识物/帧质检/降级/造句判定/uncertain/pending 队列/**复现（识物命中 + 档位推进）**全部真机验证合格。真机缺陷**跟读引擎报错不可见且不落流**已修复（`git:6758e44`，验收 `VAL-…17`/`VR-…19` PASS）。**修复后回读错误码 = aborted**（`DEC-…21`：平台中断识别器）——该设备自动跟读判定不可用且网页侧无法修复；此事实直接推动了转向中的「TTS 示范替代」决策。
- 详细台账（在册对象全集、逐任务证据、Minor 发现累积）：`.superpowers/sdd/progress.md`

## 常用命令

```bash
node --test                              # 全量测试（裸命令；node --test tests/ 在 Windows 上必红）
cp .env.example .env                     # 首次配置
node --env-file=.env server/index.mjs    # 启动服务（禁止把 .env 解析写进 loadEnv）
node scripts/export.mjs                  # 数据导出与判据统计（三轮聚合留在 rounds.mjs / 验证协议层）
node scripts/mutation-probe.mjs          # 变异探针（跑前先冻住工作树，见红线 2）
```

## 工作红线（实施期教训沉淀，细节见台账「环境教训」段）

0. **总控不亲自执行（`DEC-…b3.56`，流程违规的纠正）**：按「持续开发工作流（总控模式）」，主对话是**总控**（评审/核验/决策/布置），**执行交给新上下文子代理并携带自足任务书**。**开工前置步骤：任何执行类工作（写代码/写测试/跑探针/部署）先 `task_build` 铸任务书，再委派**——`task_build` 没有任何强制力（不存在"没 TASK 就不许改代码"的闸门），这条完全靠自律，所以必须显式做。**代价是真实的**：亲自执行会把执行噪声灌进总控上下文，直接侵蚀后续的评审与核验能力；且没有任务书的工作只能由自己的断言佐证、无法被独立复核。（2026-09-17 界面重做那一轮整个违反了这条——产物保留、流程认错，见 `DEC-…b3.56`。）
1. **变异测试必须带基线护栏**：重定向后原实现必须全绿，否则"脚本坏了"会被误读成"测试有效"。本环境禁止 piped 子进程 stdio，`process.exitCode` 须读 `exit` 事件。
2. **跑探针前冻住工作树**：包括自己在内不写仓库内任何文件（报告、清单、注释都算），跑完再改——探针的仓库完整性校验在并发写入下会假 FAIL。
3. **一轮只落一条结论事件**：不开新事件类型（`recognize_ok` 的 `latencyMs` 是字段不是新事件）。
4. **服务端没给的数不发明**：缺键不写 0——0 是"合法且极好"的读数，会盖住真凶。
5. **比对线上文件必须 LF 归一 + 字节级**（踩过两次，方法错不是部署错）：① 别用 `Invoke-WebRequest` 的 `.Content` 做字符串比对——PowerShell 会把 UTF-8 当 GBK 解，往返即损坏，曾让 `favicon.svg` 假报 MISMATCH（实际两侧都是 691 字节、SHA-256 逐位相等）；② 本地 checkout 是 CRLF、git 存 LF，**纯字节比对会让 17 个文本文件假报 MISMATCH**。正确尺子：**先做 CRLF→LF 归一再算 sha256**（`DEC-…b3.13` 已定的口径）。
6. **`tmp/` 里不许放 `*test*` 命名的脚本**：裸 `node --test` **递归扫 `tmp/`** 并把这类文件当测试跑——`tmp/probes/cascade-test.mjs`（需要 4189 上的 dev server 的开发探针）曾在服务器关闭时把整条基线弄红。开发探针一律放 **`tmp/probes/`** 且用 `-check` / `-probe` / `-shots` 这类**不含 `test`** 的名字。
7. **"全绿"必须用文档里那条命令实测**：本轮子代理用别的方式跑出 510/0，而真实的裸 `node --test` 是 **509/1**（含那个被误收的开发探针）。数字对不上时要查**口径**而不是信报告。推论：**任务书要点名"用哪条命令验、期望几个数"**——`TASK-…b3.54` 只写了"failing 必须是 0"，没钉命令，才有了这次口径分歧。
8. **评审侧：判定"缺陷"前必须先确认现象在运行时真的存在**（本轮总控连错三次，全是被自己的"读"骗了）：① 说"写了断言没写实现" —— 实际实现早就在，是**子代理自己的测试助手抓错了 CSS 规则块**；② 说"把「下次 / 改写」带进了注释" —— 该文件里这两个词**出现 0 次**；③ 说"禁用的主操作仍是实心" —— 实测是**过渡起点**（基础 `button` 有 `transition: background 180ms`，设完 `disabled` 立刻读 computed 拿到的是动画起始值，等 600ms 才是 `--surface-sunken`）。三次都是**先断言、后查证**（第 3 次甚至量了，但没算状态转换）。**规则**：声称缺陷前先问"我这个观察有没有更朴素的解释"（编码问题？命名撞车？过渡/动画期间读数？选中了另一个元素？），并且**优先信对方能在浏览器里复现的那一面**。
9. **改带过渡的属性后量 computed 值，必须等过渡结束**（`transition-property` 实测为 `background, border-color, color, transform`，`transitionDuration` 0.18s）；量完顺手确认 `transitionProperty` 里有没有你要量的那个属性——本轮就是因为没看这一条，把动画起点当成了终值。
10. **部署前必须先 commit**（本轮新踩）：`scripts/deploy-pages.mjs` 用 `git subtree split`，它**只切已提交历史**。web/ 改动留在工作区未提交时，它会报「远端已是 …——无需推送（幂等重跑，什么都没发生）」——**看起来像成功，其实一个字节都没发**。正确顺序：`git add -A && git commit` → `node scripts/deploy-pages.mjs`。与红线 7 同一族：**"工具报的成功"不等于"事情发生了"**。
11. **本机到 github 的边缘路径会不通，别把它误判成部署失败**（本轮实测）：某一时段 `https://github.com` 与 `https://*.github.io` **全部超时**，而 `https://api.github.com`、`https://www.bing.com` 正常、`git ls-remote` 也通。此时**上线核验降级为 git 侧**：用 `git ls-remote` 确认 `origin/gh-pages` 的 SHA、用 `git show origin/gh-pages:<file>` 直接查远端树内容——这两条不依赖 HTTP，足以证明"推送与内容为真"，但**证明不了"Pages 正在服务新版"**（那一截要 HTTP）。核验口径要如实分开写。
12. **解析 JS 调用点别用朴素正则**（阶段 B 总控复核时新踩）：我写的复核探针用正则解析 `action(...)` 的第 4 个实参，被 `action('拍照', onCapture, storageFull(), true)` 打败——第 3 个实参 `storageFull()` **自带括号与逗号**，正则把它当成了参数结尾 ⇒ 探针报「只有 5 个 primary」，而真实的六屏表是 6 个。**这是探针 bug，不是仓库缺陷**（红线 8 的又一次应验：先问有没有更朴素的解释）。正确做法 = 逐字符扫描、**只按顶层逗号切分**（`tests/styles.test.mjs` 的 `actionCallSites()` 就是范本，照抄它）。同类陷阱：`tmp/` 下自己写的探针也会被自己误信，**探针本身也要有自检**（如"命中必须恰好 1 次"）。
13. **探针的断言要和方法的作用域对齐**（阶段 B 同轮）：同一个浏览器探针在 `home-due` 档全绿，拿到 `pending` 档却报 5 条 FAIL——因为 `pending` 是**浮在页签之上的抽屉**，此时 `#app` 里根本没有首页那一屏，而我的断言是按主页写的。**判据是"探针用错了档位"，不是"实现坏了"**。写跨档位探针时要么参数化断言，要么先确认该档位下 DOM 的预期形状。顺带：那一跑仍产出了有效结论（抽屉内 `.word-list`/`.word-chip` 均为 0 ⇒ `.site` 作用域对抽屉零影响）。

## dmcp 段（跨会话续接第一入口）

- **workspace_id**：`ws-db58afd2-145c-4e81-9a7b-b562d8679071`（**带 `ws-` 前缀**；对象 id 里的 `OPI-ecb3037d-…` 是 project id，拿它当 workspace 用会 `WORKSPACE_NOT_FOUND`）
- **最新一轮（2026-09-17 会话，rev 43→57）**：
  - `DEC-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.7` —— 实弹探针跑通 + 超时标定（**结论：三条常量原样保留**）
  - `DEC-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.10` —— readiness **结构性不可达**根因 + 两条解封路径（**下会话若要碰 readiness 先读这条**）
  - `VAL-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.13` —— 线上/仓库一致性断言：首跑 `VR-…b3.17` = **FAIL**（3 处注释级落后），部署后二跑 `VR-…b3.38` = **PASS**（0/19 不一致）；`DEC-…b3.19` 定 `REDEPLOY_TO_SYNC`
  - `VAL-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.33` —— 无 Key 引导路径（`VR-…b3.35` = **PASS**，5/5）；`DEC-…b3.36` 登记 HUMAN_RUBRIC 出不了机读 verdict 这条能力边界
  - `DEC-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.24` —— 文档摘要**零漂移**确认 + 归一约定（防假漂移）
  - `DEC-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.40` —— 部署脚本误拦快进的真缺陷（已修已验）
  - **`DEC-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.44` —— 界面重做口径**（令牌化样式单源 + 走查台；`VAL-…b3.46` → `VR-…b3.48` = **PASS**，504/504）
  - `VAL-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.51` —— 界面重做**上线核验**（`VR-…b3.53` = **PASS**，线上 22 文件 0 不一致）
  - **`DEC-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.56` —— 流程违规的纠正**（总控亲自执行了开发；见红线 0）+ 任务书 **`TASK-OPI-5a247eb9-6816-4e78-b80f-1c5eeff7ceb3.54`**（剩余档位补验，已委派子代理）
  - `DEC-OPI-968b804d-af33-437d-be9b-277ecead51db.1` —— 补验交付的裁决：**产物接受、测试数字口径纠正**（它报 510/0，文档那条命令实测 509/1）+ 探针命名污染的根因与修法
  - **`DEC-OPI-968b804d-af33-437d-be9b-277ecead51db.6` —— 两条「重要」的人裁决**：①`word` 屏要学的词真的用衬线；②主操作改成**显式类名 `primary`**，废掉那两条 `:has()` 猜屏判据（代价：突破 `DEC-…b3.44` 的「DOM 零改动」——`app.mjs` 只加类名/标记，不改文案不改交互）；③轻微项只清零风险的三个，**`--ink-faint` 对比度 2.93:1 未修（已登记）**。任务书 `TASK-OPI-968b804d-…db.3` 已委派执行
  - `VAL-OPI-968b804d-af33-437d-be9b-277ecead51db.8` —— 上述修复的验收（`VR-…db.10` = **PASS**，511/0，六屏各恰一颗 primary、pending/feedback 零点亮）
  - `VAL-OPI-968b804d-af33-437d-be9b-277ecead51db.14` —— **上线核验**（`VR-…db.16` = **PASS**，线上 22 文件 0 不一致，`button.primary` / `word-title` / `overflow-wrap` 实测在线）
  - 本轮代码改动：`scripts/deploy-pages.mjs`（修快进误拦）+ `web/styles.css` / `web/app.mjs`（界面重做，**第一轮 DOM 零改动；第二轮按人裁决加了 `word-title` / `primary` 两个类名**）/ `web/gallery.html` / `web/favicon.svg` / `web/index.html` / `tests/styles.test.mjs`
- **最新一轮（2026-09-17 续会话，rev 57→72）——「可推广应用形式」四阶段里的 A/ A+/ B**：
  - `TASK-OPI-968b804d-…db.19` / `…db.23` —— 阶段 A（骨架）与 A+（取词退出路径）任务书；`DEC-…db.25` 定 `FIX_TRAP_NOW`
  - `VAL-OPI-968b804d-…db.32` → **`VR-…db.36` = PASS** —— **A 的线上核验补跑**（22 文件 `mismatched_files=0`），把 `DEC-…db.27` 里如实登记的"HTTP 层未验"这一截**闭合**
  - `TASK-OPI-968b804d-…db.38` —— **阶段 B（进度面）任务书**（goal/why/scope/forbidden_changes/acceptance 齐全，委派给新上下文子代理）
  - `DEC-OPI-968b804d-…db.42` —— 阶段 B 开工口径：复习页 = **清单 + 出口**（`LIST_AND_EXIT_ONLY`，复用同一条识物链路，不动冻结的转移表）
  - `VAL-OPI-968b804d-…db.45` → **`VR-…db.47` = PASS** —— **阶段 B 验收**（7 项逐条：543/0、文案未删、primary 仍 6、事件类型/units 未动、无内联 style、浏览器证卸载、19 条变异独立复现）
  - **`DEC-OPI-968b804d-…db.49` —— 阶段 B 收尾三条人裁决**（①首页入口不加 `.primary`；②两颗出口都保留；③提交后上线）
  - `VAL-OPI-968b804d-…db.32/45` 的**方法**都写进了 `measurements`（口径可复算，不只存结论）
- **最新一轮（2026-09-17 续会话，rev 73→76）——形态重写（W4 转向）**：
  - **`DEC-OPI-968b804d-…db.56`** —— **形态转向决策**：相机中心 → 教学引擎。`reason` 里写全了三层根因（识物解决的不是用户的问题 / 给答案杀死学习 / 相机中心与"生活化"是两件事）与用户原话判据；未选另两条（`VISUAL_POLISH_ONLY` 被用户当场否掉、`VALIDATE_CURRENT_FIRST` 因存量数据为零不成立）
  - **契约已重写**（载体仍是 `DEC-OPI-ecb3037d-…19`，`object_revision` 4→6）：
    - GOAL / CORE_JOURNEY / IN_SCOPE / TECHNICAL_CONSTRAINTS → **PROPOSE 强度**（新断言，用户批准的是设计稿方向，不是逐条措辞——故**不冒充 CONFIRM**）
    - NON_GOALS 3→7 条、OUT_OF_SCOPE 4→9 条（前几条仍是用户原确认的，保留 CONFIRM）
    - **新增 `COST_CONSTRAINTS`**（本项目首次）：自带 Key 在对话形态下的调用上限与成本告知
    - **新增 `FUTURE_SCOPE`**：识物降级为"主动求助时的一条查询路径"，**带重估条件**（不删能力，但退出主线）
    - **ASSUMPTIONS 首次挂上契约载体**：①新设计稿 sha256（LF 归一口径）②**声明 2026-09-14 设计 spec 的契约段已被逐段取代**（不是漂移：文档没变，只是不再权威）③新 GOAL 三条命题无任何证据 ④内容资产正确性无人背书 ⑤自带 Key 成本结构未标定
  - 设计稿：`docs/superpowers/specs/2026-09-17-形态重做-教学引擎-design.md`（`6dbfc69` 初稿 → `02502c8` 补齐三处薄弱环节；**258 行，已自审**）
  - **下会话续接第一件事**：读契约载体（尤其 ASSUMPTIONS 那 5 条）→ 读设计稿 §1/§2/§3.4/§3.6 → 若实施计划已写则按 RED-GREEN 执行
- **契约载体**（GOAL / IN_SCOPE / OUT_OF_SCOPE / 约束 / CORE_JOURNEY）：`DEC-OPI-ecb3037d-1a56-46d3-b931-4d482dcc668f.19`
- **文档绑定决策**（三份治理文档的 SHA-256 登记在其 ASSUMPTIONS 断言里；文档变更后 digest 不匹配即漂移证据）：`DEC-OPI-5c134c67-9bdd-46d2-b9bc-7d51bfde8585.5`
  - 覆盖：设计 spec（`docs/superpowers/specs/2026-09-14-…-design.md`）、实施计划（`docs/superpowers/plans/2026-09-14-….md`）、真机清单（`docs/真机验证清单.md`），登记于 2026-09-15
  - ⚠️ **复验口径**：登记值 = **工作树 LF 归一后的字节**的 sha256（不是盘上原始字节、不是 git blob）。本机是 CRLF checkout，直接用原始字节算会给 CRLF 的两份**假报 DRIFT**（见 `DEC-…b3.24`）。2026-09-17 复核：三个摘要 LF 归一口径下**逐位相等 = 零漂移**。
  - ⚠️ **2026-09-17 形态重写后的权威性变更**：那份 **09-14 设计 spec 的契约段已被新设计稿逐段取代**（`DEC-OPI-ecb3037d-…19` 的 ASSUMPTIONS 假设 2 已登记）。**这不是漂移**——文档本身没改，digest 仍应匹配；只是它不再权威。复验时若发现它 digest 不符，那才是真漂移，且**同时是形态重写的证据**。09-14 实施计划与真机清单的绑定仍然有效（它们是第一版实现的历史依据）。
  - **新权威设计稿的绑定在契约载体上**（不在 `.5`）：`docs/superpowers/specs/2026-09-17-形态重做-教学引擎-design.md` = sha256 `878b8d16698da73eac1a3881bb89cd56fa353093cf99db5b7b04530f729bdce4`（LF 归一口径）
- **续接顺序**：本文件 → `design_status` 刷新基 → `design_get` 契约载体 → 台账对象索引 → `git log --oneline`
- **宿主主体事实**：本地 stdio 运行时主体是 `HUMAN_USER`，能力族只有 `DESIGN_STATE_READ,DESIGN_STATE_MUTATE`——`finding_adjudicate` / `finding_disposition_apply` 会被诚实拒绝（需 ORGANIZATION_AUTHORITY）。
- **canonical 落盘**：`D:\DMCP-workspaces\ws-db58afd2-145c-4e81-9a7b-b562d8679071\.design\`（`state.yaml` + `findings/*.yaml`；服务端无响应字段时可直接读盘核验）
- **schema 注意**：契约改写的 `SET_ASSUMPTIONS` 分支**没有 `reason` 字段**（additionalProperties:false 即拒）；也没有 `DOC_DIGEST` 字段——文档绑定以显式假设承载（假定文档处于摘要状态，漂移即假设失效）。
