/**
 * 结果节点 liquid 的逐像素着色。
 *
 * 高级感不来自「一块绿多边形 + 径向光斑」，而来自：
 * 1. 每个像素算到波浪前沿的有符号距离；
 * 2. 颜色按距离指数衰减，最亮的核贴在波峰上；
 * 3. 滞后拖影、薄雾、暗角、胶片颗粒都是同一套场。
 *
 * 不定进度只提供 0–1 的单向 travel，不映射业务百分比。
 */

export const LIQUID_PROGRESS_BACKGROUND = '#212124'

const BACKGROUND = [0.129, 0.129, 0.141] as const
const DEEP = [0.024, 0.063, 0.043] as const
const MID = [0.055, 0.145, 0.102] as const
const GLOW = [0.086, 0.365, 0.216] as const
const BRIGHT = [0.325, 0.725, 0.478] as const
const CORE = [0.890, 0.980, 0.910] as const
const TRAIL = [0.059, 0.290, 0.173] as const
const TRAIL_HOT = [0.369, 0.831, 0.604] as const

export const LIQUID_PROGRESS_PRESET = {
  amount: 0.085,
  lag: 0.55,
  echo: 0.055,
  bloom: 1,
  frontIn: -0.12,
  frontOut: 0.12,
  churn: 1,
  feather: 1,
  ripple: 1,
  falloff: 1,
  trails: 3,
  trailGlow: 1,
  haze: 1,
  vignette: 1,
  grain: 0.01,
} as const

export type LiquidProgressFrameInput = {
  progress: number
  warp: number
  alive: number
}

