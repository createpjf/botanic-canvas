# Botanic 动效优化计划

审计基线：`e7a74ae`。第一轮 5 项已完成，并通过测试、架构检查与生产构建。

| 编号 | 计划 | 严重度 | 状态 | 依赖 |
| --- | --- | --- | --- | --- |
| 001 | [让缩放滑杆即时跟手](001-zoom-slider-direct-manipulation.md) | HIGH | DONE | 无 |
| 002 | [让画布镜头遵守减少动态](002-canvas-viewport-reduced-motion.md) | HIGH | DONE | 建议在 001 后执行，避免重复修改缩放入口 |
| 003 | [缩小血缘聚焦的全画布重绘](003-lineage-focus-compositor-only.md) | HIGH | DONE | 无 |
| 004 | [补齐持续动画的减少动态降级](004-complete-reduced-motion-coverage.md) | HIGH | DONE | 无 |
| 005 | [移除进度与 Composer 的布局属性动画](005-remove-layout-driven-motion.md) | MEDIUM | DONE | 无 |

## 推荐执行顺序

1. **001 → 002**：先拆分“连续拖动”和“离散镜头”入口，再统一减少动态时长，避免同一处重复返工。
2. **003**：独立收敛大画布选择态的重绘范围。
3. **004**：补齐已有 reduced-motion 策略，不改变普通模式。
4. **005**：删除布局属性动画，并重点人工检查 Composer 折叠体验。

## 共同边界

- 不修改生图请求、任务队列、结果回填、媒体存储或画布文档语义。
- 不新增动画库或其他运行时依赖。
- 每个计划单独验证；若源码已偏离计划中的 commit 和代码片段，停止并重新审计。
- 完成全部计划后统一执行 `npm test`、`npm run check:architecture` 和 `npm run build`，再进行 DevTools 动画慢放、Performance 与 `prefers-reduced-motion` 检查。
