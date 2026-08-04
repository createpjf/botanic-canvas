# Botanic Owner / Editor / Viewer 权限矩阵验收计划

状态：已准备，尚未执行
适用版本：PR #15 `codex/release-agent-ontology-artifact-index` 及其后续整合提交

## 1. 验收边界

本计划验证项目权限、工作区权限、Artifact Index 读取和跨刷新恢复。默认不触发真实图片或视频生成，不清理生产数据。优先在隔离 staging 工作区执行；若改用生产环境，必须使用专属测试项目、非敏感内容，并另行授权真实生成额度。

## 2. 账号与数据准备

准备三个独立账号，禁止共享浏览器 Session：

| 账号 | 工作区角色 | 测试项目角色 | 用途 |
| --- | --- | --- | --- |
| `matrix-owner` | Owner | Owner | 敏感操作、成员与审计 |
| `matrix-editor` | Member | Editor | 正常编辑与恢复 |
| `matrix-viewer` | Member | Viewer | 只读与越权拦截 |

由 Owner 创建：

- 主测试项目：`RBAC-MATRIX-<日期>`，至少包含一个图片节点、一个历史生成结果和一个 Agent Session。
- 删除专用项目：`RBAC-DELETE-<日期>`，仅用于删除权限验证。
- 一个不属于以上三个账号的现存项目 ID，以及一个确定不存在的项目 ID，用于验证 403 / 404 语义。

记录项目 ID、三个脱敏用户 ID、测试起止时间和执行环境。令牌、Cookie、邀请链接不得写入文档、截图或日志。

## 3. 项目权限矩阵

| 场景 | Owner | Editor | Viewer | 证据 |
| --- | --- | --- | --- | --- |
| 打开项目和画布 | 允许 | 允许 | 允许 | 页面截图 + `GET /api/projects/:id/document` 为 200 |
| 查看历史生成任务 | 允许 | 允许 | 允许 | `GET /api/projects/:id/generation-jobs` 为 200 |
| 查看 Agent Run | 允许 | 允许 | 允许 | `GET /api/projects/:id/agent-runs` 为 200 |
| 查看 Artifact Index | 允许 | 允许 | 允许 | `GET /api/projects/:id/agent-artifacts` 为 200，关键 Artifact ID 一致 |
| 打开或下载历史媒体 | 允许 | 允许 | 允许 | 媒体可见，响应不泄露对象存储凭据 |
| 修改测试节点或项目名 | 允许 | 允许 | 拒绝 | Owner/Editor 写入成功；Viewer 为 403 |
| 历史结果回填到画布 | 允许 | 允许 | 拒绝 | `POST /api/projects/:id/reconcile-generation-results` 为 200/200/403 |
| 将 Artifact 加入画布或继续修改 | 允许 | 允许 | 拒绝 | Viewer 控件禁用或隐藏，直接请求仍为 403 |
| 提交生成或提示词润色 | 允许 | 允许 | 拒绝 | Viewer 在任务创建前返回 403；正向真实生成需单独授权 |
| 管理项目成员 | 允许 | 拒绝 | 拒绝 | `POST /api/projects/:id/members` 为 204/403/403 |
| 读取项目审计 | 允许 | 拒绝 | 拒绝 | `GET /api/projects/:id/audit` 为 200/403/403 |
| 删除项目 | 允许 | 拒绝 | 拒绝 | 先在删除专用项目验证 Editor/Viewer 403，最后由 Owner 删除并返回 204 |

补充安全语义：

- 三个账号访问“存在但未授权”的项目均应返回 403。
- 三个账号访问确定不存在的项目均应返回 404。
- 未登录读取 Artifact Index 应返回 401 `AUTH_REQUIRED`，且不暴露项目是否存在。

## 4. 工作区权限矩阵

| 场景 | Workspace Owner | Workspace Member | 证据 |
| --- | --- | --- | --- |
| 读取、邀请或调整工作区成员 | 允许 | 拒绝 | `/api/users` 及成员操作为 2xx / 403 |
| 读取工作区审计 | 允许 | 拒绝 | `GET /api/audit` 为 200 / 403 |
| 修改共享品牌素材库 | 允许 | 拒绝 | `PUT /api/global-assets` 为 200 / 403 |
| 修改共享工作流模板 | 允许 | 拒绝 | `PUT /api/workflow-templates` 为 200 / 403 |
| 已停用账号执行敏感操作 | 不适用 | 拒绝 | 认证失败或权限为 403 |

共享库写入只在 staging 或专属测试数据上执行；测试后恢复原值并记录恢复动作。

## 5. 恢复与多端场景

三个角色分别执行：

1. 刷新页面和重新登录后，仍只看到有权访问的项目与 Artifact。
2. 在两个独立浏览器 Profile 打开同一项目，Owner/Editor 的修改可同步，Viewer 只能接收。
3. 浏览器断网后由已存在的测试任务完成，恢复网络后历史结果和 Artifact 可重新加载。
4. 删除画布结果节点后刷新，Artifact 历史身份仍存在；Viewer 不得借恢复入口写回画布。
5. 旧项目加载后，独立 Agent 实体优先于兼容字段，角色权限不因回填路径改变。

## 6. 通过标准与证据模板

全部允许项必须成功，全部拒绝项必须在服务端返回 401/403，而不是只隐藏 UI；跨项目和缺失对象必须保持 403/404 区分。任何越权写入、Artifact 泄露或 Viewer 成功提交任务均为 Release blocker。

| 用例 ID | 环境 | 角色 | 操作 | 期望 | 实际 | HTTP / 错误码 | Request ID | 截图或日志 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RBAC-001 |  | Owner |  |  |  |  |  |  |  |

验收结束后，将证据链接和失败项汇总到 PR；只记录脱敏 ID，不记录凭据。
