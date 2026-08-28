# Botanic 架构总览

一页看懂 Botanic 由哪些组件构成、它们分几层、数据怎么流动。

- 概念与语义定义 → [PRODUCT_ARCHITECTURE.md](PRODUCT_ARCHITECTURE.md)
- 模块接口与不变量 → [ARCHITECTURE.md](ARCHITECTURE.md)
- 某个行为在哪个文件 → [CODEMAP.md](CODEMAP.md)

---

## 1. 一句话

Botanic 是面向品牌视觉生产的**无限画布工作台**：素材、提示词、生成节点用连线组成可重复运行的工作流，Agent 在同一份项目语义上规划并执行经确认的行动。

**贯穿全局的一条原则：UI 只表达交互，持久化任务与结果才是状态的权威来源。**

---

## 2. 系统上下文

```mermaid
graph LR
  USER["创作者 / 团队成员<br/>浏览器"]

  subgraph BOTANIC["Botanic"]
    WEB["Web App<br/>Vercel"]
    API["API + Realtime<br/>Railway"]
    WORKER["Worker<br/>Railway"]
  end

  DB[("PostgreSQL / Supabase<br/>项目·任务·Agent 实体")]
  REDIS[("Redis<br/>队列 · 配额 · 事件总线")]
  OBJ[("S3 兼容对象存储<br/>图片 / 视频")]
  AI["图像视频供应商<br/>OpenAI · MiniMax"]
  LLM["文本 / 视觉模型<br/>Agent 规划与润色"]
  MCP["MCP Servers<br/>受控外部工具"]

  USER -->|HTTPS / WSS| WEB
  WEB -->|REST + WebSocket| API
  API --> DB
  API --> REDIS
  API --> OBJ
  API --> LLM
  API --> MCP
  REDIS --> WORKER
  WORKER --> AI
  WORKER --> DB
  WORKER --> OBJ

  classDef sys fill:#edf6ee,stroke:#4b8055,color:#234b2a
  classDef ext fill:#f4f4f4,stroke:#777,color:#252525
  class WEB,API,WORKER sys
  class DB,REDIS,OBJ,AI,LLM,MCP ext
```

**边界约束**：浏览器不持有任何生成模型密钥，不直连供应商；MCP 地址与凭据不下发到客户端；媒体只以同源授权引用进入画布。

---

## 3. 分层组件图

```mermaid
graph TD
  subgraph L1["① 客户端 · src/"]
    direction LR
    A1["功能 UI<br/>features/canvas · features/agent"]
    A2["共享 UI<br/>components/"]
    A3["画布应用模块<br/>store/"]
    A4["领域契约<br/>domain/"]
    A5["浏览器基础设施<br/>lib/ · HTTP · Yjs · IndexedDB"]
    A1 --> A3 --> A4
    A3 --> A5
    A1 --> A2
    A5 --> A4
  end

  subgraph L2["② API 与安全边界 · server/httpServer.mjs"]
    direction LR
    B1["路由目录<br/>*Routes.mjs · 405 语义"]
    B2["鉴权<br/>requestAuth · authorization"]
    B3["安全控制<br/>限流 · 配额 · MFA · 审计"]
    B1 --> B2
    B1 --> B3
  end

  subgraph L3["③ 产品核心服务"]
    direction LR
    C1["项目与画布<br/>ProductStore · 协作房间"]
    C2["Botanic Agent<br/>Turn Runtime · Planner · Run"]
    C3["Agent 工具运行时<br/>Ontology · Skill · MCP · 审批"]
    C4["生成服务<br/>配方 · 幂等 · 治理"]
    C5["媒体服务<br/>上传校验 · 授权 · 归一化"]
    C6["实时中枢<br/>项目房间 · 事件总线"]
    C2 --> C3
    C2 --> C4
    C1 --> C5
    C4 --> C5
  end

  subgraph L4["④ 异步执行 · server/worker.mjs"]
    direction LR
    D1["BullMQ 队列<br/>generation · subagent · derived"]
    D2["生成处理器<br/>租约 · 重试 · 备用模型"]
    D3["Provider 适配<br/>OpenAI · MiniMax Image / H3"]
    D4["恢复清扫器<br/>turn · run · branch · review · job"]
    D1 --> D2 --> D3
    D1 --> D4
  end

  subgraph L5["⑤ 持久化与外部依赖"]
    direction LR
    E1[("Product Store<br/>File / PostgreSQL / Supabase")]
    E2[("Object Storage")]
    E3["Supabase Auth"]
    E4["文本 / 视觉模型"]
    E5["图像视频供应商"]
    E6["MCP Servers"]
  end

  L1 -->|"REST + WSS"| L2
  L2 --> L3
  C4 -->|入队| D1
  C2 -->|子 Agent| D1
  L3 --> E1
  C5 --> E2
  B2 --> E3
  C2 --> E4
  C3 --> E6
  D3 --> E5
  D2 -->|终态回写| E1
  C6 -->|失效通知| L1

  classDef client fill:#edf6ee,stroke:#4b8055,color:#234b2a
  classDef edge fill:#eef2fb,stroke:#647db3,color:#263b68
  classDef core fill:#fff7e8,stroke:#ba8b3a,color:#5b411a
  classDef async fill:#f5effb,stroke:#8965ad,color:#493265
  classDef data fill:#f4f4f4,stroke:#777,color:#252525
  class A1,A2,A3,A4,A5 client
  class B1,B2,B3 edge
  class C1,C2,C3,C4,C5,C6 core
  class D1,D2,D3,D4 async
  class E1,E2,E3,E4,E5,E6 data
```

