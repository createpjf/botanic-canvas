# Codex Agent UI → Botanic 聊天框集成研究

## 范围与基线

- 用户参考文档:`/Users/leo/Desktop/codex-rust-v0.152.0/codex-rust-v0.152.0-agent-ui-reference.md`。
- Codex 一手源码:`/Users/leo/Desktop/codex-rust-v0.152.0`,tag `rust-v0.152.0`,commit `316795b3`。
- Botanic 基线:当前 `harness-reliability-20260901` 分支。

参考文档实际只覆盖 **Timeline / Tool activity**,不包含 textarea composer。为回答“聊天框”完整体验,本研究额外核对 Codex `bottom_pane/chat_composer*`、`chatwidget/input_queue.rs`、`chatwidget/input_restore.rs`。

结论先说:Rust TUI 代码不能直接粘进 React,但它的状态机和 view-model seam 很适合复用。Botanic 已具备约 70% 的 Timeline 核心能力;下一步收益最高的不是新造 Accordion,而是修草稿隔离、popup dismissal、输入历史与安全的运行中队列。

## Botanic 已有,不要重复建设

| Codex 逻辑 | 一手源码 | Botanic 等价物 | 判断 |
| --- | --- | --- | --- |
| 有序 Timeline + Turn boundary | `app-server-protocol/.../thread.rs:1762-1829` | Turn Event `sequence` + `agentTurnTimelineEventReader.ts` + Protocol v1 | 已有 |
| active cell 稳定 ID 原地更新 | `tool_lifecycle.rs:167-237` | `reduceAgentTimeline` 按 toolCall ID upsert | 已有 |
| 普通摘要 / 详情双视图 | `HistoryCell::display_lines/transcript_lines`(`history_cell/mod.rs:184-260`) | 对话默认摘要 + `AgentToolCallAccordion` 行详情 + 响应“展开全文” | 已有大半 |
| Web Search 单行状态 | `history_cell/search.rs:49-110` | search step + source pills | Botanic 已更适合 Web |
| Plan cell | `history_cell/plans.rs:47-134` | Botanic 计划卡/参数/确认/结果回执 | Botanic 更完整 |
| live tail 仅在用户跟随底部时滚动 | `pager_overlay.rs:752-797` | `AgentWorkspace.tsx:1376-1380` 的 `followLatestMessagesRef` | 已有 |
| 原始 reasoning 不进普通历史 | `messages.rs:297-347` | raw reasoning 默认不下发/不持久化 | 已有且必须保持 |

## A. 可直接按现有 seam 集成

### A1. 每会话草稿隔离(P0)

**当前缺陷**:`AgentComposerState` 只有一个组件级 reducer(`agentComposerState.ts:59-78`,`AgentWorkspace.tsx:480-491`)。切换 Agent Session 时没有保存/恢复 composer state,草稿会跟到另一会话;文本里可能仍引用上一个会话的语境。

**Codex 参考**:`input_restore.rs:432-478` 捕获 thread-owned composer state,`:481-503` 切回 thread 时恢复。

**Botanic 最小实现**:

- 新建 `useAgentComposerDrafts` 或纯 reducer map,键为 `projectId:sessionId`。
- session 切换前保存 `instruction + caret`,切换后恢复;`mentionQuery` 从文本+caret 重算,不持久化菜单状态。
- Context/Skill chips 已归 Session,不复制进 draft。
- 第一 change set 只做内存隔离;刷新恢复另见 A2。

**价值**:修真实串会话问题。**数据库/协议影响**:无。

### A2. 刷新后恢复草稿(P1)

**Codex 参考**:`chat_composer.rs:70-78` startup draft handoff;`input_restore.rs:432-503` 保存 thread input state。

**Botanic 改造**:

- 在 A1 owner 上加 `sessionStorage` adapter,每会话最多 8KiB,debounce 250ms。
- 只存文本和 caret;不存图片字节、URL、context IDs、Skill 正文、错误、pending recovery。
- 成功提交后清草稿;关闭 tab 自动失效,比 localStorage 长期保留用户私密 Prompt 更稳妥。

### A3. Esc dismissal token(P0,小改高收益)

**当前缺陷**:`AgentWorkspace.tsx:3803-3805` 的 Esc 只把 `mentionQuery` 设为 undefined;再次点击同一 `/foo` 或 `@node` token 会立即重开菜单。

**Codex 参考**:`chat_composer.rs:37-46` 记录 dismissed token;只要 query/token/ordinal 未改变就保持关闭,编辑 token 后才允许重开。

