# Botanic Agent 流式输出增量升级报告

基线:`origin/main@ef6dadd`。实现分支:`harness-reliability-20260901`。

## 第一批状态

| 项目 | 状态 | 解决的问题 | 提交 |
| --- | --- | --- | --- |
| S1严格Provider SSE | 完成 | 坏JSON、未闭合tail、缺`[DONE]`的半截answer/tool args不再冒充成功 | `7df4414` |
| S2 stream idle watchdog | 完成 | 健康长流不再被固定总timeout误杀；卡死流仍超时 | `ee8a416` |
| S3 attempt-start/reset | 完成 | vision流失败回退text时不再把废弃前缀与最终答案混答 | `e0dcb8f` |
| S4 PartialAccumulator | 完成 | 重复chunk、旧attempt迟到chunk被丢弃；stream状态有单一domain owner | `e0dcb8f` |
| S6 TTFT/chunk health | 完成 | 区分首token慢、解码间隔大、流截断、坏帧；为H3C提供数据 | `0c2f5b0` |

## 第二阶段：Durable TurnOutputPreview

- ADR 0012：`8d683a1`。
- 核心实现：`fe6591f`。
- 运行中answer按500ms/1KiB合并，最大12KiB；attempt-start先等待空preview fenced commit，再启动Provider。
- Turn payload只保留最新正文；`turn.output_preview.updated` Event只保存revision/attempt/step/charCount。
- 实时SSE和GET observer投影`answer_snapshot`，前端按revision replace；会话初始化清空live bubble的竞态由后续UAT修复。
- completed/waiting_user/failed/cancelled原子清除；Message、线程上下文与Cancel Partial不变。
- 新Supabase migration：`20260901120000_agent_turn_output_preview.sql`。

## 关键语义

- Provider SSE只有`[DONE]`正常结束；malformed/closed保留具名502。
- 非流请求仍使用总timeout；流请求每个网络chunk/心跳重置idle timer；Turn deadline继续管总时长。
- Agent Protocol v1 additive增加`attempt`事件；answer/reasoning携带attemptId+chunkIndex，tool携带attemptId。
- vision/text使用现有attempt ID；Chat用`chat_text`，Planner用`plan`。
- 新attempt只清除live answer/reasoning；Tool状态仍由execute前后事实拥有。
- attempt/chunk cursor live-only；reasoning与逐token answer delta不持久化。只有用户可见answer的最新有界TurnOutputPreview短期落Turn payload；Event不含正文。
- 指标不含文本/参数/URL/Turn ID/Project ID；每stream仅first_token一次、终态一次，不按chunk写日志。

## 指标

- first-token P50/P95
- stream duration P50/P95
- semantic chunk count P50/P95
- max chunk gap P95
- stream completed/closed/malformed计数
- OTel `botanic.agent.provider.chunk_count` 与 `max_chunk_gap`直方图

## 验证

- 1955 server tests + 775 app tests。
- Architecture boundaries、Protocol artifacts、build、diff check全绿。
- 故障注入:vision流先吐废弃前缀后缺DONE，服务端产生vision→text attempts，最终结果只含text答案；前端重复/迟到chunk测试通过。
- 第一阶段Chromium UAT 2/2:accepted后刷新恢复且Provider只调一次；Stop不产出最终回答。
- Preview Chromium UAT 1/1:Provider停顿30秒时刷新，GET observer恢复正文；最终请求数1；terminal DB无preview且事件无text。
- 真实Postgres SQL:preview RPC返回committed、metadata Event无text、terminal trigger清除。
- React Doctor changed scope:0 errors；现存warnings无本批新增错误。

## 保持不变

- ProductStore公共方法不新增；commit command additive支持outputPreview，三个Adapter同步。Supabase需部署ADR 0012 migration。
- 不启用transport retry(H3C Gate仍关闭)。
- 不持久化raw reasoning、tool-call argument delta或partial answer。
- 不迁移WebSocket mux。

## 后续Gate

Durable TurnOutputPreview已由ADR 0012批准并实现。Cancel Partial仍需要独立ADR决定“继续notice”或新增长期`interrupted` Message；当前不保留取消后的partial。