---

## 4. 各层职责

| 层 | 位置 | 拥有什么 | 明确不拥有 |
| --- | --- | --- | --- |
| ① 客户端 | `src/` | 交互、本地草稿、乐观展示、协作增量 | 任务状态、媒体权威、权限判定 |
| ② API 边界 | `server/*Routes.mjs`、`httpServer.mjs` | 鉴权、入参校验、幂等键、限流配额 | 业务状态机（下沉到核心服务） |
| ③ 核心服务 | `server/*Service.mjs` 等 | 项目/画布、Agent 回合、生成治理、媒体授权 | Provider 调用细节、UI 呈现 |
| ④ 异步执行 | `server/worker.mjs` | 队列消费、租约执行、恢复清扫 | 另建一套任务状态机 |
| ⑤ 持久化 | Adapter 三实现 | 权威事实与血缘 | 业务规则 |

### 4.1 客户端组件

| 组件 | 入口 | 说明 |
| --- | --- | --- |
| 画布工作区 | `features/canvas/CanvasWorkspace.tsx` | 只组合导航与面板；项目 I/O、同步、Agent 桥、React Flow 交互各归一个协调器 |
| Agent 工作区 | `features/agent/AgentWorkspace.tsx` | 只编排；对话卡、Composer、消息交付、运行轨迹各自独立 |
| Store | `store/canvasStore.ts` | 只组合命令与撤销边界；文档生命周期 / 素材图谱 / 生成 / 批量 / 模板历史 / Agent 各有深模块 |
| 领域契约 | `domain/` | 纯规则，零 I/O：画布、生成配方、批量变体、输出放置 |
| 浏览器基础设施 | `lib/` | 会话、生成请求、协作、离线草稿（IndexedDB） |

### 4.2 服务端核心组件

| 组件 | 权威文件 | 拥有的不变量 |
| --- | --- | --- |
| Agent Turn Runtime | `botanicAgentTurnRuntime.mjs` | 回合控制权唯一入口；租约 + fencing token 保证单执行者 |
| 回合检查点 | `agentTurnCheckpoint.mjs` | 副作用前持久化步骤；只读可重放，写入靠回执判定 |
| 行动执行 | `agentActionExecution.mjs` | Action Receipt 原子取得所有权；未知结果收敛为 `uncertain`，不自动重试 |
| MCP 客户端 | `mcpClient.mjs` | 版本化能力目录 + capability hash；漂移在出网前拒绝 |
| 子 Agent 运行时 | `agentSubagentBroker.mjs` | 独立队列与恢复；根 Turn 取消级联全部子项 |
| 生成治理 | `generationGovernance.mjs` | 一个 Job = 一个记账单元；重连恢复不二次预留 |
| 生成执行 | `generationJobExecution.mjs` | `executionGeneration + leaseToken` 定义 Worker 执行权 |
| 评审服务 | `agentReviewService.mjs` | 决定 + 物化 + 新 Run 同事务；事务内不调 Provider |
| 实时协作 | `canvasCollaborationRoom.mjs`、`realtimeHub.mjs` | 先持久化再广播；Redis Pub/Sub 跨实例 |
| Artifact 索引 | `botanicArtifactIndex.mjs` | 历史身份与血缘；删画布节点不删索引 |

---

## 5. 核心执行流

### 5.1 一次生成

```mermaid
sequenceDiagram
  autonumber
  participant UI as 画布 UI
  participant ST as Store
  participant API as Node API
  participant Q as Redis / BullMQ
  participant W as Worker
  participant P as Provider
  participant DB as Product Store

  UI->>ST: 结构化命令
  ST->>API: 提交（携带幂等键）
  API->>API: 鉴权 · 校验 · 配额预留
  API->>DB: 持久化 GenerationJob
  API->>Q: 入队
  API-->>UI: 任务身份
  Q->>W: 消费
  W->>W: 原子 claim 租约
  W->>P: 调用模型
  P-->>W: 输出
  W->>DB: 媒体落库 + Job 终态
  W->>DB: 投影 Canvas · Artifact · Run
  DB-->>UI: Realtime 失效通知 → 重新读取
```

要点：**先落 Job 终态，再做投影**。Canvas 节点、Artifact Index、Agent Run 都只是可恢复投影；投影未完成时 `projectWritebackPending` 保持可扫描。

### 5.2 一次 Agent 回合

