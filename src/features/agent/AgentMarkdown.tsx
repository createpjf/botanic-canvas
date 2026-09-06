import { Children, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { BotanicAgentMentionCatalog } from '../../domain/agentMentions'
import {
  localizeAgentSourceLabel,
  splitAgentMessageSources,
} from '../../domain/agentMarkdown'
import {
  MessageResponse,
  type MessageResponseProps,
} from '../../components/ai-elements/message'
import { AgentRichText } from './AgentMentionText'
import { useProductI18n } from '../../i18n/react'

const agentMarkdownUrlTransform: NonNullable<MessageResponseProps['urlTransform']> = (url, key) => {
  if (key !== 'href') return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

const zhStreamdownTranslations: NonNullable<MessageResponseProps['translations']> = {
  close: '关闭',
  copied: '已复制',
  copyCode: '复制代码',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadFile: '下载文件',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载 CSV',
  downloadTableAsMarkdown: '下载 Markdown',
  exitFullscreen: '退出全屏',
  openExternalLink: '打开外部链接',
  openLink: '打开链接',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV',
  viewFullscreen: '全屏查看',
}

const agentMarkdownControls: NonNullable<MessageResponseProps['controls']> = {
  table: false,
  code: { copy: true, download: false },
}

const agentMarkdownShikiTheme: NonNullable<MessageResponseProps['shikiTheme']> = [
  'github-light-high-contrast',
  'github-dark-high-contrast',
]

function renderMentionChildren(children: ReactNode, catalogs?: BotanicAgentMentionCatalog) {
  return Children.map(children, (child) => typeof child === 'string'
    ? <AgentRichText text={child} catalogs={catalogs} />
    : child)
}

/** 正文包含代码和引用，不能通过字段名猜测并删除内容。 */
export function agentDisplayMarkdownContent(source: string) {
  return source
}

export function AgentMarkdownSources({ sources, catalogs, onLocate }: { sources: string[]; catalogs?: BotanicAgentMentionCatalog; onLocate?: (id: string) => void }) {
  const { locale } = useProductI18n()
  const uniqueSources = [...new Set(sources.map((source) => {
    const value = source.trim()
    return catalogs?.references?.find((item) => item.id === value || `@${item.id}` === value)?.id ?? value
  }).filter(Boolean))]
  if (!uniqueSources.length) return null
  return <div className="agent-markdown__sources" aria-label={locale === 'en' ? 'Sources' : '来源'}>
    {uniqueSources.map((source) => {
      const reference = catalogs?.references?.find((item) => item.id === source || `@${item.id}` === source)
      return reference && onLocate
        ? <button type="button" key={source} title={locale === 'en' ? 'Locate on canvas' : '定位画布'} onClick={() => onLocate(reference.id)}>{reference.label}</button>
        : <small key={source}>{localizeAgentSourceLabel(source, locale)}</small>
    })}
  </div>
}

export function AgentMarkdown({
  content,
  catalogs,
  showSources = true,
}: {
  content: string
  catalogs?: BotanicAgentMentionCatalog
  showSources?: boolean
}) {
  const { locale } = useProductI18n()
  const { body, sources } = splitAgentMessageSources(agentDisplayMarkdownContent(content))
  const components = useMemo<NonNullable<MessageResponseProps['components']>>(() => ({
    p: ({ children }) => <p>{renderMentionChildren(children, catalogs)}</p>,
    li: ({ children }) => <li>{renderMentionChildren(children, catalogs)}</li>,
    h1: ({ children }) => <h1>{renderMentionChildren(children, catalogs)}</h1>,
    h2: ({ children }) => <h2>{renderMentionChildren(children, catalogs)}</h2>,
    h3: ({ children }) => <h3>{renderMentionChildren(children, catalogs)}</h3>,
    h4: ({ children }) => <h3>{renderMentionChildren(children, catalogs)}</h3>,
    h5: ({ children }) => <h3>{renderMentionChildren(children, catalogs)}</h3>,
    h6: ({ children }) => <h3>{renderMentionChildren(children, catalogs)}</h3>,
    strong: ({ children }) => <strong>{renderMentionChildren(children, catalogs)}</strong>,
    em: ({ children }) => <em>{renderMentionChildren(children, catalogs)}</em>,
    table: ({ children }) => <div className="agent-markdown__table-wrap"><table>{children}</table></div>,
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => <th>{renderMentionChildren(children, catalogs)}</th>,
    td: ({ children }) => <td>{renderMentionChildren(children, catalogs)}</td>,
    a: ({ children, href }) => href
      ? <a href={href} target="_blank" rel="noopener noreferrer">{renderMentionChildren(children, catalogs)}</a>
      : <>{renderMentionChildren(children, catalogs)}</>,
    img: () => null,
  }), [catalogs])

  return <div className="agent-markdown">
    <MessageResponse
      className="agent-markdown__response"
      components={components}
      controls={agentMarkdownControls}
      dir="auto"
      lineNumbers={false}
      shikiTheme={agentMarkdownShikiTheme}
      skipHtml
      translations={locale === 'en' ? undefined : zhStreamdownTranslations}
      urlTransform={agentMarkdownUrlTransform}
    >
      {body}
    </MessageResponse>
    {showSources ? <AgentMarkdownSources sources={sources} /> : null}
  </div>
}
