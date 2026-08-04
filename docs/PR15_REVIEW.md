# PR #15 双轴审查记录

审查日期：2026-08-04（Asia/Shanghai）
固定点：`origin/main...26c6a1a`
审查轴：Standards / Spec

## Standards

| 发现 | 级别 | 处理 |
| --- | --- | --- |
| 提交状态无法确认时必须复用原幂等键 | P1 | 已增加 `submission_unknown` 恢复态，原提交键写入任务节点，刷新和跨设备恢复继续复用；架构文档明确区分网络恢复与用户主动重新生成 |
| Memory PUT 可能清除同时戳墓碑 | P1 | 已同步 PostgreSQL、Supabase Adapter 与 Supabase RPC 的 LWW 规则；同时戳由墓碑胜出，并增加契约测试 |
| 真实 Owner / Editor / Viewer 权限矩阵尚未执行 | P1 / 人工阻断项 | 已补充独立验收计划；仍需三个真实账号和脱敏证据，未宣称通过 |

未发现需要处理的代码 smell。

## Spec

| 发现 | 级别 | 处理 |
| --- | --- | --- |
| Railway PostgreSQL 回填缺少事务内缺失/畸形对账 | P0 | 已在第三类来源回填后增加事务内对账；失败会回滚同一启动事务 |
| 历史实体 ID 冲突可能被 `on conflict do nothing` 静默吞掉 | P0 | 明确采用“全局实体 ID + 项目归属”语义；PostgreSQL 回填增加项目/会话归属对账，Supabase RPC 明确拒绝跨项目冲突 |
| 历史 Generation Artifact 可能丢失 `sourceNodeIds` | P1 | PostgreSQL 与 Supabase 回填从项目文档提取结果节点；客户端以服务端字段为权威，同时合并当前画布可定位节点 |

## 自动验证

- `npm test`：服务端 184 项、客户端 120 项通过。
- `npm run build`：通过。
- `npm run check:architecture`：通过。
- `npm run check:security`：通过。
- `git diff --check`：通过。

## 未关闭的人工阻断项

- Owner / Editor / Viewer 真实账号权限矩阵。
- Supabase leaked-password protection 启用或书面接受延期风险。
- 真实生成额度下新增 Artifact 在线写入样本；此项需要单独授权。
