# Botanic Agent AIGC 可规模化创意工作流审查

审查基线：`main` @ `2d736ba`（2026-08-16）。  
对照规范：[产品架构](PRODUCT_ARCHITECTURE.md)、[CODEMAP](CODEMAP.md)、[ARCHITECTURE](ARCHITECTURE.md)、ADR 0001–0003、[Prompt Pack MVP](BOTANIC_PROMPT_PACK_MVP.md)。  
对照先前工作：PR #15–#26（已合入的 Agent Ontology / 恢复 / P3 生产工作流），以及已关闭的 PR #27 / #28（营销生产链移植，**不得合入 Botanic**）。

本文是审查，不是当前开发规范。落地时仍以 ADR 与 CODEMAP 为权威。

---

## 1. 结论先行

Botanic 已经具备一套**可恢复、可确认、可追溯**的 Agent 生图骨架：Session / Message / Memory / Run 独立实体，GenerationJob 作为任务权威，Artifact Index 作为历史血缘。这套骨架适合品牌视觉工作室，不适合做成「再一个聊天生图页」。

当前距离「可规模化执行的 Agent AIGC 创意工作流」还差一层：**计划里的创作语义没有进入执行，首次生成几乎不经过规划模型，用户面对的是覆盖画布的对话浮层，而不是与图谱共存的生产工位。**

一句话：

> 系统能可靠地提交、恢复和记账一次生成；但不能可靠地把「锁人物、换场景、按系列出一组」变成可重复执行的配方。用户确认的是 Prompt 文本，不是可执行约束。

不要把已关闭的营销生产链（趋势 → DAG → Campaign Kit）搬进本仓库。Botanic 的规模化路径应沿着**画布图谱 + 确认计划 + 可恢复 Run + Artifact**加深，而不是横向铺成营销 SaaS。

---

## 2. 产品真相：现在到底在卖什么

### 2.1 已固化的产品主张

[PRODUCT_ARCHITECTURE.md](PRODUCT_ARCHITECTURE.md) 写得很清楚：核心不是单次生成页面，而是持续存在的「项目创作图谱 + 执行记录 + 历史产物」。Agent 在同一项目语义上检索、规划、经确认后执行；确认之后复用同一套 GenerationJob，不另起任务状态机。

这对规模化是正确的：

- 一次确认 = 一次幂等提交，网络重试不重复计费。
- 每个输出独立成节点，选择某张候选不删除其余结果。
- 删除画布节点不级联删除 Artifact。
- UI、Toast、Runtime 卡片都不是权威。

### 2.2 先前计划里必须划清的边界

| 先前工作 | 状态 | 对 Botanic 的含义 |
| --- | --- | --- |
| PR #15–#18 Ontology / Memory / 确认卡 | 已合入 | 当前 Agent 实体与确认门控的基线 |
| PR #20–#23 拆分工作区 / Store | 已合入 | 检索和审查成本下降，但编排器仍然过重 |
| PR #24–#26 协作、可观测、生产工作流 | 已合入 | 恢复与批量生产基础设施已有；Agent 主路径几乎没用上 |
| `.agents/plans/001–005` | 历史动效审计，已完成 | **不是** Agent AIGC 路线 |
| PR #27 营销生产链六阶段工作台 | 关闭；错误仓库移植后 force-push | 不得再合入 |
| PR #28 Workflow Run 权威 | 关闭；依赖 #27 的 DAG UI | 不得再合入；其中「UI 不得当 Run 权威」原则可吸收 |

#27 / #28 的正确教训只有一条：**Agent 面板不能成为执行真相**。Botanic 主路径已经遵守这一点（权威在 Agent Run + GenerationJob）。不要借这个教训把六阶段导航、TrendSignal、Review Center 塞进无限画布。

### 2.3 当前真实工作流（代码，不是文档愿望）

```text
用户输入
  → decideBotanicAgentRequest（正则启发式，不是 LLM）
      ├ chat / prompt / research → /api/agent-chat（只读 tool loop）
      ├ 视频明确生成 → 通知「暂未接入」，不建节点
      └ generation
            ├ 无选中结果 → 本地 buildBotanicAgentPlan（intent=initial_generation）
            │                 prompt = 用户原文，不调用 Planner LLM
            └ 有选中结果 → /api/agent-plans（LLM，必须 generation_create_plan）
  → 计划卡确认（手动）或 auto 模式直接确认
  → Agent Run → 每分支一个 GenerationJob（refinementMode 固定 faithful）
  → Worker / Provider → 画布结果节点 + Artifact Index
```

