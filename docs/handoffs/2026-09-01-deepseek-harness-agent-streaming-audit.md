# DeepSeek Harness Agent 流式输出审计

审计目录:`/Users/leo/Desktop/deepseek-harness-master`。

结论:存在完整生产链路；Provider上游是SSE，Host到Web是WebSocket Remote Stream Mux，不是端到端SSE。

```text
DeepSeek SSE
→ parseSse / translate
→ provider-neutral StreamChunk
→ AgentLoop session.append('assistant/chunk', seq)
→ SessionController.follow() snapshot + gap-free tail
→ WebSocket /api/remote.mux item frame
→ RemoteStreamMuxClient AsyncGenerator
→ PartialAccumulator
→ Web UI
```

## 源码锚点

- Provider SSE:`packages/llm/llm-deepseek/src/adapter.ts:522-703`。
- 严格`[DONE]`/EOF失败:`packages/llm/llm-deepseek/src/sse.ts:28-40`。
- delta翻译:`packages/llm/llm-deepseek/src/translate.ts:96-194`。
- Agent逐chunk durable:`packages/core/agent-loop/src/agent.ts:341-427`。
- Session snapshot+tail:`packages/api/session-controller/src/history.ts:88-172`。
- WS mux server:`packages/api/gateway/src/stream-server.ts:134-178`。
- WS mux client:`packages/api/gateway/src/client/stream-client.ts:80-245`。
- UI PartialAccumulator:`packages/client/ui-chat/src/client/conversation-nodes/partial.ts:18-95`。
- 取消时interrupted prefix:`packages/core/agent-loop/src/agent.ts:372-388`。

## 对Botanic的结论

可借鉴:严格SSE、idle watchdog、attempt隔离、chunk identity、partial accumulator、TTFT/chunk health指标。

不直接移植:每token durable chunk和WebSocket mux。Botanic现有durable Turn + HTTP SSE + GET observer自洽；reasoning不得持久化，WS迁移也不是增量改动。
