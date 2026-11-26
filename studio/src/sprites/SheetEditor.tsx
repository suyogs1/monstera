import { useMemo, useState, type ReactNode } from "react";
import type { Asset, Frame } from "../project/manifests";
import { FrameThumb, InteractiveSheetCanvas, useAssetImageUrl, type AssetBytesLoader } from "./FrameCanvas";
import { IntField } from "./IntField";
import {
  addFrame,
  addSheetWithFrames,
  animationsUsingFrame,
  DEFAULT_GRID,
  duplicateSheetFrame,
  moveFrame,
  nextFreeId,
  removeSheet,
  removeSheetFrame,
  renameSheetFrame,
  reorderSheetFrame,
  resliceSheetWithFrames,
  resizeFrame,
  setFrameRect,
  type AnimationsManifest,
  type Grid,
  type Result,
} from "./edit";
import { sliceGrid } from "./slice";

/** Receives the result of one operation and the history field it coalesces under. The container commits or shows the reason. */
export type Apply = (result: Result<AnimationsManifest>, field: string) => void;

const GRID_FIELDS: [keyof Grid, string][] = [
  ["frameWidth", "Frame width"],
  ["frameHeight", "Frame height"],
  ["columns", "Columns"],
  ["rows", "Rows"],
  ["margin", "Margin"],
  ["spacing", "Spacing"],
];

function GridForm({ grid, onChange }: { grid: Grid; onChange: (g: Grid) => void }) {
  return (
    <div className="actions small">
      {GRID_FIELDS.map(([k, label]) => (
        <label key={k}>
          {label}{" "}
          <IntField label={label} value={grid[k]} testId={`grid-${k}`} onApply={(n) => onChange({ ...grid, [k]: n })} />
        </label>
      ))}
    </div>
  );
}