这不是端到端 autonomous loop。它是 **「启发式路由 →（有时）LLM 规划 → 人工确认 → 程序化批量提交 Job」**。规模化发生在 Job / 幂等 / 恢复层，不发生在创意决策层。

---

## 3. 已经做对、应当保住的部分

后续任何增强都不能破坏这些不变量：

1. **入线是配方唯一来源**（ADR 0001）。全局参考面板不再偷偷改执行输入。
2. **Agent 实体独立持久化**（ADR 0002）。跨设备追加消息、Memory 墓碑、旧快照不得覆盖新状态。
3. **Artifact Index 是历史目录**（ADR 0003）。整理画布不等于销毁血缘。
4. **确认门控**：付费生成与外部工具默认确认；auto 模式遇到 Skill/MCP 行动仍停住。
5. **媒体不进模型消息**：Planner 拒绝 image/url/base64；上下文只传节点元数据。
6. **恢复语义**：`submission_unknown` 复用原幂等键；用户主动重做才换新键。
7. **架构边界**：`src/components/` 不碰 Store/网络；生成状态不由 UI loading 推断。

这些是工作室产品能规模化的地基。下面的缺口都建立在「保住这些」的前提上。

---

## 4. 产品逻辑缺口：创意语义没有闭环

按对「可规模化执行」的伤害排序。

### P0-1 计划约束不下执行层（最大产品谎言）

Ontology 把创作维度写成执行语义：`preserve` / `vary` 的 person、garment、scene、style、pose 等。计划卡也会画出「锁定 · 人物 / 变化 · 场景」。

执行层并不消费这些字段。`server/botanicAgentExecution.mjs` 的 `recipeForRun()` 只取 `run.plan.prompt`、`settings`、参考图和素材组替换。`server/generationProvider.mjs` 的 `buildProviderPrompt()` 再包一层固定意图句，与 `constraints[]` 无关。

结果：

- 用户以为「锁定人物」是系统保证，实际只是 Prompt 里碰巧写了这句话。
- 模型改写 Prompt 时漏掉锁定项，确认卡很难发现——约束芯片仍显示「锁定」。
- 素材组只决定分支数量和替换哪张参考，不强制对应维度的 `vary`。
- 评测 `agentQualityEvaluation.mjs` 只量成功率、恢复率、回填完整性，不量「锁定是否被遵守」。

规模化含义：同一条「换场景、锁服装」不能变成可重复的生产配方。人可以盯着 Prompt；Agent 和批量运行不能。

**应做成什么**：约束是执行输入，不是 UI 装饰。编译进 Provider Prompt 的结构化段落，并进入 GenerationRecipe 快照（例如 `lockedDimensions` / `variedDimensions`）。Job 重放必须带上同一份约束。Planner 输出与执行输入使用同一契约。

### P0-2 首次生成绕过规划模型

无选中结果时，`AgentWorkspace.runInstruction` 走本地 `buildBotanicAgentPlan()`：

- `intent` 固定 `initial_generation`
- `prompt` = 用户原文（或「用上一段 Prompt」的拼接）
- 服务端 Planner 的 `INTENTS` 集合甚至不含 `initial_generation`

有结果图的「换场景」会请模型整理锁定项；从零开始的「帮我做一朵白云白底图」反而把口语直接交给图像模型。这和产品叙事相反：最需要品牌结构的一步，规划最弱。

叠加 P0-3 后更糟：口语 Prompt 再被服务端包成「电商品牌首图」。

**应做成什么**：首次生成也走 Planner（或 Prompt Pack 编译器），输出结构化计划后再确认。没有参考图时停在 `waiting_reference`，而不是用正则猜用户想生图。

### P0-3 服务端仍把所有新图收敛成电商品牌首图

```text
server/generationProvider.mjs → buildProviderPrompt()
  kind !== refinement → 「生成电商品牌首图；产品主体必须清晰…适合作为投放视觉。」
```

