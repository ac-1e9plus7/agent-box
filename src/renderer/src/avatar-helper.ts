import { MAX_USER_AVATAR_DATA_URL_LENGTH, MAX_USER_AVATAR_DIMENSION } from '../../shared/user-profile'
import { t } from '../../shared/i18n'

export const AVATAR_CROP_VIEWPORT_SIZE = 340
export const MIN_AVATAR_ZOOM = 1
export const MAX_AVATAR_ZOOM = 3
export const MAX_AVATAR_SOURCE_BYTES = 30 * 1024 * 1024

const MAX_AVATAR_SOURCE_DIMENSION = 20_000
const MAX_AVATAR_SOURCE_PIXELS = 100_000_000

export interface AvatarCropLayout {
  offsetX: number
  offsetY: number
  renderedHeight: number
  renderedWidth: number
  scale: number
  sourceSize: number
  sourceX: number
  sourceY: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function resolveAvatarCropLayout(
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
  viewportSize = AVATAR_CROP_VIEWPORT_SIZE,
): AvatarCropLayout {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    !Number.isFinite(viewportSize) ||
    viewportSize <= 0
  ) {
    throw new Error(t('Avatar image size is invalid.'))
  }

  const normalizedZoom = clamp(zoom, MIN_AVATAR_ZOOM, MAX_AVATAR_ZOOM)
  const scale = Math.max(viewportSize / sourceWidth, viewportSize / sourceHeight) * normalizedZoom
  const renderedWidth = sourceWidth * scale
  const renderedHeight = sourceHeight * scale
  const maximumOffsetX = Math.max(0, (renderedWidth - viewportSize) / 2)
  const maximumOffsetY = Math.max(0, (renderedHeight - viewportSize) / 2)
  const clampedOffsetX = clamp(offsetX, -maximumOffsetX, maximumOffsetX)
  const clampedOffsetY = clamp(offsetY, -maximumOffsetY, maximumOffsetY)
  const sourceSize = viewportSize / scale

  return {
    offsetX: clampedOffsetX,
    offsetY: clampedOffsetY,
    renderedHeight,
    renderedWidth,
    scale,
    sourceSize,
    sourceX: clamp((sourceWidth - sourceSize) / 2 - clampedOffsetX / scale, 0, sourceWidth - sourceSize),
    sourceY: clamp((sourceHeight - sourceSize) / 2 - clampedOffsetY / scale, 0, sourceHeight - sourceSize),
  }
}

export function validateAvatarSourceFile(file: Pick<File, 'size' | 'type'>): void {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    throw new Error(t('Choose a PNG, JPEG, WebP, or another common bitmap format.'))
  }
  if (file.size <= 0 || file.size > MAX_AVATAR_SOURCE_BYTES) {
    throw new Error(t('The source image cannot exceed 30 MB.'))
  }
}

export function validateAvatarSourceDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_AVATAR_SOURCE_DIMENSION ||
    height > MAX_AVATAR_SOURCE_DIMENSION ||
    width * height > MAX_AVATAR_SOURCE_PIXELS
  ) {
    throw new Error(t('The original avatar image is too large or invalid.'))
  }
}

export function resolveAvatarOutputSize(sourceSize: number): number {
  if (!Number.isFinite(sourceSize) || sourceSize <= 0) throw new Error(t('Avatar crop size is invalid.'))
  return Math.min(MAX_USER_AVATAR_DIMENSION, Math.max(1, Math.round(sourceSize)))
}

function renderAvatar(image: HTMLImageElement, layout: AvatarCropLayout, outputSize: number, quality: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const context = canvas.getContext('2d')
  if (!context) throw new Error(t('Unable to create avatar canvas.'))
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    layout.sourceX,
    layout.sourceY,
    layout.sourceSize,
    layout.sourceSize,
    0,
    0,
    outputSize,
    outputSize,
  )
  return canvas.toDataURL('image/webp', quality)
}

export function cropAvatarImage(image: HTMLImageElement, zoom: number, offsetX: number, offsetY: number): string {
  validateAvatarSourceDimensions(image.naturalWidth, image.naturalHeight)
  const layout = resolveAvatarCropLayout(image.naturalWidth, image.naturalHeight, zoom, offsetX, offsetY)
  let outputSize = resolveAvatarOutputSize(layout.sourceSize)

  while (true) {
    for (const quality of [0.86, 0.72, 0.58]) {
      const dataUrl = renderAvatar(image, layout, outputSize, quality)
      if (dataUrl.length <= MAX_USER_AVATAR_DATA_URL_LENGTH) return dataUrl
    }
    if (outputSize <= 128) break
    outputSize = Math.max(128, Math.floor(outputSize * 0.8))
  }
  throw new Error(t('The avatar is still too large after compression. Choose another image.'))
}
