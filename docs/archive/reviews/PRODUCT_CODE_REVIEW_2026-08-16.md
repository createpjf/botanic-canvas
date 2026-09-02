# Botanic 产品与代码深度评审（2026-08-16）

本文是一次**时点评审**，不是当前规范。规范入口仍是 [文档索引](README.md)。

评审基线：`main` @ `2d736ba`。评审同时执行了全部门禁，结论是**门禁全绿**：

| 门禁 | 结果 |
| --- | --- |
| `npm test` | 236 服务端/脚本 + 208 客户端，全部通过 |
| `npm run check:architecture` | OK |
| `npm run check:security` | OK |
| `npm run build` | OK（`CanvasWorkspace` chunk 491 kB / gzip 153 kB） |

**因此本文讨论的问题都不是"坏掉的代码"，而是"门禁看不见的问题"**：产品语义的落差、只有人眼能发现的体验断裂、以及只有多实例真实流量才会暴露的运行时缺陷。这类问题正是当前工程体系的盲区，也是本次评审的重点。

---

## 一、结论摘要

Botanic 的文档把自己定义为"项目创作图谱 + 执行记录 + 历史产物"的持续工作台，Ontology 定义了 10 个受控创作维度、preserve/vary 语义、Plan/Run/Skill/Memory/Artifact 五类 Agent 实体。**这套 Ontology 的持久化、鉴权、幂等、血缘部分实现得相当扎实，但"创意生产"部分基本停在契约层。**

最关键的五条结论：

1. **创作维度无法规模化展开。** 产品承诺"用受控维度表达变化"，但执行层只支持沿**一个**素材组轴展开，总量硬上限 20 张。"变化场景"这条约束不会产生 N 个场景，只会产生 1 张图。这是"可规模化 AIGC 创意工作流"这个命题上最根本的缺口。
2. **`constraints`（锁定/变化）是纯装饰。** 它被 LLM 生成、被服务端校验、在确认卡上渲染成"锁定 · 场景"的标签，然后在提交生成任务时被完全丢弃。用户看到的承诺没有任何机制保证。
3. **产品有一个 96 处写入、0 处读取的反馈通道。** `assistantMessage` 承载了从"任务已入队"到"视频模型尚未配置"的几乎全部系统反馈，但没有任何组件订阅它。用户在大量场景下得到的是静默。
4. **默认落地页是一个假的经营驾驶舱。** 硬编码的 KPI、假的待决事项、6 个 disabled 的导航项，是新用户看到的第一屏，真正的产品在第二跳。
5. **Agent 运行轨迹给用户看的是前端动画，真实的服务端 trace 已经实现但没人消费。** `useAgentRuntimeTrace` 用 50ms 定时器逐条点亮"读取上下文"步骤；`server/agentExecutionTrace.mjs` 的真实 traceId 链路和 `/api/agent-runs/:id/trace` 端点没有任何 UI 接入。

另有两个必须尽快修的运行时缺陷（详见第四章）：`reclaimStaleActive` 会误删无关的在途任务；`project.updated` 不跨实例广播，与 canvas/agent 事件的处理方式不一致。

---

## 二、产品逻辑评估：现在的 Agent 工作流到底是什么

### 2.1 实际链路

```text
用户输入
  → decideBotanicAgentRequest（15 条正则的手写 NLU，纯客户端）
      ├─ chat        → /api/agent-chat（真 LLM + 4 个只读工具，≤5 步）
      ├─ clarification → 一条提示消息，链路终止
      └─ generation
            ├─ 无已选结果 → buildBotanicAgentPlan（本地模板，无 LLM）
            └─ 有已选结果 → /api/agent-plans（真 LLM Planner + 工具，≤4 步）
  → 计划卡 pending → 用户确认（或 auto 模式自动确认）
  → createPersistentAgentRun → generation_submit（HMAC 审批令牌）
  → prepareAgentRunExecution：每分支 1 个 Job + 1 组画布节点
  → 复用普通生成队列 → 回写画布 → Artifact Index
```

