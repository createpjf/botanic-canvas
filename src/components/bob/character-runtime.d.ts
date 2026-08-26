export type BobRuntimePaint = {
  scaleX: number
  scaleY: number
  cx: number
  cy: number
  r: number
  light: string
  mid: string
  dark: string
  seam?: boolean
  gloss?: { cx: number; cy: number; r: number; color: string; opacity: number }
  rim?: { r: number; inner: number; color: string; opacity: number }
  stops?: Array<{ offset: string | number; color: string; opacity?: number }>
}

export type BobRuntimeEye = {
  d?: string
  op?: string | number
  id?: string
  pd?: string
  gd?: string
  pop?: string | number
}

export type BobRuntimeOverlay = {
  d: string
  fill: string
  op: string | number
  blur?: boolean
}

export type BobRuntimeTexture = {
  d?: string
  fill: string
  stroke: string
  width: string | number
  op: string | number
}

export type BobRuntimeFrame = {
  bodyD: string
  groupTransform: string
  eyeL?: BobRuntimeEye
  eyeR?: BobRuntimeEye
  eyeC?: BobRuntimeEye
  overlays: BobRuntimeOverlay[]
  texture: BobRuntimeTexture[]
  ramp?: { light: string; mid: string; dark: string }
}

export declare const EYE_STYLE_BY_ID: Record<string, unknown>
export declare const MOTION_BY_ID: Record<string, unknown>
export declare function createAvatar(spec: unknown, motion: unknown, dense: boolean, seedOff?: number, detail?: number): { motion: unknown }
export declare function play(avatar: { motion: unknown }, motion: unknown): void
export declare function computeFrame(avatar: unknown, now: number, input: unknown): unknown
export declare function svgFrame(frame: unknown): BobRuntimeFrame
export declare function bodyPaint(config: unknown, spec: unknown): BobRuntimePaint
export declare function topperById(id: string, detail?: number): unknown
export declare function contentExtent(spec: unknown, config: unknown, topper: unknown, motion: unknown): number
