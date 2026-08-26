/**
 * 生成中结果节点的 flow 点阵场。
 * 每个格子是一颗软点；亮度沿旋度场的锋面滑动。
 * 这是占位动效，不映射业务百分比。
 */

export const GENERATION_DOTS_BACKGROUND = '#000000'

export const GENERATION_DOTS_PRESET = {
  speed: 1,
  brightness: 1,
  tint: [1, 1, 1] as const,
  background: [0, 0, 0] as const,
  dotSize: 2,
  gridDensity: 1.5,
  patternScale: 0.7,
  vignette: 1.45,
} as const

function clamp01(value: number) {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function roundAwayFromZero(value: number) {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5)
}

export function generationDotsLuma(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function shadeGenerationDotsPixel(
  x: number,
  y: number,
  width: number,
  height: number,
  time: number,
): [number, number, number] {
  const { speed, brightness, tint, background, dotSize, gridDensity, patternScale, vignette } = GENERATION_DOTS_PRESET
  const px = x + 0.5
  const py = y + 0.5
  const uvX = (px - width * 0.5) / height
  const uvY = (py - height * 0.5) / height
  const grid = 0.02 / Math.max(gridDensity, 0.01)
  const cellX = roundAwayFromZero(uvX / grid) * grid
  const cellY = roundAwayFromZero(uvY / grid) * grid
  const dist = Math.hypot(uvX - cellX, uvY - cellY)
  const radius = (1.4 / Math.max(height, 1)) * dotSize
  const mask = smoothstep(radius * 1.4, radius * 0.6, dist)

  const clock = time * speed
  const scale = patternScale
  const swirl = Math.sin(cellX * 3 * scale + clock * 0.4) * Math.cos(cellY * 3 * scale - clock * 0.35)
    + 0.5 * Math.sin(cellX * 7 * scale - clock * 0.6) * Math.sin(cellY * 7 * scale + clock * 0.55)
  const fronts = Math.sin(swirl * 6 + Math.hypot(cellX, cellY) * 8 * scale - clock * 1.8)
  const pulse = Math.max(fronts, 0) ** 1.8

  const vigX = (px - width * 0.5) / width
  const vigY = (py - height * 0.5) / height
  const vig = clamp01(1 - (vigX * vigX + vigY * vigY) * 0.85 * vignette)
  const intensity = clamp01(mask * (0.1 + pulse) * vig)

  return [
    background[0] + (tint[0] * brightness - background[0]) * intensity,
    background[1] + (tint[1] * brightness - background[1]) * intensity,
    background[2] + (tint[2] * brightness - background[2]) * intensity,
  ]
}

export function fillGenerationDotsPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  time: number,
) {
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = shadeGenerationDotsPixel(x, y, width, height, time)
      pixels[offset] = Math.round(clamp01(r) * 255)
      pixels[offset + 1] = Math.round(clamp01(g) * 255)
      pixels[offset + 2] = Math.round(clamp01(b) * 255)
      pixels[offset + 3] = 255
      offset += 4
    }
  }
}

export function generationDotsBufferSize(cssWidth: number, cssHeight: number, compact: boolean) {
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