这是一条 **"正则路由 →（有条件的）LLM 规划 → 人工确认 → 程序化批量提交"** 的流水线，不是端到端的 agent loop。这个定位本身没问题——对付费生成做强确认门控是正确的产品判断——但它意味着"Agent 的智能"几乎全部集中在**一次** Planner 调用上，而这一次调用的产出又在执行时被大幅丢弃。

### 2.2 Ontology 承诺 vs 代码落地

| Ontology 概念 | 契约层 | 执行层 | 落差 |
| --- | --- | --- | --- |
| 10 个创作维度 | 完整定义（`src/domain/agent.ts:14`） | 未使用 | 维度只是标签 |
| preserve / vary | LLM 产出 + 服务端校验（`server/botanicAgentPlanner.mjs:298-311`） | 未传入生成请求 | **纯装饰** |
| Plan.output 分支 | `single` \| `batch_by_asset`（`src/domain/agent.ts:480`） | 分支数 = 素材组成员数 | 无维度笛卡尔积 |
| Skill | 项目内可审核的受控操作 | 自由文本 instructions，写一个文字节点 | 不是可执行资产 |
| Memory | 长期创作规则 | 最多 30 条被动注入 Planner 的 JSON | 无检索、无排序、无学习 |
| Agent Run | 可恢复执行记录 | 实现扎实（幂等键、分支重试、断线补提交） | ✅ 达标 |
| Artifact Index | 历史血缘目录 | 实现扎实（游标分页、不随画布删除） | ✅ 达标 |
| Action Proposal/Receipt | 确认后执行 | 实现扎实（HMAC 审批、回执幂等） | ✅ 达标 |

**规律很清晰：凡是"记录与治理"的部分都做到位了，凡是"创意生产"的部分都停在类型定义。** 这与团队过去几轮的迭代重心（迁移、持久化、权限矩阵、协作历史）完全吻合，也说明下一轮的重心应该换方向。

---

## 三、规模化能力的六个断点

### 3.1 创作维度无法笛卡尔展开（P0，最高优先级）

批量的唯一形态是"一个素材组 × 每素材 N 张"，且总量硬上限 20：

```23:25:src/domain/batchVariations.ts
    if (input.group.assetIds.length * candidatesPerAsset > 20) {
      throw new Error(`单次批量最多创建 20 张结果；当前为 ${input.group.assetIds.length} × ${candidatesPerAsset}。`)
    }
```

Agent 侧同样只有两种 output 模式，分支数由素材组决定，不由 LLM 指定：

```480:483:src/domain/agent.ts
    mode: 'single' | 'batch_by_asset'
```

Agent Run 的上限同样是 20 分支 / 20 count / 8 candidates（`server/botanicAgentRun.mjs:140-144`）。

**这意味着品牌视觉生产最典型的需求——"3 个场景 × 4 件商品 × 2 种光线 = 24 个组合"——在产品里无法表达。** 用户只能手动跑 3 次批量，再自己拼结果。对一个自称"可规模化"的创意工作流，这是定义性的缺失。

建议方向：把 `output` 从"单轴 + count"升级为**维度矩阵**（每个 `vary` 维度携带取值列表，执行层做笛卡尔积并展平成分支），把 20 的硬上限换成"预算/配额驱动的软上限 + 分批执行"。这需要 `src/domain/agent.ts` 的 Plan 契约、`server/botanicAgentExecution.mjs` 的分支构建、`src/domain/batchVariations.ts` 的并发协调器同步演进，属于跨层改动，必须先固定契约再逐层落地。

### 3.2 `constraints` 不进入执行（P0）

Plan 的 constraints 经过了完整的生成、校验、持久化和渲染：

```309:311:server/botanicAgentPlanner.mjs
  if (!constraints.length || !constraints.some((item) => item.mode === 'vary')) {
    throw new BotanicAgentPlannerError(502, 'INVALID_PROVIDER_RESPONSE', ...)
  }
```

确认卡上渲染成"锁定 · 场景 / 变化 · 服装"的标签（`src/features/agent/AgentConversationMessage.tsx:144-145`）。

