# Botanic 生产环境审计修复交接单

> 交接对象：Developer Agent
> 任务性质：生产环境问题修复，不是重新做一轮泛化评审
> 审计站点：[https://botanic-canvas.vercel.app/](https://botanic-canvas.vercel.app/)
> 实测时间：2026-08-30（Asia/Shanghai）
> 参考截图：`/Users/leo/.codex/state/plugins/product-design/audit/botanic-2026-08-30/`

## 0. 先执行的交接动作

1. 先检查 `git status --short`、`git diff --stat` 和当前分支。当前工作区已有大量未提交修改，均视为用户或前序 Agent 的工作，禁止 `git reset --hard`、批量覆盖或清理。
2. 阅读以下文档，再决定代码归属：
   - `docs/PRODUCT_ARCHITECTURE.md`
   - `docs/CODEMAP.md`
   - `docs/ARCHITECTURE.md`
3. 先在当前版本复现每个问题。若已经修复，补充验证证据，不要为了匹配旧审计结论继续改代码。
4. 只修本交接单范围内的问题。不要顺手重构、改视觉风格或替换 Provider。
5. 普通开发测试禁止调用真实生成 Provider；优先使用既有契约测试、Mock、故障注入和本地队列。用户已授权修复后的生产 smoke test，但只允许小样本、逐项记录成本和任务身份。

## 1. 目标

把 Botanic 从“画布和部分生成能力可用”推进到生产验收门槛：

- 生产工作流保存、运行、失败、重试和恢复具有 durable 状态；
- Agent 计划确认后能真正创建并完成生成任务，结果稳定写回画布、历史和 Artifact；
- 图片、视频和投放交付包可以真实下载，并有明确反馈；
- Provider 失败、模型能力不匹配和任务异常可诊断、可恢复；
- 关键 UI 文案与实际执行语义一致，用户不会误以为已完成但实际没有产物。

## 2. 非目标

- 不做全量视觉重设计，不替换 React Flow、队列、Store 或 Agent Runtime 架构。
- 不新增第二套任务状态机、第二套持久化或第二套 Provider 调用路径。
- 不删除审计期间创建的测试项目、素材组、记忆、Skill、节点或生成结果。
- 不执行真实淘宝/小红书/抖音发布，不修改账号安全设置，不退出登录。
- 不在本任务中完善未被实测触发的高级权限、计费后台或完整 WCAG 认证。

## 3. 完成定义

开发完成必须同时满足：

- 相关聚焦测试通过；
- `npm test`、`npm run check:architecture`、`npm run build`、`git diff --check` 通过；
- 生产工作流和 Agent 状态以持久化任务/Run/Artifact 为准，不以 Toast、本地 loading 或对话卡片为准；
- 本地、PostgreSQL、Supabase Adapter 的接口行为保持一致；
- 修复后重新走完第 8 节的浏览器验收矩阵；
- 报告中分别列明：代码测试、生产 smoke、Provider 结果、仍未覆盖的环境限制。

## 4. 已确认的生产基线

| 能力 | 实测结果 | 备注 |
| --- | --- | --- |
| 首页、项目列表、空白项目、重命名 | ✅ | 主入口可用 |
| 画布节点、连线、缩放、定位、历史 | 🟡 | 10%/58% fit-all 时节点过小，但聚焦可恢复 |
| 素材搜索、筛选、预览、分组 | 🟡 | 基础操作可用；“入库”语义异常 |
| GPT Image 2 直接生成 | ✅ | 单图成功，约 68 秒 |
| MiniMax Image 01 直接生成 | ✅ | 单图成功，模型自动调整为 1K |
| MiniMax H3 视频生成 | ✅ | 视频成功，约 5 秒，可加载预览 |
| Nano Banana / Flock 图片生成 | ❌ | 多次返回无可用图片 |
| GLM5、Kimi、Gemini Agent 文本对话 | ✅ | 纯文本连通性成功 |
| DeepSeek Agent 文本对话 | 🟡 | 长时间停在规划，手动停止后可取消 |
| Agent 计划模式真实出图 | ❌ | 确认生成后显示“服务发生未预期错误” |
| Agent 自动模式真实出图 | ❌ | 同样失败，且“可直接提交”与实际暂停确认冲突 |
| 生产工作流保存/运行/重试 | ❌ | 能显示已保存，但运行失败，重试无明显效果，重新进入项目后流程消失 |
| 图片/视频下载、投放交付导出 | ❌ | 未观察到真实下载文件，也没有可靠失败反馈 |
| 项目记忆、项目 Skill 创建和挂载 | ✅ | 主路径可用 |
| 协作动态 | 🟡 | 冲突提示频繁，事件有重复，解决动作不够明确 |
| 移动端 Agent + 画布 | ❌ / 🟡 | 390×844 下 Agent 几乎遮挡整个画布；若支持移动端则为阻塞 |

## 5. 修复任务

### P0-01：生产工作流保存后不可持久化

**复现路径**

1. 打开有成功生成结果的项目。
2. 进入“模板 / 生产”，选择一个生成节点，点击“保存当前生成流程”。
3. 确认页面显示 `生产 1`，并导入一行 CSV，例如：

   ```csv
   sku,channel,language
   TEST-1,tmall,zh
   ```

4. 运行当前版本，等待状态更新。
5. 离开项目，再次进入同一项目并打开“生产”。

**审计观察**

- 保存后页面显示了一个生产工作流。
- 运行后显示 `已失败`，但错误原因不清楚。
- 点击“重试失败项”后没有看到明确的新尝试或状态变化。
- 离开并重新进入项目后，生产列表显示 `生产 0`，原流程消失。

**期望行为**

- 工作流、版本、运行、每个批量项和失败原因在刷新及重新进入项目后仍存在。
- 运行状态来自 durable Run/Job；前端断线、刷新或关闭面板不影响后台执行。
- 重试必须遵循现有幂等和计费语义：保留旧失败记录，按现有领域规则创建稳定的新尝试，不静默重复扣费。
- 若运行失败，展示可操作的错误码、Provider、任务身份和恢复建议。
- 运行成功后结果、Artifact、历史和画布投影一致；部分失败不能覆盖成功项。

**优先检查入口**

- `src/features/canvas/CanvasWorkspacePanels.tsx`
- `src/lib/productionWorkflowApi.ts`
- `server/productionWorkflowRoutes.mjs`
- `server/productionWorkflowPublishService.mjs`
- `server/productionWorkflowAdvance.mjs`
- `server/productionWorkflow.mjs`
- `server/generationSubmissionService.mjs`
- `server/productStore.mjs`
- `server/postgresProductStore.mjs`
- `server/supabaseProductStore.mjs`
- `src/store/canvasDocumentMigration.ts`

先检查浏览器保存请求的响应、项目重新读取请求的响应和三个 Adapter 的写入路径，再决定是 API、Store、迁移兼容视图还是前端恢复逻辑的问题。不要只在面板中补一个本地状态。

### P0-02：下载与投放导出无法形成交付闭环

**复现路径**

- 在历史记录中下载成功图片和视频。
- 在“投放交付”中选择一张图片，保留淘宝、小红书、抖音三个规格，点击“导出 3 个规格”。
- 监听浏览器下载、网络响应和界面反馈。

**审计观察**

- 没有观察到浏览器产生真实下载文件。
- 导出等待超时，界面没有稳定的成功或失败状态。
- 不能让用户确认 ZIP 是否生成、包含多少文件、是否含 manifest。

**期望行为**

- 图片/视频下载能处理鉴权媒体 URL，使用稳定文件名，并在失败时给出原因。
- 投放导出产生包含各规格文件和 manifest 的 ZIP。
- 成功反馈必须来自真实 Blob/下载完成路径，不可只在点击后显示成功 Toast。
- 多次点击应防重复打包；导出中按钮应有禁用和恢复状态。

**优先检查入口**

- `src/lib/mediaDownload.ts`
- `src/lib/deliveryExport.ts`
- `src/features/canvas/CanvasEditorViews.tsx`
- `src/features/canvas/CanvasWorkspace.tsx`
- `src/features/canvas/CanvasWorkspacePanels.tsx`
- `server/deliveryManifest.mjs`
- `server/productionWorkflowRoutes.mjs`

### P0-03：Agent 真实生成执行失败

**复现路径**

1. 打开 Agent，保留一张画布参考图。
2. 计划模式输入：`把背景改成清晨的浅色海边，保留香薰瓶、标签文字和三分之一留白。`
3. 确认计划并提交生成。
4. 切换自动模式，再用类似提示词执行一次。

**审计观察**

- Agent 计划可以展示分支、模型、比例和张数。
- 真实执行后显示 `服务发生未预期错误` / `Agent 运行未完成`。
- 计划分支出现 `场景替换为保留香薰瓶`、`场景替换为标签文字` 等不完整拆解。
- 自动模式文案为“出图可直接提交”，但实际仍暂停要求确认。

**期望行为**

- 计划确认后只创建一个权威 durable Run，并通过现有生成提交入口创建 Job。
- Run、分支、Job、媒体、画布节点和 Artifact 的状态可刷新恢复，不能只更新聊天卡片。
- 锁定约束、变量轴、输出张数和模型能力在服务端重新校验；模型不能自行篡改锁定内容。
- 失败时展示具体阶段和错误原因；重试不能重复创建不明身份的计费任务。
- 计划模式和自动模式文案必须与真实确认门槛一致。
- Agent 生成结果应进入结果面板、历史、画布和 Artifact Index；任一写回失败时显示待恢复状态，而不是假成功。

**优先检查入口**

- `src/features/agent/AgentWorkspace.tsx`
- `src/features/agent/AgentComposer.tsx`
- `src/features/agent/AgentUtilityPanels.tsx`
- `src/lib/agentApi.ts`
- `server/botanicAgentTurnRuntime.mjs`
- `server/botanicAgentExecution.mjs`
- `server/agentRunGenerationService.mjs`
- `server/generationSubmissionService.mjs`
- `server/generationProcessor.mjs`
- `server/generationProvider.mjs`
- `server/flockGenerationProvider.mjs`
- `server/creativePlanResolver.mjs`

### P0-04：不可用 Provider 仍作为可选/默认路径暴露

**审计观察**

- Nano Banana/Flock 在不同项目和不同提示词下多次返回“Flock 图像服务没有返回可用的图片”。
- 重试表现为新增失败节点或重复尝试，不能解释是否扣费或是否复用任务。
- GPT Image 2 和 MiniMax Image 01 在相同生产站环境下可成功，说明需要优先检查 Flock 路由、响应解析、模型配置和 fallback，而不是笼统判断全链路不可用。

**期望行为**

- 提交前校验模型是否已配置、是否支持目标比例/分辨率/媒体类型。
- Provider 响应缺失媒体时，持久化明确的错误码和原始响应摘要，不把空结果当成功。
- 如果存在 fallback，必须符合现有计费和用户确认语义，不能静默换模型造成意外成本。
- UI 标记不可用模型，不把它作为无条件可执行选项。

## 6. P1 / P2 修复项

### P1-01：生成结果“入库”行为与界面语义不一致

成功生成后点击“将图片入库”，审计中没有成功 Toast，素材库“生成入库”仍为 `0 项`，部分情况下还创建了编辑节点。

验收要求：

- 点击“入库”只创建或幂等更新 `AssetRecord`，不隐式创建编辑节点。
- 生成入库后，素材库来源筛选立即可见该素材。
- 已入库状态来自持久化 AssetRecord，而非按钮本地状态。
- 图片点击、定位、继续编辑等动作使用不同的显式按钮，避免点击预览本身改变画布。

重点入口：`src/features/canvas/CanvasEditorViews.tsx`、`src/features/canvas/CanvasWorkspacePanels.tsx`、`src/store/canvasAssetGraphActions.ts`、三个 ProductStore Adapter。

### P1-02：失败提示、重试和 stale alert

- 生产运行失败后的错误信息过于泛化。
- 合法 CSV 导入后仍可看到之前空批量运行的 alert。
- Agent/Provider 失败没有统一的任务详情和恢复入口。

验收要求：每个错误反馈绑定具体操作和任务身份；新一次成功提交后清理无关的旧 alert；重试按钮必须展示新尝试是否真的创建。

### P1-03：协作冲突状态

- “画布有新的云端版本”提示频繁出现。
- 协作动态有重复的成员事件。
- `暂留本地`、`使用云端版本`、`全部已读` 的关系不够明确。

验收要求：冲突显示本地/云端 revision 和影响范围；解决动作明确且可恢复；事件去重；读取/清空失败不会伪造成功。

重点入口：`src/features/canvas/useCanvasWorkspaceSynchronization.ts`、`src/lib/projectCollaboration.ts`、协作事件 Store/Adapter。

### P1-04：移动端工作区

如果产品支持移动端，需保证 390×844 下 Agent、画布、项目切换和输入框可以互相切换；不能让 Agent 面板永久遮住唯一的工作区。若产品明确仅支持桌面端，应在入口、响应式样式和文档中明确限制，而不是提供一个不可用的半响应式布局。

### P2-01：画布 fit-all 可读性

`显示全部` 会把画布缩到约 58% 或更小，节点变得难以阅读。优先保证聚焦选中节点、最小可读缩放和清晰的回到工作区入口；不要为了视觉居中牺牲可操作性。

### P2-02：模板创建和元数据

模板创建得到的项目名为 `01 · 项目`，模板内容和模型元数据不够透明；保存模板时曾观察到展示模型与当前节点模型不一致。验收时需检查模板快照是否只保存稳定配方，不带已执行任务、媒体字节和过期 Provider 状态。

## 7. 实现约束

- 先确认行为归属，再修改拥有该行为的模块；不要把生产、Agent 或持久化规则塞回 UI。
- `src/components/` 保持纯 UI，不直接访问 Store、网络或服务端。
- GenerationJob、Agent Run、Artifact、AssetRecord 和生产工作流记录是状态权威；Toast、占位节点、本地选择态不是。
- 不改变现有幂等键、任务恢复、版本冲突、媒体授权和取消语义，除非修复本身证明当前实现违反了这些不变量。
- ProductStore 有本地、PostgreSQL、Supabase 三个 Adapter；跨 Adapter 契约变更必须同步实现并测试。
- Artifact Index 是历史血缘目录；删除画布节点或素材引用不能级联删除历史 Artifact。
- 不把 Provider 原始推理、媒体凭据或私有媒体 URL写进普通 Agent 消息、Memory、Run 或 Artifact Index。
- 不用真实生成 Provider 代替单元/契约测试；生产 smoke 只做最小数量的已授权样本。

## 8. 验收矩阵

### 本地 / CI

- 生产工作流：发布、读取、CSV 运行、单项失败、失败重试、刷新恢复、版本不可变。
- 生成任务：Provider 空响应、格式错误、超时、部分输出、重复提交、写回失败。
- Agent：计划确认、自动模式、取消、断线恢复、结果写回、Artifact 写回、Provider 错误展示。
- 下载：鉴权媒体 Blob、文件名、ZIP manifest、导出失败、重复点击。
- Adapter：本地、PostgreSQL、Supabase 的同一契约测试。
- 最小命令：

  ```bash
  npm test
  npm run check:architecture
  npm run build
  git diff --check
  ```

### 浏览器 smoke

1. 新建或打开测试项目，添加参考素材。
2. 直接用一个已验证可用模型生成 1 张图片和 1 个视频。
3. 刷新、离开项目、重新进入，确认节点、历史、媒体和 Artifact 均保留。
4. 将图片加入素材库，切换“生成入库”来源，确认 AssetRecord 可见且不新增编辑节点。
5. 下载图片、下载视频、导出至少两个投放规格，确认真实文件存在且 UI 有结果反馈。
6. 保存生产工作流，导入一行 CSV，运行并等待终态；再次进入项目确认工作流和运行记录仍在。
7. 使用受控 Provider 成功执行一次 Agent 计划生成，确认 Run → Job → Media → Canvas → History → Artifact 全链路一致。
8. 注入一次失败并重试，确认旧尝试保留、新尝试身份明确、不会重复覆盖成功结果。
9. 刷新或断开观察连接后重新打开 Agent，确认对话、Turn、Run 和结果可恢复。
10. 若支持移动端，再测 390×844 的 Agent/画布切换；若不支持，确认产品明确声明桌面端范围。

### 修复后生产 smoke

只在部署完成且用户授权仍有效时执行，建议每条链路最多 1 个样本：

- 记录部署 URL、commit/revision、浏览器、模型、开始/结束时间、耗时、任务 ID、Run ID、Job ID、Artifact ID 和实际成本。
- 优先使用 GPT Image 2 或 MiniMax Image 01 作为已知可用基线，再单独验证 Flock/Nano Banana 修复结果。
- 不做批量生产，不真实发布平台，不删除测试数据。
- 若失败，保留错误证据并停止扩大样本，不用反复点击“重试”猜测状态。

## 9. 审计遗留数据与证据

本次审计期间在生产站创建或保留了以下测试数据：

- 测试项目：`创意项目 4`、`01 · 项目`
- 素材组：`QA 走查组`
- 项目记忆：`测试记忆：商品标签文字不可改变。`
- 自定义 Skill：`测试留白规范`
- 若干图片、视频、失败任务和生产流程相关记录

这些数据目前**没有删除**，开发 Agent 不得自行清理。截图证据位于：

`/Users/leo/.codex/state/plugins/product-design/audit/botanic-2026-08-30/`

重点文件：

- `02-production-lost.png`：生产流程重新进入项目后显示 `生产 0`
- `03-canvas-result.png`：生成结果、继续编辑和入库入口
- `04-agent-panel.png`：Agent 计划/自动状态和失败反馈
- `05-delivery.png`：投放交付规格和导出入口
- `07-mobile-agent.png`：移动端 Agent 遮挡画布

## 10. 交付报告格式

修复完成后请按以下结构回报，不要只说“已修复”：

1. 修改文件和每个文件的行为归属。
2. P0/P1/P2 哪些已完成、哪些未完成。
3. 每个问题的复现前后结果。
4. 聚焦测试、全量测试、架构检查、构建结果。
5. 生产 smoke 的部署 revision、任务身份、耗时和成本。
6. 仍存在的环境限制或未执行动作。
7. 当前 Git 分支、commit、未提交文件和是否已推送。

最终目标不是让面板看起来成功，而是证明：用户可以从 Agent 意图独立完成生成、审阅、保存、恢复并下载交付物。
