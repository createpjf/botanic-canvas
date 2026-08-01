# 004 — 补齐持续动画的减少动态降级

- **Status**: DONE
- **Commit**: e7a74ae
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 1 file，约 10–20 行

## Problem

同步保存状态持续脉冲：

```css
/* src/styles.css:1651 — current */
.canvas-sync-status.is-saving .canvas-sync-status__summary i { background: #b18b42; box-shadow: 0 0 0 3px rgba(177, 139, 66, .13); animation: canvas-sync-pulse 1.25s ease-in-out infinite; }
```

项目骨架持续扫光：

```css
/* src/styles.css:1949 — current */
.project-card--skeleton { min-height: 330px; border-color: transparent; background: linear-gradient(100deg, #edf0eb 32%, #f7f8f5 45%, #edf0eb 58%); background-size: 220% 100%; animation: project-card-shimmer 1.2s ease-in-out infinite; }
```

润色成功仍包含 1.4s 缩放、旋转与描边动画：

```css
/* src/styles.css:2217 — current */
.canvas-composer__refine.is-complete { color: #2f7040; pointer-events: none; }
.canvas-composer__refine.is-complete svg { animation: composer-refine-success 1.4s ease-out both; }
.canvas-composer__prompt.is-refinement-success textarea { animation: composer-refine-success-border 1.4s ease-out both; }
```

现有 `src/styles.css:2398` 的减少动态规则只关闭润色 loading，没有覆盖上述三类动画：

```css
/* src/styles.css:2398 — current */
@media (prefers-reduced-motion: reduce) {
  .canvas-composer__refine.is-loading svg { animation: none; }
  /* ... */
}
```

## Target

减少动态模式保留状态含义和颜色，不保留循环位移、缩放、旋转或扫光：

```css
/* target addition inside the existing media query */
@media (prefers-reduced-motion: reduce) {
  .canvas-sync-status.is-saving .canvas-sync-status__summary i,
  .project-card--skeleton,
  .canvas-composer__refine.is-loading svg,
  .canvas-composer__refine.is-complete svg,
  .canvas-composer__prompt.is-refinement-success textarea {
    animation: none;
  }
}
```

- 保存中仍显示黄色状态点。
- 项目加载仍显示静态渐变骨架。
- 润色成功仍显示绿色图标和已经更新的文本，不执行缩放旋转。
- 不用 `display:none` 隐藏任何状态反馈。

## Repo conventions to follow

- `src/styles.css:1135` 已在减少动态时关闭 loading dot、候选骨架和画布加载动画。
- `src/styles.css:1341` 已正确关闭生成流光、脉冲和流动连线。
- `src/styles.css:2418` 已把结果节点入场降级为 100ms opacity-only；本计划继续遵循“保留信息、移除位置运动”。

## Steps

1. 在 `src/styles.css:2398` 的现有减少动态块中扩展 animation 关闭列表。
2. 加入保存同步状态点、项目骨架、润色完成图标和润色成功文本框。
3. 保留各组件的背景、颜色、边框和文案，确保状态仍可识别。
4. 不新增额外 reduced-motion 媒体块，避免规则继续分散。

## Boundaries

- Do NOT 改变普通动态模式下的动画时长；润色成功 1.4s 的普通模式优化属于后续独立发现。
- Do NOT 修改同步状态机、项目加载逻辑或润色请求逻辑。
- Do NOT 隐藏 loading、saving 或 success 信息。
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: 运行 `npm test`、`npm run check:architecture`、`npm run build`，预期全部通过。
- **Feel check**: 在 DevTools Rendering 中开启 `prefers-reduced-motion: reduce`，分别触发项目加载、画布保存、润色成功并确认：
  - 项目骨架可见但不扫光。
  - 保存中黄色状态点可见但不脉冲。
  - 润色成功绿色状态可见，但图标不缩放旋转、文本框不扩散光环。
  - 关闭减少动态后，原有动画恢复。
- **Done when**: 三类遗漏动画在减少动态模式中全部静止，同时其状态颜色和文字仍可识别。