但提交生成时，只有 prompt、references、settings 被传下去：

```122:129:server/botanicAgentExecution.mjs
  return {
    references,
    prompt: run.plan.prompt,
    batchCount: run.plan.output.mode === 'single'
      ? run.plan.output.count
      : run.plan.output.candidatesPerItem,
    settings: clone(run.plan.settings),
  }
```

`constraints` 在整个 `server/botanicAgentExecution.mjs` 中一次都没出现。**"锁定人物"能否生效，完全取决于 Planner 是否恰好把这句话写进了 prompt 文本。** 用户界面给出的是一个契约级的承诺，实现给的是一个概率。

同一函数里 `refinementMode` 被硬编码为 `'faithful'`（`server/botanicAgentExecution.mjs:139`、`:174`、`:188`），Agent 路径无法使用普通生成路径已经支持的其他精修强度——这也是同一个问题的另一面：Plan 表达力比执行层丰富，多出来的部分被静默丢弃。

### 3.3 首次生成完全绕过 Planner（P1）

有已选结果时走真 LLM Planner，没有时走本地模板，prompt 直接等于用户原话：

```1250:1251:src/domain/agent.ts
    ? { mode: 'batch_by_asset' as const, count: batchCount, candidatesPerItem: 1 }
    : { mode: 'single' as const, count: 1, candidatesPerItem: 1 }
```

服务端 Planner 的 `INTENTS` 集合甚至不包含 `initial_generation`（`server/botanicAgentPlanner.mjs:5-8`），说明这是有意为之的分叉。

后果是**新用户的第一次体验质量最低**——恰恰是决定留存的那一次。"给我做一张夏日香氛的商品图"会被原样送进模型，而同一个用户在有了结果之后说"换个场景"，反而能享受完整的 prompt 工程。这个体验梯度是反的。

### 3.4 意图路由是 15 条手写正则（P1）

整条链路的第一个决策点——这句话是聊天、是改 prompt、是检索，还是要花钱生成——由纯客户端正则决定：

```170:175:src/domain/agentChatContract.ts
  if (explicitVisualGeneration.test(text) || explicitVisualChange.test(text)) {
    return { kind: 'generation', mediaKind, promptSource: 'instruction' }
  }
  if (hasGenerationTarget && /^(?:保持|继续|再来|重试|重新|换|替换|调整)(?!.*[?？])/iu.test(text)) {
    return { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' }
  }
```

配套的正则常量本身已经复杂到难以维护（`src/domain/agentChatContract.ts:91-95`，单条正则超过 200 字符）。git 历史里的 `14ef2b2 修复：Agent 提示词意图误建空节点` 正是这类误判的产物。

代码注释把它定位为"防止 Agent 因一句'图片怎么改'就创建空节点的单一边界"——这个**意图是对的**（误判为生成会花钱、会污染画布，比误判为聊天严重得多），但用正则实现这个边界会持续产生长尾误判，而且每个误判都要靠新增一条正则来修，复杂度只增不减。

建议方向：保留正则作为**低成本的快速通道**（明确的"生成"关键词直接放行，明确的疑问句直接进聊天），中间的模糊地带交给一次廉价的服务端分类调用，并让"是否要生成"这个决策**永远以确认卡收口**——只要确认门控可靠，误判为生成的代价就从"花钱"降级为"多一次点击"。

### 3.5 没有任何质量闭环（P1）

- 消息上有 `feedback: 'positive' | 'negative'` 字段，持久化了，但没有任何消费者把它送回 Planner 或 Memory。
- `server/agentQualityEvaluation.mjs` 名字像创意质量评测，实际只统计成功率、等待时长、重复提交率、回写完整度，而且是**离线夹具评测器**，全仓库只有它自己的测试文件引用它。
- 没有生成后的评图、没有基于失败的自动改写、没有"这次成功的配方"被复用的机制。
- Memory 只能靠用户手动录入，Planner 只是被动接收最多 30 条 JSON（`server/botanicAgentPlanner.mjs:174-185`），没有相关性排序，也没有像 Chat 那样的 `project_memory_search` 工具。

