# Agent 深度思考时间线与联网检索

> 设计规格。本轮只定方案，不改运行时代码。实现拆成 PR-A（时间线）和 PR-B（联网工具）。

**Goal:** 对话气泡里按真实执行顺序展示「深度思考 → 工具步骤 → 再思考 → 回答」，并让 Agent 在受控条件下检索公开网页；原始思维链仍不得写入消息、计划、Run 或 Artifact Index。

**Architecture:** 时间线权威在 `src/domain/agentTimeline.ts`；流式事件仍走现有 SSE。联网是对话/规划工具白名单里的只读工具，由服务端执行，不走浏览器、不走 MCP 确认卡。提供方 `reasoning_content` 继续只在 `AGENT_RAW_REASONING=true` 时随当轮下发。

**Tech Stack:** 现有 Agent 工具循环 `server/agentToolRuntime.mjs`、对话 `server/botanicAgentChat.mjs`、规划 `server/botanicAgentPlanner.mjs`、时间线 UI `src/features/agent/AgentConversationMessage.tsx`。检索走服务端 HTTPS 搜索 API + 受 SSRF 约束的页面抓取。

## Global Constraints

- 不改变幂等键、任务恢复、项目版本冲突、媒体授权、Artifact 级联删除。
- Agent Session / Message / Memory / Run 仍是权威实体。
- 提供方原始推理（`reasoning_content` / `reasoning`）默认不下发；打开后也不得写入消息、计划、Run 或 Artifact Index。
- 工具 `why` 是摘要级说明，可展示，可随当轮响应和计划工具轨迹出现。
- `src/components/` 不直接访问 Store、网络或服务端。
- 领域规则留在 `src/domain/` 与 `server/`，UI 只展示。
- 普通开发测试不得调用真实生成 Provider，也不得打真实搜索/抓取供应商；用注入的 `fetchImpl` 夹具。
- Agent 不得把图片字节、对象存储地址或私有媒体 URL 送进文本模型。
- 真实行动（写画布、MCP、创建 Skill、提交生成）仍走原确认策略；联网检索不是这类行动。

---

## 截图对应的产品行为

参考界面是：

1. 可折叠「深度思考」，里面是模型当步的推理正文。
2. 一行工具状态，例如「网页获取 www.andlight.cn」。
3. 工具返回后再出现一段「深度思考」。
4. 最后才是对用户的回答。

Botanic 已经有同一骨架，缺的是：**交错的多段思考、工具行展示主机名、以及真正能出网的工具。**

---

## 现状（不要重做）

| 能力 | 现在在哪 | 现状 |
| --- | --- | --- |
| 思考块 + 工具步骤 + 原始工具组 | `src/domain/agentTimeline.ts`、`AgentConversationMessage.tsx` 的 `AgentMessageTimeline` | 有。思考文案是「思考了 Xs」，有文本才变成 `<details>` |
| 流式 reasoning / answer / tool | `src/domain/agentChatStream.ts`、`server/botanicAgentStream.mjs`、`server/botanicAgentChat.mjs` | 有。`reasoning` 事件仅当 `runtimeConfig.agentRawReasoning` 为真才下发 |
| 原始推理安全边界 | `server/botanicAgentReasoning.mjs`、`server/runtime.mjs` 的 `AGENT_RAW_REASONING` | 有。摘要 160 字，原始片段 600 字，一轮最多 8 段 |
| 工具 `why` | `server/agentToolRuntime.mjs` 给每个工具注入 `why` | 有。会进工具轨迹 `summary` 和 reasoning 的 `source: 'summary'` |
| `web_search` 展示映射 | `agentTimelineToolPresentation`、`toolEventPresentation` | **只映射了名字**。对话工具列表里没有这个工具 |
| 对话只读工具 | `server/botanicAgentChat.mjs` `chatToolRegistry` | 只有 `ontology_read`、`project_memory_search`、`asset_group_search`、`skill_search` |
| 系统提示 | 同上 | 已写明：工具列表没有外部搜索时，不得声称查过互联网 |
| 外部 MCP | `mcp_propose` / `mcp_call` + `BOTANIC_MCP_TOOLS_JSON` | 有，但要用户确认，且浏览器拿不到 MCP 地址。不适合「查一下官网」这种读操作 |
| Flock 模型 | `FLOCK_AGENT_MODELS`（DeepSeek / Kimi） | 会回 `reasoning_content`，所以截图那种长思考在传输层已经存在，只是默认被开关挡住 |

