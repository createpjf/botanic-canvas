# H0 基线同步与红灯证据(2026-09-01)

## 基线
- 审计起点:`main@38a38bc`;实施基线:本地 `origin/main@a05e564`(fast-forward 后从其创建 `harness-reliability-20260901`)
- `git fetch` 失败:本机代理 `127.0.0.1:1082` 拒绝连接,无法验证真实远端;维护者已批准以 `a05e564` 为基线
- 工作区无脏改动(仅未跟踪文档);保留 stash 与既有分支

## 关键函数与 caller(a05e564)
- `resolveBotanicAgentMountedSkills` / `botanicAgentMountedSkillBriefing`:caller 为 botanicAgentTurn.mjs:1054-1055、botanicAgentChat.mjs:326、botanicAgentPlanner.mjs:685/696-699
- `runAgentToolLoop`:caller 为 botanicAgentTurn.mjs:887、botanicAgentChat.mjs:193、botanicAgentPlanner.mjs:774、agentSubagentRunner.mjs:316
- `createBotanicAgentTurnRuntime`:caller 为 worker.mjs:211、httpServer.mjs:430、agentRoutes.mjs:254
- `awaitDurableTurn`:agentTurnSubmission.mjs:113,唯一 caller 同文件 :198

## 红灯复现(临时 probe,已删除,不提交)
| # | 红灯 | 证据 |
|---|---|---|
| 1 | 请求 16 个 Skill 只解析 8 个 | `resolveBotanicAgentMountedSkills` 返回 8(`botanicAgentTools.mjs:191` `.slice(0, 8)`) |
| 2 | 挂载正文 2000 字静默截断 | 2001 字 sentinel 在 briefing 中消失(`botanicAgentTools.mjs:221` `.slice(0, 2000)`) |
| 3 | unknown Skill ID 静默丢弃 | 请求 2 个(1 unknown)解析 1 个,无错误(`botanicAgentTools.mjs:179/190`) |
| 4 | 最后一轮执行工具后直接 loop limit | maximumSteps=2,工具执行 2 次后抛 `TOOL_LOOP_LIMIT_REACHED`,无最终综合(`agentToolRuntime.mjs:1074`) |
| 5 | 非 WEB_* 工具错误直接终止 | `ENTITY_NOT_FOUND` 冒泡终止,modelCalls=1,模型无修复机会(`agentToolRuntime.mjs:192-194/849`) |
| 6 | 根 signal 不达工具 | `tool.execute` context 无 signal 字段;`runAgentToolLoop` 无 signal 参数(全文件 grep signal 0 命中) |
| 7 | Planner 整轮 timeout | `botanicAgentPlanner.mjs:702-703` 单个 `AbortSignal.timeout` 覆盖整轮 |
| 8 | submission poller 无上限 | `agentTurnSubmission.mjs:125` 固定 5ms 轮询,无 deadline |
| 9 | 无 Turn deadline | `deadlineAt`/`AGENT_TURN_LIFETIME` grep 0 命中 |

## 结论
9 项红灯全部存在,无一被主线修复;H1–H7 全部 change set 保留。主线已有 per-provider-call timeout(Turn `botanicAgentTurn.mjs:876`、Chat `botanicAgentChat.mjs:175` `activeCallTimeout`),实施中保留。
