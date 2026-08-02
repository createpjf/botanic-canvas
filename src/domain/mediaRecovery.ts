export function mediaRetryUrl(source: string, attempt: number) {
  if (!source || attempt <= 0) return source
  const hashIndex = source.indexOf('#')
  const hash = hashIndex >= 0 ? source.slice(hashIndex) : ''
  const base = hashIndex >= 0 ? source.slice(0, hashIndex) : source
  return `${base}${base.includes('?') ? '&' : '?'}botanic_retry=${attempt}${hash}`
}