当前时间线 reducer 的关键缺口：所有 `reasoning` 增量都拼进**同一个** `thinking` 块。工具之后再来的思考不会新开一段，截图里的「思考 → 网页获取 → 再思考」做不出来。

---

## 问题 1：深度思考思维链

### 能不能做

能。展示层已经存在，不要新开一套气泡或新的持久化实体。

### 做在哪

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 领域时间线 | `src/domain/agentTimeline.ts` | 工具步骤之后若再收到 `reasoning`，**新开**一段 `thinking`，而不是追加到第一段 |
| 流式契约 | `src/domain/agentChatStream.ts`（事件形状不变） | 继续用 `{ type: 'reasoning', step, delta }` |
| 对话循环 | `server/botanicAgentChat.mjs`、`server/agentToolRuntime.mjs` | 每步模型调用都可发 reasoning；工具 `why` 作为该步思考的摘要来源 |
| 规划循环 | `server/botanicAgentPlanner.mjs` | 若规划也走同一条 SSE，复用同一时间线，不要做第二套 UI |
| 气泡 UI | `src/features/agent/AgentConversationMessage.tsx` | 思考块标题改为「深度思考」，副文保留耗时；有文本则可展开 |
| 样式 | `src/styles.css` `.agent-timeline__*` | 只调标题/展开样式，不把规则放进 CSS |
| 运行轨迹面板 | `src/features/agent/useAgentRuntimeTrace.ts`、`src/domain/agent.ts` | 继续只收摘要级 `why` 与可选当轮 raw；刷新后轨迹不恢复 raw |

### 备选

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A. 双通道时间线（推荐）** | 默认用 `why` 和短步骤说明填思考块；`AGENT_RAW_REASONING=true` 时同一 UI 改流原始推理。工具后新开思考块 | 默认安全、截图可复现；运营可按环境打开长思考 |
| B. 生产默认打开原始推理 | 只改 `AGENT_RAW_REASONING=true` | 最快，但完整思维链进浏览器，刷新即丢，且和现规范的默认关闭冲突 |
| C. 把思维链写入 Message | 结束后把 thinking 存进消息 | **禁止**。规范已写明 raw 不得入库 |

不选 C。B 只作为 staging 验证手段，不作为产品默认。

### 推荐设计

1. **两级内容，一块 UI**
   - `source: 'summary'`：来自工具 `why`，默认就有，可出现在当轮响应的 `reasoning` 数组里（现有行为）。
   - `source: 'raw'`：来自提供方 `reasoning_content`，仅 `AGENT_RAW_REASONING=true` 时随 SSE 下发，轮次结束丢弃。
   - 同一思考块优先展示 raw（若有），否则展示该步已收集的 summary。空思考块只显示「深度思考」+ 耗时，不编造正文。
2. **交错**
   - `createAgentTimeline` 仍先放一段 running thinking。
   - 收到 `tool` 后，把当前 running thinking 标为 done。
   - 再收到 `reasoning` 时，在工具步骤之后 **insert** 新的 thinking 块。
   - `done` / `error` 结束所有 running thinking。
3. **文案**
   - 折叠标题：`深度思考`；耗时仍用现有 `思考了 Xs` 作为 `<small>` 或 aria。
   - 不要把函数名、JSON 参数、完整网页正文放进思考块。