[Prompt Pack MVP](BOTANIC_PROMPT_PACK_MVP.md) 已写明：环境大片、服装细节、社媒种草接入时必须改成与任务匹配的意图，否则画面会被错误收敛。该规格仍未落地，Prompt Pack 数据、编译器和 UI 在仓库中均不存在。

Fashion Prompt Skill（`server/skills/botanic-fashion-prompt/`）只在 **chat 的 prompt 模式**加载，不进入 Planner，更不进入 Job。系列目录是给写 Prompt 用的，不是给执行用的。

**应做成什么**：意图随任务类型变化（白底 / 环境 / 细节 / 社媒 / 精修 / 探索）。Prompt Pack 作为独立类型（与模板分开），应用后只写草稿，不自动出图。系列溯源（`packId` / `seriesId` / `taskId`）进入配方，供复用和效果分析。

### P0-4 路由是正则，不是对意图的理解

`decideBotanicAgentRequest()` 用一组中文/英文正则切五条路。它成功挡住了不少误触发生成的句子（「你能生成吗」「为什么没出图」），但规模化时会系统性误判：

- 「做一组海边的」可能进对话，因为没有「生成/出图」。
- 「换成森林背景」无目标时仍可能按 instruction 当 Prompt 首次生成。
- 视频被写死为 `unsupported_media`，画布其实已经能跑 MiniMax H3。
- 欢迎区「换场景 / 换动作 / 换风格」只填输入框，不检查是否已有结果图。

路由测试覆盖的是作者想到的句子，不是设计师的口语。这是产品门，不是实现细节。

**应做成什么**：启发式继续做**安全闸门**（明确取消、能力询问、未完成追问不得建节点）。真正的分流应结合选中节点、是否已有 Prompt、是否已有参考，必要时让 Chat 模型返回结构化 route，而不是再堆正则。

### P1-1 没有评价 → 修订 → 再执行的闭环

Run 终态只有 `completed / partial / failed / cancelled`。消息上的赞踩会写入 Message，不进入下一次 Planner，不进入 Memory，不进入评测。内置 Skill 只有三句说明文字（受控编辑 / 批量变体 / 原配方重做），`skill_run` 的产物是待确认的文字节点，不改计划结构。

规模化的创意工作流需要至少一种廉价闭环：

1. 对输出做结构化评价（主体是否保持、场景是否替换、明显残缺）。
2. 评价可一键生成「修订计划」，复用原 Run 的约束与参考。
3. 用户确认的评价可提议写入 Memory（仍需确认，不能自动改品牌规则）。

现在的「继续修改」只是把节点重新放进上下文，并在输入框预填一句「继续优化这张结果：」。

### P1-2 三条执行入口，三种心智

| 入口 | 权威 | 用户感知 |
| --- | --- | --- |
| 画布生成节点 Composer | GenerationJob | 选中节点后自动弹出，改 Prompt 即生成 |
| Agent 计划卡「确认并生成」 | Agent Run → 同一 Job | 对话里确认锁定项 |
| 模板面板「生产」页签 | ProductionWorkflowRun | 发布版本、批量跑、暂停/重试 |

生产工作流是 P3 的正确基础设施：版本快照、批量项独立恢复、失败重试复用预算。但它埋在模板侧栏第三页，Agent 主路径不会「把刚才这次确认提升为版本」。`productionWorkflowDraftFromCanvas()` 能从已完成生成做草稿，UI 没有把这条路接到计划卡完成态。

用户会问：我刚才确认的计划和模板里的「生产」是不是一回事？现在不是。规模化时必须是同一配方的两种触发方式：探索用 Agent Run，复用用 Workflow Version。

### P1-3 视频、无底图、探索变体都在 Agent 门外

- Agent 明确拦截视频执行，画布节点却支持 H3（5/10/15 秒，首帧/首尾帧）。
- 真实生图至少需要一张参考图；文档已承认「无底图直出」不可用。
- Agent Run 把 `refinementMode` 写死为 `faithful`。画布 Composer 可以走探索变体，Agent 不能。

结果：设计师在 Agent 里做不完一条「图 → 视频 → 投放」链，必须跳回画布手搭节点。Agent 变成局部改图助手，而不是工作流执行器。

### P1-4 Memory / Skill / 素材组被做成三种互不相通的偏好

Ontology 明确三者不能互相替代。实现上它们也确实分开，但都依赖用户手工维护：

