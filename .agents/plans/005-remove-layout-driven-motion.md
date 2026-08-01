# 005 — 移除进度与 Composer 的布局属性动画

- **Status**: DONE
- **Commit**: e7a74ae
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 1 file，约 8–15 行

## Problem

生成进度的基础样式声明了 `width` transition：

```css
/* src/styles.css:1117 — current */
.generation-progress { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 6px 8px; margin: 0 0 10px; padding: 8px; border: 1px solid #dce8de; border-radius: 8px; background: #f7faf6; }
.generation-progress > div { height: 4px; overflow: hidden; border-radius: 999px; background: #e0e9e1; }
.generation-progress > div > span { display: block; height: 100%; border-radius: inherit; background: #4f835c; transition: width 180ms ease-out; }
```

当前 JSX 在 `src/App.tsx:5439` 只渲染不确定进度 `.is-indeterminate`，它已经用 `transform` 位移；基础 `width` transition 没有必要。

Composer 折叠同时动画外框 `width` 与内容 `max-height`：

```css
/* src/styles.css:2156 — current */
.canvas-composer {
  /* ... */
  transition: width 180ms cubic-bezier(.2, .8, .2, 1);
}
.canvas-composer.is-collapsed { width: min(320px, calc(100% - 32px)); }
```

```css
/* src/styles.css:2201 — current */
.canvas-composer__expanded-content { display: grid; grid-template-rows: minmax(0, 1fr) auto; max-height: min(360px, calc(100dvh - 152px)); min-height: 0; overflow: hidden; opacity: 1; transform: translate3d(0, 0, 0); transition: max-height 180ms cubic-bezier(.2, .8, .2, 1), opacity 130ms linear, transform 180ms cubic-bezier(.2, .8, .2, 1); }
.canvas-composer.is-collapsed .canvas-composer__expanded-content { max-height: 0; opacity: 0; transform: translate3d(0, 4px, 0); pointer-events: none; }
```

`width` 和 `max-height` 每帧触发布局。Composer 又可拖动并覆盖 React Flow 画布，这种布局动画容易在节点较多时放大卡顿。

## Target

第一阶段采用“高频折叠即时响应”的最小修复：删除布局属性 transition，不新增 JS 动画或依赖。

```css
/* target */
.generation-progress > div > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #4f835c;
}

.canvas-composer {
  /* existing visual properties remain */
  transition: none;
}

.canvas-composer__expanded-content {
  /* existing layout and state properties remain */
  transition: none;
}
```

`.is-indeterminate` 继续使用现有 `transform: translateX()` 动画；折叠/展开的最终尺寸、`aria-hidden` 和 `inert` 行为不变，只取消中间布局补间。

## Repo conventions to follow

- `src/styles.css:1347` 的不确定进度已经通过 transform 移动，是正确的性能路径。
- `src/App.tsx:873` 已用 `aria-hidden` 与 `inert` 同步折叠状态，取消视觉补间不会改变可访问性语义。
- AUDIT 规定高频 UI 的最强修复往往是删除动画；本计划不为折叠引入复杂 FLIP 或第三方 spring。

## Steps

1. 删除 `.generation-progress > div > span` 的 `transition: width 180ms ease-out`。
2. 删除 `.canvas-composer` 的 width transition。
3. 删除 `.canvas-composer__expanded-content` 的 `max-height`、opacity 和 transform transition 声明；保留展开/折叠的最终属性。
4. 保留 `.is-indeterminate` 的 transform 动画及其减少动态降级。
5. 检查折叠后 Composer 拖动边界仍依据最终尺寸计算，不改拖动代码。

## Boundaries

- Do NOT 改变展开和折叠的最终宽度、最大高度、DOM 结构、`aria-hidden` 或 `inert`。
- Do NOT 修改 Composer prompt、参数、生成请求或拖动持久化。
- Do NOT 引入 FLIP、WAAPI、Framer Motion 或 spring；若后续需要更强表现，另立计划。
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: 运行 `npm test`、`npm run check:architecture`、`npm run build`，预期全部通过。
- **Feel check**: 在含大量节点的画布上反复折叠/展开 Composer 并触发生成等待状态，确认：
  - Composer 状态立即切换，没有宽度或高度逐帧重排。
  - 折叠后没有可聚焦的隐藏表单控件，展开后控件恢复。
  - 拖动已折叠和已展开 Composer 时边界均正确。
  - 不确定进度仍平滑横移；减少动态模式下保持静态。
  - DevTools Performance 中折叠操作不再出现连续 180ms Layout 记录。
- **Done when**: CSS 不再 transition `width` 或 `max-height`，Composer 最终布局和生成状态语义保持一致。