**结果是这个 Agent 用一年也不会变得更懂这个品牌。** 对一个定位为"持续存在的项目创作图谱"的产品，这是产品叙事上最大的自相矛盾：系统积累了完整的历史血缘，却不从中学习。

### 3.6 Skill / MCP 是文本，不是可执行资产（P2）

项目 Skill 的本质是一段自由文本 instructions，`skill_run` 在规划阶段只是把文本取出来并提议一个"写文字节点到画布"的行动。内置 Skill 只有 3 个。没有版本、没有触发条件、没有参数 schema、不可组合。

MCP 侧有完整的白名单、审批令牌、超时控制（安全做得好），但只有单轮 `tools/call`，结果不回流到 Planner 做二次规划，且返回值 `structuredClone` 后直接进 Artifact，没有 schema 校验或体积约束。

---

## 四、必须尽快修的运行时缺陷

这两条不属于"改进建议"，属于缺陷。

### 4.1 `reclaimStaleActive` 会误删无关的在途任务（P0）

```29:36:server/generationQueue.mjs
    async reclaimStaleActive(jobId) {
      const job = await queue.getJob(jobId)
      if (!job || await job.getState() !== 'active') return false
      const removed = await queue.clean(0, 1, 'active')
      if (!removed.includes(jobId)) return false
      await queue.add('generate', { jobId }, { jobId })
      return true
    },
```

`queue.clean(0, 1, 'active')` 清理的是**任意一条** active 任务，不是参数里的 `jobId`。当 Worker 每 30 秒扫描到一个 stale 任务时，这行代码可能删掉另一个**正在健康执行**的任务，然后因为 `removed` 不包含目标 `jobId` 而返回 `false`——目标任务没被恢复，无辜任务被杀，并且没有任何日志说明发生了什么。并发越高，误伤概率越大。

同时，`server/worker.mjs` 在 reclaim 之后**没有把数据库里的 `running` 状态改回 `queued`**，所以恢复路径本身也是不完整的。

### 4.2 `project.updated` 不跨实例广播（P1）

Canvas 的 Yjs 增量和 Presence 通过 `canvasRealtimeEventBus` 跨实例（还带 HMAC 验签），Agent Run 和协作动态通过 `agentRunEventBus` 跨实例，唯独 HTTP 保存触发的 `project.updated` 只推本实例的 socket：

```365:367:server/realtimeHub.mjs
      for (const socket of clientsByProject.get(projectId) ?? []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload)
      }
```

节点和连线因为走 CRDT 所以能同步，但**素材库新增、模板保存、历史摘要、生成任务快照这些非图谱变更，在多 API 实例下不会推给其他实例的协作者**。这是一个只在扩容后才暴露的问题，单实例测试永远发现不了。

顺带：`agentRunEventBus` 的 Redis 消息**没有签名**，而 `canvasRealtimeEventBus` 有。同一个威胁模型下两套标准，应当对齐。

---

## 五、使用体验问题

### 5.1 反馈黑洞：96 处写入，0 处读取（P0）

`assistantMessage` 在 `src/store/canvasStore.types.ts:90` 声明，在 store 各 action 中写入 92 次，在 `useCanvasWorkspaceSynchronization.ts` 写入 4 次，在 `CanvasWorkspace.tsx` 写入 2 次——**没有任何 `.tsx` 读取它**。

被吞掉的反馈包括：

- `'正在用原幂等键确认任务，不会重复生成。'`（`canvasGenerationActions.ts:399`）
- `'取消请求未能同步到服务端，请在任务面板稍后确认状态。'`（同上 `:557`）
- `'视频模型尚未配置，请先检查 MiniMax H3。'`（`CanvasWorkspace.tsx:2096`、`:2440`）
- `'画布已同步。' / '已切换到云端版本。'`（`useCanvasWorkspaceSynchronization.ts:225-257`）

配套的 `.canvas-sync-status` 样式在 `src/styles.css` 里写好了，同样零引用。看起来这是一次重构中丢失的渲染出口，之后所有新增反馈都继续往这个洞里写。

