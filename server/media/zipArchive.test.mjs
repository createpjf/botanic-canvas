import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSafeZipEntryName, crc32, dosDateTime, writeZipArchive, zipArchiveBuffer } from './zipArchive.mjs'

/**
 * 这里的读取器是**独立按 ZIP 规范重写的**，不复用写入器的任何常量或函数。
 * 用自己的读法去验自己的写法，只能证明两边一致，证明不了包是对的。
 *
 * 开发时另外用 Python `zipfile.testzip()`（全量 CRC 校验）与系统 `unzip -t` 交叉验证过，
 * 两者都能正确解开含中文名、空文件与 65536 条目（ZIP64）的包。
 */
function readZip(buffer) {
  // 从尾部找 EOCD（22 字节定长，无注释）。
  const eocdOffset = buffer.length - 22
  assert.equal(buffer.readUInt32LE(eocdOffset), 0x06054b50, 'EOCD 签名')
  let entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    // ZIP64：EOCD 之前是 20 字节 locator，locator 指向 ZIP64 EOCD 记录。
    const locatorOffset = eocdOffset - 20
    assert.equal(buffer.readUInt32LE(locatorOffset), 0x07064b50, 'ZIP64 locator 签名')
    const recordOffset = Number(buffer.readBigUInt64LE(locatorOffset + 8))
    assert.equal(buffer.readUInt32LE(recordOffset), 0x06064b50, 'ZIP64 EOCD 签名')
    entryCount = Number(buffer.readBigUInt64LE(recordOffset + 32))
    centralOffset = Number(buffer.readBigUInt64LE(recordOffset + 48))
  }
  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `第 ${index} 个中央目录项签名`)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    let size = buffer.readUInt32LE(cursor + 24)
    let localOffset = buffer.readUInt32LE(cursor + 42)
    if (size === 0xffffffff || localOffset === 0xffffffff) {
      const extraStart = cursor + 46 + nameLength
      assert.equal(buffer.readUInt16LE(extraStart), 0x0001, 'ZIP64 扩展字段头')
      let field = extraStart + 4
      if (size === 0xffffffff) { size = Number(buffer.readBigUInt64LE(field)); field += 16 }
      if (localOffset === 0xffffffff) localOffset = Number(buffer.readBigUInt64LE(field))
    }
    // 按中央目录记录的偏移回到 local header，取出真实数据。
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `${name} 的 local header 签名`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    entries.push({ name, size, crc, flags, method, data: buffer.subarray(dataStart, dataStart + size) })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const at = Date.UTC(2026, 7, 25, 10, 30, 20)

test('CRC32 对标准测试向量', () => {
  // 标准向量：'123456789' → 0xCBF43926。写错 CRC 的包能解开但内容校验必失败。
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test('条目可按中央目录偏移取回，内容与 CRC 都对', async () => {
  const files = [
    { name: '首图-SKU1-1.png', data: Buffer.from('PNG-CONTENT-A'), modifiedAt: at },
    { name: 'campaign/视频-SKU2.mp4', data: Buffer.alloc(5000, 7), modifiedAt: at },
    { name: 'empty.txt', data: Buffer.alloc(0), modifiedAt: at },
  ]
  const entries = readZip(await zipArchiveBuffer(files))
  assert.deepEqual(entries.map((entry) => entry.name), files.map((file) => file.name))
  assert.equal(entries[0].data.toString(), 'PNG-CONTENT-A')
  assert.equal(entries[1].size, 5000)
  assert.ok(entries[1].data.every((byte) => byte === 7))
  // 空文件必须能存在：清单里出现 0 字节的输出时，跳过它等于静默少一张。
  assert.equal(entries[2].size, 0)
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.crc, crc32(files[index].data), `${entry.name} 的 CRC`)
  }
})

test('全部 store 且置 UTF-8 位', async () => {
  // 交付物本身已压缩，deflate 收益接近 0，却会引入一整类可能写错的东西。
  const entries = readZip(await zipArchiveBuffer([{ name: '中文名.png', data: Buffer.from('x'), modifiedAt: at }]))
  assert.equal(entries[0].method, 0, 'store')
  // 不置 UTF-8 位的话中文名在多数解压工具里是乱码。
  assert.equal(entries[0].flags & 0x0800, 0x0800)
})

test('超过 16 位条目数上限自动切 ZIP64', async () => {
  // 静默溢出会得到一个字段回绕、看起来正常却解不开的包。
  const files = Array.from({ length: 65536 }, (_, index) => ({
    name: `f${index}.txt`, data: Buffer.from(`x${index}`), modifiedAt: at,
  }))
  const buffer = await zipArchiveBuffer(files)
  // EOCD 的 16 位字段被写成哨兵，真实值在 ZIP64 记录里。
  assert.equal(buffer.readUInt16LE(buffer.length - 22 + 10), 0xffff)
  const entries = readZip(buffer)
  assert.equal(entries.length, 65536)
  assert.equal(entries.at(-1).data.toString(), 'x65535')
})

test('同名条目直接报错，不自动改名', async () => {
  // 解压时后者覆盖前者 —— 交付出去就是少了几张。自动改名则会让文件名与清单对不上。
  await assert.rejects(() => zipArchiveBuffer([
    { name: 'a.png', data: Buffer.from('1') },
    { name: 'a.png', data: Buffer.from('2') },
  ]), /条目名重复/u)
})

test('Zip Slip 与非法文件名被挡住', () => {
  // 这些名字会让解压时写到目标目录之外。
  for (const name of ['../escape.png', '/etc/passwd', 'C:\\win.png', 'a/../../b.png']) {
    assert.throws(() => assertSafeZipEntryName(name), /不安全/u, name)
  }
  assert.throws(() => assertSafeZipEntryName(''), /缺少文件名/u)
  assert.throws(() => assertSafeZipEntryName('a\u0000b.png'), /非法字符/u)
  assert.equal(assertSafeZipEntryName(' campaign/首图-1.png '), 'campaign/首图-1.png')
})

test('早于 1980 的时间夹到 DOS 纪元起点，不回绕', () => {
  // 回绕后的包能解开，但每个文件的时间戳都是错的。
  assert.deepEqual(dosDateTime(0), { time: 0, date: (1 << 5) | 1 })
  const normal = dosDateTime(at)
  assert.equal((normal.date >> 9) + 1980, 2026)
  assert.equal((normal.date >> 5) & 0x0f, 8)
  assert.equal(normal.date & 0x1f, 25)
  assert.equal(normal.time >> 11, 10)
})

test('流式写出：逐块产出而不是整包缓冲', async () => {
  const chunks = []
  for await (const chunk of writeZipArchive([
    { name: 'a.png', data: Buffer.alloc(1024), modifiedAt: at },
    { name: 'b.png', data: Buffer.alloc(1024), modifiedAt: at },
  ])) chunks.push(chunk)
  // 每个文件两块（头 + 数据）+ 中央目录 + EOCD。
  assert.equal(chunks.length, 6)
  assert.equal(readZip(Buffer.concat(chunks)).length, 2)
})

