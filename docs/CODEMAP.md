# Botanic 代码地图

这份地图回答三个问题：需求属于哪里、从哪个接口进入、改完验证什么。文件名表达所有权；同一行为只保留一个权威实现。

## 快速定位

| 需求/行为 | 首要入口 | 相关实现 | 聚焦测试与不变量 |
| --- | --- | --- | --- |
| 画布节点与连线 | `src/domain/canvas.ts` | `canvasGraph.ts`、`canvasBranch.ts`、`canvasNodeLayout.ts` | `src/domain/canvas*.test.ts`；输入连线是生成配方唯一来源 |
| 输出节点与血缘 | `src/domain/generationResultPlacement.ts` | `generationResultReconciliation.ts`、`canvasPresentation.ts` | 每个输出独立成节点；候选 ID 稳定 |
| 画布交互与面板 | `src/App.tsx` | `src/components/`、`exclusiveSurface.ts`、`overlayPriority.ts` | `exclusiveSurface.test.ts`、`overlayPriority.test.ts`；高层浮层优先处理 Escape |
| Agent 面板交互 | `src/features/agent/AgentWorkspace.tsx` | `src/domain/agent*.ts`、`src/lib/agent*.ts` | Agent 领域/Lib 测试；面板按需加载，短暂交互面互斥 |
| 画布应用状态 | `src/store/canvasStore.types.ts` | `src/store/canvasStore.ts`、`src/lib/db.ts`、领域命令 | 先核对 Store 端口；远端新结果不得被旧草稿覆盖 |
| 普通生成任务 | `src/lib/generationApi.ts` | `server/generationService.mjs`、`generationProcessor.mjs`、`generationProvider.mjs` | `server/generation*.test.mjs`；同一次重试复用幂等键 |
| 批量变化 | `src/domain/batchVariations.ts` | Store 批量协调、服务端 Processor | `batchVariations.test.ts`、Processor 测试；各分支独立持久化和恢复 |
| Agent 对话分流 | `src/domain/agentChatContract.ts` | `src/lib/agentApi.ts`、`server/botanicAgentChat.mjs` | 对话测试；浏览器不发送图片字节或私有 URL |
| Agent 计划和执行 | `src/domain/agentPlanContract.ts` | `agent.ts`、`server/botanicAgentPlanner.mjs`、`botanicAgentTools.mjs` | Agent Planner/Tool/Run 测试；外部行动默认确认 |
| Agent 持久化 | `server/botanicAgentPersistence.mjs` | 三个 ProductStore Adapter、Canvas 兼容视图 | 独立实体合并测试；Memory 墓碑永久胜出 |
| Artifact Index | `server/botanicArtifactIndex.mjs` | 三个 Store Adapter、Agent 结果区 | Artifact 测试和迁移对账；历史不随 UI 删除 |
| 素材与媒体 | `src/domain/asset*.ts`、`agentMedia.ts` | `src/lib/db.ts`、`server/mediaService.mjs`、`objectStore.mjs` | 素材/媒体测试；组件不接触对象存储凭据 |
| 项目同步 | `src/lib/db.ts` | `projectRealtime.ts`、`projectCollaboration.ts`、Store | Realtime/冲突测试；`revision` 与 `graphRevision` 分工明确 |
| 账户与权限 | `src/lib/productSession.ts` | `server/authorization.mjs`、`projectAuthorization.mjs` | 授权和账户测试；越权 403、真实缺失 404 |
| HTTP 路由 | `server/httpRouteTable.mjs` | `server/httpServer.mjs`、`server/index.mjs` | 路由目录/HTTP Server 测试；组合根不包含业务处理 |
| ProductStore | `server/runtime.mjs` | `productStore.mjs`、`postgresProductStore.mjs`、`supabaseProductStore.mjs` | Adapter 契约及各 Store 测试 |
| 投放交付 | `src/domain/deliveryPresentation.ts` | `src/lib/deliveryExport.ts` | delivery 测试；视频不进入图片投放模板 |

## 依赖方向

```text
App / Feature UI → Store → Domain + Browser Lib → Node HTTP → Queue / Processor → Adapter
```

- `src/domain/`：纯规则和数据契约，不依赖 UI、Store、网络或存储。
- `src/lib/`：浏览器网络与本地持久化 Adapter，不依赖 UI 或 Store。
- `src/store/`：组合领域规则和浏览器 Adapter，不依赖 UI。
- `src/components/`：纯展示和用户事件，只依赖领域类型与共享 UI。
- `src/features/`：按产品能力组合 Store、Lib 和组件；对外暴露一个明确功能入口。
- `src/App.tsx`：组合根，负责把 Store/Lib 能力注入功能 UI，不拥有领域规则。
- `server/runtime.mjs`：服务端组合根，选择 ProductStore、队列、媒体和 Provider Adapter。

完整规则见 [ARCHITECTURE.md](ARCHITECTURE.md)，自动检查见 `scripts/architectureBoundaries.mjs`。

## 检索建议

优先搜索领域名和公开命令，不要从 CSS 类名反推业务：

```bash
rg "runGraphGeneration|runBatchVariation" src server
rg "BotanicAgentRun|AgentArtifact" src/domain server
rg "requireProjectPermission" server
rg "revision|graphRevision" src/lib server
```

如果需求同时命中 App、Store 和服务端，先固定跨层接口与不变量，再逐层修改；不要在一次 UI 修改中顺带改变任务或持久化语义。

## 验证矩阵

| 改动范围 | 必跑验证 |
| --- | --- |
| Domain / Lib | 对应 `node --test ...`，然后 `npm test` |
| UI / Store | 对应行为测试、`npm run build`、必要的浏览器回归 |
| Server / Adapter | 对应 `server/*.test.mjs`、`npm test` |
| 依赖方向 | `npm run check:architecture` |
| 发布相关 | 以上全部，加生产浏览器、控制台、HTTP 与 Provider 分项验证 |
