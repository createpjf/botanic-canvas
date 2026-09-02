# 批量变体：共享提示词、按支回填、尺寸目录

> 设计规格。本轮一次落地 A/B/C，并支持 gpt-image-2 自定义像素。

**Goal:** 以画布参考图为父节点开 N 个分支时，每支只拿到自己的画面指令、每支独立对账出图，并允许在模型真实支持的范围内改比例、清晰度或自定义像素。

**Architecture:** 变体取值与 `promptDelta` 仍是分支权威；`plan.prompt` 只允许共享底（锁定约束 + 继承画面，不含取值清单）。Run/Job 按 `branchId` 对账，终态不得早于画布投影。尺寸权威字段是 `aspectRatio` / `resolution`，gpt-image-2 可另存 `outputWidth` + `outputHeight`；选目录比例时清掉自定义像素。不把任意像素传给不支持的模型，也不静默换 MiniMax。

**Tech Stack:** 现有 Botanic Agent 领域模块、`server/botanicAgent*.mjs`、GenerationJob / Artifact Index、模型目录 `server/generationModels.mjs`。

## Global Constraints

- 不改变幂等键：`${run.id}:${branch.id}:attempt-${attempt}`。
- 不改变任务恢复、项目版本冲突、媒体授权语义。
- 删除画布节点不得级联删除 Artifact Index。
- Agent Session / Message / Memory / Run 仍是权威实体。
- `src/components/` 不直接访问 Store、网络或服务端。
- 领域规则留在 `src/domain/` 与 `server/`，UI 只展示。
- `src/domain/agentVariations.ts` 与 `server/botanicAgentVariations.mjs` 必须同步。
- ProductStore 三 Adapter 若接口变化则同步契约测试。
- 普通开发测试不得调用真实生成 Provider。
- 本规格覆盖三个子系统，本轮一次落地；不要把改动塞进已合并的 #38–#41。

---

## 用户完成标准

顺序不变：已确认的肤色/变体取值不再追问 → 结构化计划（节点 ↔ 取值 ↔ prompt 一一对应）→ 用户没给尺寸则继承参考图 → 只新增不覆盖原图。

验收：

1. 原图仍在。
2. 新增节点数 = 已确认取值数。
3. 每节点独立 prompt：共享底不含完整变体清单，本支只带本支 delta。
4. 任务面板能看到每支 queued / running / succeeded / failed，而不是只显示一张图或一句总进度。
5. 确认卡可以改模型/比例/清晰度；gpt-image-2 可输入自定义宽×高（对齐 /16，拒绝超窗）。

---

## 现象（当前截图）

三支节点标签类似「来选 / 一个在海边 / 一个在沙漠里」。每个「精修描述」和确认卡分支框都塞同一大段（海边 + 沙漠 + 宇宙清单），只在末行 `人物替换为…` 不同。画布两支仍「等待生成结果」，一支沙漠已出图，角标全是 `1:1 · 1K`。侧栏出现「结果已生成，正在回填画布」。

这不是三件无关 UI 问题，而是一次批量变体执行里三条通道同时失真。

---

## 问题 1：三个 prompt 共用一份冗长清单

### 根因

权威拼装链：

1. 规划器把「三场景说明书」写进 `plan.prompt`。
2. `applyBotanicAgentVariationToPlan` 用 `botanicAgentSharedVariationPrompt` 试图清洗。
3. `stripVariationInventory` **只剥逗号/顿号列表和「N种」**，剥不掉 `1. 海边 2. 沙漠 3. 宇宙` 或「一个在海边 / 一个在沙漠里」。
4. `botanicAgentBranchGenerationPrompt(plan.prompt, promptDelta)` 把整段共享底 + 一句 delta 拼给确认卡、recipe 和画布文本节点。
5. `workflowForBranch` 在 delta 已经写进 `recipe.prompt` 后再调一次 `botanicAgentBranchGenerationPrompt(recipe.prompt, undefined, …)`，文本节点等于全文再铺一遍。

轴识别也会写反：取值像「来选」「一个在海边」且指令里没有「场景」时，可能落到 `person` 或 `custom`。`person` 的 delta 是「人物替换为 X，保持服装、商品与场景不变」，与用户要的换场景相反。

画布 `TextNode` 用固定高度 textarea 展示全文，看起来像 UI 复制错，其实是领域拼装结果。

### 备选

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A. 领域契约（推荐）** | 变体 ready 后强制重写共享底；清单不得进入 `plan.prompt`；分支展示以 delta 为主 | 一次修确认卡、recipe、文本节点同源；规划器散文无法再污染生图 |
| B. 只加规划器字段 `sharedPrompt` | 让模型自己分栏 | 模型仍会把清单写进共享栏，没有强制清洗 |
| C. 只截断 UI | 确认卡/节点折叠长文 | 三支 Job 仍把互相冲突的场景送给生图模型 |

