# Botanic 版本与 PR 流程

## 基线分支

- `main`：始终保持可构建、可测试的稳定版本。
- 大版本、跨模块功能和生产架构调整不得直接在 `main` 开发。
- 紧急线上修复完成后，也要通过 PR 留下变更与验证记录。

## 大版本流程

1. 从最新 `main` 创建 `codex/<版本或功能>` 分支。
2. 开发期间只提交该版本范围内的文件，避免混入无关修改。
3. 至少运行：

   ```bash
   npm test
   npm run build
   npm run check:architecture
   npm run check:security
   npm run test:e2e
   git diff --check
   ```

4. 推送分支并创建 Draft PR。
5. PR 中说明需求、实现、影响模块、兼容策略和验证结果。
6. 检查通过并完成人工确认后再合并到 `main`。

## 生产发布与验收

1. Railway API 必须配置 `/api/health` 健康检查；发布成功以健康检查通过和实例保持运行共同判定，不能只看构建完成。
2. API、Worker 与前端分别记录 deployment ID 和源码 revision。服务端独立修复若未改变前端产物，可以保留上一成功 Vercel deployment，但必须重新验证同源代理 `/api/health`。
3. 前端可见版本号改 [`package.json`](../package.json) 的 `version`；构建 revision 取 `VERCEL_GIT_COMMIT_SHA` 前 7 位，并写入同次产物的 `/release.json`。已打开的工作台按 revision 发现更新后必须刷新才能继续，检查失败不拦截。不要把前端门闩挂到 Railway `/api/health`：API 与 Vercel 可独立发布。`index.html` 与 `release.json` 必须 `Cache-Control: no-store`，`/assets/*` 保持长缓存。
4. 至少验证：Railway 直连健康接口 200、Vercel 同源健康接口 200、未登录受保护接口 401、API/Worker 启动日志无错误。
5. 涉及生成或恢复语义时，使用一个最小真实任务验证浏览器 → API → Queue → Worker → Provider → Media → 项目恢复；验收后删除临时项目。
6. HTTP 错误路径必须通过真实请求入口测试，防止路由已写响应后组合根再次写头；仅对处理函数做单元测试不足以覆盖该类生产崩溃。

## 需要 PR 的改动

- 生图请求、任务状态机、队列或 Worker；
- 项目文档、数据库、媒体存储或离线同步；
- 画布节点模型、历史回填或批量输出；
- 登录、权限、部署架构或环境变量；
- 大范围 UI、交互或组件重构；
- 依赖升级和数据迁移。

仅文案错别字等低风险小改动可以合并到就近 PR，不单独创建版本分支。
