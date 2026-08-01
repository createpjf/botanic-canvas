# 002 — 让画布镜头遵守减少动态

- **Status**: DONE
- **Commit**: e7a74ae
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 1 file，约 25–40 行

## Problem

页面转场已经在 `src/App.tsx:127` 检测减少动态，但画布镜头仍在多个入口硬编码非零时长：

```tsx
// src/App.tsx:1468 — current
function focusTaskFlow(setCenter: SetCenter, nodes: CanvasNode[]) {
  if (!nodes.length) return Promise.resolve(false)
  // ...
  return setCenter((left + right) / 2, (top + bottom) / 2 + composerSafeOffset, { zoom: canvasMinZoom, duration: 220 })
}
```

```tsx
// src/App.tsx:1524 — current
const focusCanvas = () => {
  if (selectedNodes.length) {
    commitViewport(fitView({ nodes: selectedNodes, duration: 180, padding: 0.32, minZoom: canvasMinZoom, maxZoom: 1.2 }))
    return
  }
  if (taskNodes.length) {
    commitViewport(focusTaskFlow(setCenter, taskNodes))
    return
  }
  commitViewport(fitView({ duration: 180, padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 }))
}
```

```tsx
// src/App.tsx:2030 — current
useEffect(() => {
  if (!node) return
  const frame = window.requestAnimationFrame(() => {
    void fitView({ nodes: [node], duration: 220, padding: 0.48, minZoom: canvasMinZoom, maxZoom: 1.05 })
  })
  return () => window.cancelAnimationFrame(frame)
}, [fitView, node, requestId])
```

画布平移和缩放比小组件淡入更容易引发不适；当前减少动态用户仍会看到 180–220ms 的大范围镜头运动。

## Target

建立唯一时长转换函数：普通模式原样返回，减少动态时返回 `0`。

```tsx
// target
function viewportMotionDuration(duration: number) {
  return reducedMotionRequested() ? 0 : duration
}
```

以下非零镜头时长必须通过该函数：

- `focusTaskFlow` 的 220ms。
- 聚焦选中节点和显示全部的 180ms。
- 自动整理后的 220ms。
- Composer 为避免遮挡而移动视角的 180ms。
- `FocusCanvasNode` 的 220ms。

减少动态只取消位置补间，不取消最终定位、视角保存和节点选择反馈。

## Repo conventions to follow

- 复用 `src/App.tsx:121` 的 `reducedMotionRequested()`，不要建立第二个媒体查询实现。
- 页面转场在 `src/App.tsx:127` 已采用“动态偏好只影响视觉过程，不影响状态更新”的模式。
- 画布恢复在 `src/App.tsx:1650` 已使用 `duration: 0`，可作为无动画定位的正确示例。

## Steps

1. 在 `reducedMotionRequested()` 附近新增 `viewportMotionDuration(duration)`，保持为无副作用纯函数。
2. 将 `focusTaskFlow` 的 `duration: 220` 改为 `duration: viewportMotionDuration(220)`。
3. 修改 `CanvasNavigation` 内聚焦、自动整理、显示全部的 180/220ms 时长。
4. 修改 Composer 避让视角的 `setViewport(..., { duration: 180 })`。
5. 修改 `FocusCanvasNode` 的 `fitView(..., { duration: 220 })`。
6. 保留首次画布恢复使用的 `duration: 0`，不要二次包装。

## Boundaries

- Do NOT 改变最终 x/y/zoom、padding、minZoom 或 maxZoom。
- Do NOT 修改页面 View Transition 的现有减少动态分支；该问题不在本计划内。
- Do NOT 修改 React Flow 节点、连线或持久化契约。
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: 运行 `npm test`、`npm run check:architecture`、`npm run build`，预期全部通过。
- **Feel check**: 在 DevTools Rendering 中切换 `prefers-reduced-motion: reduce`，确认：
  - “聚焦选中节点”“显示全部”“自动整理”直接抵达最终视角，不经过平移或缩放补间。
  - 点击历史素材定位节点时直接抵达对应节点。
  - 新任务完成后的自动聚焦直接抵达，但节点仍被正确选中。
  - 关闭减少动态后，原有 180–220ms 镜头移动恢复。
- **Done when**: 所有非恢复型 `fitView`、`setCenter`、`setViewport` 非零时长均通过同一 helper，减少动态模式下无画布镜头补间且最终视角正确。
