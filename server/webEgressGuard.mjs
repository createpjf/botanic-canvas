import { lookup as dnsLookup } from 'node:dns/promises'
import { classifyPublicHttpUrl, isPrivateIpAddress } from './agentWebResearch.mjs'

async function defaultLookup(hostname) {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export async function assertPublicHttpsUrl(raw, { lookup = defaultLookup, allowLocal = false } = {}) {
  const classified = classifyPublicHttpUrl(raw, { allowLocal })
  if (!classified.ok) return classified
  if (classified.ipLiteral) return classified
  let addresses
  try {
    addresses = await lookup(classified.hostname)
  } catch {
    return { ok: false, message: '无法解析该网页地址。' }
  }
  if (!Array.isArray(addresses) || !addresses.length) return { ok: false, message: '无法解析该网页地址。' }
  if (addresses.some((address) => isPrivateIpAddress(String(address)))) {
    return { ok: false, message: '不能抓取内网或本机地址。' }
  }
  return classified
}