```mermaid
sequenceDiagram
  autonumber
  participant UI as Agent 面板
  participant API as Turn Runtime
  participant M as 模型
  participant T as 工具运行时
  participant G as 生成链路

  UI->>UI: 先持久化 pending 用户 Message（含请求快照）
  UI->>API: POST /api/agent-turns
  API->>API: 原子 claim + request binding + 关联 turnId
  API-->>UI: accepted（SSE）或 202 + observer
  loop 每个步骤
    API->>API: 写 prepared Checkpoint
    API->>M: 模型调用
    M-->>API: 回答 / 工具调用
    API->>T: 白名单工具（外部行动需确认）
    T-->>API: 受控输出（单工具 ≤2k，单轮 ≤6k）
  end
  API->>G: 计划确认后复用同一套生成基础设施
  API-->>UI: 有序 Turn Event（sequence 为续读游标）
```

要点：HTTP 连接**只是观察通道**。断线刷新从用户 Message 的 `turnId` 按 `sequence` 续读；Stop 先写 durable fence，再按 `Turn → Run → GenerationJob` 传播，等到实际 Worker 的 release ack 才收口。

---

## 6. 权威来源

| 状态 | 权威来源 | 非权威表现 |
| --- | --- | --- |
| 生成进度与结果 | 持久化 GenerationJob | UI 占位、Toast、本地 loading |
| Agent 执行 | Agent Run 与分支任务 | 对话卡片的临时进度 |
| 回合控制权与续读 | Turn + Checkpoint + 有序 Turn Event | HTTP 连接、进程内 Promise |
| 外部行动结果 | Action Receipt | HTTP 请求、Toast |
| 会话内容 | 独立 Session / Message / Memory | CanvasDocument 迁移兼容字段 |
| 历史产物 | Artifact Index | 当前画布节点与素材引用 |
| 节点与连线协作 | 独立画布图谱 + Yjs 增量 | 本机选择态与视角 |
| 媒体内容 | 授权 MediaObject | 浏览器临时 Object URL |

---

## 7. 依赖方向铁律

`npm run check:architecture` 会拒绝违反下列方向的代码：

```mermaid
graph LR
  UI["features / App"] --> STORE["store"] --> DOMAIN["domain"]
  STORE --> LIB["lib"] --> DOMAIN
  COMP["components"] --> DOMAIN
  UI --> COMP
  UI -.->|禁止| SERVER["server/"]
  COMP -.->|禁止| LIB
  DOMAIN -.->|禁止| STORE

  classDef ok fill:#edf6ee,stroke:#4b8055,color:#234b2a
  classDef no fill:#fbeeee,stroke:#b36464,color:#682626
  class UI,STORE,DOMAIN,LIB,COMP ok
  class SERVER no
```

- 前端源码不得导入 `server/`
- `components/` 是纯 UI，不得导入 `lib/`、`store/`、`server/`
- `domain/` 不得反向导入 UI、Store、种子数据或基础设施
- `lib/` 不得反向导入 UI 或 Store

---

## 8. 部署拓扑

```mermaid
graph TD
  CDN["Vercel<br/>静态 Web App"]
  API["Railway · API<br/>server/index.mjs<br/>REST + WebSocket"]
  WK["Railway · Worker<br/>server/worker.mjs"]
  RD[("Redis<br/>队列 · 配额 · Pub/Sub")]
  PG[("PostgreSQL / Supabase")]
  S3[("S3 兼容对象存储")]

  CDN --> API
  API <--> RD
  WK <--> RD
  API --> PG
  WK --> PG
  API --> S3
  WK --> S3

  classDef run fill:#eef2fb,stroke:#647db3,color:#263b68
  classDef data fill:#f4f4f4,stroke:#777,color:#252525
  class CDN,API,WK run
  class RD,PG,S3 data
```

**多实例安全**：API 与 Worker 都可水平扩展。跨实例一致性靠三件事——数据库时钟裁决的租约与 fencing token、Redis Pub/Sub 传播已持久化的事件、周期清扫器按稳定 keyset 恢复中断任务（`turn.reclaim` / `run.submit` / `branch.retry` / `review.run` / `workflow.advance`）。

**存储可替换**：Product Store 有 File / PostgreSQL / Supabase 三个 Adapter，由 `server/runtime.mjs` 在启动时选择并通过 `productStoreContract.mjs` 校验同一契约。

---

## 9. 读这份文档之后

| 下一步 | 去哪 |
| --- | --- |
| 理解某个概念的语义 | [PRODUCT_ARCHITECTURE.md](PRODUCT_ARCHITECTURE.md) |
| 改代码前的约定 | [../AGENTS.md](../AGENTS.md) |
| 找某个行为的权威实现 | [CODEMAP.md](CODEMAP.md) |
| 具体不变量与迁移顺序 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 某个设计为什么这样定 | [adr/](adr/) |
| 本地跑起来、验证门禁 | [DEVELOPMENT.md](DEVELOPMENT.md) |