4. **不持久化**
   - `appendMessage` 仍只写回答正文。
   - 刷新后历史气泡没有时间线，这是现行为，保持。需要回看步骤时走运行轨迹面板里的工具 `why`，不是 raw。

验收：

- 无 raw 开关时：调用了工具的一轮，气泡出现「深度思考」和工具行；展开思考能看到该步 `why`，看不到 `reasoning_content`。
- 打开 raw 开关且提供方回了推理：思考块出现流式正文，刷新后消息里没有这段正文。
- 工具后的第二段思考不会合并进第一段。

---

## 问题 2：web_search / 网页获取

### 能不能做

能，但**现在没有出网工具**。时间线已经按 `web_search` 这个名字画了「已搜索 N 个网站」，对话系统提示也要求没工具就别谎称搜过网。缺的是服务端白名单工具本身。

不要用 MCP 确认卡冒充截图里的「网页获取」：MCP 是外部写/贵操作通道，每次要用户确认，而且配置在 `BOTANIC_MCP_TOOLS_JSON`。品牌查官网应是只读、配额内自动执行。

### 做在哪

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 搜索与抓取纯规则 | **新建** `src/domain/agentWebResearch.ts` + `server/agentWebResearch.mjs`（同步） | 解析查询、规范化 URL、主机名展示、结果卡片形状 |
| SSRF / 出口守卫 | **新建** `server/webEgressGuard.mjs` | HTTPS、禁止私网/metadata、重定向再校验、超时、体积上限 |
| 搜索适配 | **新建** `server/webSearchProvider.mjs` | 只通过注入的 `fetchImpl` 调配置好的搜索 API；测试不打真实供应商 |
| 页面抽取 | **新建** `server/webFetchExtract.mjs` | HTML → 有限纯文本；去掉 script/style；截断 |
| 对话工具注册 | `server/botanicAgentChat.mjs` `chatToolRegistry` | 增加 `web_search`、`web_fetch` |
| 规划工具注册 | `server/botanicAgentTools.mjs` | 同样挂上，供「查品牌官网再规划」；仍不在规划阶段改画布 |
| 运行时展示 | `server/agentToolRuntime.mjs` `toolEventPresentation` | `web_fetch` 展示「网页获取 {hostname}」；`web_search` 继续聚合「已搜索 N 个网站」 |
| 客户端兜底 | `src/domain/agentTimeline.ts` | 为 `web_fetch` 增加 `TimelineStepKind` 值 `fetch`，图标用现有 `GlobeIcon` |
| 来源脚注 | `sourceLabels` + 对话 `sources` | 命中后回答末尾可列公开 URL 主机名，不列完整抓取正文 |
| 配置 | `server/runtime.mjs` | `BOTANIC_WEB_SEARCH_API_KEY` 控制是否注册 `web_search`；`BOTANIC_WEB_SEARCH_URL` 缺省 `https://api.tavily.com/search`。`web_fetch` 不依赖这两项 |
| 系统提示 | `botanicAgentChat.mjs`、`server/skills/botanic-agent/modes/*.md` | 有工具才允许搜；没有就维持现有「不得声称查过互联网」 |
| 配额 | `server/securityControls.mjs` 或 Agent 路由侧 | 每用户每分钟次数上限；失败计次 |

### 工具契约

`web_search`

- 参数：`query`（必填，≤ 200 字）、`why`（现有注入）。
- 风险：`external` 只读，**不** `requiresConfirmation`。
- 返回给模型：最多 5 条 `{ title, url, snippet, hostname }`。不要把原始搜索 JSON 原样塞回去。
- 时间线：running「正在搜索网站」；succeeded「已搜索 N 个网站」。连续多次搜索仍按现逻辑聚合成一步。

`web_fetch`