不选 C。展示可以折叠，但不能只折叠。

### 推荐设计

**共享底只保留：** 锁定约束（人物/服装/商品/身份）+ 从参考图 `rootRecipe.prompt` 或用户画面描述继承的单场景描述。

**不得进入共享底：** 全部变体取值枚举、编号清单、「一个在…一个在…」、规划旁白、确认卡表格。

清洗入口仍是 `botanicAgentSharedVariationPrompt` / `stripVariationInventory`（client + server 同步），并增加：

- 编号清单：`1. / 1、 / （1）` 以及换行枚举。
- 平行句式：`一个在X`、`分别是`、`一个…一个…`。
- 若清洗后仍同时包含 ≥2 个已确认取值标签，则丢弃这段，回退到参考图 `rootRecipe.prompt`；再没有则用现有兜底句「保持人物身份、服装与商品不变，仅按变体说明调整画面。」

**轴：**

- 「在海边 / 在沙漠 / 宇宙」这类处所用语，默认 `scene`，delta 用「场景替换为 X，保持人物、服装与商品不变。」
- 未点名轴时，禁止仅因取值不像肤色就落到 `person`。
- `identityAxisKeys`（肤色/族裔）继续锁定人物/服装/商品/场景，只 vary style。

**展示（不改存储权威）：**

- 确认卡分支框主展示：取值标签 + 本支 `promptDelta`。完整提交词放在可展开的「完整提示词」。
- 画布文本节点**仍存储** `shared + delta`（图配方从连线文本重建时不能丢共享底），UI 默认折叠到约两行，全文进节点检视/hover。
- `generate` 节点继续不印全文（#37 已做）。

**提交给 Provider 的 `recipe.prompt`：** 必须是清洗后的共享底 + **仅本支** delta。禁止三支正文几乎相同。

### 改哪些文件

- `src/domain/agentVariations.ts`
- `server/botanicAgentVariations.mjs`
- `src/domain/agentVariations.test.ts` 与对应 server 测试
- 确认卡：`src/features/agent/AgentConversationMessage.tsx`（展示，不把规则放回 UI）
- 画布折叠：`src/features/canvas/CanvasEditorViews.tsx` + `src/styles.css`
- 文本节点写入：`server/botanicAgentExecution.mjs` 的 `workflowForBranch` 不再二次拼接已含 delta 的 `recipe.prompt`

### 验收用例（实现时先写失败测试）

1. 共享底含「1. 海边 2. 沙漠 3. 宇宙」+ 三支 scene delta → 清洗后共享底不含这三个词；沙漠支全文不含「海边」「宇宙」。
2. 「一个在海边、一个在沙漠里、一个在宇宙」无「场景」二字 → 轴为 `scene`，delta 为场景替换而非人物替换。
3. 规划旁白 + 清单 → 共享底回退到 `rootRecipe.prompt` 或兜底句。
4. `botanicAgentPlanBranchPrompts` 对确认卡返回的主展示字段是 delta；完整拼装仍可取到。

---

## 问题 2：画布只显示一张，另外两支等待

### 根因（按证据，不是猜测）

三节点已建、`submitGenerationOnce` 对 `pendingJobs` 逐个 `enqueue`，Worker `concurrency` 默认 3（`GENERATION_WORKER_CONCURRENCY`，1–8）。生产路径**不是**本地 `runGraphGeneration`；后者在 `generationStatus !== idle` 时直接 `return false`，不能当并行方案。

侧栏文案「结果已生成，正在回填画布」只在 `botanicAgentRunFeedback` 里出现，条件是 **`run.status === 'completed'`** 且 `canvasOutputCount < artifactCount`。含义是：Run 已认为全部分支成功，Artifact Index 已有记录，但当前画布节点集合对不上这些 Artifact 的 `sourceNodeIds`。

服务端其实已经试图挡住「Job 成功但画布没图就推进 Run」：

- `generationJobProjectionComplete` 要求结果节点带 `image`。
- `writeJobToProject` 在 Agent Job 投影未完成时抛错并 `projectWritebackPending`。
- `putGenerationJob(..., { updateAgentRun: false })` 直到画布和 Artifact 都写好。

因此截图更像下面两类之一，实现时必须用测试钉死，而不是加 Toast：

1. **投影/合并漏支：** `reconcileGenerationResults` 每次只吃当前这一个 Job；客户端 `mergeRecoveredGenerationJobs` 的 `resultOutputIdentity` **要求 `candidateId`**，而 `generationJobProjectionComplete` 在单输出时允许没有 `candidateId`。服务端以为回填完了，客户端恢复路径可能不认这张图。Realtime 若只推 graph、客户端对账用另一份 jobs，也会出现「一支有图、两支仍 waiting」。
2. **状态文案超前：** 若 Run 已 `completed` 而画布仍显示两支 generating，任务面板必须按 `branchId` 列出 Job 状态。部分成功必须是 `partial`，不能假装全完。

