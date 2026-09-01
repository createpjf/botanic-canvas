# ADR 0011: Agent Connector 与凭据边界(Gate,未采纳)

提议,2026-09-01。本 ADR 只固定未来 seam 与进入实现的门槛;在 Gate 满足前,**正确状态就是停在本文档**,继续使用 operator 管理的 MCP 配置(`BOTANIC_MCP_TOOLS_JSON` + env token,ADR 0010)。

## 背景

Botanic 已有 Skill(版本化契约)、MCP Client(capability hash、outcome_unknown、Receipt)、Action Governance(审批 Token、权限矩阵)。这些足够 operator 预配置的固定外部工具,但不足以支撑**用户/项目自助安装的 Connector**(如 Shopify、DAM、Drive、Notion):缺项目级绑定、OAuth 生命周期、凭据保管与统一出网策略。

对照 Codex `rust-v0.152.0` 的 connectors/secrets/keyring-store 分层:凭据存取是独立后端、connector 是声明式目录、出网集中治理。Botanic 不复制其 plugin marketplace——单产品阶段的安装/升级/供应链/沙箱成本无法被证明。

## 进入实现的 Gate(全部满足才开工)

1. **已命名首个真实 Connector**:具体产品需求指名要接哪个系统,不是「以后可能用」。
2. **维护者批准 credential backend 与数据库迁移**:凭据表/加密方案属于 schema 变更,需单独评审。
3. **Agent Protocol v1 已稳定**:Connector 的工具目录与错误码必须进 protocol catalog,不再手写第二份。
4. **首版只做声明式 HTTP/MCP Connector**:不执行第三方代码;需要跑代码的集成回到「受控执行平台」路线(见 2026-09-01 层级差距研究)。

## 决定(冻结的未来 seam)

### Capability 目录

- Connector 声明 identity/version/inputSchema/outputSchema/risk/recovery/auth requirement,复用 MCP 的 capability hash 与 replay policy;进入 Turn 前冻结进 step snapshot,同一回合内不漂移。
- 暴露给模型的工具经现有 Tool Registry 装配,不建第二套注册机制。

### 绑定与授权

- **Project Connector Binding** 是独立持久化实体(三个 ProductStore Adapter 同步实现+契约测试):项目 × Connector × 凭据引用 × 启用状态。
- 安装/撤权是 owner 权限(`execute-external-tool` 之上新增 `manage-connectors`),走 Action Proposal/Receipt 确认链。
- 撤权立即生效:执行中的调用按 outcome_unknown 收口,不回滚已完成 Receipt。

### 凭据

- OAuth grant/refresh/revoke 由服务端独立模块拥有;token 只存 credential backend(生产至少 DB 加密列,评审时决定是否引入外部 vault)。
- token **绝不进入** Turn/Message/Plan/Run/Artifact/日志/语义事件/checkpoint;出现即 bug。
- 浏览器只见「已连接/未连接 + 授权账号显示名」;raw token 不下发(与现有 Action Receipt 的 token 纪律一致)。

### 出网

- Connector 出网统一走 `webEgressGuard` 的 DNS 解析+私网拦截(现 MCP URL 仅校验 https:,开放用户配置前必须补齐)。
- 每 Connector 独立配额与超时;调用经 Receipt,复用 mcp_call 的确认策略与 uncertain 人工核对。

### 运维

- install/upgrade/disable 每步留审计;全局 kill switch 与现有 feature flag 语义一致(kill 默认不干预,触发后 fail closed)。
- Connector 目录/绑定进 harness 指标(低基数:connector kind/outcome,不含项目/用户)。

## 不做

- Plugin marketplace、第三方代码执行、浏览器端 OAuth 弹窗自管理(用服务端回调)、把 Skill 改造成 Connector 容器。

## 后果

- Gate 前:新外部集成继续 operator 配置,改 env 重启生效;这是有意的低成本路径。
- Gate 后:上述 seam 逐条变更为实现任务,凭据迁移单独 change set;本 ADR 升级为「已采纳」并补充实际 schema。
