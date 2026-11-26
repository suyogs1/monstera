import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Frame, Sheet } from "../project/manifests";
import type { Rect } from "./edit";

export type AssetBytesLoader = (assetId: string) => Promise<Uint8Array | null>;

/** Loads an asset's bytes as a revocable object URL. */
export function useAssetImageUrl(assetId: string | null, assetBytes?: AssetBytesLoader): { url: string | null; missing: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!assetId || !assetBytes) {
      setUrl(null);
      setMissing(false);
      return;
    }
    let live = true;
    let made: string | null = null;
    setUrl(null);
    setMissing(false);
    void assetBytes(assetId).then((bytes) => {
      if (!live) return;
      if (bytes === null) {
        setMissing(true);
        return;
      }
      made = URL.createObjectURL(new Blob([bytes.slice()]));
      setUrl(made);
    });
    return () => {
      live = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [assetId, assetBytes]);
  return { url, missing };
}

/** Cropped pixel-art thumbnail preview of a single frame rectangle. */
export function FrameThumb({
  url,
  frame,
  size = 40,
}: {
  url: string | null;
  frame: Pick<Frame, "x" | "y" | "w" | "h">;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = false;
      const scale = Math.min(size / Math.max(1, frame.w), size / Math.max(1, frame.h));
      const dw = Math.max(1, Math.round(frame.w * scale));
      const dh = Math.max(1, Math.round(frame.h * scale));
      const dx = Math.floor((size - dw) / 2);
      const dy = Math.floor((size - dh) / 2);
      ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, dx, dy, dw, dh);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, frame.x, frame.y, frame.w, frame.h, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="frame-thumb-canvas"
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}

