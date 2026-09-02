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

## 关键语义

- Provider SSE只有`[DONE]`正常结束；malformed/closed保留具名502。
- 非流请求仍使用总timeout；流请求每个网络chunk/心跳重置idle timer；Turn deadline继续管总时长。
- Agent Protocol v1 additive增加`attempt`事件；answer/reasoning携带attemptId+chunkIndex，tool携带attemptId。
- vision/text使用现有attempt ID；Chat用`chat_text`，Planner用`plan`。
- 新attempt只清除live answer/reasoning；Tool状态仍由execute前后事实拥有。
- attempt/chunk cursor live-only；reasoning/answer仍不进入durable Turn Event。
- 指标不含文本/参数/URL/Turn ID/Project ID；每stream仅first_token一次、终态一次，不按chunk写日志。

## 指标

- first-token P50/P95
- stream duration P50/P95
- semantic chunk count P50/P95
- max chunk gap P95
- stream completed/closed/malformed计数
- OTel `botanic.agent.provider.chunk_count` 与 `max_chunk_gap`直方图

## 验证

- 774 tests。
- Architecture boundaries、Protocol artifacts、build、diff check全绿。
- 故障注入:vision流先吐废弃前缀后缺DONE，服务端产生vision→text attempts，最终结果只含text答案；前端重复/迟到chunk测试通过。
- Chromium UAT 2/2:accepted后刷新恢复且Provider只调一次；Stop不产出最终回答。
- React Doctor changed scope:0 errors；现存warnings无本批新增错误。

## 保持不变

- 无数据库/schema/ProductStore Adapter变化。
- 不启用transport retry(H3C Gate仍关闭)。
- 不持久化raw reasoning、tool-call argument delta或partial answer。
- 不迁移WebSocket mux。

## 后续Gate

Durable answer snapshot会改变内容持久化边界，必须单独ADR；Cancel partial需要产品决定“本地保留已停止前缀”还是继续保守丢弃。本批不实现。
