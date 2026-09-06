import { Source } from './ai-elements/sources'
import { safeTimelineWebSources } from '../domain/agentTimelineWebSources'
import { useProductI18n } from '../i18n/react'
import { InlineCitation, InlineCitationCard, InlineCitationCardBody, InlineCitationCardTrigger, InlineCitationSource, InlineCitationText } from './ai-elements/inline-citation'

export type AgentWebSourcePillItem = {
  hostname: string
  href?: string
  title?: string
}

function uniqueWebSources(sources: AgentWebSourcePillItem[]): AgentWebSourcePillItem[] {
  return (safeTimelineWebSources(sources.map(({ hostname, href, title }) => ({ hostname, url: href, title })), 30) ?? [])
    .map(({ hostname, url, title }) => ({ hostname, href: url, title }))
}

/** 正文末尾的来源引用：一个官方样式胶囊，详情里再展开全部来源。 */
export function AgentInlineCitation({ sources }: { sources: AgentWebSourcePillItem[] }) {
  const { locale } = useProductI18n()
  const unique = uniqueWebSources(sources)
  const linkedSources = unique.filter((source): source is AgentWebSourcePillItem & { href: string } => Boolean(source.href))
  if (!unique.length) return null
  const hrefs = linkedSources.map((source) => source.href)
  const accessibleLabel = linkedSources.map((source) => source.title ? `${source.hostname} — ${source.title}` : source.hostname).join('、')
  return <InlineCitation className="agent-inline-citation">
    {unique.filter((source) => !source.href).map((source) => <span key={source.hostname}>{source.hostname}</span>)}
    {linkedSources.length ? <InlineCitationCard>
      <InlineCitationCardTrigger sources={hrefs} aria-label={`${accessibleLabel} ${locale === 'en' ? 'details' : '详情'}`} />
      <InlineCitationCardBody aria-label={accessibleLabel} closeLabel={locale === 'en' ? 'Close' : '关闭'}>
        <div className="agent-inline-citation__sources">
          {linkedSources.map((source) => <InlineCitationSource key={source.href} title={source.title ?? source.hostname} url={source.href} />)}
        </div>
      </InlineCitationCardBody>
    </InlineCitationCard> : null}
  </InlineCitation>
}

function AgentWebSourceMark({ hostname }: { hostname: string }) {
  const letter = (hostname.trim().charAt(0) || '?').toLocaleUpperCase()
  return <span className="agent-web-source-mark" aria-hidden="true">{letter}</span>
}

/** 站点身份胶囊只用本地字母标记，不向第三方图标服务泄露来源域名。 */
export function AgentWebSourcePills({ sources }: { sources: AgentWebSourcePillItem[] }) {
  const { locale } = useProductI18n()
  const uniqueSources = uniqueWebSources(sources)
  if (!uniqueSources.length) return null
  return (
    <ul className="agent-timeline-search-sources">
      {uniqueSources.map((source) => {
        const accessibleLabel = source.title
          ? `${source.hostname} — ${source.title}`
          : source.hostname
        const content = (
          <>
            <AgentWebSourceMark hostname={source.hostname} />
            <span>{source.hostname}</span>
          </>
        )
        return <li key={source.href || source.hostname}>
          <InlineCitation className="agent-timeline-search-citation">
            {source.href ? <Source
              className="agent-timeline-search-source"
              href={source.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={accessibleLabel}
            >
              <InlineCitationText>{content}</InlineCitationText>
            </Source> : <span
              className="agent-timeline-search-source agent-timeline-search-source--static"
              title={accessibleLabel}
              aria-label={accessibleLabel}
            ><InlineCitationText>{content}</InlineCitationText></span>}
            {source.title ? <InlineCitationCard>
              <InlineCitationCardTrigger sources={source.href ? [source.href] : []} aria-label={`${accessibleLabel} ${locale === 'en' ? 'details' : '详情'}`}>i</InlineCitationCardTrigger>
              <InlineCitationCardBody aria-label={accessibleLabel} closeLabel={locale === 'en' ? 'Close' : '关闭'}><InlineCitationSource title={source.title} url={source.href} /></InlineCitationCardBody>
            </InlineCitationCard> : null}
          </InlineCitation>
        </li>
      })}
    </ul>
  )
}
