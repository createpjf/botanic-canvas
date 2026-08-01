# 001 — 让缩放滑杆即时跟手

- **Status**: DONE
- **Commit**: e7a74ae
- **Severity**: HIGH
- **Category**: Purpose & frequency / Interruptibility
- **Estimated scope**: 1 file，约 20–30 行

## Problem

`src/App.tsx:1515` 的 `commitViewport` 会为每次视角变化安排一次 260ms 后的补写：

```tsx
// src/App.tsx:1515 — current
const commitViewport = (operation: Promise<boolean>) => {
  void operation.then(() => onViewportChange(getViewport()))
  window.setTimeout(() => onViewportChange(getViewport()), 260)
}
```

`src/App.tsx:1552` 的缩放滑杆又在每个 `onChange` 上启动 90ms 补间：

```tsx
// src/App.tsx:1552 — current
<div className="zoom-panel__slider">
  <input
    className="zoom-track"
    aria-label="画布缩放级别"
    type="range"
    min={canvasMinZoom}
    max={canvasMaxZoom}
    step="0.01"
    value={zoom}
    style={{ '--zoom-fill': zoomFill } as CSSProperties}
    onChange={(event) => commitViewport(zoomTo(Number(event.target.value), { duration: 90 }))}
  />
</div>
```

拖动属于直接操控、高频动作。连续创建固定时长补间会让画布落后于指针；每次事件再创建一个 260ms 定时器，会在拖动结束后继续重复回写相同视角。

## Target

- 滑杆拖动时 `duration` 固定为 `0`，视角与滑块保持一一对应。
- 滑杆拖动产生的持久化写入以 `requestAnimationFrame` 合并，同一帧最多写一次。
- “聚焦”“自动整理”“显示全部”等离散操作继续使用现有 180–220ms 动画和既有最终补写机制。
- 不改变 `onViewportChange` 的数据结构、项目文档语义或画布持久化入口。

```tsx
// target shape
const directViewportFrame = useRef(0)

const commitDirectViewport = (operation: Promise<boolean>) => {
  void operation.then(() => {
    window.cancelAnimationFrame(directViewportFrame.current)
    directViewportFrame.current = window.requestAnimationFrame(() => {
      onViewportChange(getViewport())
    })
  })
}

useEffect(() => () => window.cancelAnimationFrame(directViewportFrame.current), [])

// slider
onChange={(event) => commitDirectViewport(
  zoomTo(Number(event.target.value), { duration: 0 }),
)}
```

## Repo conventions to follow

- `src/App.tsx:121` 已用 `reducedMotionRequested()` 集中判断动态偏好。
- `src/App.tsx:1653` 已使用 `requestAnimationFrame` 等待 React Flow 布局完成；继续使用浏览器原生 rAF，不增加依赖。
- `src/App.tsx:1515` 的 `commitViewport` 是离散镜头动作入口，不应被删除或改变现有成功回写语义。

## Steps

1. 在 `CanvasNavigation` 内新增 `directViewportFrame` ref，并在卸载时取消未执行的帧。
2. 新增 `commitDirectViewport`，等待 React Flow 操作完成后取消上一帧、只保留最新一次 `onViewportChange(getViewport())`。
3. 将缩放滑杆的 `zoomTo` 时长改为 `0`，并改走 `commitDirectViewport`。
4. 保持 `focusCanvas`、自动整理和显示全部继续走原 `commitViewport`。
5. 不新增 debounce 定时器；直接操控只允许 rAF 合并，避免引入拖动结束后的额外延迟。

## Boundaries

- Do NOT touch `src/store/canvasStore.ts`、服务端、同步队列或项目文档结构。
- Do NOT 改变缩放上下限、步长、视角数据格式或 React Flow 节点布局。
- Do NOT add new dependencies.
- If a step doesn't match the code you find (drift since the commit stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: 运行 `npm test`、`npm run check:architecture`、`npm run build`，预期全部通过。
- **Feel check**: 运行 `npm run dev`，打开任意含多个节点的画布并确认：
  - 快速左右拖动缩放滑杆时，画布比例紧跟指针，没有 90ms 追赶感。
  - 松手后画布不会继续产生迟到的缩放或多次状态闪动。
  - 点击“聚焦选中节点”“显示全部”仍保留平滑镜头移动。
  - 在 DevTools Performance 中记录一次连续拖动，确认单帧没有堆积多个 260ms timer callback。
- **Done when**: 连续往返拖动 5 秒仍保持直接映射，刷新后最后一次缩放值能够恢复，离散镜头动作行为不变。
