# ADR 0010：MCP Runtime V2 与 Skill Manifest 快照

## 状态

已采纳，2026-08-28。

## 背景

旧 MCP 白名单只固定 `server.tool → URL`，确认提案没有绑定工具版本或结构化契约。管理员在用户确认后修改配置时，
执行会静默使用新能力；响应也会先完整载入，且 URL 结果曾可能被误当作可写入画布的媒体。旧 Skill 版本只摘要部分
字段，依赖在挂载时重新解析；能力、Manifest 或依赖改变后，历史 Run 无法证明实际执行的契约。

## 决策

### 1. MCP 是版本化、不可自动重放的外部能力

- Composition root 从服务端配置建立 Runtime；业务层只得到 `catalog()` 与 `invoke()`，不得接触 URL、token 或传输参数。
- 目录项固定 `server.tool`、`version`、规范化输入/输出 Schema、`capabilityHash` 与 `replayPolicy: never`。
  hash 由公开身份和结构化契约计算；配置可选声明 hash，但必须与计算值完全一致。
- Proposal 固定工具 key、version 与 capability hash。执行在出网前重新比对当前目录；缺失或漂移 fail closed，要求重新确认。
- 输入先按冻结 Schema 校验并投影；未知字段不会越过契约边界。响应先按字节上限读取，再严格校验 JSON-RPC 2.0、
  request id 与输出 Schema。
- 只有参数、身份或派发前取消能证明行动未发生。请求开始派发后的取消、超时、网络失败、远端 error、协议错误、
  截断和输出 Schema 错误都按 `outcome_unknown` 收口，Receipt 不自动重放。

### 2. 工具结果不能授予媒体权限

- 外部 MCP 返回的 HTTPS URL 只是数据，不是 Botanic 媒体授权；不得直接创建 Artifact、画布节点或素材引用。
- 只有经过项目权限检查、规范化为同源 `/api/media/...` 的资源可以提升为 Artifact。浏览器仍看不到 MCP 地址和凭据。

### 3. Skill 每版保存完整语义快照

- Skill 执行内容 hash 覆盖 name、instructions、capabilities 与完整 Manifest；内置 Skill 与项目 Skill 使用同一身份规则。
- 每个版本保存完整快照。语义变化只能无间隙追加下一版本，历史前缀不可截断或覆写；完全相同的写入幂等重放。
  唯一允许的同版本元数据变化是同一语义 `draft → published` 首次补齐批准信息。
- Manifest 依赖在创建版本时解析并固定 `id + version + contentHash`。DFS 只把当前递归栈识别为环，公共依赖形成的
  菱形图合法；缺失、弃用或身份不匹配显式进入 dependency issues，不静默替换。
- `guidance` Skill 不得声明无人消费的 outputSchema；`evaluator` 的结构化输出由评审执行器验证。工具风险取 capabilities
  自称和 Manifest allowlist 中注册表真实风险的较高者，未知工具按最高风险。`evaluator.outputSchema` 任意嵌套对象键
  统一使用结构化契约的 ASCII 字段词表（含必填 `verdict`），避免 Node UTF-16 与 PostgreSQL C collation 对 Unicode 键
  排序不同而产生跨 Adapter content hash 分叉。

### 4. 历史与存储契约

- `GET /api/projects/:projectId/agent-skills/:skillId/versions/:version` 经项目权限读取安全历史版本，不返回存储私有字段。
- Local、PostgreSQL、Supabase Adapter 共用同一持久化决策与契约测试，读取指定版本的行为一致。
- 版本历史继续保存在既有 Skill JSON payload 中，不新增表或列。PostgreSQL 在事务行锁内重做前缀校验；
  Supabase 必须先执行 `20260828220000_agent_skill_atomic_persistence.sql`，由单个 RPC 在同一事务内持锁、重算
  canonical hash、验证无间隙历史并写入审计。缺少 RPC 时 Adapter fail closed，不回退 read-then-upsert。

## 兼容与迁移

- 未声明 version 的存量 MCP 配置归一为 `1`；未声明 Schema 的配置暂用开放对象契约。新配置必须收紧 Schema。
- 旧的、没有 version/capabilityHash 绑定的 MCP Proposal 不再执行，用户需重新发起并确认。这是有意的安全断点。
- Skill 旧记录在下一次受控写入时形成完整快照；Adapter 不自行补版本、不重算内容 hash，也不截断历史。

## 后果

- 用户确认的是稳定能力，不是可被配置热替换的名字；跨实例恢复仍能验证原执行身份。
- MCP 协议或响应失败可能增加人工核对，但不会以自动重试放大未知副作用。
- 完整 Skill 历史与冻结依赖支持审计、重放和旧 Run 解释；代价是每版 JSON payload 增长，后续可在不改变领域契约的
  前提下迁移到规范化历史表。