- Memory：侧栏表单，500 字，最多约 30 条塞进 Planner JSON，无检索（Chat 侧才有 `project_memory_search`）。
- Skill：自由文本，无 schema、无版本、无组合；「可自动调用」只是文案。
- 素材组：Composer 里一个缩成「组 / 1」的选择器，和计划意图的角色（场景/模特/商品/调性）没有引导式绑定。

赞踩、成功 Run、被删除的坏结果，都不会变成下一次默认约束。项目做久了，Agent 并不会更懂这个品牌。

---

## 5. 使用体验缺口：工作流被做成「会说话的侧栏」

### 5.1 Agent 覆盖画布，而不是与画布分工

`.agent-workspace` 是 `position: fixed; right: 12px; width: min(480px, …)` 的浮层。打开后：

- 画布右侧被挡住，刚生成的结果节点经常落在浮层下面。
- `exclusiveSurface` 让 Agent 与素材库互斥；要补参考就得关掉 Agent。
- 选中生成节点时的 Canvas Composer 在 Agent 打开时被强制关掉（`setComposerOpen(false)`）。
- 布局类名写死 `app-shell--agent-closed`，说明曾经考虑过网格第三列，后来改成浮层，网格模式成为死代码。

先前营销方案把 Agent 设计成常驻 360px 列，方向对，实现仓库错了。Botanic 自己的规模化交互应是：**画布管图谱，Agent 管计划与确认，两者同时可见**。浮层适合偶尔问一句，不适合盯着图改十轮。

### 5.2 首次成功出图的门槛过高

无图项目里，用户要连续跨过：

1. 发现右缘那颗 44px 的 Agent 按钮（无文字，只有 title）。
2. 上传或 `@` 一张图片（`@` 菜单只列出「素材」节点，且所有选项副标题都写「素材」）。
3. 被追问模型 / 比例 / 分辨率。
4. 再确认一次计划卡（原文、润色 Prompt、约束芯片、设置、执行路由、确认按钮叠在同一张卡上）。
5. 等待 Runtime 动画（客户端拼出来的步骤，不是服务端 trace）。

任一步失败，文案往往正确（「本次没有改动画布」），但用户不知道下一步该打开素材库、画布节点还是确认卡。欢迎区三个快捷按钮在没有结果图时会把「换场景」填进输入框，发送后进入首次生成路径，语义是错的。

### 5.3 计划卡信息过载，真正要确认的东西被淹没

当前确认卡同时承担：工具调用列表、Skill/MCP 行动、Prompt 原文 vs 润色 diff、十条约束芯片、模型/比例/清晰度/分支数、上下文锁、执行路由 `<details>`、确认按钮。

PR #18 已经为完成态降噪，但**待确认态**仍然像一张运维工单。设计师真正要签核的是：

1. 锁什么 / 变什么；
2. 用哪几张参考；
3. 最终 Prompt 是否还能认出来；
4. 这次会花一次生成、出几张。

模型名、Planner 供应商、工具 JSON 应默认折叠。auto 模式在无 action 时会跳过这张卡，等于把唯一的人机核对点拆掉，又没有 FLORA 式的执行前成本/影响摘要顶上。

### 5.4 Runtime 是演出，不是观测

`createBotanicAgentRuntimeSteps()` 在浏览器里按「有没有目标 / 有几条 Memory」拼步骤，再用 `requestAnimationFrame` 把读取步骤标成完成。刷新后 `restoreBotanicAgentRuntimeSteps()` 把历史步骤全部标成「已从服务端恢复」。服务端其实有 `agentExecutionTrace.mjs`（稳定 `agent-trace:<runId>`），浏览器 API 也有简要状态，**主界面不用**。

用户看见的「正在读取画布上下文」不能拿来排障；真正的 Job 失败原因在任务面板另一处。结果区和任务面板还通过互斥工具菜单争同一块浮层，不能并排对照「这句话 → 这次 Run → 这几张图」。

### 5.5 双 Composer、双「继续」

画布节点有完整 Composer（参考条、参数、探索/忠实、批量）。Agent 另有 Composer（聊天、@、执行模式、Planner 模型、素材组）。结果节点上有「Agent 修改」，也有「添加节点 / 继续生成」。

