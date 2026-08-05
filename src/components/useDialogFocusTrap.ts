import { useEffect, useRef } from 'react'

/**
 * 让自定义浮层在打开时获得焦点，并把 Tab 导航限制在浮层内部。
 * 该行为属于共享交互基础设施，不归任何具体账户或工作区功能所有。
 */
export function useDialogFocusTrap(active: boolean) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    if (!dialog) return
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hidden)
    const frame = window.requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]') ?? focusables()[0]
      preferred?.focus({ preventScroll: true })
    })
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', trap)
    return () => { window.cancelAnimationFrame(frame); dialog.removeEventListener('keydown', trap) }
  }, [active])
  return dialogRef
}