不要用 `Promise.all(runGraphGeneration)` 修这个问题。

### 备选

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A. 按 branchId 对账（推荐）** | 每个 Job 只改自己的 generate/result 节点；投影完成条件与客户端合并条件一致（含 `candidateId`）；任务面板按支展示 | 对齐现有「Job 是状态权威」 |
| B. 只加大 Worker 并发 | 环境变量调到 8 | 不修对账，截图仍可能只回填一支 |
| C. 本地并行跑图 | Store 里同时 `runGraphGeneration` | 违反单一 `generationStatus`，且不是生产路径 |

### 推荐设计

- 任务面板与 Run 反馈以 `run.branches[]` 为准：每支显示 queued / running / succeeded / failed，附 `activeJobId`。
- `completed`：全部 succeded **且** 每支至少有一个带 `image` 的结果节点（或明确记录投影完成）。
- 有成功也有失败 → `partial`；文案「已回填 N 项，有分支失败」。
- 「正在回填画布」仅用于：分支已 succeeded、Artifact 已有、对应结果节点还没有 `image`。只要仍有 queued/running，文案必须是「正在生成」，即使 Artifact 已出现第一张。
- `reconcileAgentGenerationJobToProject` 禁止用当前 Job 的投影覆盖兄弟分支节点的 `image` / `jobId`。
- 单输出 Agent 结果也写入 `candidateId`，让 `generationJobProjectionComplete` 与 `resultOutputIdentity` 使用同一身份。
- `mergeRecoveredGenerationJobs` 对 Agent 占位结果：即使缺少 `candidateId`，只要 `jobId` + `agentRun.branchId` 匹配且 recovered 带 `image`，也要合并。
- 保持现有冲突重试（项目 5 次、Agent persistJobState 3 次）和 `projectWritebackPending` 再入队；补测试：三支几乎同时 succeeded 时三张图都在。

### 改哪些文件

- `server/generationResultReconciliation.mjs` 与测试
- `server/botanicAgentExecution.mjs` / `server/generationProcessor.mjs`
- `src/store/canvasGenerationRecovery.ts` 与测试
- `src/domain/agent.ts` 的 `botanicAgentRunFeedback`（区分「仍有分支在生成」与「已生成待回填」）
- `src/features/agent/AgentWorkspaceParts.tsx`、任务/结果面板
- 不改幂等键，不改 Artifact 级联删除策略

### 验收用例

1. 三支 Job 依次 succeeded，每次只传入当前 Job 做 reconcile → 三张结果节点都有各自 `image` 和 `jobId`。
2. 两支冲突写入后重试 → 不丢已经写上的第一张图。
3. 单输出无 `candidateId` 的历史节点仍能被客户端合并（兼容）；新写入必带 `candidateId`。
4. Run 仍有 running 分支时，反馈不得出现「结果已生成，正在回填画布」。
5. 一支失败两支成功 → `partial`，原图仍在。

---

## 问题 3：GPT 其他尺寸 / 自定义尺寸

### 根因

- OpenAI 目录在 `server/generationModels.mjs` 写死 `aspectRatios: ['1:1', '3:4', '4:5', '9:16']`，**没有 16:9 / 4:3**。MiniMax 图才有 16:9 / 4:3。
- `server/generationProvider.mjs` 的 `outputSize` 只映射上述四档 × 1K/2K。领域类型 `GenerationAspectRatio` 含 16:9/4:3，但 GPT 目录未开，推断/确认会被丢掉。
- 用户没说尺寸时，Brief 从参考图继承（常为 `1:1 · 1K`）。确认卡设置区目前是只读展示，改尺寸只能靠对话或追问卡；继承成功后往往不再追问。
- 官方约束（2026-08 OpenAI Image API）：
  - **gpt-image-1 系列：** 离散档 `1024x1024` / `1024x1536` / `1536x1024` / `auto`，不是任意像素。
  - **gpt-image-2：** 允许 `WIDTHxHEIGHT`，两边须为 16 的倍数，长短边比不超过 3:1，总像素 655,360–8,294,400，长边 ≤ 3840；超过约 2560×1440 视为实验档。文档示例包含 16:9 的 `1536x864`、2K 方图 `2048x2048`。

当前仓库把 GPT 一律当成「四档竖图目录」，所以即使用户用的是 gpt-image-2，确认卡也选不到 16:9。