**用户侧的实际表现：点了视频生成没反应且没有任何解释；任务在后台恢复而界面完全静默；取消失败但用户以为成功了。** 这一条的修复成本极低（加一个订阅该状态的通知区域），收益极高，应该排在所有改进的最前面。

### 5.2 默认落地页是假的（P0）

`defaultWorkspaceLocation` 是 `{ view: 'dashboard' }`（`src/features/canvas/CanvasWorkspace.tsx:193`），而这个 dashboard 是：

```93:98:src/components/WorkspaceViews.tsx
        <section className="dashboard-kpis" aria-label="核心经营指标">
          <article className="is-primary"><span>今日支付额</span><strong>¥126,400</strong><small>较昨日 +18.6% · 淘宝 ¥98,720</small></article>
```

KPI、待决事项、经营脉搏曲线全是硬编码常量（`WorkspaceViews.tsx:31-35, 93-120`），侧栏 9 个入口有 6 个 `disabled title="该模块尚未开放"`，"生成审批包"下载的是把硬编码数组转成的 JSON。

**新用户第一屏看到的是一个明显造假的仪表盘和一排灰掉的按钮，真正能用的产品在"创意生成"后面。** 这对产品可信度的伤害远大于它作为演示素材的价值。建议要么把默认落地页改为项目库，要么让驾驶舱接真实数据，要么把它移到明确标注的演示入口下。

### 5.3 假进度条 vs 未接入的真 trace（P1）

`useAgentRuntimeTrace` 的"上下文读取"步骤是纯前端动画：

```84:91:src/features/agent/useAgentRuntimeTrace.ts
  const completeContextReads = useCallback(async (runtimeSteps: BotanicAgentRuntimeStep[]) => {
    const contextSteps = runtimeSteps.filter((step) => !['call-planner', 'finalize-plan', 'create-workflow', 'respond'].includes(step.id))
    for (const step of contextSteps) {
      updateStep(step.id, 'running')
      await yieldRuntimeFrame()
      updateStep(step.id, 'succeeded')
    }
  }, [updateStep])
```

`yieldRuntimeFrame` 是一个 rAF + 50ms 超时的延迟（`:13-26`）。这些步骤与服务端是否真的读了画布、检索了记忆没有任何关系。

与此同时，`server/agentExecutionTrace.mjs` 实现了串联 Run/Job/Artifact 的稳定 traceId，`/api/agent-runs/:id/trace` 端点存在，`src/lib/agentApi.ts` 里的读取函数也写好了——**全仓库没有任何 UI 调用它**。

真实数据在服务端躺着，界面上演的是动画。这不只是"体验不好"，在排障时它会主动误导用户和支持人员。

### 5.4 批量变体不可取消（P1）

Store 契约里有 `runBatchVariation`、`retryBatchVariationItem`、`resumeBatchVariations`（`src/store/canvasStore.types.ts:137-163`），**没有 `cancelBatchVariation`**。而普通图片生成是可以取消的。

用户提交了一个 20 张的批量之后，唯一能做的就是等它跑完并烧掉配额。考虑到日配额默认只有 100 张（`SECURITY_GENERATION_OUTPUTS_PER_DAY`），一次误操作会吃掉当天 20% 的额度且无法挽回。

### 5.5 画布基础操作缺失（P1）

| 缺失 | 证据 |
| --- | --- |
| 键盘删除节点 | `deleteKeyCode={null}`（`CanvasWorkspace.tsx:1981`），只能点节点内的删除按钮 |
| Cmd/Ctrl+Z 撤销 | 全仓库无该快捷键绑定，只有一个 `UndoToast` |
| 画布/节点搜索 | 无任何实现（素材库和 Agent 会话有搜索，画布没有） |
| 批量操作 | 多选工具栏只有"取消选择" |
| 快捷键说明 | Space 平移、Shift 框选、Esc 关面板均未在界面任何位置说明 |

对一个无限画布产品，"选中节点按 Delete 删不掉"是会被用户当成 bug 报告的。

### 5.6 面板互斥造成上下文丢失（P2）

