# 003 — 缩小血缘聚焦的全画布重绘

- **Status**: DONE
- **Commit**: e7a74ae
- **Severity**: HIGH
- **Category**: Performance / Purpose & frequency
- **Estimated scope**: 2 files，约 15–25 行

## Problem

任意节点选中后，`src/App.tsx:2787` 都会建立血缘聚焦：

```tsx
// src/App.tsx:2787 — current
const selectedFocusNodeIds = useMemo(() => {
  const selectedIds = document.nodes.filter((node) => node.selected).map((node) => node.id)
  if (selectedIds.length) return selectedIds
  return selectedNodeId ? [selectedNodeId] : []
}, [document.nodes, selectedNodeId])
const focusedLineage = useMemo(
  () => traceCanvasLineage(selectedFocusNodeIds, document.edges),
  [document.edges, selectedFocusNodeIds],
)
const hasLineageFocus = selectedFocusNodeIds.length > 0
```

`src/App.tsx:2851` 随后为所有节点计算 `is-lineage` 或 `is-lineage-muted`。CSS 对全画布节点和边同时动画 `opacity`、`filter`、`stroke-width`：

```css
/* src/styles.css:2450 — current */
.botanic-flow .react-flow__node,
.botanic-flow .react-flow__edge-path { transition: opacity 150ms ease, filter 150ms ease, stroke-width 150ms ease; }
.botanic-flow.has-lineage-focus .react-flow__node.is-lineage-muted { opacity: .2; filter: saturate(.5); }
.botanic-flow.has-lineage-focus .react-flow__node.is-lineage { opacity: 1; }
.botanic-flow.has-lineage-focus .react-flow__edge.is-lineage-muted .react-flow__edge-path { opacity: .1; }
.botanic-flow.has-lineage-focus .react-flow__edge.is-lineage .react-flow__edge-path { opacity: 1; stroke-width: 2.35px !important; filter: drop-shadow(0 1px 2px rgba(38, 86, 51, .2)); }
```

节点选择是高频动作。大画布上同时改变 `filter`、阴影和线宽会对大量 SVG/HTML 节点触发重绘，节点越多越明显。

## Target

全画布聚焦仅过渡可合成的 `opacity`；不再给全部节点与血缘边动画滤镜或线宽。

```css
/* target */
.botanic-flow .react-flow__node,
.botanic-flow .react-flow__edge-path {
  transition: opacity 150ms cubic-bezier(.2, .8, .2, 1);
}
.botanic-flow.has-lineage-focus .react-flow__node.is-lineage-muted { opacity: .2; }
.botanic-flow.has-lineage-focus .react-flow__node.is-lineage { opacity: 1; }
.botanic-flow.has-lineage-focus .react-flow__edge.is-lineage-muted .react-flow__edge-path { opacity: .1; }
.botanic-flow.has-lineage-focus .react-flow__edge.is-lineage .react-flow__edge-path { opacity: 1; }
```

选中对象的深描边继续由 `src/styles.css:228` 的 `.react-flow__edge.selected` 和节点自身选中样式表达，不在血缘集合上叠加阴影。

## Repo conventions to follow

- `src/styles.css:221` 已使用 120ms opacity 过渡表达画布状态。
- `src/styles.css:2004` 使用 `cubic-bezier(.2, .8, .2, 1)` 作为现有快速 UI ease-out；本计划保持现有视觉语言，不引入新 token。
- `src/styles.css:228` 已对真正选中的边提供深色描边和小范围阴影，应复用而不是扩大阴影作用范围。

## Steps

1. 保留 `traceCanvasLineage`、`selectedFocusNodeIds` 和 `is-lineage` class 计算，不改领域逻辑。
2. 将节点与边路径的 transition 缩减为单独的 `opacity 150ms cubic-bezier(.2, .8, .2, 1)`。
3. 从 `.is-lineage-muted` 节点移除 `filter: saturate(.5)`。
4. 从 `.is-lineage` 边移除 `stroke-width` 和 `drop-shadow`，只保留 opacity。
5. 保留 `.react-flow__edge.selected` 和视频边的既有选中样式。

## Boundaries

- Do NOT 修改节点选择、血缘追踪算法、边数据或 React Flow class 生成逻辑。
- Do NOT 改变 muted opacity `.2` / `.1` 或选中节点层级。
- Do NOT 修改视频/图片边的颜色体系。
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: 运行 `npm test`、`npm run check:architecture`、`npm run build`，预期全部通过。
- **Feel check**: 在至少 30 个节点的画布中连续选择不同分支并确认：
  - 非血缘节点和边仍平滑淡出，血缘关系仍清楚。
  - 全画布不再发生饱和度变化或大量边阴影闪动。
  - 真正选中的节点/边仍有明确的深描边反馈。
  - DevTools Performance 记录连续选择，Paint 时间相较当前实现下降。
  - 减少动态模式下 opacity transition 仍按现有规则关闭。
- **Done when**: 血缘聚焦只动画 opacity，样式中不再对全局节点/边过渡 filter 或 stroke-width，选择语义保持不变。