同一张图的下一轮，用户有三条看起来都能用的路，参数和 Prompt 还不一定同步。规模化团队协作时，这会变成「有人在节点上改、有人在 Agent 里改、历史对不上」——尽管底层 Job 是一份。

### 5.6 结果区能汇总，不能挑选创意方向

结果面板按 Run 分组，支持入库、下载、定位、创建下一轮。缺的是创意操作：

- 选中两张做「保留 A 的人物 + B 的场景」；
- 标记「可用 / 弃用」并建议写入 Memory；
- 把一组成功输出提升为生产工作流版本；
- 过滤「仅当前对话 / 仅未入库 / 仅锁定失败的回放」。

视频筛选项在 Agent 结果区是空的，因为 Agent 根本不生产视频。非 Agent 的画布生成也不进该区（ADR 0003 的设计），所以用户会觉得「我明明在画布出过图，Agent 结果是空的」。这需要一句话解释，而不是一个空白状态。

### 5.7 协作与冲突对创作者不友好

协作动态、冲突预览、已读回执在工程上完整。对设计师来说：

- 冲突文案是「暂留本地 / 使用云端版本」，不是「保留我刚确认的计划、只合并对方的节点」。
- Agent 浮层里的协作面板会替换整个对话，不能边聊边看谁改了哪条边。
- 409「画布刚刚发生变化，请刷新后重新执行」把一次已确认计划变成手工重来，没有「用最新图谱重放同一 submission key」的按钮。

---

## 6. 代码与结构缺口：编排器仍在吸收产品

### 6.1 文件过重，行为归属开始重新糊掉

| 文件 | 约行数 | 问题 |
| --- | --- | --- |
| `src/styles.css` | 3916 | 单文件承担全站视觉，Agent 浮层/计划卡/结果区难以独立演进 |
| `CanvasWorkspace.tsx` | 2680 | PR #20/#23 已拆协调器，根组件仍组合导航、面板、快捷键、节点菜单 |
| `AgentWorkspace.tsx` | 1627 | 路由、计划、确认、恢复、快捷操作、五个工具面板开关仍在同一文件 |
| `CanvasWorkspacePanels.tsx` | 1613 | 素材库、模板、生产工作流、历史挤在一起 |
| `src/domain/agent.ts` | 1482 | 运行时步骤文案、时间线、Mention、Artifact 合并、计划构造混在同一模块 |

`AgentConversationMessage` 已拆出，但吃进 20+ 回调 props，计划卡 UI 仍是巨型 JSX。这不是「再抽一层透传」，而是计划卡、欢迎态、任务列表应成为**拥有自己交互的深模块**，工作区只接线。

### 6.2 客户端模拟的执行过程 vs 服务端真实 trace

- `useAgentRuntimeTrace.ts` 用 50ms / rAF 推进「读取」步骤。
- 领域注释已承认：时间线「不是服务端事实」。
- `server/agentExecutionTrace.mjs` 与质量评测夹具闲置。

继续加客户端步骤会让排障更假。下一步应让 Runtime 订阅 Run/Job 的公开阶段，而不是再写一套 step id。

### 6.3 双写与兼容视图仍是运行时成本

ADR 0002 要求迁移完成前继续双写 `CanvasDocument.agentSessions / agentMemory / agentRuns`。这在 2026-08 仍是现状。每次项目保存都要合并独立实体与文档字段；PostgreSQL 路径已做差量同步，但心智上仍是两份 Agent 状态。

未完成双设备门禁就停双写会丢数据。完成门禁却不停，会让「Session 是权威」在代码审查里永远要解释一遍。这应是有明确验收的收口任务，而不是无限期兼容。

### 6.4 死接口与半截能力

- `workflow_create` 已注册权限与工具，客户端确认路径不用。
- `@` 引用只过滤 `kind === '素材'`，结果图、文字节点、生成节点不能被点名，尽管上下文快照类型支持它们。
- Chat ontology 有节点摘要，Planner 主要吃 selectedResult + 配方参考，两边看到的项目不是同一张图。
- `openai.yaml` 类技能清单不被读取，只加载 `SKILL.md`。
- `product-server-migration.md` 仍描述本机路径上的旧 Supabase 主存储方案，与当前 Railway PostgreSQL + S3、Supabase 仅 Auth 矛盾。

### 6.5 韧性上已经很好，但仍有产品化断点

