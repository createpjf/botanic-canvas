# Botanic Agent 架构升级 Handoff（2026-08-18 → 08-20）

给**另一个已 fork Botanic 的仓库**里的 Agent 用。目标是复用同一套架构升级，而不是像素级抄 UI。

参考仓库：`https://github.com/createpjf/botanic-canvas`  
参考 `main` 顶端：`d81e17b`（#56）  
当前规范入口：`AGENTS.md` → `docs/PRODUCT_ARCHITECTURE.md` → `docs/CODEMAP.md` → `docs/ARCHITECTURE.md` → `docs/adr/`

不要把 `docs/` 里的历史验收、已完成计划当成当前规范。本文件是三天升级的快照说明书。

---

## 0. 对方 Agent 先读什么

按这个顺序读参考仓库，再动手：

1. `AGENTS.md`（约束与验证）
2. `docs/PRODUCT_ARCHITECTURE.md` §3 Agent Ontology、§4 权威来源
3. `docs/ARCHITECTURE.md` 依赖方向 + 受保护接口
4. `docs/CODEMAP.md` Agent 相关行（回合、mentions、时间线、变体、视觉、局部重绘、方案）
5. ADR 0001 / 0002 / 0003（图谱、Agent 实体、Artifact Index）
6. 设计稿（实现时以代码为准）：
   - `docs/superpowers/specs/2026-08-19-variation-prompt-writeback-size-design.md`
   - `docs/superpowers/specs/2026-08-19-agent-thinking-web-search-design.md`

对照参考实现时，用 `git show <sha>` / `git log --oneline 243ecf2^..d81e17b`，不要从聊天记录猜。

---

## 1. 这三天维护者怎么做的（流程表）

时间均为北京时间。维护者的方法是：**小步合进 `main`、立刻部署、用真实面板截图打回**；并行分支最后收成一条再合，避免多条长期 PR 互相打架。