**Botanic 最小实现**:

- `AgentComposerState` 增加 `dismissedMention?: {trigger,start,end,text}`。
- Esc 保存当前 token;`onInstructionClick` 若命中完全相同 token则不重开。
- 文本编辑触及该范围后清 dismissal;选择完成也清。

**价值**:菜单不“关了又弹”。**风险**:低,纯客户端,已有 mention parser 带 start/end。

### A4. 输入历史 ↑/↓(P1)

**Codex 参考**:`chat_composer_history.rs:127-163` 独立 history 状态机;`:374-402` 只在空输入或已召回文本且光标位于边界时接管方向键;`:409-465` Up/Down 导航与越过最新清空。

**Botanic 数据源**:直接使用当前 `session.messages.filter(role==='user')`,无需第二套历史存储。

**交互**:

- 无 mention popup 时,textarea 为空且 caret 在首行/开头才用 ↑ 召回。
- 召回后只有文本未修改且 caret 在边界时继续 ↑/↓;改过内容就恢复普通多行光标行为。
- 越过最新恢复用户进入 history 前的原草稿。
- 首版只召回文本,不隐式替换当前 Context/Skill chips,避免引用已删除节点。

### A5. 同类只读调用合并 + 快速成功降噪(P1)

**Codex 参考**:

- `ExecCell::display_lines`(`exec_cell/render.rs:186-240`)将多条探索命令压成 `Ran N commands`,Transcript 保留明细。
- `HookCell`(`hook_cell.rs:1-13,45-100`)使用 300ms PendingReveal、600ms QuietLinger,相邻运行项合并(`:330-360`)。

**Botanic 现状**:`presentAgentToolAccordion` 只有连续同名 MCP 合并(`agentTimeline.ts:974-989`);ontology/memory/skill/asset reads 逐行出现,settled header 取最后一项详情而不是总结。

**安全改造**:

- 仅对 `risk==='read'` 且非 web source 的快速成功调用应用;write/costly/external/error/aborted 永远保留。
- <300ms 成功的本地 read 不闪单行,并入一条 `已读取 N 项`;展开 accordion 仍看各行。
- 运行超过 300ms 立即显示;一旦显示至少保持 600ms,避免闪烁。
- 只改 presentation,不改 Timeline/Turn 权威状态。

### A6. 建议菜单 fuzzy 排序(P2)

**Codex 参考**:`command_popup.rs:97`、`mentions_v2/filter.rs`、`file_search_popup.rs:67` 使用 score 排序。

**Botanic seam**:`AgentWorkspace.tsx:753-784` 当前仅 `includes`。实现一个中文字符友好的纯函数 fuzzy score,用于 `@` 与 `/`;精确前缀 > 连续命中 > 非连续命中。

## B. 可集成,但必须按 Botanic 语义改造

### B1. 运行中队列 + 可编辑预览(P1,不要当 steer)

**Codex 参考**:

- `input_queue.rs:21-47` 分开 queued messages / pending steers / rejected steers。
- `:65-98` 提供安全 preview。
- `input_restore.rs:180-207` 最后一条队列弹回 composer。
- `chat_composer.rs:80-100` Enter/Tab 提交和附件保留规则。

**Botanic 当前**:`AgentComposer.tsx:328-335` 运行中 send 按钮变 Stop;`handleKeyDown` planning 时吞 Enter;`AgentWorkspace.tsx:3222-3247` 禁止并发提交。

**正确实现**:

- 首版是“当前 Turn 终态后发送”,不是 mid-turn steer。
- 队列 owner 是本地/`sessionStorage` composer state,**不能复用 `useAgentMessageDelivery`**——后者会先持久化 User Message,可能让 pending selector并发启动第二 Turn。
- 入队时冻结文本、model、mode、Context IDs、mounted Skill IDs或现有 `turnRequestSnapshot`;不能 flush 时读取已经变化的当前 UI。
- 聊天框上方显示最多3条紧凑 queue chip;点击最后一条弹回编辑,删除可取消。
- 当前 Turn正常完成后 FIFO flush一条;取消/失败时不自动发,把队列恢复为草稿。
- 与 pending auto-submission 的 selector互斥。

**价值**:长 Turn 时继续表达,不中断心流。**风险**:中,需要严谨快照与selector测试,但不改服务端协议。

### B2. 安全 Transcript / 继续加载(P2,按指标 Gate)

