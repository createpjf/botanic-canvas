# Agent Turn 不兼容快照发布与回退

适用于工具 schema/描述、模型、权限绑定、Skill/Memory catalog 或 context policy 改变而导致 `attempt.snapshotHash` 变化的发布。2026-09-22 O1 的工具分页参数变更属于此类。**采用排空后切换，不承诺旧 Turn 跨版本继续执行。** 不改旧 Checkpoint、不用新哈希覆盖旧哈希、不重复提交原消息。

## 为什么不能直接滚动发布

`server/agent/turn/botanicAgentTurn.mjs` 的 `turnAttempt` 对冻结快照取哈希；`server/agent/tools/agentToolRuntime.mjs` 在恢复前校验 id/model/hash。旧快照遇到新能力必须返回 `AGENT_TURN_CHECKPOINT_SNAPSHOT_MISMATCH`。只读工具的返回语义也可能改变，即使 schema 未变，也不能把哈希相同当成所有发布都安全。

`listAgentTurnsForProject` 有项目/身份过滤和最多 100 条限制；`listStaleAgentTurns` 仅返回失联 queued/running/cancelling。它们都不能证明全局排空，waiting_user 也不能当完成。

## 发布顺序（需要单独的生产操作授权）

1. 确认目标环境、数据库、当前和目标代码版本；记录回退镜像。保持旧版本 API/Worker 与当前模型和 Skill 配置不变。已有数据库迁移门禁仍按 ADR 0004 执行，本次不提供或执行迁移。
2. 在部署平台/入口设置持续的维护隔离，阻止新业务写入。至少涵盖 POST `/api/agent-turns` 及 `/stream`，旧 `/api/agent-chat`、`/api/agent-intent`、`/api/agent-plans` 及各自 `/stream`，Plan continuation、Run/retry/review、subagent followup、队列和自动化创建入口。只隐藏 UI 或仅阻断一个 URL 不够；防止通过源站/内网绕过入口隔离。
3. 用**旧版本**推进已有工作到终态；只保留需要的观察、补读与显式取消路径。waiting_user 的确认会继续业务，须在受控窗口完成后重新封闭入口；或者由原用户明确取消并等到取消传播完成。不得自动取消、批量标 failed、删除任务或缩短 TTL 来制造零值。超时或无法安全收口则推迟发布。
4. 完成排空后停止并确认退出全部旧 API/Worker/队列消费者/自动创建器，包括 subagent 调度器；维护隔离继续保持。让仍在提交的事务结束。**只有这时才可声明 `--quiesced`。** 进程在最后退出时留下新的非终态，下面的门禁会阻断；需要恢复旧版本继续收口，再重复本步骤。
5. 通过已授权的秘密注入机制提供 `AGENT_TURN_RELEASE_DATABASE_URL`，明确连接实际 PostgreSQL 或 Supabase 的 PostgreSQL 数据库；不把密码放进命令行，不从 `.env` 自动猜目标。使用有全表可见性的已授权角色，不为通过门禁临时扩大权限。

   ```bash
   node scripts/agentTurnReleaseGate.mjs --expected-database '<已核对的数据库名>' --quiesced
   ```

   退出 0 = 该只读快照中只有一致的 completed/failed/cancelled，且操作者声明所有创建器已经静止；退出 1 = 阻断；退出 2 = 未验证（连接、权限、RLS、缺表、超时或参数问题）。数据库名只是额外防误连检查，不能替代核对连接的环境/实例身份。不得把错误当成零。

6. 在**同一个持续停写窗口**切换所有 API/Worker 到目标版本，避免旧新消费者混跑。保存门禁输出和版本记录；窗口中一旦重开入口、重启旧生产者或改变数据库，之前的门禁结果失效。脚本不持有锁，也不检测进程/网络隔离，`quiescedAttested` 是操作声明，不是自动检测结果。
7. 在维护隔离内完成目标版本 smoke：测试账户的终态补读、相同 Message 的重试不产生第二个 Turn、断线后观察同一 Turn、取消的持久终态。涉及模型/生图或生产数据写入需相应授权；本地 fake Provider 通过不能代替生产证明。确认全部实例同版本、既有迁移门禁通过、指标正常后才开放入口。

## 门禁边界

- SQL 是 repeatable-read/read-only 全表聚合，不返回项目内容、消息、Checkpoint 或 ID；不新增 ProductStore 接口，不改三套 Adapter。
- `row_security=off` **不是绕过 RLS**：如果当前角色会被策略过滤，PostgreSQL 必须报错，不能返回一个貌似为空的子集。只读连接无法获得完整可见性时停止，联系维护者提供已有的合法运维途径。
- queued/running/waiting_user/cancelling、未知状态、`status` 与 `payload.status` 不一致都阻断。只查 `public.agent_turns`；非标准 schema、多数据库、多租户分库须逐个确认，不能用一次输出代表其他库。
- Local Adapter 没有共享数据库，不在这个生产门禁的认证范围。隔离 UAT 仍可验证恢复行为，但不能用 Local 结果代替 PG/Supabase 的全局清点。
- 这是 **Turn 快照兼容门禁**，不是 Generation Job/ReviewTask/Run/Action 的全系统发布认证。那些实体的 writer、租约、未知副作用与迁移要求仍需按其自身发布规范检查。

## 回退

目标版本还未接受任何新请求时，可在持续隔离下切回已记录旧版本，并复核数据库兼容性。目标版本已经接受请求时，先按同样流程让**目标版本**排空并静止，再运行门禁，之后才回旧版本。不得把新 Checkpoint 交给旧 Runtime，不恢复过时数据库备份来覆盖用户数据。

## 本次证据与尚未验证项

- `scripts/agentTurnReleaseGate.test.mjs` 覆盖全局 SQL 形状、read-only、RLS 防静默过滤声明、目标/静止声明、活动与不一致状态阻断。注入式 SQL 测试不是实际 PostgreSQL 执行或 RLS 实验。
- `server/agent/tools/agentToolRuntime.test.mjs` 的“发布新增工具分页参数”用旧 schema 生成 prepared/completed Checkpoint，证明新 schema 在任何模型、工具或写回前拒绝；既有终态/receipt/fencing/恢复测试继续复用。
- 本次没有连接生产数据库、设置维护窗口、发布、迁移或取消真实任务。实际 PG/Supabase 全局清点、并发/RLS 验证及生产回退演练仍是上线前门槛。