`nextExclusiveSurface` 在画布和 Agent 各维护一套互斥状态（`CanvasWorkspace.tsx:721`、`AgentWorkspace.tsx:273`）。实际表现是：打开 Agent 会强制关掉正在编辑的 composer；打开素材库会关掉 composer；打开 Agent 工具面板会**整体替换对话区**，让用户以为对话丢了。

互斥的初衷（避免面板打架、小屏可用）是合理的，但代价是用户在"看素材 → 写提示词 → 问 Agent"这个高频循环里不断丢失上下文。这三件事恰恰需要同时可见。

### 5.7 无 i18n（P2）

约 950 处中文字面量散落在 TSX 中（`CanvasWorkspacePanels.tsx` 260 处、`CanvasEditorViews.tsx` 125 处、`AgentWorkspace.tsx` 115 处），日期格式硬编码 `Intl.DateTimeFormat('zh-CN')` 至少 4 处，没有任何 i18n 框架。如果产品有出海或多语言客户的计划，现在是抽取成本最低的时刻。

---

## 六、工程与代码质量

### 6.1 上帝组件

| 文件 | 行数 | 问题 |
| --- | --- | --- |
| `src/features/canvas/CanvasWorkspace.tsx` | 2680 | 路由 + tab + React Flow + 账户 + 全部面板 + composer + Agent 桥接，60+ 处 store 订阅 |
| `src/features/agent/AgentWorkspace.tsx` | 1627 | 对话 + 规划 + 运行轨迹 + 5 种工具面板，子组件 prop 达 20+ |
| `src/features/canvas/CanvasWorkspacePanels.tsx` | 1613 | 素材库/生成/交付/模板/历史/批量变体同文件 |
| `src/features/canvas/CanvasEditorViews.tsx` | 1162 | 所有 RF 节点 + composer，节点内直接调 `refinePrompt()` 等网络请求 |

`check:architecture` 通过是因为它检查的是 `src/components/` 的纯净度和依赖方向，而这些文件都在 `src/features/`——**边界检查覆盖不到 features 层内部的膨胀**。`src/components/` 确实保持了纯 UI，规则本身是有效的，只是保护范围需要扩展。

结果是 `CanvasWorkspace` 打包出 491 kB（gzip 153 kB）的单 chunk，且任意 store slice 变化都可能触发大范围重渲染（React Flow 节点组件未 memo，`ResultNode` 内有 8 个 store 选择器 + 1 秒定时器）。

### 6.2 三个 Store Adapter 无契约测试覆盖

`server/productStoreContract.test.mjs` 只对本地文件 store 断言契约。`postgresProductStore.mjs`（1586 行）和 `supabaseProductStore.mjs`（1078 行）**没有任何集成或契约测试**。

这一点可以从测试运行时间反推：整个 `npm test` 在 `node_modules` 完全缺失的情况下仍能跑过 228 个用例——说明测试体系里没有任何东西真的连过 Postgres、Redis 或 Supabase。

同时 schema 有两个来源：Postgres adapter 在启动时 inline 执行 DDL 并补建索引（`postgresProductStore.mjs:89-300`），Supabase 走 `supabase/migrations/`。两条轨道长期必然漂移——目前 Supabase 迁移里只有一个 `jobs_status_updated_at_idx`，缺少 `(project_id, updated_at)` 这类查询索引。

### 6.3 未拆除的双写兼容层

ADR 0002 和 ARCHITECTURE 都写明"迁移完成且双设备验收通过后才停止双写"，这个门禁至今未关闭。当前每次 `writeProject` 都要从 document 同步一遍 Agent 实体，Supabase 路径下同步失败只 warn 不回滚：

```442:447:server/supabaseProductStore.mjs
      try {
        await syncAgentStateFromDocument(userId, document, previous?.document)
      } catch (caught) {
        console.warn(`[agent-persistence] entity sync deferred for ${document.id}: ...`)
      }
```

存在 document 与独立实体表短暂不一致的窗口。生产工作流定义和运行历史也仍然嵌在项目文档的"兼容扩展区"（`server/productionWorkflowRoutes.mjs:53`），会持续推高 document 体积。

