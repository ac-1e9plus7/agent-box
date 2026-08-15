// Self-contained logo rasterizer. No dependencies. Renders the ChatBox Lite
// app icon (rounded-square green gradient + white circular spark mark) to PNGs.
// Geometry mirrors the in-app `app` icon (Icon.tsx) so the app icon and the
// in-app logo stay unified.
import { deflateSync, constants as zConstants } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = 'build'
const FAVICON_DIR = join('src', 'renderer', 'public')
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(FAVICON_DIR, { recursive: true })

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

// Encode RGBA pixel buffer to a PNG.
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  // Add filter byte (0) per scanline.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9, strategy: zConstants.Z_DEFAULT_STRATEGY })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// Render the logo at a given size into an RGBA Buffer.
function renderLogo(size) {
  const S = size
  const buf = Buffer.alloc(S * S * 4)
  const idx = (x, y) => (y * S + x) * 4

  // Geometry normalized to a 0..1 square then scaled.
  const radius = S * 0.221 // matches rx=226/1024
  // Gradient stops (#789477 -> #415b45) along diagonal.
  const grad = (t) => [
    Math.round(0x78 + (0x41 - 0x78) * t),
    Math.round(0x94 + (0x5b - 0x94) * t),
    Math.round(0x77 + (0x45 - 0x77) * t),
  ]

  // Rounded-rect coverage (antialiased) for the tile background.
  const inRound = (px, py) => {
    // distance to rounded rect boundary
    const cx = Math.min(Math.max(px, radius), S - radius)
    const cy = Math.min(Math.max(py, radius), S - radius)
    const dx = px - cx
    const dy = py - cy
    return radius - Math.sqrt(dx * dx + dy * dy) // >0 inside, <0 outside
  }

  // Circle stroke coverage. strokeW in px, circle center (cx,cy) radius r.
  const circleStroke = (px, py, cx, cy, r, strokeW) => {
    const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2)
    const inner = r - strokeW / 2
    const outer = r + strokeW / 2
    return Math.min(d - inner, outer - d) // >0 within stroke band
  }

  // Point-in-polygon (with AA via distance to nearest edge approx) for the spark.
  // Spark polygon in normalized 0..1 space (derived from the app icon mark).
  const spark = [
    [0.375, 0.508],
    [0.410, 0.332],
    [0.531, 0.230],
    [0.516, 0.406],
    [0.578, 0.484],
    [0.703, 0.520],
    [0.578, 0.555],
    [0.469, 0.672],
    [0.449, 0.828],
    [0.402, 0.641],
    [0.328, 0.539],
  ]
  const sparkPx = spark.map(([x, y]) => [x * S, y * S])
  const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  const pointInPoly = (p) => {
    let inside = false
    for (let i = 0, j = sparkPx.length - 1; i < sparkPx.length; j = i++) {
      const a = sparkPx[i]
      const b = sparkPx[j]
      if (((a[1] > p[1]) !== (b[1] > p[1])) && (p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])) {
        inside = !inside
      }
    }
    return inside
  }
  // Nearest distance to any polygon edge (for AA).
  const distToPoly = (p) => {
    let min = Infinity
    for (let i = 0, j = sparkPx.length - 1; i < sparkPx.length; j = i++) {
      const a = sparkPx[i]
      const b = sparkPx[j]
      const vx = b[0] - a[0]
      const vy = b[1] - a[1]
      const wx = p[0] - a[0]
      const wy = p[1] - a[1]
      const len2 = vx * vx + vy * vy
      let t = len2 ? (wx * vx + wy * vy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      const dx = a[0] + vx * t - p[0]
      const dy = a[1] + vy * t - p[1]
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < min) min = d
    }
    return min
  }

  const cx = S / 2
  const cy = S / 2
  const circleR = S * 0.293
  const strokeW = S * 0.0566

  // Supersample 2x2 for antialiasing.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const px = x + (sx + 0.5) / 2
          const py = y + (sy + 0.5) / 2
          // Background rounded rect.
          const bgCover = Math.max(0, Math.min(1, inRound(px, py)))
          const t = (px + py) / (2 * S) // diagonal gradient
          const [gr, gg, gb] = grad(t)
          let pr = gr
          let pg = gg
          let pb = gb
          let pa = bgCover
          // White circle stroke over background.
          const sc = circleStroke(px, py, cx, cy, circleR, strokeW)
          if (sc > -0.5) {
            const cov = Math.max(0, Math.min(1, sc + 0.5))
            pr = pr * (1 - cov) + 0xf8 * cov
            pg = pg * (1 - cov) + 0xfb * cov
            pb = pb * (1 - cov) + 0xf6 * cov
          }
          // White spark fill over everything.
          const p = [px, py]
          const inSpark = pointInPoly(p)
          const dEdge = distToPoly(p)
          let sparkCov = 0
          if (inSpark) sparkCov = Math.min(1, dEdge + 0.5)
          else if (dEdge < 0.5) sparkCov = Math.max(0, dEdge + 0.5)
          if (sparkCov > 0) {
            pr = pr * (1 - sparkCov) + 0xf8 * sparkCov
            pg = pg * (1 - sparkCov) + 0xfb * sparkCov
            pb = pb * (1 - sparkCov) + 0xf6 * sparkCov
            pa = Math.max(pa, sparkCov * bgCover)
          }
          r += pr
          g += pg
          b += pb
          a += pa * 255
        }
      }
      const o = idx(x, y)
      buf[o] = Math.round(r / 4)
      buf[o + 1] = Math.round(g / 4)
      buf[o + 2] = Math.round(b / 4)
      buf[o + 3] = Math.min(255, Math.round(a / 4))
    }
  }
  return buf
}

for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  const rgba = renderLogo(size)
  const png = encodePng(size, size, rgba)
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), png)
  if (size === 256) writeFileSync(join(OUT_DIR, 'icon.png'), png)
  if (size === 32) writeFileSync(join(FAVICON_DIR, 'favicon-32.png'), png)
  if (size === 64) writeFileSync(join(FAVICON_DIR, 'favicon-64.png'), png)
  console.log(`wrote icon-${size}.png (${png.length} bytes)`)
}
console.log('done')