**Codex 参考**:`HistoryCell::display_lines/transcript_lines`;`ThreadTimelineEntry`分页协议(`thread.rs:1762-1829`);`TranscriptOverlay::sync_live_tail`(`pager_overlay.rs:752-797`)。

**Botanic 现状**:

- accordion 已承担摘要/详情,无需另造全局 overlay。
- reader 每页200,最多5页(`agentTurnTimelineEventReader.ts:9-60`);截断时 UI 只显示说明(`AgentConversationMessage.tsx:663-667`),没有加载动作。
- 现有 Core 工具调用上限远低于1000,正常 Turn 几乎不会截断。

**Gate**:只有生产出现 `timeline.truncation` 样本或子 Agent 事件显著增多才做。届时在现有 accordion 加“更多”按钮,继续从 `nextAfter` 读取并单调合并;Transcript 只显示安全 presentation、状态、耗时、错误码、source pill、Receipt/Artifact引用,不显示 raw args/result/reasoning。

### B3. 子 Agent 活动节点(P2)

**Codex 参考**:`multi_agents.rs:203-340` 把 Started/Interrupted/Completed投影为专用历史节点;`tool_lifecycle.rs:148-151` 写入历史。

**Botanic 现状**:Durable Subagent存在,但根 Turn没有向聊天事件投影专用生命周期;`subagent_research`只作为普通工具行。

**改造**:服务端先增加安全的 root-turn presentation事件(只含descriptor label/status/count/duration,不含子任务Prompt/raw output),Protocol v1登记后UI再渲染。不能在客户端猜。

### B4. Slash 本地命令(P2)

Codex `slash_commands.rs` 将命令与文本提交分流。Botanic 的 `/` 已归 Skill menu;若扩展,只加入按能力过滤的本地导航命令(新会话/历史/模型/Skill面板),与Skill分组展示。不要复制CLI的`/diff`、`/vim`、`/quit`。

### B5. 大粘贴折叠(P2)

Codex `chat_composer.rs:122-150` 用 placeholder保存大粘贴。Botanic textarea已限制高度并滚动,浏览器也有原生paste,收益较小。若生产出现>1000字符品牌文案输入,只移植 threshold+placeholder+提交展开,不要移植terminal `PasteBurst`。

## C. 不适用 / 不应移植

| Codex 代码 | 原因 |
| --- | --- |
| `paste_burst.rs` | 解决终端无 bracketed-paste;浏览器有原生paste事件 |
| Vim/keymap引擎、外部编辑器 | 目标用户/运行环境不匹配 |
| terminal `[Image #N]` rows | Botanic图片/context chips更好 |
| Exec command/raw output Transcript | Botanic不执行shell;raw工具结果/Provider body禁止持久化 |
| 无界完整 Transcript / raw reasoning | 违反Botanic隐私和结果envelope边界 |
| mid-turn steer直接移植 | 需服务端Turn协议、幂等与恢复设计;UI单改会破坏durable语义 |
| Thread fork/backtrack回滚 | 与Artifact Index不可变血缘冲突;Botanic已有消息编辑取回文本 |
| Codex sandbox/permission审批类型 | Botanic审批权威是Plan/Action Receipt/confirmation waiver |
| footer快捷键说明行 | Botanic设计约束禁止用可见文案解释快捷键/如何使用;保持tooltip/原生行为即可 |
| model effort/service tier | Botanic planner模型没有该领域维度 |

## 推荐实施顺序

### 第一批:修逻辑缺陷(低风险)

1. **A1 per-session draft隔离**。
2. **A3 dismissed mention token**。
3. **A4 输入历史 Up/Down**。

无后端/数据库/Protocol变化。每项最多1主路径+1失败路径测试。

### 第二批:运行中不中断心流

4. **B1 queue-after-turn + queue chips + pop-back**。单独change set,先写纯state reducer与selector竞态测试。

### 第三批:对话活动降噪

5. **A5 read-only grouping + delayed reveal**。
6. 根据H7数据决定B2安全Transcript/继续加载与B3子Agent活动。

## 验收重点

- 切会话草稿不串、刷新不丢、成功提交清除。
- Esc关闭同一mention token后不重开;编辑token后恢复。
- 多行textarea的Up/Down不被历史导航劫持。
- queue不创建并发Turn、不读取flush时的当前Context、不在取消/失败后自动发送。
- 快速read降噪不隐藏失败、外部调用、写入、费用、source与aborted状态。
- 任何详细轨迹不展示raw reasoning、Provider body、私有URL、token或未经允许的工具结果。