type Handle = "nw" | "ne" | "sw" | "se";
type DragOp =
  | { kind: "draw"; startX: number; startY: number; curX: number; curY: number }
  | { kind: "move"; frameId: string; startX: number; startY: number; orig: Rect; dx: number; dy: number }
  | { kind: "resize"; frameId: string; handle: Handle; startX: number; startY: number; orig: Rect; rect: Rect };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function computeResized(orig: Rect, handle: Handle, dx: number, dy: number, maxW: number, maxH: number): Rect {
  let x1 = orig.x;
  let y1 = orig.y;
  let x2 = orig.x + orig.w;
  let y2 = orig.y + orig.h;
  if (handle === "nw" || handle === "sw") x1 = clamp(orig.x + dx, 0, x2 - 1);
  if (handle === "ne" || handle === "se") x2 = clamp(orig.x + orig.w + dx, x1 + 1, maxW);
  if (handle === "nw" || handle === "ne") y1 = clamp(orig.y + dy, 0, y2 - 1);
  if (handle === "sw" || handle === "se") y2 = clamp(orig.y + orig.h + dy, y1 + 1, maxH);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export interface InteractiveSheetCanvasProps {
  sheet: Sheet | null;
  url: string | null;
  missing?: boolean;
  imageWidth: number;
  imageHeight: number;
  mode: "grid" | "manual";
  selectedFrameId: string | null;
  gridPreview?: readonly Frame[];
  deselectedGridIds?: ReadonlySet<string>;
  onSelectFrame: (id: string | null) => void;
  onToggleGridCell?: (id: string) => void;
  onAddRect?: (rect: Rect) => void;
  onMoveRect?: (frameId: string, x: number, y: number) => void;
  onResizeRect?: (frameId: string, rect: Rect) => void;
}

/**
 * Interactive pixel-accurate slicing canvas supporting:
 * - Grid mode: live grid preview + click cells to select/deselect.
 * - Manual mode: pointer-drag to draw new rectangles, move selected frame, resize via corner handles.
 */
export function InteractiveSheetCanvas({
  sheet,
  url,
  missing,
  imageWidth,
  imageHeight,
  mode,
  selectedFrameId,
  gridPreview,
  deselectedGridIds,
  onSelectFrame,
  onToggleGridCell,
  onAddRect,
  onMoveRect,
  onResizeRect,
}: InteractiveSheetCanvasProps) {
  const defaultZoom = imageWidth <= 64 && imageHeight <= 64 ? 4 : imageWidth <= 128 && imageHeight <= 128 ? 2 : 1;
  const [zoom, setZoom] = useState<number>(defaultZoom);
  const [drag, setDrag] = useState<DragOp | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  if (missing) {
    return <p className="muted" role="alert">The stored bytes for this image are not available, so the sheet cannot be drawn.</p>;
  }
  if (url === null) {
    return <p className="muted">Loading image...</p>;
  }

  const toPixel = (clientX: number, clientY: number): { px: number; py: number } => {
    const el = stageRef.current;
    if (!el) return { px: 0, py: 0 };
    const box = el.getBoundingClientRect();
    return {
      px: clamp(Math.floor((clientX - box.left) / zoom), 0, imageWidth),
      py: clamp(Math.floor((clientY - box.top) / zoom), 0, imageHeight),
    };
  };

  const onStagePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (mode !== "manual" || !sheet || e.button !== 0) return;
    if ((e.target as HTMLElement).dataset["role"]) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { px, py } = toPixel(e.clientX, e.clientY);
    const sx = clamp(px, 0, Math.max(0, imageWidth - 1));
    const sy = clamp(py, 0, Math.max(0, imageHeight - 1));
    setDrag({ kind: "draw", startX: sx, startY: sy, curX: sx + 1, curY: sy + 1 });
  };

  const onStagePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { px, py } = toPixel(e.clientX, e.clientY);
    if (drag.kind === "draw") {
      setDrag({ ...drag, curX: px, curY: py });
    } else if (drag.kind === "move") {
      const dx = clamp(px - drag.startX, -drag.orig.x, imageWidth - drag.orig.w - drag.orig.x);
      const dy = clamp(py - drag.startY, -drag.orig.y, imageHeight - drag.orig.h - drag.orig.y);
      setDrag({ ...drag, dx, dy });
    } else if (drag.kind === "resize") {
      const rect = computeResized(drag.orig, drag.handle, px - drag.startX, py - drag.startY, imageWidth, imageHeight);
      setDrag({ ...drag, rect });
    }
  };

  const onStagePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (drag.kind === "draw") {
      const x = Math.min(drag.startX, drag.curX);
      const y = Math.min(drag.startY, drag.curY);
      const w = Math.max(1, Math.abs(drag.curX - drag.startX));
      const h = Math.max(1, Math.abs(drag.curY - drag.startY));
      if (x + w <= imageWidth && y + h <= imageHeight) {
        onAddRect?.({ x, y, w, h });
      }
    } else if (drag.kind === "move") {
      if (drag.dx !== 0 || drag.dy !== 0) {
        onMoveRect?.(drag.frameId, drag.orig.x + drag.dx, drag.orig.y + drag.dy);
      }
    } else if (drag.kind === "resize") {
      if (
        drag.rect.x !== drag.orig.x ||
        drag.rect.y !== drag.orig.y ||
        drag.rect.w !== drag.orig.w ||
        drag.rect.h !== drag.orig.h
      ) {
        onResizeRect?.(drag.frameId, drag.rect);
      }
    }
    setDrag(null);
  };

  const displayFrames = mode === "grid" && gridPreview ? gridPreview : sheet?.frames ?? [];
  const drawRect: Rect | null =
    drag?.kind === "draw"
      ? {
          x: Math.min(drag.startX, drag.curX),
          y: Math.min(drag.startY, drag.curY),
          w: Math.max(1, Math.abs(drag.curX - drag.startX)),
          h: Math.max(1, Math.abs(drag.curY - drag.startY)),
        }
      : null;

  return (
    <div className="slice-canvas-wrap">
      <div className="slice-canvas-toolbar">
        <span className="small muted">
          Image: {imageWidth}×{imageHeight}px
          {mode === "manual" && sheet ? " · Drag empty area to draw frame, drag frame to move, drag corners to resize" : ""}
          {mode === "grid" && gridPreview ? " · Click grid cells to include/exclude frames" : ""}
        </span>
        <div className="slice-zoom-group" role="group" aria-label="Canvas zoom">
          {[1, 2, 4, 6].map((z) => (
            <button
              key={z}
              type="button"
              className={`btn-zoom ${zoom === z ? "is-active" : ""}`}
              onClick={() => setZoom(z)}
            >
              {z}×
            </button>
          ))}
        </div>
      </div>

      <div className="slice-stage-scroll">
        <div
          ref={stageRef}
          data-testid="sheet-preview"
          className={`slice-stage ${mode === "manual" ? "is-manual" : "is-grid"}`}
          style={{ width: imageWidth * zoom, height: imageHeight * zoom }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
        >
          <img
            src={url}
            alt={sheet ? `Sprite sheet ${sheet.id}` : "Sprite sheet preview"}
            width={imageWidth * zoom}
            height={imageHeight * zoom}
            draggable={false}
            style={{ imageRendering: "pixelated", display: "block", pointerEvents: "none", userSelect: "none" }}
          />

          {displayFrames.map((f) => {
            const isGridExcluded = mode === "grid" && deselectedGridIds?.has(f.id);
            const isSelected = mode === "manual" && selectedFrameId === f.id;
            let box: Rect = f;
            if (drag?.kind === "move" && drag.frameId === f.id) {
              box = { ...f, x: drag.orig.x + drag.dx, y: drag.orig.y + drag.dy };
            } else if (drag?.kind === "resize" && drag.frameId === f.id) {
              box = drag.rect;
            }
            return (
              <div
                key={f.id}
                title={`${f.id} (${box.x}, ${box.y}, ${box.w}×${box.h})`}
                data-testid={`frame-outline-${f.id}`}
                data-role="frame-box"
                className={`slice-frame-box ${isSelected ? "is-selected" : ""} ${isGridExcluded ? "is-excluded" : ""}`}
                style={{
                  left: box.x * zoom,
                  top: box.y * zoom,
                  width: box.w * zoom,
                  height: box.h * zoom,
                }}
                onPointerDown={(e) => {
                  if (mode === "grid") {
                    e.stopPropagation();
                    onToggleGridCell?.(f.id);
                    return;
                  }
                  if (mode === "manual" && sheet && e.button === 0) {
                    e.stopPropagation();
                    onSelectFrame(f.id);
                    stageRef.current?.setPointerCapture(e.pointerId);
                    const { px, py } = toPixel(e.clientX, e.clientY);
                    setDrag({ kind: "move", frameId: f.id, startX: px, startY: py, orig: f, dx: 0, dy: 0 });
                  }
                }}
              >
                <span className="slice-frame-tag">{f.id}</span>
                {isSelected && mode === "manual" && (
                  <>
                    {(["nw", "ne", "sw", "se"] as const).map((h) => (
                      <span
                        key={h}
                        data-role="resize-handle"
                        className={`slice-handle slice-handle-${h}`}
                        onPointerDown={(e) => {
                          if (!sheet || e.button !== 0) return;
                          e.stopPropagation();
                          stageRef.current?.setPointerCapture(e.pointerId);
                          const { px, py } = toPixel(e.clientX, e.clientY);
                          setDrag({ kind: "resize", frameId: f.id, handle: h, startX: px, startY: py, orig: f, rect: f });
                        }}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}

          {drawRect && (
            <div
              className="slice-frame-box is-drawing"
              style={{
                left: drawRect.x * zoom,
                top: drawRect.y * zoom,
                width: drawRect.w * zoom,
                height: drawRect.h * zoom,
              }}
            >
              <span className="slice-frame-tag">
                {drawRect.w}×{drawRect.h}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
