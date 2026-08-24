# ADR 0004：可恢复 Agent Turn Runtime

## 状态

已接受。

## 背景

Botanic 已有 Session、Message、Run、GenerationJob 和 Artifact 等独立实体，但聊天、意图解析和计划规划仍通过不同 HTTP 入口编排。浏览器断线时，流事件无法从稳定游标恢复，UI 也容易把临时状态误认为执行事实。

## 决策

增加项目级 Agent Turn 与追加式 Turn Event。Turn 只拥有一次控制权循环和事件顺序，不复制 Session、Message、Run、Job 或 Artifact 的业务权威。每个 Item 只保存对现有实体的类型化引用。

Runtime 通过一个小 Interface 提供 `execute`、`cancel` 与事件补读；新的 `/api/agent-turns` HTTP/SSE 入口只做 Adapter。旧的 chat、intent、plan 路径在兼容期内保留旧响应形状，但复用同一回合解析器；待客户端迁移完成后移除兼容入口。

可恢复的工具事件必须先持久化再推送，使用 `(turnId, sequence)` 作为稳定游标；原始 reasoning/answer 只随当前实时响应传输，不写入事件表。Turn 中断只停止尚未提交的模型或工具回合；已经创建的 Run 必须通过独立 Run Cancel 语义取消。

## 后果

- 浏览器刷新和 SSE 断线可以从服务端恢复。
- UI 只能消费 Runtime 读模型，不能伪造工具成功或任务状态。
- Local、PostgreSQL、Supabase Adapter 需要同步实现 Turn 读写与事件分页。
- 旧消息、Run 和 Artifact 数据无需重写；Turn 只建立导航和可回放索引。