- 参数：`url`（必填，http(s)）、`why`。
- 只接受 `https:`（测试可用 localhost 夹具，生产拒绝）。
- 守卫拒绝：回环、链路本地、私网、云 metadata（`169.254.169.254` 等）、非 80/443、超大响应、非文本 HTML/纯文本。
- 返回给模型：`{ url, hostname, title, text }`，`text` 截断到 4000 字（与现有 `safeResultText` 上限一致）。
- 时间线：**「网页获取 {hostname}」**，对齐截图，不要显示完整 URL 或 query。
- 不把抓到的图写进画布，不创建 Artifact，不下载媒体字节给模型。

规划器可以使用这两个工具读品牌资料，但不得用抓取结果直接 `generation_submit`。生成仍走确认后的原任务链路。

对话 `maximumSteps` 现为 5，规划器现为 4。注册了联网工具时两者都提到 **8**，避免「搜 → 抓 → 再想 → 回答」被截断。未注册时保持原上限。不要无界循环。

### 最后一公里：谁出网

模型自己不上网。Botanic 已经有 OpenAI 兼容的 `tool_calls` 循环（`runAgentToolLoop`）：模型只生成 `{ name, arguments }`，服务端执行后再把 JSON 结果以 `role: "tool"` 塞回去。联网就是在这个循环里多两个只读工具。

不要接 Kimi 官方 `$web_search` / Formula。Agent 流量走 Flock（`kimi-k3` 与 DeepSeek 共用同一套 `tools`），Flock 不保证透传 Moonshot 内置工具；内置搜索也不会打出「网页获取 {hostname}」这种我们自己的步骤。

```text
用户：和光是做什么的？官网 https://www.andlight.cn/
        │
        ▼
Flock chat/completions（带 web_search / web_fetch 声明）
        │  tool_calls
        ▼
runAgentToolLoop
        │
        ├─ web_search(query) ──► webSearchProvider
        │                         POST BOTANIC_WEB_SEARCH_URL
        │                         Authorization: Bearer KEY
        │                         body: { query, max_results: 5 }
        │                         归一成最多 5 条 { title, url, snippet, hostname }
        │
        └─ web_fetch(url) ─────► webEgressGuard（HTTPS / 拒私网 / 超时 / 体积）
                                  GET 目标页
                                  HTML → 纯文本 ≤ 4000 字
        │
        ▼
role=tool 结果回模型 → 再思考 → 回答
时间线：已搜索 N 个网站 / 网页获取 www.andlight.cn
```

截图里的「网页获取 www.andlight.cn」对应 **`web_fetch`**：用户或上一跳搜索已经给出 URL，Botanic Node 自己 GET，不经过搜索引擎。用户只说「搜一下和光」、没有 URL 时才走 **`web_search`**。

**搜索供应商（第一版只做一个适配器）：**

- 环境变量：`BOTANIC_WEB_SEARCH_URL`、`BOTANIC_WEB_SEARCH_API_KEY`。
- 适配器按 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) 的请求/响应形状实现：`POST { query, max_results: 5 }` → `results[].{ title, url, content }`，再映射到我们的 `{ title, url, snippet, hostname }`。
- 默认 URL 为 `https://api.tavily.com/search`。若改用博查等中文搜索，只要网关吐出同一 `results` 形状，或加第二个适配器分支；第一版不并行接两家。
- 密钥只留在 Railway/API 进程，不进浏览器、不进模型消息。

**抓取没有第三方：** `web_fetch` 用 Node `fetch`（测试注入 `fetchImpl`）。这是截图能落地的最小闭环；没有搜索 Key 时，只要用户消息里已有 https URL，仍可只注册 `web_fetch`。

配置矩阵：

| 配置 | `web_search` | `web_fetch` |
| --- | --- | --- |
| 有 `BOTANIC_WEB_SEARCH_API_KEY`（URL 可缺省 Tavily） | 注册 | 注册 |
| 无搜索 Key | 不注册 | **仍注册**。截图那种「网页获取官网」不依赖搜索引擎 |
| 守卫拒绝 / 配额用尽 | 工具报错，模型必须如实说没查到 | 同左 |

无搜索 Key 时系统提示改为：没有关键词搜索，但可以抓取用户或上下文里已给出的 https URL；不得声称做过全网检索。

