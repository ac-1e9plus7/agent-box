import { useMemo, useRef, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import {
  AVATAR_CROP_VIEWPORT_SIZE,
  cropAvatarImage,
  MAX_AVATAR_ZOOM,
  MIN_AVATAR_ZOOM,
  resolveAvatarCropLayout,
  validateAvatarSourceDimensions,
} from '../avatar-helper'
import { Icon } from './Icon'
import { t } from "../../../shared/i18n"

interface AvatarCropDialogProps {
  onCancel: () => void
  onComplete: (avatarDataUrl: string) => void
  sourceUrl: string
}

interface ImageDimensions {
  height: number
  width: number
}

interface DragState {
  pointerId: number
  startOffsetX: number
  startOffsetY: number
  startX: number
  startY: number
}

export function AvatarCropDialog({
  onCancel,
  onComplete,
  sourceUrl,
}: AvatarCropDialogProps): JSX.Element {
  const imageRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null)
  const [zoom, setZoom] = useState(MIN_AVATAR_ZOOM)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const layout = useMemo(() => dimensions
    ? resolveAvatarCropLayout(dimensions.width, dimensions.height, zoom, offset.x, offset.y)
    : null, [dimensions, offset.x, offset.y, zoom])

  const applyOffset = (x: number, y: number): void => {
    if (!dimensions) return
    const next = resolveAvatarCropLayout(dimensions.width, dimensions.height, zoom, x, y)
    setOffset({ x: next.offsetX, y: next.offsetY })
  }

  const moveBy = (x: number, y: number): void => {
    applyOffset(offset.x + x, offset.y + y)
  }

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dimensions) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startOffsetX: offset.x,
      startOffsetY: offset.y,
      startX: event.clientX,
      startY: event.clientY,
    }
  }

  const drag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return
    applyOffset(
      state.startOffsetX + event.clientX - state.startX,
      state.startOffsetY + event.clientY - state.startY,
    )
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const updateZoom = (nextZoom: number): void => {
    if (!dimensions) return
    const next = resolveAvatarCropLayout(
      dimensions.width,
      dimensions.height,
      nextZoom,
      offset.x,
      offset.y,
    )
    setZoom(nextZoom)
    setOffset({ x: next.offsetX, y: next.offsetY })
  }

  const save = (): void => {
    const image = imageRef.current
    if (!image || !dimensions) return
    setSaving(true)
    setError('')
    try {
      onComplete(cropAvatarImage(image, zoom, offset.x, offset.y))
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : t("Avatar processing failed. Try again."))
      setSaving(false)
    }
  }

  return (
    <div className="avatar-crop-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onCancel()
    }}>
      <section aria-label={t("Crop avatar")} aria-modal="true" className="avatar-crop-dialog" role="dialog">
        <header className="avatar-crop-header">
          <div><h3>{t("Crop avatar")}</h3><small>{t("Drag the image to choose the visible area")}</small></div>
          <button aria-label={t("Close avatar cropper")} className="icon-button" onClick={onCancel} type="button">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="avatar-crop-body">
          <div
            aria-label={t("Avatar crop area. Drag the image or use the arrow keys to adjust it.")}
            className={`avatar-crop-stage ${dimensions ? 'is-ready' : ''}`}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 15 : 4
              if (event.key === 'ArrowLeft') moveBy(-step, 0)
              else if (event.key === 'ArrowRight') moveBy(step, 0)
              else if (event.key === 'ArrowUp') moveBy(0, -step)
              else if (event.key === 'ArrowDown') moveBy(0, step)
              else return
              event.preventDefault()
            }}
            onPointerCancel={finishDrag}
            onPointerDown={startDrag}
            onPointerMove={drag}
            onPointerUp={finishDrag}
            tabIndex={0}
          >
            <img
              alt={t("Avatar preview")}
              draggable={false}
              onError={() => setError(t("Could not read this image. Choose another image and try again."))}
              onLoad={(event) => {
                try {
                  const nextDimensions = {
                    height: event.currentTarget.naturalHeight,
                    width: event.currentTarget.naturalWidth,
                  }
                  validateAvatarSourceDimensions(nextDimensions.width, nextDimensions.height)
                  setDimensions(nextDimensions)
                  setZoom(MIN_AVATAR_ZOOM)
                  setOffset({ x: 0, y: 0 })
                  setError('')
                } catch (loadError) {
                  setDimensions(null)
                  setError(loadError instanceof Error ? loadError.message : t("Avatar image size is invalid."))
                }
              }}
              ref={imageRef}
              src={sourceUrl}
              style={layout ? {
                height: layout.renderedHeight,
                left: (AVATAR_CROP_VIEWPORT_SIZE - layout.renderedWidth) / 2 + layout.offsetX,
                top: (AVATAR_CROP_VIEWPORT_SIZE - layout.renderedHeight) / 2 + layout.offsetY,
                width: layout.renderedWidth,
              } : undefined}
            />
            <span aria-hidden="true" className="avatar-crop-grid" />
          </div>
          <label className="avatar-zoom-control">
            <Icon name="image" size={14} />
            <input
              aria-label={t("Avatar zoom")}
              disabled={!dimensions}
              max={MAX_AVATAR_ZOOM}
              min={MIN_AVATAR_ZOOM}
              onChange={(event) => updateZoom(Number(event.target.value))}
              step="0.01"
              type="range"
              value={zoom}
            />
            <Icon name="image" size={19} />
          </label>
          <p className="avatar-crop-hint">{t("After saving, the image will be cropped to a square and resized to at most 1,000 px.")}</p>
          {error && <p className="avatar-crop-error" role="alert">{error}</p>}
        </div>
        <footer className="avatar-crop-footer">
          <button className="secondary-button" onClick={onCancel} type="button">{t("Cancel")}</button>
          <button className="primary-button" disabled={!dimensions || Boolean(error) || saving} onClick={save} type="button">
            {saving ? t("Processing…") : t("Use this avatar")}
          </button>
        </footer>
      </section>
    </div>
  )
}
