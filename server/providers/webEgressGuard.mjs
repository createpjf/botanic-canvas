import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { classifyPublicHttpUrl, isPrivateIpAddress } from '../agent/tools/agentWebResearch.mjs'

async function defaultLookup(hostname) {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export function createPinnedLookup(address) {
  const family = isIP(address)
  if (!family) throw new TypeError('固定出口地址必须是有效 IP。')
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options?.all) {
      callback(null, [{ address, family }])
      return
    }
    callback(null, address, family)
  }
}

export async function assertPublicHttpsUrl(raw, { lookup = defaultLookup, allowLocal = false } = {}) {
  const classified = classifyPublicHttpUrl(raw, { allowLocal })
  if (!classified.ok) return classified
  if (classified.ipLiteral) return { ...classified, addresses: [classified.ipLiteral] }
  let addresses
  try {
    addresses = await lookup(classified.hostname)
  } catch {
    return { ok: false, message: '无法解析该网页地址。' }
  }
  const normalizedAddresses = Array.isArray(addresses)
    ? [...new Set(addresses.map((address) => String(address).trim()).filter((address) => isIP(address) !== 0))]
    : []
  if (!normalizedAddresses.length || normalizedAddresses.length !== addresses.length) return { ok: false, message: '无法解析该网页地址。' }
  if (!allowLocal && normalizedAddresses.some((address) => isPrivateIpAddress(address))) {
    return { ok: false, message: '不能抓取内网或本机地址。' }
  }
  // 调用方必须使用这里冻结的地址建立连接，不能在校验后再次独立 DNS 解析。
  return { ...classified, addresses: normalizedAddresses }
}
