# AGENTS.md — 英语学习平台 · 首条价值切片

## 项目一句话

手机浏览器可用的学习闭环：拍照识物取词 → 跟读 → 自己造句 → 拿到结构化反馈 → 该词在新场景中复现。路线 **SCENE_FIRST**（契约载体 `DEC-OPI-…19`），产品边界 EVOLUTIONARY_MVP。用来回答：成人愿不愿意为一次取词举起手机拍一下，并愿意付出造句这份主动产出成本。

## 当前状态（2026-09-15 核对）

- **项目已转向（`DEC-…23`/`DEC-…26`）**：人工契约级验收（验证一/二/三，`VAL-…36/38/42/50`）**挂起不再调度**（保持 pending 如实呈现——它们绑定的旧设计假设已被用户推翻）。下一阶段 = **核心功能重构 + GitHub 公开部署**，三项形态已定：
  1. **部署 = GitHub Pages + 访问者自带 API Key**（localStorage 不入库；前端直连 api.deepseek.com，CORS 已实测放行）；**服务端代理（server/）退役**——Task 12 重构的主项
  2. **录音 = TTS 示范替代**（speechSynthesis 本地免费；SpeechRecognition 依赖退役，`aborted` 类平台限制不再影响主流程）
  3. **拍照 = 相册导入**（识物链路不变，输入源加相册选图）
  - 部署期契约断言（DEPLOYMENT/RUNTIME）已首次登记在 `DEC-…26` 载体上——runbook：漂移时 readiness 可查
- 执行层现状：**远程仓库已建**：`https://github.com/ZJW11398925/english-learning-platform`（公开，master + feat/first-value-slice 双分支，gh 已登录）。**Task 12A 已完成并通过验收**（`git:41f3b1a`，`VAL-…d5d39b50.2`/`VR-…6` PASS，裁决 `DEC-…d5d39b50.8`）：识物/造句链路浏览器直连 api.deepseek.com，Key 存 localStorage（`elp.apiKey`），设置入口 + 无 Key 引导页，server/ 已停止被客户端调用（12C 才删）。待办：12B（相册导入 + TTS 示范）→ 12C（server 退役 + Pages 上线 + README）→ `design_readiness` 对 RELEASE 诊断 → 开 Pages。
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

1. **变异测试必须带基线护栏**：重定向后原实现必须全绿，否则"脚本坏了"会被误读成"测试有效"。本环境禁止 piped 子进程 stdio，`process.exitCode` 须读 `exit` 事件。
2. **跑探针前冻住工作树**：包括自己在内不写仓库内任何文件（报告、清单、注释都算），跑完再改——探针的仓库完整性校验在并发写入下会假 FAIL。
3. **一轮只落一条结论事件**：不开新事件类型（`recognize_ok` 的 `latencyMs` 是字段不是新事件）。
4. **服务端没给的数不发明**：缺键不写 0——0 是"合法且极好"的读数，会盖住真凶。

## dmcp 段（跨会话续接第一入口）

- **workspace_id**：`ws-db58afd2-145c-4e81-9a7b-b562d8679071`（**带 `ws-` 前缀**；对象 id 里的 `OPI-ecb3037d-…` 是 project id，拿它当 workspace 用会 `WORKSPACE_NOT_FOUND`）
- **契约载体**（GOAL / IN_SCOPE / OUT_OF_SCOPE / 约束 / CORE_JOURNEY）：`DEC-OPI-ecb3037d-1a56-46d3-b931-4d482dcc668f.19`
- **文档绑定决策**（三份治理文档的 SHA-256 登记在其 ASSUMPTIONS 断言里；文档变更后 digest 不匹配即漂移证据）：`DEC-OPI-5c134c67-9bdd-46d2-b9bc-7d51bfde8585.5`
  - 覆盖：设计 spec（`docs/superpowers/specs/2026-09-14-…-design.md`）、实施计划（`docs/superpowers/plans/2026-09-14-….md`）、真机清单（`docs/真机验证清单.md`），登记于 2026-09-15
- **最新实施期裁决**：`DEC-OPI-ecb3037d-1a56-46d3-b931-4d482dcc668f.87`（Task 10 四项）
- **在册对象索引**（决策/任务/判据/验收对照表）：`.superpowers/sdd/progress.md` 的「在册对象索引」表
- **续接顺序**：本文件 → `design_status` 刷新基 → `design_get` 契约载体 → 台账对象索引 → `git log --oneline`
- **宿主主体事实**：本地 stdio 运行时主体是 `HUMAN_USER`，能力族只有 `DESIGN_STATE_READ,DESIGN_STATE_MUTATE`——`finding_adjudicate` / `finding_disposition_apply` 会被诚实拒绝（需 ORGANIZATION_AUTHORITY）。
- **canonical 落盘**：`D:\DMCP-workspaces\ws-db58afd2-145c-4e81-9a7b-b562d8679071\.design\`（`state.yaml` + `findings/*.yaml`；服务端无响应字段时可直接读盘核验）
- **schema 注意**：契约改写的 `SET_ASSUMPTIONS` 分支**没有 `reason` 字段**（additionalProperties:false 即拒）；也没有 `DOC_DIGEST` 字段——文档绑定以显式假设承载（假定文档处于摘要状态，漂移即假设失效）。
