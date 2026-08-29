import { useEffect, useState } from 'react'
import { ArrowUpRightIcon } from '../../components/BotanicIcons'
import {
  emptyStatusSnapshot,
  type StatusDayCell,
  type StatusHourCell,
  type StatusLevel,
  type StatusSnapshot,
} from '../../domain/statusPage'
import { LanguageSwitcher, useProductI18n } from '../../i18n/react'
import { loadStatusSnapshot, readStatusPageConfig } from '../../lib/statusPage'

type StatusWorkspaceProps = {
  isAuthenticated: boolean
  onEnterWorkspace: () => void
  ariaHidden?: boolean
}

const statusPageCopy = {
  'zh-CN': {
    brandAria: 'Botanic 产品首页',
    navAria: '状态页导航',
    homeNav: '产品首页',
    statusNav: '状态',
    signIn: '登录工作台',
    enterWorkspace: '进入工作台',
    title: '系统状态',
    checking: '正在检查系统状态',
    disclaimer: '这里只列出有广泛影响的事故。个别项目或单次生成问题不会出现。',
    noIncidents: '近期没有公开事故',
    updated: '更新于',
    components: {
      web: '工作台',
      api: 'API',
      auth: '登录',
    },
    ongoing: '进行中',
    hours: '过去 24 小时',
    days: '过去 30 天',
    unconfigured: '状态页未接入',
    levels: {
      operational: '全部正常',
      degraded: '部分异常',
      outage: '严重中断',
      maintenance: '维护中',
      unknown: '无法探测',
    },
  },
  en: {
    brandAria: 'Botanic product home',
    navAria: 'Status page',
    homeNav: 'Product home',
    statusNav: 'Status',
    signIn: 'Sign in',
    enterWorkspace: 'Open workspace',
    title: 'System status',
    checking: 'Checking system status',
    disclaimer: 'This page lists incidents with widespread impact. Isolated project or generation issues do not appear here.',
    noIncidents: 'No public incidents recently',
    updated: 'Updated',
    components: {
      web: 'Workspace',
      api: 'API',
      auth: 'Sign-in',
    },
    ongoing: 'Ongoing',
    hours: 'Last 24 hours',
    days: 'Last 30 days',
    unconfigured: 'Status page is not connected',
    levels: {
      operational: 'All systems operational',
      degraded: 'Partial disruption',
      outage: 'Major disruption',
      maintenance: 'Maintenance',
      unknown: 'Status unavailable',
    },
  },
} as const

type StatusCopy = (typeof statusPageCopy)[keyof typeof statusPageCopy]

function formatUptime(value: number | null) {
  return value == null ? '—' : `${value.toFixed(2)}%`
}

function formatLocalStamp(iso: string, locale: string) {
  return new Date(iso).toLocaleString(locale)
}

function formatLocalRange(start: string, end: string, locale: string) {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  return `${new Date(start).toLocaleString(locale, options)} – ${new Date(end).toLocaleString(locale, options)}`
}

function overallText(snapshot: StatusSnapshot | null, copy: StatusCopy) {
  if (!snapshot) return copy.checking
  if (snapshot.loadState === 'unconfigured') return copy.unconfigured
  if (snapshot.loadState === 'unavailable' || snapshot.overall == null) return copy.levels.unknown
  return copy.levels[snapshot.overall]
}

function overallLevel(snapshot: StatusSnapshot | null): StatusLevel | 'unconfigured' | 'checking' {
  if (!snapshot) return 'checking'
  if (snapshot.loadState === 'unconfigured') return 'unconfigured'
  if (snapshot.loadState === 'unavailable' || snapshot.overall == null) return 'unknown'
  return snapshot.overall
}

function hourCellLabel(cell: StatusHourCell, locale: string, copy: StatusCopy) {
  const parts = [formatLocalRange(cell.start, cell.end, locale), copy.levels[cell.level]]
  if (cell.incidentTitle) parts.push(cell.incidentTitle)
  return parts.join(', ')
}

function downtimePhrase(seconds: number, locale: string) {
  return locale === 'zh-CN' ? `宕机 ${seconds} 秒` : `${seconds} seconds downtime`
}

function dayCellLabel(cell: StatusDayCell, locale: string, copy: StatusCopy) {
  const parts = [cell.day, copy.levels[cell.level]]
  if (cell.downtimeSeconds > 0) parts.push(downtimePhrase(cell.downtimeSeconds, locale))
  return parts.join(', ')
}

function StatusCells({
  cells,
  kind,
  locale,
  copy,
}: {
  cells: StatusHourCell[] | StatusDayCell[]
  kind: 'hour' | 'day'
  locale: string
  copy: StatusCopy
}) {
  return (
    <ol className="product-status__cells">
      {cells.map((cell) => {
        const key = kind === 'hour' ? (cell as StatusHourCell).start : (cell as StatusDayCell).day
        const label = kind === 'hour'
          ? hourCellLabel(cell as StatusHourCell, locale, copy)
          : dayCellLabel(cell as StatusDayCell, locale, copy)
        return (
          <li
            key={key}
            tabIndex={0}
            className={`product-status__cell product-status__cell--${cell.level}`}
            aria-label={label}
            title={label}
          />
        )
      })}
    </ol>
  )
}

