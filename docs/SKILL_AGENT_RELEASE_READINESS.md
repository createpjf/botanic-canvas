# Skill 与 Agent 发布就绪手册

## 适用范围

本手册覆盖 Skill 生命周期、Agent 确认前影响预览、Action Receipt 与失败恢复入口。它不授权生产迁移、Canary 或部署。

## 本地与 CI 门禁

在干净工作树和 Node.js 22 环境运行：

```bash
npm ci
npx playwright install chromium
npm run release:ready
```

`release:ready` 顺序执行单元/契约测试、固定 Agent eval、安全检查、架构边界、生产构建和 Chromium Playwright E2E。测试使用本地持久化或固定 fixture，不调用真实模型 Provider，不读取生产素材，不执行数据库迁移。

通过标准：命令退出码为 0；没有 skipped/only 测试；构建生成 `dist/release.json`；Playwright 报告无失败。

## Staging UAT

1. 记录待发布 commit SHA、staging Web/API URL、数据库备份时间与当前 Canvas Sync epoch。
2. 先运行 staging migration dry-run；核对将执行的 migration 清单，再执行 migration。
3. 用测试项目完成 Skill 主路径：新建草稿 → 编辑 → preflight → 提交审核 → 发布 → 挂载 → 触发 Agent 计划。
4. 验证非 published Skill 不出现在可挂载目录；发布后出现，弃用后消失。
5. 在计划卡核对“保持、改变、写入、恢复”，再确认行动；核对 Action Receipt、Run、Artifact 和画布结果血缘。
6. 模拟一个可重试失败，确认任务面板保留重试、修改参数或换模型入口。
7. 刷新页面，确认 Skill 版本、Run 绑定、Receipt 与恢复入口不漂移。
8. 运行 `npm run smoke:e2e -- --base-url <staging-url>`（仅在已配置隔离测试项目和额度时）；保存输出与时间戳。

任何一步失败都停止推进，保留证据并回滚 staging 变更。不得用生产项目代替 staging 测试项目。

## Production Go/No-Go（必须再次人工确认）

执行前必须单独确认以下内容：

- staging UAT 全部通过，commit SHA 与待部署 artifact 一致；
- 数据库备份可恢复，migration 有明确 rollback/forward-fix；
- Sentry release、告警、值守人与回滚负责人已就位；
- 已选择一个低风险项目作为 Epoch 2 Canary；
- 生产 Provider 额度、速率限制和熔断策略已确认。

确认后才可依次执行：production migration → `npm run canvas:epoch2` 的单项目 Canary → 部署 → 在线健康、Skill 生命周期、Agent Receipt/恢复验证。不要并行扩大 Canary。

## 回滚触发条件

以下任一情况立即停止扩量：migration 错误；非 published Skill 可执行；Receipt 与实际写入不一致；Run/Artifact 血缘丢失；Canvas Sync epoch/版本冲突异常上升；关键错误率或延迟超过既定阈值。

应用层回滚使用上一已知良好 artifact；数据库按 migration 预案处理；Canvas Sync 使用既有 `scripts/canvasSyncEpoch2Cutover.mjs`，不得临时创建替代脚本。回滚后再次执行健康检查和最小读写验证，并记录 incident 时间线。
