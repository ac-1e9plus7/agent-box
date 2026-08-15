// Packs the generated PNG icons into a Windows .ico file (PNG-compressed ICO,
// supported since Windows Vista). No dependencies.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SIZES = [16, 32, 48, 64, 128, 256]
const images = SIZES.map((size) => ({
  size,
  data: readFileSync(join('build', `icon-${size}.png`)),
}))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4) // count

let offset = 6 + images.length * 16
const entries = []
const blobs = []
for (const { size, data } of images) {
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size >= 256 ? 0 : size, 0) // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1) // height (0 = 256)
  entry.writeUInt8(0, 2) // palette
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bit depth
  entry.writeUInt32LE(data.length, 8) // bytes in resource
  entry.writeUInt32LE(offset, 12) // image offset
  entries.push(entry)
  blobs.push(data)
  offset += data.length
}

writeFileSync(join('build', 'icon.ico'), Buffer.concat([header, ...entries, ...blobs]))
console.log(`wrote build/icon.ico (${offset} bytes, ${images.length} sizes)`)