export default function StatusWorkspace({
  isAuthenticated,
  onEnterWorkspace,
  ariaHidden = false,
}: StatusWorkspaceProps) {
  const { locale } = useProductI18n()
  const copy = statusPageCopy[locale]
  const enterLabel = isAuthenticated ? copy.enterWorkspace : copy.signIn
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(() => {
    const config = readStatusPageConfig()
    return config.jsonUrl ? null : emptyStatusSnapshot('unconfigured', new Date().toISOString(), config.subscribeUrl)
  })

  useEffect(() => {
    let active = true
    void loadStatusSnapshot().then((next) => {
      if (active) setSnapshot(next)
    })
    return () => {
      active = false
    }
  }, [])

  const banner = overallText(snapshot, copy)
  const bannerLevel = overallLevel(snapshot)

  return (
    <main
      className="product-status"
      lang={locale}
      aria-hidden={ariaHidden || undefined}
      inert={ariaHidden || undefined}
      aria-busy={snapshot === null || undefined}
    >
      <header className="product-landing__nav">
        <a className="product-landing__brand" href="/" aria-label={copy.brandAria}>
          <strong>Botanic</strong>
          <span>AI VISUAL PRODUCTION</span>
        </a>
        <nav aria-label={copy.navAria}>
          <a href="/">{copy.homeNav}</a>
          <a href="/status" aria-current="page">{copy.statusNav}</a>
          <LanguageSwitcher className="product-landing__language" />
        </nav>
        <div className="product-landing__nav-actions">
          <button type="button" className="product-landing__login" onClick={onEnterWorkspace}>
            {enterLabel} <ArrowUpRightIcon />
          </button>
        </div>
      </header>

      <div className="product-status__frame">
        <h1>{copy.title}</h1>
        <p className={`product-status__overall product-status__overall--${bannerLevel}`} role="status">
          <i aria-hidden="true" />
          {banner}
        </p>

        {snapshot ? (
          <>
            <p className="product-status__disclaimer">{copy.disclaimer}</p>

            {snapshot.components.length ? (
              <ul className="product-status__components">
                {snapshot.components.map((component) => (
                  <li key={component.id}>
                    <div className="product-status__component-head">
                      <strong>{copy.components[component.id as keyof typeof copy.components] ?? component.name}</strong>
                      <span className={`product-status__level product-status__level--${component.level}`}>
                        {copy.levels[component.level]}
                      </span>
                    </div>
                    <div className="product-status__windows">
                      <div className="product-status__window">
                        <div className="product-status__window-meta">
                          <span>{copy.hours}</span>
                          <span>{formatUptime(component.uptime24h)}</span>
                        </div>
                        <StatusCells cells={component.hours24} kind="hour" locale={locale} copy={copy} />
                      </div>
                      <div className="product-status__window">
                        <div className="product-status__window-meta">
                          <span>{copy.days}</span>
                          <span>{formatUptime(component.uptime30d)}</span>
                        </div>
                        <StatusCells cells={component.days30} kind="day" locale={locale} copy={copy} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            <section className="product-status__incidents">
              {snapshot.loadState === 'ready' && snapshot.incidents.length === 0 ? (
                <p>{copy.noIncidents}</p>
              ) : snapshot.incidents.length ? (
                <ul>
                  {snapshot.incidents.map((incident) => (
                    <li key={incident.id}>
                      <div className="product-status__incident-head">
                        <strong>{incident.title}</strong>
                        <span className={`product-status__level product-status__level--${incident.level}`}>
                          {copy.levels[incident.level]}
                        </span>
                        {incident.resolvedAt ? null : <em>{copy.ongoing}</em>}
                      </div>
                      <p>
                        <time dateTime={incident.startedAt}>{formatLocalStamp(incident.startedAt, locale)}</time>
                        {incident.resolvedAt ? (
                          <>
                            {' – '}
                            <time dateTime={incident.resolvedAt}>{formatLocalStamp(incident.resolvedAt, locale)}</time>
                          </>
                        ) : null}
                      </p>
                      {incident.updates.length ? (
                        <ol>
                          {incident.updates.map((update) => (
                            <li key={`${update.at}-${update.body}`}>
                              <time dateTime={update.at}>{formatLocalStamp(update.at, locale)}</time>
                              <span>{update.body}</span>
                            </li>
                          ))}
                        </ol>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <footer className="product-status__footer">
              <span>{copy.updated} {formatLocalStamp(snapshot.updatedAt ?? snapshot.fetchedAt, locale)}</span>
            </footer>
          </>
        ) : null}
      </div>
    </main>
  )
}
