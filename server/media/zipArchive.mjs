// @ts-check

/**
 * ZIP 归档写入器（Epic 7 交付打包）。
 *
 * 仓库没有 zip 依赖，因此手写 —— 与 `mediaSpec.mjs`（PNG/JPEG/MP4 头解析）和
 * `imageOverlay.mjs`（PNG 写入）是同一路数。但 ZIP 比那两者危险：中央目录写错的表现
 * **不是报错，是交付给客户的压缩包损坏**，而且往往要到对方解压时才发现。所以这里的
 * 每个取舍都偏向「宁可简单且可证」：
 *
 * - **只用 store（不压缩）**。交付物是图片和视频，本身已经压缩过，deflate 收益接近 0，
 *   却会引入压缩流状态、data descriptor 等一整类可能写错的东西。
 * - **逐个文件缓冲，不用 data descriptor**。CRC 与长度在写 local header 之前就算出来，
 *   因此头里写的是真实值。峰值内存是**最大的单个文件**，不是整个包。
 * - **不信任清单里记录的字节数**。规格是生成时实测的，但对象存储里的字节才是要打包的
 *   那份；两者不一致时按记录值写头会直接产出坏包。
 * - **超过 32 位边界自动切 ZIP64**。视频批量很容易超过 4GB，静默溢出会得到一个大小
 *   字段回绕、看起来正常却解不开的包。
 */

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50

/** 32 位字段的溢出哨兵。写到这个值表示「真实值在 ZIP64 扩展字段里」。 */
const MAX_UINT32 = 0xffffffff
const MAX_UINT16 = 0xffff

/** store 方式且无 ZIP64 时的最低版本；含 ZIP64 时必须声明 4.5。 */
const VERSION_STORE = 20
const VERSION_ZIP64 = 45

/** 通用标志位 11：文件名按 UTF-8 解释。不置位的话中文名在多数解压工具里是乱码。 */
const FLAG_UTF8 = 0x0800

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    }
    table[index] = value
  }
  return table
})()

/** @param {Buffer} buffer */
export function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/**
 * 时间戳 → DOS 时间/日期。
 *
 * DOS 纪元从 1980 开始且秒只有 2 秒精度。早于 1980 的时间**夹到 1980-01-01**而不是
 * 让它回绕成一个未来日期 —— 回绕后的包能解开，但每个文件的时间戳都是错的。
 *
 * @param {number} timestamp
 */
export function dosDateTime(timestamp) {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : 0)
  const year = date.getUTCFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

function zip64ExtraField(values) {
  // 扩展字段只包含**确实溢出**的那几项，且顺序固定：usize, csize, offset。
  const body = Buffer.alloc(values.length * 8)
  values.forEach((value, index) => body.writeBigUInt64LE(BigInt(value), index * 8))
  const field = Buffer.alloc(4 + body.length)
  field.writeUInt16LE(0x0001, 0)
  field.writeUInt16LE(body.length, 2)
  body.copy(field, 4)
  return field
}

function localHeader(entry) {
  const nameBytes = Buffer.from(entry.name, 'utf8')
  // local header 里的 ZIP64 扩展必须同时给 usize 与 csize（不能只给溢出的那个）。
  const needsZip64 = entry.size > MAX_UINT32
  const extra = needsZip64 ? zip64ExtraField([entry.size, entry.size]) : Buffer.alloc(0)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(LOCAL_SIGNATURE, 0)
  header.writeUInt16LE(needsZip64 ? VERSION_ZIP64 : VERSION_STORE, 4)
  header.writeUInt16LE(FLAG_UTF8, 6)
  header.writeUInt16LE(0, 8) // store
  header.writeUInt16LE(entry.time, 10)
  header.writeUInt16LE(entry.date, 12)
  header.writeUInt32LE(entry.crc, 14)
  header.writeUInt32LE(needsZip64 ? MAX_UINT32 : entry.size, 18)
  header.writeUInt32LE(needsZip64 ? MAX_UINT32 : entry.size, 22)
  header.writeUInt16LE(nameBytes.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, nameBytes, extra])
}