值得保留：Run/Job 幂等、queued 无 Job 可补提交、分支重试、4xx 收口、离线消息队列。

仍伤体验的点：

- 确认与执行非原子：消息已标 submitted，enqueue 部分失败变成 `partial`，没有「撤回这次确认」。
- 5xx 悬挂靠轮询，Runtime 可能一直「处理中」。
- 审批 HMAC 15 分钟过期后，计划卡要重新走确认，但 Prompt 草稿在本地 `promptDrafts`。
- `agentMessageQueue` 不覆盖 Plan/Run 提交。
- 生产工作流取消后稳定 Run ID 可能让「再发布」变成死胡同（#28 已发现；因 PR 关闭，主路径暂未暴露，提升工作流时不要原样复制）。

---

## 7. 建议的加深顺序（按依赖，不按日历）

只列 Botanic 原生、可验证、不破坏幂等/媒体授权的步骤。

### 第一刀：让计划成为可执行配方

1. 把 `constraints[]` 编进 Provider Prompt，并写入 GenerationRecipe 快照。
2. 首次生成走 Planner 或 Prompt Pack 编译器，禁止用户原文直出。
3. 去掉全局「电商品牌首图」意图，改为任务类型意图。
4. 给约束遵守加离线夹具测试（不调用真实 Provider）：锁定维度必须出现在编译后的 Prompt 结构里。

完成标准：同一条「锁人物、换场景」计划，重放 Job 时得到同一份结构化约束；计划卡上的芯片与实际提交一致。

### 第二刀：收束入口，降低第一次成功

1. Agent 改为与画布分列的常驻工位（或至少推开画布而不是盖住结果）。
2. `@` 能引用素材、结果、文字；快捷「换场景」在无目标时改为「先选一张图」。
3. 计划卡默认只展示锁/变、参考、Prompt、预计输出数；路由与工具折进高级。
4. 明确三条入口的关系：节点 Composer = 手工配方；Agent = 计划确认；生产页签 = 已验证版本的批量重跑。计划完成态提供「提升为生产版本」。

### 第三刀：品牌可重复，而不是更会聊天

1. 落地 Prompt Pack MVP（9 个系列、任务类型、1～2 个变量、只写草稿）。
2. 赞踩 / 「可用」标记可提议 Memory，仍需确认。
3. 允许 Agent 走探索 refinement，以及视频计划（复用现有 H3 Job，不新建状态机）。
4. Runtime 改为投影公开 Run/Job 阶段；退役 rAF 假步骤。

### 明确不做

- 不把 Master Kang 的六阶段壳、TrendSignal、Brandwatch/Sprinklr、Campaign Kit 合进 Botanic。
- 不让效果数据自动改 Memory / 品牌规则。
- 不把 Agent 做成无确认的全自动出图。
- 不为了拆文件而加透传层；先移动拥有行为的模块。
- 不在未完成迁移门禁时停止 Agent 双写。

---

## 8. 审查时核对过的关键代码

- 路由：`src/domain/agentChatContract.ts` → `decideBotanicAgentRequest`
- 首次计划：`src/features/agent/AgentWorkspace.tsx` → `runInstruction`（无 `target` 分支）
- 本地计划：`src/domain/agent.ts` → `buildBotanicAgentPlan`
- LLM 计划：`server/botanicAgentPlanner.mjs`、`server/skills/botanic-agent-planner/SKILL.md`
- 执行：`server/botanicAgentExecution.mjs` → `recipeForRun`
- Provider 意图：`server/generationProvider.mjs` → `buildProviderPrompt`
- 确认卡：`src/features/agent/AgentConversationMessage.tsx`
- 浮层布局：`src/styles.css` `.agent-workspace`；`CanvasWorkspace.tsx` 写死 `app-shell--agent-closed`
- 生产工作流：`src/domain/productionWorkflows.ts`、`CanvasWorkspacePanels.tsx` 模板「生产」页签
- 闲置观测：`server/agentExecutionTrace.mjs`、`server/agentQualityEvaluation.mjs`

---

## 9. 一句话给后续实现

先让「锁定 / 变化」成为 Job 输入，再让 Agent 与画布同时可见，最后才把系列包、视频和评价闭环接上去。顺序反了，会继续做出一个恢复能力很强、创意语义很假的对话侧栏。
