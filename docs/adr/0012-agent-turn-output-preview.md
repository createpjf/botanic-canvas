# ADR 0012：Agent Turn 运行中输出预览持久化

## 状态

已接受。2026-09-01：维护者批准按“先 Durable Output Preview，后单独决定 Cancel Partial”的顺序实施。

## 背景

Botanic 的 Provider answer delta 当前只存在于进程内与 SSE；Turn Event 只持久化安全工具摘要。浏览器断线后可用 durable Turn observer 恢复工具轨迹和最终结果，但在 Turn 尚未终态时，看不到已生成的正文。

“answer”在产品语义中表示完成后的权威助手消息。运行中内容可能被后续 attempt reset、失败或取消，因此本 ADR 将其命名为 **TurnOutputPreview**：可恢复的运行中投影，不是 Message、完成答案、Plan、Run 或 Artifact。

## 决策

### 1. 权威归属

TurnOutputPreview 由当前持有 Turn lease/fencing token 的 Runtime 写入 Agent Turn；浏览器、HTTP 连接和 Provider Adapter 都不拥有其持久化状态。

形状固定为：

```ts
type AgentTurnOutputPreview = {
  version: 1
  attemptId: string
  revision: number
  step: number
  text: string
  truncated?: boolean
  updatedAt: number
}
```

Preview 是 replace-style 最新投影。完整正文保存在 Turn payload 的 `outputPreview`；追加式 Turn Event 只保存 revision、attemptId、step、charCount、truncated，不复制正文。

### 2. 写入与预算

- 只消费用户可见 `answer` delta；raw reasoning、tool-call arguments、Provider body、媒体字节与私有 URL 不得进入。
- 每 500ms 或自上次持久化新增 1024 字符时 flush，先到者触发。
- 文本上限 12KiB；保留 Markdown 换行，剥离除 tab/newline 之外的控制字符。超限截断并固定 `truncated=true`。
- `attempt-start` 必须先写空的新 attempt preview，再接受该 attempt 的 answer，防止 Vision 失败前缀在恢复时泄漏到 Text fallback。
- 工具事件前 flush，使长工具执行期间仍可恢复此前已展示的正文。
- 每次 preview commit 与轻量事件在同一 Store 锁/事务内，使用 execution generation + lease token；revision 必须单调且幂等重放只能复用完全相同的值。

### 3. 读取与实时协议

公共 Turn 在非终态时可返回安全 `outputPreview`。Runtime 在 preview commit 后向当前 SSE 观察者投影 replace-style `answer_snapshot`；GET observer 每页也比较 preview revision 并投影同一事件。客户端必须 replace content，不得 append snapshot；旧 revision 与旧 attempt 被丢弃。

### 4. 终态

`completed`、`waiting_user`、`failed` 与 `cancelled` 的权威 commit 必须原子删除 `outputPreview`。完成结果仍只来自 Turn result/稳定 Assistant Message；失败与取消仍沿用现有 notice。本 ADR 不保留 Cancel Partial。

Supabase 通过 terminal Turn trigger 兜底剥离 preview；Local/PostgreSQL Adapter 由共享 commit contract 清除。旧执行者在 lease stale 后不能写 preview。

### 5. 发布顺序

1. reader 与公共 DTO 先接受可选 preview/answer_snapshot；旧 Turn 无字段时行为不变。
2. Local/PostgreSQL/Supabase fenced writer 与 terminal clear 同步部署。
3. Runtime writer 后启用。
4. 通过断线、attempt reset、terminal clear、stale lease 和三 Adapter 契约后发布。

## 未选择

- 不把每个 token 作为 durable Event；避免事件写放大与正文复制。
- 不把 preview 写入 Agent Message；避免运行中内容进入线程上下文、Memory、反馈或执行入口。
- 不持久化 reasoning 或 tool arguments。
- 不在本 ADR 中新增 `interrupted` Message；Cancel Partial 需要独立 ADR。
- 不迁移 WebSocket mux。

## 后果

- 运行中的已展示正文成为短期服务端数据，受项目授权、数据删除和静态加密边界约束。
- 终态后不保留该投影，因此长期对话历史语义不变。
- ProductStore 的三 Adapter 与 Supabase migration 必须同步；测试/本地实现不能替代生产迁移。
- Observer 恢复从“只恢复工具轨迹，等待最终答案”提升为“恢复最近正文预览并继续等待终态”。
