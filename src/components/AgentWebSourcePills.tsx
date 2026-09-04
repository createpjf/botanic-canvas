import { Source } from './ai-elements/sources'

export type AgentWebSourcePillItem = {
  hostname: string
  href?: string
  title?: string
}

function AgentWebSourceMark({ hostname }: { hostname: string }) {
  const letter = (hostname.trim().charAt(0) || '?').toLocaleUpperCase()
  return <span className="agent-web-source-mark" aria-hidden="true">{letter}</span>
}

/** 站点身份胶囊只用本地字母标记，不向第三方图标服务泄露来源域名。 */
export function AgentWebSourcePills({ sources }: { sources: AgentWebSourcePillItem[] }) {
  if (!sources.length) return null
  return (
    <ul className="agent-timeline-search-sources">
      {sources.map((source) => {
        const accessibleLabel = source.title
          ? `${source.hostname} — ${source.title}`
          : source.hostname
        const content = (
          <>
            <AgentWebSourceMark hostname={source.hostname} />
            <span>{source.hostname}</span>
          </>
        )
        return (
          <li key={source.hostname}>
            {source.href ? (
              <Source
                className="agent-timeline-search-source"
                href={source.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={accessibleLabel}
              >
                {content}
              </Source>
            ) : (
              <span
                className="agent-timeline-search-source agent-timeline-search-source--static"
                title={accessibleLabel}
                aria-label={accessibleLabel}
              >
                {content}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