**双写不是免费的**：它同时放大了写放大、冲突概率和不一致窗口。应该给这个门禁定一个明确的关闭条件和负责人，而不是让它无限期挂着。

### 6.4 全文档读-改-写的写放大

Worker 回写画布的路径是"读整个项目 → 内存 reconcile → 乐观锁写回"，冲突时最多重试 5 次：

```35:49:server/generationProcessor.mjs
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const project = await productStore.readProject(job.ownerId, job.projectId)
```

而 `readProject` 一次最多加载 40000 条 agent 消息（`postgresProductStore.mjs:623`），`writeProject` 写回完整的 `document` JSONB。Postgres 连接池默认只有 4（`postgresProductStore.mjs:79`）。

把这几条放在一起看：**一个 20 分支的 Agent Run 会触发 20 次"加载全项目 + 写回全文档"，彼此争抢 4 条连接并互相制造乐观锁冲突。** 这是第 3.1 节"提高批量上限"之前必须先解决的前置条件——否则扩大批量只会让冲突重试雪崩。

### 6.5 死代码与残留

| 项 | 位置 |
| --- | --- |
| `assistantMessage` 无读取方 | `src/store/canvasStore.types.ts:90` + 96 处写入 |
| `.canvas-sync-status` 样式无引用 | `src/styles.css` |
| `evaluateAgentRunFixtures` 只被自己的测试引用 | `server/agentQualityEvaluation.mjs:11` |
| trace 读取函数无 UI 消费者 | `src/lib/agentApi.ts` + `/api/agent-runs/:id/trace` |
| `workflow_create` action 注册但客户端从不调用 | `server/botanicAgentTools.mjs:372` |
| Chat 工具里 `void nodeById` 占位 | `server/botanicAgentChat.mjs:174` |
| Planner `INTENTS` 不含 `initial_generation`，与领域类型不一致 | `server/botanicAgentPlanner.mjs:5` |
| `createBotanicAgentRun` 默认 `awaiting_confirmation`，服务端直接 `queued` | `src/domain/agent.ts:1306` vs `server/botanicAgentRun.mjs:207` |
| Prompt Pack MVP 有完整规格文档，零代码 | `docs/BOTANIC_PROMPT_PACK_MVP.md` |
| `batch-variation-${now}` 时间戳 ID，同毫秒可碰撞 | `src/domain/batchVariations.ts:27` |

### 6.6 文档层面

- `docs/product-server-migration.md` 描述的是"项目/任务/媒体走 Supabase"的旧方案，与 README/ARCHITECTURE 的"Railway PostgreSQL 唯一生产存储、Supabase 仅 Auth"直接矛盾，且引用了一个本地绝对路径 `/Users/leo/Documents/...`。应当归档或重写。
- `docs/` 下 6 个历史验收文档与 3 个当前规范文档平铺在同一层，虽然索引里做了分区，但 `PR15_REVIEW.md` 里"未关闭的阻断项"已被后续验收覆盖，容易被后来者当成待办。
- Sentry / 集中日志在 README 和 SECURITY_OPERATIONS 中都被提及为"后续"，至今未接入——目前生产环境的错误可观测性只有 `console.error`。

---

## 七、建议的改进路线

按"投入产出比 × 是否阻塞后续"排序。不含时间估计，只标注影响范围与依赖。

### P0：先止血（改动集中，收益立竿见影）

1. **接回反馈通道。** 为 `assistantMessage` 增加一个订阅它的通知出口（`.canvas-sync-status` 样式已就绪），并顺带审查这 96 条文案的措辞。改动范围：`CanvasWorkspace.tsx` + 一个展示组件。
2. **修 `reclaimStaleActive`。** 用 `job.remove()` 精确移除目标任务，并在 Worker 侧把数据库状态改回 `queued`。改动范围：`server/generationQueue.mjs`、`server/worker.mjs`，需补一个针对"清理不得影响其他 active 任务"的测试。
3. **处理假驾驶舱。** 最小方案是把默认落地页改为项目库，把驾驶舱移到明确标注为演示的入口。改动范围：`CanvasWorkspace.tsx:193` + `WorkspaceViews.tsx`。
4. **让 `constraints` 要么生效、要么不展示。** 短期最诚实的做法是把 constraints 编译进 prompt 的结构化段落并在生成请求中带上，而不是继续在 UI 上做无支撑的承诺。改动范围：`server/botanicAgentExecution.mjs` + Planner skill 文本。

