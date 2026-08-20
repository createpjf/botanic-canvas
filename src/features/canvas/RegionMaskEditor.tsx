import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { RegionRect } from '../../domain/regionMask'
import { describeRegionRect, regionRectFromPoints } from '../../domain/regionMask'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap'
import { CloseIcon } from '../../components/BotanicIcons'
import { useProductI18n } from '../../i18n/react'

type RegionMaskEditorTarget = { id: string; name: string; image: string }

function normalizedPoint(event: ReactPointerEvent, element: HTMLElement) {
  const bounds = element.getBoundingClientRect()
  return {
    x: Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1),
    y: Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1),
  }
}

/**
 * 局部重绘选区编辑器：在基准图上拖拽框出要重绘的区域，配一句重绘说明。
 * 只产出归一化选区（纯数据）；位图蒙版由生成 Worker 按基准图真实像素生成。
 */
export function RegionMaskEditor({ target, busy, hidePrompt, submitLabel, onSubmit, onClose }: {
  target: RegionMaskEditorTarget
  busy: boolean
  /** Agent 链路的重绘说明已在指令里：只框选，不再要求二次输入。 */
  hidePrompt?: boolean
  submitLabel?: string
  onSubmit: (input: { rect: RegionRect; prompt: string }) => void
  onClose: () => void
}) {
  const { locale } = useProductI18n()
  const dialogRef = useDialogFocusTrap(true)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const [draftRect, setDraftRect] = useState<RegionRect | null>(null)
  const [rect, setRect] = useState<RegionRect | null>(null)
  const [prompt, setPrompt] = useState('')

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceRef.current || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStartRef.current = normalizedPoint(event, surfaceRef.current)
    setDraftRect(null)
  }, [])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceRef.current || !dragStartRef.current) return
    setDraftRect(regionRectFromPoints(dragStartRef.current, normalizedPoint(event, surfaceRef.current)))
  }, [])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceRef.current || !dragStartRef.current) return
    const next = regionRectFromPoints(dragStartRef.current, normalizedPoint(event, surfaceRef.current))
    dragStartRef.current = null
    setDraftRect(null)
    if (next) setRect(next)
  }, [])

  const activeRect = draftRect ?? rect
  const copy = locale === 'en' ? {
    label: 'Redraw region',
    close: 'Close region redraw',
    hint: `Drag over “${target.name}” to select the area to redraw; everything outside the selection stays unchanged.`,
    promptLabel: rect ? `Redraw ${describeRegionRect(rect, locale)} as:` : 'Redraw instructions',
    placeholder: 'For example: blooming white camellias while preserving the light direction',
    noSelection: 'No region selected',
    busy: 'A task is already running',
    submit: 'Redraw selection',
  } : {
    label: '局部重绘',
    close: '关闭局部重绘',
    hint: `在「${target.name}」上拖拽框出要重绘的区域；框外画面保持原样。`,
    promptLabel: rect ? `重绘${describeRegionRect(rect)}为：` : '重绘说明',
    placeholder: '例如：盛开的白色山茶花丛，保持光线方向不变',
    noSelection: '尚未框选区域',
    busy: '已有任务运行中',
    submit: '重绘选区',
  }

  return createPortal(
    <div className="region-mask-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="region-mask-editor" role="dialog" aria-modal="true" aria-label={copy.label}>
        <header>
          <div><span>REGION EDIT</span><h2>{copy.label}</h2></div>
          <button type="button" onClick={onClose} aria-label={copy.close}><CloseIcon /></button>
        </header>
        <p className="region-mask-editor__hint">{copy.hint}</p>
        <div
          ref={surfaceRef}
          className="region-mask-editor__surface"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <img src={target.image} alt={target.name} draggable={false} />
          {activeRect ? <div
            className="region-mask-editor__selection"
            style={{
              left: `${activeRect.x * 100}%`,
              top: `${activeRect.y * 100}%`,
              width: `${activeRect.width * 100}%`,
              height: `${activeRect.height * 100}%`,
            }}
          /> : null}
        </div>
        {hidePrompt ? null : <label className="region-mask-editor__prompt">
          <span>{copy.promptLabel}</span>
          <textarea
            value={prompt}
            rows={3}
            placeholder={copy.placeholder}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>}
        <footer>
          <span>{rect ? describeRegionRect(rect, locale) : copy.noSelection}</span>
          <button
            type="button"
            disabled={busy || !rect || (!hidePrompt && !prompt.trim())}
            onClick={() => { if (rect && (hidePrompt || prompt.trim())) onSubmit({ rect, prompt: prompt.trim() }) }}
          >{busy ? copy.busy : submitLabel ?? copy.submit}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