| 日期 | 阶段 | 维护者实际做法 | 合进 main 的证据 |
|---|---|---|---|
| 8/18 中午 | 先把「能出图」修通 | 自然语言生图必须进 Plan，而不是闲聊。有图上下文才出计划。结果要回填节点，流式状态要对 | 直推 `44471db` `6fefc29` `883c64e` `a6d525c` |
| 8/18 下午 | 审计现有 Agent↔画布 | 不先加新能力。修产物落点、运行轨迹、结果面板、执行模式、Skill 超时、Prompt 连线 | [#31](https://github.com/createpjf/botanic-canvas/pull/31) [#33](https://github.com/createpjf/botanic-canvas/pull/33) |
| 8/19 上午 | 降确认噪音 | 控件/文案/任务卡先收。同一回答只流一次。结果面板出画面，节点不印全文 Prompt | [#34](https://github.com/createpjf/botanic-canvas/pull/34)–[#37](https://github.com/createpjf/botanic-canvas/pull/37) |
| 8/19 下午 | 变体做成领域能力 | 表格+可复制 Prompt → 无素材组单轴 → 规划器确认一次展开 → 裸确认只提交待确认计划 | [#38](https://github.com/createpjf/botanic-canvas/pull/38)–[#41](https://github.com/createpjf/botanic-canvas/pull/41) |
| 8/20 早晨 | 收并行 PR | #42 没单独合。变体独立 Prompt、自定义尺寸、Tavily 搜索打进 [#43](https://github.com/createpjf/botanic-canvas/pull/43)。#44/#45/#46/#47 先合成 [#48](https://github.com/createpjf/botanic-canvas/pull/48) 再进 main | 避免 4 条分支互相 rebase |
| 8/20 上午 | 回合成为权威 | 服务端 tool-calling 回合解析器拥有意图 + Prompt 合成。浏览器编排只执行决策，不再在 UI 里用正则判意图 | [#44](https://github.com/createpjf/botanic-canvas/pull/44) `server/botanicAgentTurn.mjs` + `src/domain/agentInstructionRouting.ts` |
| 8/20 中午 | 分层加视觉能力 | 按 6 批独立验证后才下一批：多模态 → mask 进 Job → 选区 UI + `region_edit` → 迭代闭合 → 方案分解 → 方案卡执行 | [#49](https://github.com/createpjf/botanic-canvas/pull/49) |
| 8/20 下午 | 语言与变体纪律 | 全站 locale 是单独 PR。变体轴只从用户原话解析，综合 Prompt 不得挖伪变体。选中态/执行模式下发到回合 | [#51](https://github.com/createpjf/botanic-canvas/pull/51) [#52](https://github.com/createpjf/botanic-canvas/pull/52) `20a6534` `24821da` |
| 8/20 下午 | 结构化输入 | Skill/素材从 Prompt 拆成芯片。`/` 挂 Skill，`@` 挂画布。只挂芯片发送时要有兜底指令，避免回合收到空正文 | [#53](https://github.com/createpjf/botanic-canvas/pull/53) |
| 8/20 傍晚 | 工具接到用户真路径 | 日常发送走回合，不走 chat。回合注册与 chat 同一套 `web_search`/`web_fetch`，否则模型会按规则拒绝「互联网调研」 | [#54](https://github.com/createpjf/botanic-canvas/pull/54) |
| 8/20 晚上 | 截图打回抛光 | 停止键、来源翻译、计划卡 2×2、自定义尺寸只在选 Custom 时横排。合完立刻 Vercel + Railway | [#55](https://github.com/createpjf/botanic-canvas/pull/55) [#56](https://github.com/createpjf/botanic-canvas/pull/56) |

工作习惯（请同样遵守）：

- 领域规则先落 `src/domain/` 或 `server/`，UI 只展示。
- 先聚焦测试，再 `npm test && npm run check:architecture && npm run build`。
- 不用真实生成 Provider / 真实搜索供应商做普通开发测试。
- 未经维护者明确要求，不要自动开 PR；这个仓库后来是维护者明确要求才合部署。
- 并行功能用一条合成分支审查，不要让 4 条 PR 同时改同一编排器。

---

## 2. 目标架构（必须对齐，不要各写一套）

```text
用户输入（自然语言 + /Skill芯片 + @画布芯片 + 可选选区）
        ↓
agentInstructionRouting.ts     纯决策：谁处理、是否已有意图、要不要追问
        ↓
  ┌─────┴──────────────────────────────────────┐
  │ 仅「全新用户发送」才进服务端回合              │
  │ 澄清答复 / 使用这段 Prompt / 执行语 / 选区    │
  │ / 方案卡点击 = 确定性本地路径                 │
  └─────┬──────────────────────────────────────┘
        ↓
botanicAgentTurn.mjs           tool-calling：读上下文、分解方案、出计划、联网
        ↓
kind: chat | clarification | composition | generation
        ↓
  chat          → 气泡 + 时间线（思考/工具/来源）
  clarification → 追问卡（设置完整性在这里保证）
  composition   → 方案消息 + 方案卡（不是独立实体）
  generation    → Plan 消息 → 用户确认 → Agent Run → 幂等 Job
        ↓
agentRunGenerationService.mjs  确认后服务端自主执行，浏览器是观察者
        ↓
GenerationJob + Artifact Index + 画布节点回填
```

权威来源（抄错会把 fork 做坏）：

| 状态 | 权威 | 禁止当成权威 |
|---|---|---|
| 生成进度/结果 | 持久化 GenerationJob | UI 占位、Toast、本地 loading |
| Agent 执行 | Session / Message / Memory / Run | `CanvasDocument` 同名字段（只是迁移视图） |
| 历史产物 | Artifact Index | 当前画布节点；删节点不得级联删历史 |
| 配方输入 | 生成节点入线 | Prompt 正文里的 @名称 |
| 变体张数 | 已确认轴展开结果 | 模型手写 batchCount |
| 工具进度 | 服务端 `registry.execute` 前后的 SSE | 客户端 rAF 假进度 |
| 原始思维链 | 默认不下发；`AGENT_RAW_REASONING=true` 仅当轮展示 | 写入 Message / Plan / Run / Artifact |

---

## 3. 建议在 fork 上的实施顺序

按参考仓库真实顺序做。**不要**先做停止键和计划卡 CSS。

### 批次 A — 出图闭环（对应 8/18）

先保证：自然语言生图进计划；有图片上下文才出图；结果回填独立节点；流式状态跟 Job 走。

入口：`src/domain/agent.ts` `inferBotanicAgentIntent`、`src/domain/generationOutputPlacement.ts`、`useCanvasAgentExecutionBridge.ts`。

### 批次 B — 确认与变体（对应 8/19 + #43）

1. 确认卡变薄：一行设置、Prompt 可折叠、裸「确认生成」只提交已有待确认计划。
2. 变体进规划器。无素材组也可单轴展开。
3. 每支独立 `promptDelta`。`plan.prompt` 只留共享底，不含取值清单。
4. 变体轴只从**用户原话**解析；润色后的综合 Prompt 不得再挖轴。
5. `src/domain/agentVariations.ts` 与 `server/botanicAgentVariations.mjs` 必须对拍。夹具：`scripts/fixtures/agentVariationMirrorCases.json`。
6. gpt-image-2 才允许 `outputWidth`+`outputHeight`；选目录比例时清掉自定义像素。

### 批次 C — 服务端回合（对应 #44，这是整轮升级的中轴）

1. 新增 `server/botanicAgentTurn.mjs`：tool-calling 拥有意图和 Prompt 合成。
2. 浏览器日常发送走 `/api/agent-intent/stream`（`streamBotanicAgentTurn`），不要再转 chat。
3. 把 `AgentWorkspace` 里的意图分支搬到 `src/domain/agentInstructionRouting.ts`。该文件只返回决策，不追加消息、不置忙、不发请求。
4. 只有全新用户发送进回合。澄清答复、「使用这段 Prompt」、执行语、带选区、方案卡点击保持确定性路径。
5. 提问不得当成确认提交。坏生成参数归一成 502，不要判成用户请求非法。超长历史要截断。

参考提交：`2e7a49f` `2eb2141` `844fc17` `5909409` `0d6734f`。

### 批次 D — 视觉 / 局部重绘 / 方案（对应 #49，内部再分 6 小批）

每小批独立测试后再做下一批：

1. `server/botanicAgentVision.mjs`：引用图以 `image_url` 进视觉模型；422/429/502 回退 caption；识别结果不落盘。
2. `GenerationRecipe.maskImage` 穿过 Job → Worker → `images/edits`。能力看模型目录 `supportsMask`。
3. `src/domain/regionMask.ts` 选区是归一化纯数据。`server/regionMaskPng.mjs` 按基准图像素落蒙版，服务端无 DOM。意图 `region_edit`。
4. 对话「只重画这块」弹出框选，回程直落 `region_edit`，跳过规划器和变体展开。自评 `bestNodeId` 成为下轮默认目标。
5. 回合工具 `decompose_creative_brief`。领域 `src/domain/agentCreativeComposition.ts`。消息 `kind: composition`，不是新实体。
6. 方案卡逐项/整套按钮绑定**该条消息自己的** composition。

### 批次 E — 芯片输入（对应 #53/#54 的 `/` `@`）

1. `src/domain/agentMentions.ts`：解析与消耗 mention。选中后只留芯片，不把名称写进可执行 Prompt。
2. `readBotanicAgentMentionQuery`：`/` 挂 Skill（边界不要误伤 `https://`、`3/4`）；`@` 挂画布节点/图片/视频。
3. 只挂芯片、正文为空时，Composer 要生成一句兜底指令，否则回合会收到空正文。
4. 点选画布图片、面板开着时，直接加入 `contextNodeIds`。

### 批次 F — 联网接到回合（对应 #43 工具 + #54 接线）

常见翻车：工具只注册在 `botanicAgentChat.mjs`，日常发送已经走 Turn，模型按系统提示说「没有外部来源」。

1. 搜索/抓取只在服务端：`server/botanicAgentWebTools.mjs`、`server/agentWebResearch.mjs`、`server/webSearchProvider.mjs`。
2. Turn 与 Chat **共用**同一套 web 工具组装。有 Key 才暴露 `web_search`；`web_fetch` 可单独存在。
3. 配额、SSRF、结果清洗只留服务端一份。浏览器不发图片字节或私有 URL。
4. 来源标签服务端用稳定中文（`互联网`/`网页`/`项目本体`…），展示层再按 locale 翻译，不改落库正文。
5. 时间线：`src/domain/agentTimeline.ts`。工具步只在 `registry.execute` 前后 emit。思考块在工具之后要**新开**一段，不要拼回第一段。
6. 原始推理默认不下发，打开也不入库。

### 批次 G — 语言与抛光（可后做，fork 可裁剪）

#51/#52 是产品 i18n，不是架构中轴。#55/#56 是窄栏计划卡和停止键。fork 若面板布局不同，对齐语义即可：规划可取消、自定义尺寸不要挤进比例格、校验文案跟 locale。

---

## 4. 文件对照（从参考仓库搬语义，不要整文件覆盖）

| 行为 | 领域 / 契约 | 服务端 | UI 编排 |
|---|---|---|---|
| 指令路由 | `src/domain/agentInstructionRouting.ts` | — | `AgentWorkspace.tsx` 只执行返回值 |
| 对话 vs 生成分流 | `src/domain/agentChatContract.ts` | `botanicAgentChat.mjs` | `src/lib/agentApi.ts` |
| 回合解析 | `agentPlanContract.ts`、`agentCreativeBrief.ts` | `server/botanicAgentTurn.mjs` | `streamBotanicAgentTurn` |
| 变体 | `src/domain/agentVariations.ts` | `server/botanicAgentVariations.mjs` | 计划卡 / 追问卡 |
| Mentions | `src/domain/agentMentions.ts`、`agent.ts` query | persistence 存芯片 | `AgentComposer.tsx` |
| 时间线 | `src/domain/agentTimeline.ts`、`agentChatStream.ts` | `agentToolRuntime.mjs` SSE | `AgentConversationMessage.tsx` |
| 联网 | — | `botanicAgentWebTools.mjs`、`agentWebResearch.mjs` | 只渲染来源芯片 |
| 视觉 | — | `botanicAgentVision.mjs` | 不把识别结果当记忆 |
| 局部重绘 | `src/domain/regionMask.ts` | `regionMaskPng.mjs`、generation provider | `RegionMaskEditor.tsx` |
| 方案 | `src/domain/agentCreativeComposition.ts` | turn 工具 `decompose_creative_brief` | 方案卡绑 message.composition |
| 确认后执行 | `agent.ts` Run/Plan | `agentRunGenerationService.mjs` | 浏览器观察 Run，不补打三跳 |
| 画布写回 | `agentMedia.ts`、output placement | Artifact Index + projection | `useCanvasAgentExecutionBridge.ts` |
| Agent 实体命令 | — | persistence + 三 Adapter | `src/store/canvasAgentActions.ts` |

HTTP：Agent 资源在 `server/agentRoutes.mjs`，目录仍在 `server/httpRouteTable.mjs`。

---

## 5. 不要搬、不要改的东西

除非 fork 的维护者明确要求：

- 幂等键、任务恢复、项目 `revision` / `graphRevision` 冲突、媒体授权 URL。
- Artifact 级联删除语义。
- ProductStore 三 Adapter 不同步改接口。
- 把领域规则写回 `src/components/` 或 `AgentWorkspace.tsx` 的大段 if/else。
- 投放链路的 `canUseForImageDelivery`（参考仓库明确没为 Agent 引用放宽它）。
- 用客户端动画伪造工具进度。
- 把 `reasoning_content` 写入任何持久化实体。
- 把图片字节 / 对象存储地址 / 私有媒体 URL 送给文本模型。

UI 像素（停止键颜色、计划卡 2×2、中英文文案）不是架构升级的验收标准。

---

## 6. 验收清单（按批次打勾）

- [ ] 用户说「生成一张…」且有图上下文 → 出现待确认 Plan，不是一段闲聊。
- [ ] 确认后出现 Agent Run；刷新后任务还在；重试复用同一幂等键。
- [ ] 「确认生成」在没有新计划时不会凭空造 8 张。
- [ ] 变体确认一次 → 分支数 = 取值数；每支独立 Prompt；原图还在。
- [ ] 综合 Prompt 里的「浅色/深色」不会被当成新的变体轴。
- [ ] 日常输入走回合；「帮我互联网调研」会调 `web_search`（有 Key 时），不会说没有外部来源。
- [ ] `/` 出 Skill 菜单，`@` 出画布菜单；芯片不进 Prompt 正文。
- [ ] 只挂芯片发送，回合仍能理解（有兜底指令）。
- [ ] 框选局部重绘 → `region_edit` 计划，不走变体展开。
- [ ] 成套需求 → `composition` 消息；刷新后仍能生成第 N 项。
- [ ] 思考/工具时间线来自 SSE 真事件；工具后思考是新块。
- [ ] 删除画布结果节点，Artifact Index 里历史还在。

验证命令（参考仓库）：

```bash
npm test
npm run check:architecture
npm run build
git diff --check
```

聚焦时至少跑：`src/domain/agent*.test.ts`、`src/domain/agentInstructionRouting.test.ts`、`server/botanicAgentTurn.test.mjs`、`server/botanicAgentChat.test.mjs`、变体镜像夹具。

---

## 7. 参考 PR / commit 速查

| 批次 | PR 或 commit | 说明 |
|---|---|---|
| A 出图闭环 | #31 #33，`6fefc29` `44471db` | 审计 + 生图进 Plan |
| B 变体 | #38–#41 #43 | 展开、独立 Prompt、自定义尺寸、Tavily 工具 |
| C 回合 | #44 #48，`2e7a49f` | 回合解析器 + 合成进 main |
| C 纪律 | `844fc17` `8690fb4` `20a6534` `24821da` | 执行语、伪变体、模式下发 |
| D 视觉方案 | #49 | 六批升级 |
| E 芯片 | #53 #54 | Skill/画布离开 Prompt |
| F 联网接线 | #54 | 回合注册 web 工具 |
| G 抛光 | #51 #52 #55 #56 | i18n 与计划卡，fork 可裁 |

被吸收后关闭、不要当独立实现源：#42（进 #43）、#46（进 #48）、#50（变体纪律后继提交）。

---

## 8. 给对方 Agent 的开工指令

你在一个 Botanic fork 里复现 `createpjf/botanic-canvas` 于 2026-08-18 至 08-20 的 Agent 架构升级。

先读本文件 §0 和 §2，再对照 fork 现状做差距表：哪些实体已有、日常发送是否已走服务端回合、web 工具是否只挂在 chat、变体是否仍用正则挖综合 Prompt。

然后按 §3 批次 A→G 做。每一批先写/改领域测试，再改拥有该行为的模块。不要把规则放进 UI。不要改幂等、恢复、媒体授权、Artifact 删除。不要为了对齐截图先改 CSS。

每批结束运行该模块聚焦测试和 `npm run check:architecture`。全部批次完成后再做 fork 自己的面板抛光。