### 备选

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A. 一等只读工具（推荐）** | 服务端执行 `web_search`（Tavily 形状）+ `web_fetch`（自抓） | 与截图一致；DeepSeek / Kimi 都能用；SSRF/配额自己做 |
| B. 只配 MCP 搜索 | `BOTANIC_MCP_TOOLS_JSON` 挂 Tavily | 每次确认，和「查一下官网」不匹配 |
| C. 模型内置联网 | 接 Kimi `$web_search` / Formula | 绑死 Kimi；Flock + DeepSeek 不可用；时间线不是我们的工具行 |

不选 B、C。MCP 仍留给写操作。Kimi 内置搜索不当作生产路径。

### 未配置时的行为

没有 `BOTANIC_WEB_SEARCH_API_KEY`：

- 不注册 `web_search`。
- 仍注册 `web_fetch`（自抓，与搜索供应商无关）。
- 系统提示：没有关键词搜索；只有用户或上下文给出 https URL 时才能抓取；不得声称做过全网检索。
- 测试用注入配置 + mock `fetchImpl` 覆盖成功/拒绝/超时。

---

## 推荐落地顺序

1. **PR-A 时间线交错与「深度思考」文案**  
   只改 `agentTimeline` + 气泡 UI + 测试。不接出网。打开 raw 开关即可在现有 Flock 模型上看到长思考。
2. **PR-B `web_search` / `web_fetch`**  
   守卫、provider、工具注册、展示「网页获取 {hostname}」、来源列表、配额。规划器与对话共用同一对工具实现。

两 PR 都不要改生成幂等、ProductStore Adapter、媒体授权。

---

## 明确不做

- 不把 `'web_search'` 做成 Skill，也不写进 Memory。
- 不让浏览器直接请求第三方搜索或任意 URL。
- 不把抓取页当素材导入画布。
- 不把完整网页或原始推理写入 Message / Plan / Run / Artifact Index。
- 不用 `Promise.all` 并行抓一堆 URL 当生产路径；逐步、有上限。
- 不在未配置搜索 API 时向模型暴露空壳 `web_search`（避免幻觉调用）。`web_fetch` 在无搜索 Key 时仍可注册。

---

## 验证

实现时：

```bash
node --experimental-strip-types --test src/domain/agentTimeline.test.ts
node --test server/agentToolRuntime.test.mjs server/botanicAgentChat.test.mjs server/webEgressGuard.test.mjs
npm test
npm run check:architecture
npm run check:security
npm run build
git diff --check
```

夹具覆盖：私网 URL 拒绝、超大 HTML 截断、搜索未配置则工具列表不含 `web_search`、工具后第二段 thinking 独立成块、raw 关闭时 SSE 无 `reasoning` 事件。

---

## 文件地图（实现时）

新建：

- `src/domain/agentWebResearch.ts`
- `src/domain/agentWebResearch.test.ts`
- `server/agentWebResearch.mjs`
- `server/webEgressGuard.mjs`
- `server/webEgressGuard.test.mjs`
- `server/webSearchProvider.mjs`
- `server/webSearchProvider.test.mjs`
- `server/webFetchExtract.mjs`
- `server/webFetchExtract.test.mjs`

修改：

- `src/domain/agentTimeline.ts` / `agentTimeline.test.ts`
- `src/features/agent/AgentConversationMessage.tsx`
- `src/styles.css`（仅思考块标题）
- `server/botanicAgentChat.mjs` / `botanicAgentChat.test.mjs`
- `server/botanicAgentTools.mjs` / `botanicAgentTools.test.mjs`
- `server/agentToolRuntime.mjs`
- `server/runtime.mjs`
- `server/skills/botanic-agent/modes/*.md`
- `docs/CODEMAP.md`、`docs/README.md`

不改：`src/components/`、ProductStore 三 Adapter、生成幂等键、MCP 确认协议。
