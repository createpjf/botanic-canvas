import { useState } from 'react'

export type AgentWebSourcePillItem = {
  hostname: string
  href?: string
  title?: string
}

function AgentWebSourceFavicon({ hostname }: { hostname: string }) {
  const [failed, setFailed] = useState(false)
  const letter = (hostname.trim().charAt(0) || '?').toLocaleUpperCase()
  if (failed || !hostname.trim()) {
    return <span className="agent-web-source-favicon agent-web-source-favicon--fallback" aria-hidden="true">{letter}</span>
  }
  return (
    <img
      className="agent-web-source-favicon"
      src={`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(hostname)}`}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

/** 站点身份胶囊：favicon + 域名；图标失败回退字母底。 */
export function AgentWebSourcePills({ sources }: { sources: AgentWebSourcePillItem[] }) {
  if (!sources.length) return null
  return (
    <ul className="agent-timeline-search-sources">
      {sources.map((source) => {
        const content = (
          <>
            <AgentWebSourceFavicon hostname={source.hostname} />
            <span>{source.hostname}</span>
          </>
        )
        return (
          <li key={source.hostname}>
            {source.href ? (
              <a
                className="agent-timeline-search-source"
                href={source.href}
                target="_blank"
                rel="noopener noreferrer"
                title={source.title || source.hostname}
              >
                {content}
              </a>
            ) : (
              <span
                className="agent-timeline-search-source agent-timeline-search-source--static"
                title={source.title || source.hostname}
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