function FrameRenameControl({
  frameId,
  onRename,
}: {
  frameId: string;
  onRename: (nextId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(frameId);

  if (!editing) {
    return (
      <span className="frame-id-cell">
        <code>{frameId}</code>
        <button
          type="button"
          className="btn-card-subtle"
          data-testid={`frame-rename-open-${frameId}`}
          onClick={() => {
            setDraft(frameId);
            setEditing(true);
          }}
        >
          Rename
        </button>
      </span>
    );
  }
  return (
    <span className="frame-id-cell">
      <input
        type="text"
        value={draft}
        aria-label={`Rename ${frameId}`}
        data-testid={`frame-rename-input-${frameId}`}
        className="rename-input"
        style={{ width: 96 }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onRename(draft);
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
      />
      <button
        type="button"
        className="btn-primary-xs"
        data-testid={`frame-rename-save-${frameId}`}
        onClick={() => {
          onRename(draft);
          setEditing(false);
        }}
      >
        Save
      </button>
      <button type="button" className="btn-card-subtle" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </span>
  );
}

/**
 * Sheets and frames: choose an image asset, slice it via Grid Slicing (with live frame preview and per-frame selection)
 * or Manual Slicing (draw, move, resize rectangles directly on the image), then rename, reorder, duplicate or remove frames.
 */
export function SheetEditor({
  animations,
  images,
  selectedId,
  onSelect,
  apply,
  preview,
  interactive = false,
  assetBytes,
}: {
  animations: AnimationsManifest;
  images: readonly Asset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  apply: Apply;
  preview?: ReactNode;
  interactive?: boolean;
  assetBytes?: AssetBytesLoader;
}) {
  const [assetId, setAssetId] = useState("");
  const [newGrid, setNewGrid] = useState<Grid>(DEFAULT_GRID);
  const [newExcluded, setNewExcluded] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<"grid" | "manual">("grid");
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [editGrid, setEditGrid] = useState<Grid | null>(null);
  const [editExcluded, setEditExcluded] = useState<Set<string>>(() => new Set());
  const [rect, setRect] = useState({ x: 0, y: 0, w: 16, h: 16 });
  const [confirm, setConfirm] = useState<{ frameId: string; users: string[] } | null>(null);

  const sheet = animations.sheets.find((s) => s.id === selectedId) ?? null;
  const imageOf = (id: string) => images.find((a) => a.id === id);
  const image = sheet ? imageOf(sheet.assetId) : undefined;
  const chosen = imageOf(assetId) ?? images[0];

  const newAssetUrl = useAssetImageUrl(interactive && chosen ? chosen.id : null, assetBytes);
  const sheetAssetUrl = useAssetImageUrl(interactive && image ? image.id : null, assetBytes);

  const newGridSlice = useMemo(() => {
    if (!chosen) return null;
    return sliceGrid(newGrid, chosen.width, chosen.height);
  }, [chosen, newGrid]);

  const activeEditGrid = editGrid ?? sheet?.grid ?? DEFAULT_GRID;
  const editGridSlice = useMemo(() => {
    if (!sheet || !image) return null;
    return sliceGrid(activeEditGrid, image.width, image.height);
  }, [sheet, image, activeEditGrid]);

  const toggleNewCell = (id: string) => {
    setNewExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleEditCell = (id: string) => {
    setEditExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedNewFrames: Frame[] = useMemo(() => {
    if (!newGridSlice?.ok) return [];
    return newGridSlice.value.filter((f) => !newExcluded.has(f.id));
  }, [newGridSlice, newExcluded]);

  const selectedEditFrames: Frame[] = useMemo(() => {
    if (!editGridSlice?.ok) return [];
    return editGridSlice.value.filter((f) => !editExcluded.has(f.id));
  }, [editGridSlice, editExcluded]);

  const mixedSizes = useMemo(() => {
    if (!sheet || sheet.frames.length <= 1) return false;
    const first = sheet.frames[0]!;
    return sheet.frames.some((f) => f.w !== first.w || f.h !== first.h);
  }, [sheet]);

  const selectedFrame = sheet?.frames.find((f) => f.id === selectedFrameId) ?? sheet?.frames[0] ?? null;

  return (
    <section data-testid="sheet-editor">
      <h3>Sheets</h3>
      <p className="muted">
        Prototype. Sheets, frames and animations are stored, previewed and exported by Studio. A sheet becomes the native atlas in the Native sprites section below; the animation data itself is Studio data.
      </p>

      <ul className="asset-list">
        {animations.sheets.map((s) => (
          <li key={s.id} data-testid={`sheet-row-${s.id}`} data-selected={s.id === selectedId ? "true" : undefined}>
            <span>
              <code>{s.id}</code> on <code>{s.assetId}</code>, {s.frames.length} frames
            </span>
            <button
              type="button"
              data-testid={`sheet-select-${s.id}`}
              aria-pressed={s.id === selectedId}
              onClick={() => {
                const next = s.id === selectedId ? null : s.id;
                setEditGrid(null);
                setEditExcluded(new Set());
                setSelectedFrameId(null);
                onSelect(next);
              }}
            >
              Edit
            </button>
          </li>
        ))}
        {animations.sheets.length === 0 && (
          <li className="muted" data-testid="sheet-empty">
            No sheets yet.
          </li>
        )}
      </ul>

      <fieldset data-testid="sheet-new">
        <legend>New sheet (Grid Slicing)</legend>
        {images.length === 0 ? (
          <p className="muted">Import an image in Asset Studio first.</p>
        ) : (
          <>
            <label>
              Image{" "}
              <select
                data-testid="sheet-new-asset"
                value={chosen?.id ?? ""}
                onChange={(e) => {
                  setAssetId(e.target.value);
                  setNewExcluded(new Set());
                }}
              >
                {images.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id} ({a.file}, {a.width}×{a.height})
                  </option>
                ))}
              </select>
            </label>
            <GridForm
              grid={newGrid}
              onChange={(g) => {
                setNewGrid(g);
                setNewExcluded(new Set());
              }}
            />
            {newGridSlice && !newGridSlice.ok && (
              <p className="issue-inline" role="alert">
                {newGridSlice.error}
              </p>
            )}
            {interactive && chosen && newGridSlice?.ok && (
              <div className="grid-preview-panel">
                <InteractiveSheetCanvas
                  sheet={null}
                  url={newAssetUrl.url}
                  missing={newAssetUrl.missing}
                  imageWidth={chosen.width}
                  imageHeight={chosen.height}
                  mode="grid"
                  selectedFrameId={null}
                  gridPreview={newGridSlice.value}
                  deselectedGridIds={newExcluded}
                  onSelectFrame={() => undefined}
                  onToggleGridCell={toggleNewCell}
                />
                <div className="grid-cell-selector">
                  <div className="actions small">
                    <span className="small muted">
                      Frames selected: {selectedNewFrames.length} of {newGridSlice.value.length}
                    </span>
                    <button type="button" className="btn-card-subtle" onClick={() => setNewExcluded(new Set())}>
                      Select all
                    </button>
                    <button
                      type="button"
                      className="btn-card-subtle"
                      onClick={() => setNewExcluded(new Set(newGridSlice.value.map((f) => f.id)))}
                    >
                      Clear selection
                    </button>
                  </div>
                  <div className="frame-thumb-strip">
                    {newGridSlice.value.map((f) => {
                      const excluded = newExcluded.has(f.id);
                      return (
                        <button
                          key={f.id}
                          type="button"
                          className={`frame-chip-btn ${excluded ? "is-excluded" : "is-included"}`}
                          data-testid={`new-grid-cell-${f.id}`}
                          aria-pressed={!excluded}
                          onClick={() => toggleNewCell(f.id)}
                          title={`${f.id} (${f.x},${f.y} ${f.w}×${f.h}) — click to ${excluded ? "include" : "exclude"}`}
                        >
                          <FrameThumb url={newAssetUrl.url} frame={f} size={32} />
                          <span>{f.id}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            <div className="actions small">
              <button
                type="button"
                data-testid="sheet-create"
                disabled={!chosen || (newGridSlice !== null && !newGridSlice.ok) || selectedNewFrames.length === 0}
                onClick={() => {
                  if (!chosen) return;
                  const nextId = nextFreeId("sheet", animations.sheets);
                  apply(addSheetWithFrames(animations, nextId, chosen, newGrid, selectedNewFrames), "animations.sheets");
                  onSelect(nextId);
                }}
              >
                Slice into a new sheet ({selectedNewFrames.length} frames)
              </button>
            </div>
          </>
        )}
      </fieldset>

      {sheet && (
        <div data-testid={`sheet-detail-${sheet.id}`} className="sheet-detail-box">
          <div className="sheet-detail-header">
            <h4>Sheet: {sheet.id}</h4>
            <div className="slice-mode-tabs" role="tablist" aria-label="Slicing mode">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "grid"}
                data-testid="slice-mode-grid"
                className={`btn-mode-tab ${mode === "grid" ? "is-active" : ""}`}
                onClick={() => setMode("grid")}
              >
                Grid Slicing
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "manual"}
                data-testid="slice-mode-manual"
                className={`btn-mode-tab ${mode === "manual" ? "is-active" : ""}`}
                onClick={() => setMode("manual")}
              >
                Manual Slicing
              </button>
            </div>
          </div>

          {preview}

          {interactive && image && (
            <InteractiveSheetCanvas
              sheet={sheet}
              url={sheetAssetUrl.url}
              missing={sheetAssetUrl.missing}
              imageWidth={image.width}
              imageHeight={image.height}
              mode={mode}
              selectedFrameId={selectedFrame?.id ?? null}
              gridPreview={mode === "grid" && editGridSlice?.ok ? editGridSlice.value : undefined}
              deselectedGridIds={mode === "grid" ? editExcluded : undefined}
              onSelectFrame={(id) => setSelectedFrameId(id)}
              onToggleGridCell={toggleEditCell}
              onAddRect={(r) => apply(addFrame(animations, sheet.id, r, image), "animations.frames")}
              onMoveRect={(fId, x, y) => apply(moveFrame(animations, sheet.id, fId, x, y, image), `animations.${sheet.id}.${fId}.pos`)}
              onResizeRect={(fId, r) => apply(setFrameRect(animations, sheet.id, fId, r, image), `animations.${sheet.id}.${fId}.size`)}
            />
          )}

          {image === undefined && (
            <p role="alert" className="error">
              The image asset {sheet.assetId} is missing, so this sheet cannot be edited.
            </p>
          )}

          {mixedSizes && (
            <p className="notice" role="status" data-testid="sheet-mixed-sizes">
              This sheet contains mixed crop dimensions. Original crop rectangles are preserved; when you build the native Spec v5 atlas below, frames are normalized to uniform cell dimensions (up to 128×128).
            </p>
          )}

          {mode === "grid" && (
            <fieldset>
              <legend>Grid</legend>
              <GridForm
                grid={activeEditGrid}
                onChange={(g) => {
                  setEditGrid(g);
                  setEditExcluded(new Set());
                }}
              />
              {editGridSlice && !editGridSlice.ok && (
                <p className="issue-inline" role="alert">
                  {editGridSlice.error}
                </p>
              )}
              <div className="actions small">
                <button
                  type="button"
                  data-testid="grid-reslice-apply"
                  disabled={!image || !editGridSlice?.ok || selectedEditFrames.length === 0}
                  onClick={() => {
                    if (image) {
                      apply(
                        resliceSheetWithFrames(animations, sheet.id, image, activeEditGrid, selectedEditFrames),
                        `animations.${sheet.id}.grid`
                      );
                    }
                  }}
                >
                  Apply grid slices ({selectedEditFrames.length} selected)
                </button>
                {editGridSlice?.ok && (
                  <>
                    <button type="button" className="btn-card-subtle" onClick={() => setEditExcluded(new Set())}>
                      Select all
                    </button>
                    <button
                      type="button"
                      className="btn-card-subtle"
                      onClick={() => setEditExcluded(new Set(editGridSlice.value.map((f) => f.id)))}
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
              <small className="muted">
                Applying grid slices replaces the sheet&apos;s frames with the selected cells. Refused if an animation uses an omitted frame id.
              </small>
            </fieldset>
          )}

          {interactive && selectedFrame && (
            <div className="selected-frame-preview" data-testid="selected-frame-preview">
              <FrameThumb url={sheetAssetUrl.url} frame={selectedFrame} size={56} />
              <div>
                <strong>Selected frame: <code>{selectedFrame.id}</code></strong>
                <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
                  x={selectedFrame.x}, y={selectedFrame.y}, {selectedFrame.w}×{selectedFrame.h}px
                </p>
              </div>
            </div>
          )}

          <div className="frame-list-scroll" data-testid="frame-list-container">
            <table data-testid="frame-list">
            <thead>
              <tr>
                {interactive && <th>Preview</th>}
                <th>Frame</th>
                <th>X</th>
                <th>Y</th>
                <th>Width</th>
                <th>Height</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sheet.frames.map((f, i) => (
                <tr
                  key={f.id}
                  data-testid={`frame-row-${f.id}`}
                  data-selected={selectedFrame?.id === f.id ? "true" : undefined}
                  onClick={() => setSelectedFrameId(f.id)}
                >
                  {interactive && (
                    <td>
                      <FrameThumb url={sheetAssetUrl.url} frame={f} size={36} />
                    </td>
                  )}
                  <td>
                    <FrameRenameControl
                      frameId={f.id}
                      onRename={(nextId) => apply(renameSheetFrame(animations, sheet.id, f.id, nextId), `animations.${sheet.id}.rename`)}
                    />
                  </td>
                  <td>
                    <IntField
                      label={`${f.id} x`}
                      value={f.x}
                      onApply={(n) => image && apply(moveFrame(animations, sheet.id, f.id, n, f.y, image), `animations.${sheet.id}.${f.id}.pos`)}
                    />
                  </td>
                  <td>
                    <IntField
                      label={`${f.id} y`}
                      value={f.y}
                      onApply={(n) => image && apply(moveFrame(animations, sheet.id, f.id, f.x, n, image), `animations.${sheet.id}.${f.id}.pos`)}
                    />
                  </td>
                  <td>
                    <IntField
                      label={`${f.id} width`}
                      value={f.w}
                      onApply={(n) => image && apply(resizeFrame(animations, sheet.id, f.id, n, f.h, image), `animations.${sheet.id}.${f.id}.size`)}
                    />
                  </td>
                  <td>
                    <IntField
                      label={`${f.id} height`}
                      value={f.h}
                      onApply={(n) => image && apply(resizeFrame(animations, sheet.id, f.id, f.w, n, image), `animations.${sheet.id}.${f.id}.size`)}
                    />
                  </td>
                  <td className="actions small">
                    <button
                      type="button"
                      data-testid={`frame-up-${f.id}`}
                      disabled={i === 0}
                      aria-label={`Move ${f.id} up`}
                      onClick={() => apply(reorderSheetFrame(animations, sheet.id, i, i - 1), "animations.frames")}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      data-testid={`frame-down-${f.id}`}
                      disabled={i === sheet.frames.length - 1}
                      aria-label={`Move ${f.id} down`}
                      onClick={() => apply(reorderSheetFrame(animations, sheet.id, i, i + 1), "animations.frames")}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      data-testid={`frame-duplicate-${f.id}`}
                      aria-label={`Duplicate ${f.id}`}
                      onClick={() => apply(duplicateSheetFrame(animations, sheet.id, i), "animations.frames")}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      data-testid={`frame-remove-${f.id}`}
                      aria-label={`Remove ${f.id}`}
                      onClick={() => {
                        const users = animationsUsingFrame(animations, sheet.id, f.id);
                        if (users.length > 0) setConfirm({ frameId: f.id, users });
                        else apply(removeSheetFrame(animations, sheet.id, f.id), "animations.frames");
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>

          {confirm && (
            <div role="alertdialog" aria-label="Frame is in use" data-testid="frame-remove-confirm" className="banner">
              <p>
                Frame {confirm.frameId} is used by animation {confirm.users.join(", ")}. Removing it also removes it from those sequences.
              </p>
              <button
                type="button"
                data-testid="frame-remove-confirm-yes"
                onClick={() => {
                  apply(removeSheetFrame(animations, sheet.id, confirm.frameId, true), "animations.frames");
                  setConfirm(null);
                }}
              >
                Remove from sequences too
              </button>{" "}
              <button type="button" data-testid="frame-remove-confirm-no" onClick={() => setConfirm(null)}>
                Keep it
              </button>
            </div>
          )}

          <fieldset data-testid="frame-add">
            <legend>Add a frame by rectangle (whole pixels)</legend>
            <div className="actions small">
              {(["x", "y", "w", "h"] as const).map((k) => (
                <label key={k}>
                  {k === "w" ? "Width" : k === "h" ? "Height" : k.toUpperCase()}{" "}
                  <IntField label={`new frame ${k}`} value={rect[k]} testId={`frame-add-${k}`} onApply={(n) => setRect({ ...rect, [k]: n })} />
                </label>
              ))}
              <button
                type="button"
                data-testid="frame-add-submit"
                onClick={() => image && apply(addFrame(animations, sheet.id, rect, image), "animations.frames")}
              >
                Add frame
              </button>
            </div>
          </fieldset>
          <button
            type="button"
            data-testid="sheet-delete"
            onClick={() => {
              apply(removeSheet(animations, sheet.id), "animations.sheets");
            }}
          >
            Delete sheet
          </button>
        </div>
      )}
    </section>
  );
}