function centralHeader(entry) {
  const nameBytes = Buffer.from(entry.name, 'utf8')
  const overflow = []
  const sizeOverflow = entry.size > MAX_UINT32
  const offsetOverflow = entry.offset > MAX_UINT32
  if (sizeOverflow) overflow.push(entry.size, entry.size)
  if (offsetOverflow) overflow.push(entry.offset)
  const extra = overflow.length ? zip64ExtraField(overflow) : Buffer.alloc(0)
  const header = Buffer.alloc(46)
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0)
  // version made by：高字节 0 = MS-DOS/FAT，低字节是版本。
  header.writeUInt16LE(sizeOverflow || offsetOverflow ? VERSION_ZIP64 : VERSION_STORE, 4)
  header.writeUInt16LE(sizeOverflow || offsetOverflow ? VERSION_ZIP64 : VERSION_STORE, 6)
  header.writeUInt16LE(FLAG_UTF8, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(entry.time, 12)
  header.writeUInt16LE(entry.date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(sizeOverflow ? MAX_UINT32 : entry.size, 20)
  header.writeUInt32LE(sizeOverflow ? MAX_UINT32 : entry.size, 24)
  header.writeUInt16LE(nameBytes.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt16LE(0, 32) // comment length
  header.writeUInt16LE(0, 34) // disk number start
  header.writeUInt16LE(0, 36) // internal attributes
  header.writeUInt32LE(0, 38) // external attributes
  header.writeUInt32LE(offsetOverflow ? MAX_UINT32 : entry.offset, 42)
  return Buffer.concat([header, nameBytes, extra])
}

function endOfCentralDirectory({ entries, centralSize, centralOffset }) {
  // 任一项越界就必须写 ZIP64 记录；只写 EOCD 会让大小字段回绕，包看起来正常却解不开。
  const needsZip64 = entries > MAX_UINT16 || centralSize > MAX_UINT32 || centralOffset > MAX_UINT32
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(needsZip64 ? MAX_UINT16 : entries, 8)
  eocd.writeUInt16LE(needsZip64 ? MAX_UINT16 : entries, 10)
  eocd.writeUInt32LE(needsZip64 ? MAX_UINT32 : centralSize, 12)
  eocd.writeUInt32LE(needsZip64 ? MAX_UINT32 : centralOffset, 16)
  eocd.writeUInt16LE(0, 20)
  if (!needsZip64) return eocd

  const record = Buffer.alloc(56)
  record.writeUInt32LE(ZIP64_EOCD_SIGNATURE, 0)
  record.writeBigUInt64LE(BigInt(44), 4) // 本记录剩余字节数
  record.writeUInt16LE(VERSION_ZIP64, 12)
  record.writeUInt16LE(VERSION_ZIP64, 14)
  record.writeUInt32LE(0, 16)
  record.writeUInt32LE(0, 20)
  record.writeBigUInt64LE(BigInt(entries), 24)
  record.writeBigUInt64LE(BigInt(entries), 32)
  record.writeBigUInt64LE(BigInt(centralSize), 40)
  record.writeBigUInt64LE(BigInt(centralOffset), 48)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([record, locator, eocd])
}

/**
 * 文件名去重与净化。
 *
 * ZIP 允许同名条目共存，但解压时后者覆盖前者 —— **交付出去就是少了几张**。
 * `buildDeliveryManifest` 已经在生成清单时拒绝同名，这里是第二道：打包这一层不能
 * 假设调用方一定做过检查。冲突时**报错而不是自动改名**，自动改名会让交付文件名与
 * 清单对不上。
 *
 * @param {string} name
 */
export function assertSafeZipEntryName(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!value) throw new TypeError('压缩包条目缺少文件名。')
  if (value.length > 200) throw new TypeError(`压缩包条目名过长：${value.slice(0, 40)}…`)
  // 绝对路径与 `..` 会让解压时写到目标目录之外（Zip Slip）。
  if (value.startsWith('/') || value.includes('..') || /^[a-zA-Z]:/.test(value)) {
    throw new TypeError(`压缩包条目名不安全：${value}`)
  }
  if (/[ -\\]/.test(value)) throw new TypeError(`压缩包条目名含非法字符：${value}`)
  return value
}

/**
 * 流式写出一个 ZIP。
 *
 * `files` 是异步可迭代，逐个产出 `{ name, data }`；`data` 是这个文件的完整字节。
 * 逐个缓冲而不是整包缓冲：峰值内存是最大的单个文件。
 *
 * @param {AsyncIterable<{ name: string, data: Buffer, modifiedAt?: number }> | Iterable<{ name: string, data: Buffer, modifiedAt?: number }>} files
 * @param {{ now?: number }} [options]
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* writeZipArchive(files, { now = Date.now() } = {}) {
  /** @type {any[]} */
  const entries = []
  const seen = new Set()
  let offset = 0
  for await (const file of files) {
    const name = assertSafeZipEntryName(file?.name)
    if (seen.has(name)) {
      // 同名条目解压时会互相覆盖，交付出去就是少了几张。
      throw new TypeError(`压缩包条目名重复：${name}`)
    }
    seen.add(name)
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file?.data ?? [])
    const { time, date } = dosDateTime(file.modifiedAt ?? now)
    const entry = { name, size: data.length, crc: crc32(data), time, date, offset }
    const header = localHeader(entry)
    entries.push(entry)
    offset += header.length + data.length
    yield header
    yield data
  }
  const central = Buffer.concat(entries.map(centralHeader))
  yield central
  yield endOfCentralDirectory({ entries: entries.length, centralSize: central.length, centralOffset: offset })
}

/** 一次性产出完整字节。只用于小包与测试；生产路径用 `writeZipArchive` 流式写。 */
export async function zipArchiveBuffer(files, options) {
  const chunks = []
  for await (const chunk of writeZipArchive(files, options)) chunks.push(chunk)
  return Buffer.concat(chunks)
}