function fract(value: number) {
  return value - Math.floor(value)
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function clamp01(value: number) {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function hash21(x: number, y: number) {
  let px = fract(x * 0.3183099 + 0.11)
  let py = fract(y * 0.3678794 + 0.17)
  const offset = px * (py + 23.17)
  px += offset
  py += offset
  return fract(px * py * 51.37)
}

function valueNoise(x: number, y: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash21(ix, iy)
  const b = hash21(ix + 1, iy)
  const c = hash21(ix, iy + 1)
  const d = hash21(ix + 1, iy + 1)
  return mix(mix(a, b, ux), mix(c, d, ux), uy)
}

function fbm(x: number, y: number, octaves: number) {
  let value = 0
  let amplitude = 0.5
  let px = x
  let py = y
  for (let i = 0; i < octaves; i += 1) {
    value += amplitude * valueNoise(px, py)
    px = px * 2.07 + 9.4
    py = py * 2.07 + 9.4
    amplitude *= 0.5
  }
  return value
}

export function liquidFrontAxis(progress: number, aspect: number) {
  const { frontIn, frontOut } = LIQUID_PROGRESS_PRESET
  return mix(frontIn, aspect + frontOut, clamp01(progress))
}

export function liquidWaveOffset(uvY: number, warp: number, amplitude: number) {
  if (amplitude <= 1e-5) return 0
  const { ripple, churn } = LIQUID_PROGRESS_PRESET
  const y = uvY * ripple
  const t = warp * churn
  const swell = Math.sin(y * 17.5 + t * 1.48) * 0.46
    + Math.sin(y * 29.4 - t * 1.08 + 1.15) * 0.28
    + Math.sin(y * 7.8 + t * 0.58) * 0.38
    + (fbm(y * 2.8, t * 0.46, 3) - 0.5) * 1.35
  return swell * amplitude
}

function mixRgb(
  target: [number, number, number],
  source: readonly [number, number, number],
  amount: number,
) {
  const t = clamp01(amount)
  target[0] = mix(target[0], source[0], t)
  target[1] = mix(target[1], source[1], t)
  target[2] = mix(target[2], source[2], t)
}

function addRgb(
  target: [number, number, number],
  source: readonly [number, number, number],
  amount: number,
) {
  target[0] += source[0] * amount
  target[1] += source[1] * amount
  target[2] += source[2] * amount
}

export function liquidProgressLuma(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function shadeLiquidProgressPixel(
  x: number,
  y: number,
  width: number,
  height: number,
  input: LiquidProgressFrameInput,
  rowWaves?: Float32Array,
): [number, number, number] {
  const aspect = width / Math.max(height, 1)
  const uvX = (x + 0.5) / width
  const uvY = (y + 0.5) / height
  const px = uvX * aspect
  const progress = clamp01(input.progress)
  const alive = clamp01(input.alive)
  const warp = input.warp
  const amplitude = LIQUID_PROGRESS_PRESET.amount * alive
  const front = liquidFrontAxis(progress, aspect)
  const wave = rowWaves
    ? rowWaves[y]
    : liquidWaveOffset(uvY, warp, amplitude)
  const distance = px - (front + wave)
  const pixel = 1.55 * LIQUID_PROGRESS_PRESET.feather / Math.max(height, 1)
  const inside = 1 - smoothstep(-pixel, pixel, distance)
  const depth = Math.max(0, -distance)
  const crest = amplitude > 1e-5 ? clamp01(wave / amplitude * 0.5 + 0.5) : 0.5
  const bloom = LIQUID_PROGRESS_PRESET.bloom
  const falloff = LIQUID_PROGRESS_PRESET.falloff

  const color: [number, number, number] = [DEEP[0], DEEP[1], DEEP[2]]
  mixRgb(color, MID, Math.exp(-depth * 2.05 * falloff))
  mixRgb(color, GLOW, Math.exp(-depth * 4.9 * falloff) * 0.9)
  mixRgb(color, BRIGHT, Math.exp(-depth * 8.8 * falloff) * (0.78 + 0.22 * crest) * bloom)
  mixRgb(color, CORE, Math.exp(-depth * 15.2 * falloff) * (0.72 + 0.28 * crest) * bloom)
  addRgb(color, CORE, Math.exp(-Math.abs(distance) * 26 * falloff) * 0.28 * bloom * inside)

  const trails = LIQUID_PROGRESS_PRESET.trails
  for (let k = 1; k <= trails; k += 1) {
    const echoWave = rowWaves
      ? rowWaves[k * height + y]
      : liquidWaveOffset(uvY, warp - k * LIQUID_PROGRESS_PRESET.lag, amplitude * (1 + k * 0.2))
    const trailDistance = px - (front + echoWave - k * (LIQUID_PROGRESS_PRESET.echo + 0.028 * alive))
    const absDistance = Math.abs(trailDistance)
    addRgb(color, TRAIL, Math.exp(-absDistance * Math.max(0.5, 13.2 - k * 2.8) * falloff) * (0.4 / k) * LIQUID_PROGRESS_PRESET.trailGlow)
    addRgb(color, TRAIL_HOT, Math.exp(-absDistance * Math.max(0.5, 34 - k * 6.2) * falloff) * (0.2 / k) * bloom * LIQUID_PROGRESS_PRESET.trailGlow)
  }

  const haze = fbm(
    px * 1.55 - warp * 0.055 * alive * LIQUID_PROGRESS_PRESET.churn,
    uvY * 1.85 + warp * 0.048 * alive * LIQUID_PROGRESS_PRESET.churn,
    2,
  )
  const hazeMix = mix(1, 0.84 + 0.3 * haze, LIQUID_PROGRESS_PRESET.haze)
  color[0] *= hazeMix
  color[1] *= hazeMix
  color[2] *= hazeMix

  const vignette = smoothstep(0, 0.4, uvY) * smoothstep(1, 0.6, uvY)
  const vignetteMix = mix(1, mix(0.76, 1.05, vignette), LIQUID_PROGRESS_PRESET.vignette)
  color[0] *= vignetteMix
  color[1] *= vignetteMix
  color[2] *= vignetteMix

  const grain = (hash21(x + 0.5, y + 0.5) - 0.5) * LIQUID_PROGRESS_PRESET.grain
  color[0] += grain
  color[1] += grain
  color[2] += grain

  return [
    mix(BACKGROUND[0], color[0], inside),
    mix(BACKGROUND[1], color[1], inside),
    mix(BACKGROUND[2], color[2], inside),
  ]
}

export function fillLiquidProgressPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  input: LiquidProgressFrameInput,
) {
  const amplitude = LIQUID_PROGRESS_PRESET.amount * clamp01(input.alive)
  const trails = LIQUID_PROGRESS_PRESET.trails
  const rowWaves = new Float32Array((trails + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const uvY = (y + 0.5) / height
    rowWaves[y] = liquidWaveOffset(uvY, input.warp, amplitude)
    for (let k = 1; k <= trails; k += 1) {
      rowWaves[k * height + y] = liquidWaveOffset(
        uvY,
        input.warp - k * LIQUID_PROGRESS_PRESET.lag,
        amplitude * (1 + k * 0.2),
      )
    }
  }

  let offset = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = shadeLiquidProgressPixel(x, y, width, height, input, rowWaves)
      pixels[offset] = Math.round(clamp01(r) * 255)
      pixels[offset + 1] = Math.round(clamp01(g) * 255)
      pixels[offset + 2] = Math.round(clamp01(b) * 255)
      pixels[offset + 3] = 255
      offset += 4
    }
  }
}

export function liquidProgressBufferSize(cssWidth: number, cssHeight: number, compact: boolean) {
  const width = Math.max(1, cssWidth)
  const height = Math.max(1, cssHeight)
  const areaCap = compact ? 70_000 : 140_000
  const area = width * height
  const scale = area > areaCap ? Math.sqrt(areaCap / area) : 1
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