### P1：补齐产品闭环

5. **批量变体加取消。** 与普通生成的取消语义对齐，复用同一套幂等和配额回收逻辑。改动范围：`canvasStore.types.ts`、`canvasBatchVariationActions.ts`、进度浮窗。
6. **接入真实 trace，下线假进度。** 让运行轨迹展示 `agentExecutionTrace` 的真实步骤。改动范围：`useAgentRuntimeTrace.ts`、`AgentWorkspace.tsx`。
7. **画布基础操作。** Delete 键删除、Cmd+Z 撤销、快捷键说明面板。
8. **`project.updated` 跨实例广播**，并给 `agentRunEventBus` 补上与 canvas 事件一致的 HMAC 验签。
9. **首次生成走 Planner。** 把 `initial_generation` 加入 Planner 的 `INTENTS`，让第一次生成也享受 prompt 工程。
10. **三个 Adapter 的契约测试。** 用容器化 Postgres 在 CI 中跑同一套契约断言，并统一 schema 来源（migrations 为准，移除运行时 inline DDL）。

### P2：打开规模化天花板（需要先完成 6.4 的写放大治理）

11. **Plan 升级为维度矩阵。** `vary` 维度携带取值列表，执行层做笛卡尔积并展平为分支；上限从固定 20 改为配额驱动 + 分批。这是"可规模化创意工作流"的核心命题，涉及 domain 契约、服务端执行、Store 并发协调器三层，必须先固定跨层接口。
12. **质量闭环。** 把 `feedback` 字段接回 Memory 提炼；给 Planner 增加 `project_memory_search` 和"历史成功配方检索"工具；让部分失败的 Run 能够基于失败原因发起一次 plan 修订。
13. **Skill 升级为可执行资产。** 参数 schema、版本、触发条件、可组合。
14. **意图路由改造。** 正则降级为快速通道，模糊地带交给廉价分类调用，全部收口于确认卡。
15. **拆除双写。** 给 ADR 0002 的门禁定明确的关闭条件；把生产工作流从项目文档兼容区迁出为独立实体。
16. **i18n 抽取** 与 **features 层的组件拆分**（可与上述改动顺带进行，不必单独立项）。

### 建议新增的门禁

当前门禁全绿却漏掉了本文所有问题，说明检查项需要扩展：

- **无用状态检查**：store 中声明并写入、但无任何组件读取的字段应当报错（本次的 `assistantMessage` 会被立即抓住）。
- **`check:architecture` 扩展到 features 层**：单文件行数上限、单组件 store 订阅数上限。
- **Adapter 契约测试进 CI**：容器化 Postgres，三个 Adapter 跑同一套断言。
- **E2E 覆盖主路径**：当前 E2E 只覆盖导航、面板互斥、`@` 引用和刷新恢复，不覆盖生成、候选选择、批量变体、Agent 计划确认、导出和失败重试。
- **多实例冒烟**：两个 API 实例 + 一个 Redis，验证 `project.updated` 与协作事件的跨实例投递。

---

## 八、给产品侧的一句话总结

Botanic 已经把"**记录一次 AIGC 生产**"这件事做到了相当高的工程完成度——幂等、恢复、血缘、权限、协作都经得起推敲。但它还没有开始做"**规模化地生产创意**"这件事：创作维度不能展开、约束不被执行、质量不被学习、反馈不被看见。

下一轮的重心应该从"把状态管对"转向"把创意做多、做好、做得让用户看得见"。而在扩大批量之前，必须先解决全文档读-改-写的写放大——否则规模化的第一步就会撞在乐观锁冲突上。