### 备选

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A. 目录补齐 + 确认卡可改（本轮）** | gpt-image-2 打开 16:9 / 4:3，映射到合法像素；确认卡可改比例/清晰度 | 覆盖截图诉求 |
| **B. gpt-image-2 自定义像素（本轮一并做）** | 确认卡与画布 Composer 可输入宽高；校验 /16 与像素窗；1920×1080 对齐到 1920×1088 | 仅 gpt-image-2；不支持则拒绝，不换模型 |
| C. 要 16:9 就静默换 MiniMax | 目录不够就换模型 | 画面模型和用户选择被偷换，不接受 |

### 推荐设计

1. 模型目录按 **模型 id** 而不是「凡是 openai」一刀切：
   - `gpt-image-2`：`['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']`，分辨率仍 `1K` / `2K`，`supportsCustomSize: true`。
   - 其他 gpt-image-1 系：保持现有四档。
2. `outputSize` 优先 `outputWidth`×`outputHeight`（对齐 /16），否则走目录表：
   - 1K 16:9 → `1536x864`；1K 4:3 → `1536x1152`。
   - 2K 16:9 → `2048x1152`；2K 1:1 → `2048x2048`。
3. 确认卡「本次生成设置」在提交前可改模型/比例/清晰度，选项 = 当前模型目录。gpt-image-2 另提供宽×高输入。默认值 = 用户说过的值，否则继承参考图。
4. 选目录比例时清掉自定义像素。自定义时仍可保留推断的最近目录比例，**不要**把 `'custom'` 加进 `GenerationAspectRatio`。
5. 投放文案「自定义」只表示不是淘宝/小红书/抖音，与像素输入无关。
6. 对齐 /16 可接受（1920×1080 → 1920×1088）；拒绝无法满足像素窗/比例的值，不静默裁成奇怪比例。MiniMax 无自定义像素。

### 改哪些文件

- `src/domain/generationOutputSize.ts` 与 `server/generationOutputSize.mjs`
- `server/generationModels.mjs`
- `server/generationProvider.mjs`（`resolveGenerationOutputSize`）
- `src/domain/agentCreativeBrief.ts`、`src/domain/agentChatContract.ts`（推断与目录对齐）
- 确认卡：`AgentConversationMessage.tsx` 设置区由只读改为提交前可编辑
- 画布 Composer：`CanvasEditorViews.tsx`
- 对应 planner / provider / brief 测试；e2e 夹具里的 GPT 目录一并补 16:9

### 验收用例

1. 指令「16:9、2K」+ 模型 gpt-image-2 → settings 即为 16:9 / 2K，Job `size` 为表中合法像素，不是 `undefined`。
2. 指令「16:9」但当前模型目录无 16:9 → 追问或标明最接近档，不静默改模型。
3. 未提尺寸 → 继承参考图；若参考图比例不在目录内，确认卡预选目录第一项并可见提示。
4. 确认卡改 3:4 → 2K 后提交，三支 Job 使用同一 settings，互不影响 prompt 通道。
5. 指令「1920×1080」+ gpt-image-2 → Job `size` 为 `1920x1088`；MiniMax 拒绝自定义像素。

---

## PR 拆分

本轮在 `cursor/agent-variation-channel-design-dfcd` 一次落地 A/B/C 与自定义像素，不要把改动塞进已合并的 #38–#41。

| PR | 内容 | 为什么先做 |
| --- | --- | --- |
| **A** | 共享底清洗 + 轴=场景 + 确认卡/节点展示 | 不修这个，三支会继续画出同一张「说明书」 |
| **B** | 按支投影/合并/反馈 | 修完 A 才能判断「只有一张」是真没出还是没回填 |
| **C** | gpt-image-2 目录与确认卡改尺寸 | 不依赖 A/B，但避免和 A 抢确认卡 |

不要把本规格塞进已合并的 #38–#41。从最新 `main` 开 `cursor/<name>-dfcd`。

## 明确不改

- Markdown 表格解析（#38）
- 裸确认语路由（#41）
- 幂等键、媒体授权、Artifact 级联删除
- 用真实 Provider 做开发测试
- 本地 Store 并行 `runGraphGeneration`

## 实现入口（CODEMAP）

- 变体与 prompt：`src/domain/agentVariations.ts`、`server/botanicAgentVariations.mjs`、`server/botanicAgentExecution.mjs`
- Agent 面板：`src/features/agent/AgentWorkspace.tsx`、`AgentConversationMessage.tsx`、`AgentUtilityPanels.tsx`
- 画布文本节点：`src/features/canvas/CanvasEditorViews.tsx`
- 生成对账：`server/generationResultReconciliation.mjs`、`src/store/canvasGenerationRecovery.ts`、`server/generationProcessor.mjs`
- 尺寸：`src/domain/generationOutputSize.ts`、`server/generationOutputSize.mjs`、`server/generationModels.mjs`、`server/generationProvider.mjs`
- 验证：先跑被改模块测试，再 `npm test`、`npm run check:architecture`、`npm run check:security`、`npm run build`、`git diff --check`
