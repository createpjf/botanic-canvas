import { createPortal } from 'react-dom'
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon } from './BotanicIcons'
import { useMotionPresence } from './motionPresence'

export type BotanicSelectOption = { value: string; label: string }

export function BotanicSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
  menuWidth,
  placeholder,
  renderTrigger,
  renderOption,
}: {
  value: string | number
  options: BotanicSelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
  menuWidth?: number
  placeholder?: string
  renderTrigger?: (selected: BotanicSelectOption | undefined) => ReactNode
  renderOption?: (option: BotanicSelectOption, selected: boolean) => ReactNode
}) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null)
  const menuPresence = useMotionPresence(open, 110)
  const normalizedValue = String(value)
  const selected = options.find((option) => option.value === normalizedValue)

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(window.innerWidth - 24, Math.max(menuWidth ?? 0, rect.width, 116))
    const estimatedHeight = Math.min(280, options.length * 32 + 12)
    const opensAbove = window.innerHeight - rect.bottom < estimatedHeight + 12 && rect.top > estimatedHeight
    setAnchor({
      left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left)),
      top: opensAbove ? Math.max(12, rect.top - estimatedHeight - 6) : Math.min(window.innerHeight - 48, rect.bottom + 6),
      width,
    })
  }, [menuWidth, options.length])

  useEffect(() => {
    if (!open) return
    updateAnchor()
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('resize', updateAnchor)
    window.addEventListener('scroll', updateAnchor, true)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('resize', updateAnchor)
      window.removeEventListener('scroll', updateAnchor, true)
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, updateAnchor])

  useEffect(() => {
    if (!open || !anchor) return
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [anchor, open])

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown'
      ? (current + 1 + buttons.length) % buttons.length
      : (current - 1 + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }

  return <span className={`botanic-select ${className}${open ? ' is-open' : ''}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="botanic-select__trigger"
      disabled={disabled || !options.length}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={() => {
        if (!open) updateAnchor()
        setOpen((current) => !current)
      }}
    >
      {renderTrigger ? renderTrigger(selected) : <span>{selected?.label ?? placeholder ?? '请选择'}</span>}
      <ChevronDownIcon className="botanic-select__chevron" />
    </button>
    {menuPresence.present && anchor && typeof document !== 'undefined' ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        className={`botanic-select__menu is-${menuPresence.phase}`}
        style={anchor}
        role="listbox"
        aria-label={ariaLabel}
        aria-hidden={menuPresence.phase === 'exit' ? true : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={moveFocus}
      >
        {options.map((option) => <button
          type="button"
          role="option"
          aria-selected={option.value === normalizedValue}
          className={option.value === normalizedValue ? 'is-selected' : ''}
          key={option.value}
          onClick={() => {
            onChange(option.value)
            setOpen(false)
            triggerRef.current?.focus()
          }}
        >{renderOption ? renderOption(option, option.value === normalizedValue) : <>{option.label}{option.value === normalizedValue ? <b>✓</b> : null}</>}</button>)}
      </div>,
      document.body,
    ) : null}
  </span>
}
