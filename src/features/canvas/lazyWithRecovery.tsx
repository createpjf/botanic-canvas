import { Component, createElement, lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { useProductI18n } from '../../i18n/react'
import { captureSentryModuleFailure, isModuleLoadError } from '../../lib/sentry'

class ModuleBoundary extends Component<{ children: ReactNode; retry: () => void; label: string }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) { return { error } }
  componentDidCatch(error: Error) {
    if (isModuleLoadError(error.message)) captureSentryModuleFailure(error)
  }
  render() {
    if (!this.state.error) return this.props.children
    if (!isModuleLoadError(this.state.error instanceof Error ? this.state.error.message : '')) throw this.state.error
    return <div role="alert" style={{ padding: 16 }}><button type="button" onClick={this.props.retry}>{this.props.label}</button></div>
  }
}

/** 每次手动重试创建新的 lazy 实例，避免 React 缓存首次失败；不刷新画布。 */
export function lazyWithRecovery<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  const initialView = lazy(load)
  return function RecoverableModule(props: ComponentProps<T>) {
    const { locale } = useProductI18n()
    const [attempt, setAttempt] = useState(() => ({ View: initialView, key: 0 }))
    return <ModuleBoundary key={attempt.key}
      label={attempt.key === 0
        ? locale === 'en' ? 'Panel failed to load · Retry' : '面板加载失败 · 重试'
        : locale === 'en' ? 'Still unavailable · Refresh page' : '仍无法加载 · 刷新页面'}
      retry={() => {
        if (attempt.key === 0) setAttempt(current => ({ View: lazy(load), key: current.key + 1 }))
        else if (window.confirm(locale === 'en'
          ? 'Refreshing may discard unsaved edits. Refresh this page?'
          : '刷新可能丢失尚未保存的修改。确定刷新页面？')) window.location.reload()
      }}>
      {createElement(attempt.View, props)}
    </ModuleBoundary>
  }
}
