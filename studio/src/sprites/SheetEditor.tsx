import { useState, type ReactNode } from "react";
import type { Asset } from "../project/manifests";
import { IntField } from "./IntField";
import {
  addFrame, addSheet, animationsUsingFrame, DEFAULT_GRID, duplicateSheetFrame, moveFrame, nextFreeId, removeSheet, removeSheetFrame,
  reorderSheetFrame, resizeFrame, resliceSheet, type AnimationsManifest, type Grid, type Result,
} from "./edit";
/** Receives the result of one operation and the history field it coalesces under. The container commits or shows the reason. */
export type Apply = (result: Result<AnimationsManifest>, field: string) => void;
const GRID_FIELDS: [keyof Grid, string][] = [
  ["frameWidth", "Frame width"], ["frameHeight", "Frame height"], ["columns", "Columns"], ["rows", "Rows"], ["margin", "Margin"], ["spacing", "Spacing"],
];
function GridForm({ grid, onChange }: { grid: Grid; onChange: (g: Grid) => void }) {
  return (
    <div className="actions small">
      {GRID_FIELDS.map(([k, label]) => (
        <label key={k}>{label} <IntField label={label} value={grid[k]} testId={`grid-${k}`} onApply={(n) => onChange({ ...grid, [k]: n })} /></label>
      ))}
    </div>
  );
}
/**
 * Sheets and frames: choose an image asset, slice it by a grid, then add, move, resize, reorder, duplicate and remove frames in
 * whole pixels. Presentational; `preview` is the image with frame outlines, drawn by the container.
 */
export function SheetEditor({ animations, images, selectedId, onSelect, apply, preview }: {
  animations: AnimationsManifest; images: readonly Asset[]; selectedId: string | null; onSelect: (id: string | null) => void;
  apply: Apply; preview: ReactNode;
}) {
  const [assetId, setAssetId] = useState("");
  const [newGrid, setNewGrid] = useState<Grid>(DEFAULT_GRID);
  const [rect, setRect] = useState({ x: 0, y: 0, w: 16, h: 16 });
  const [confirm, setConfirm] = useState<{ frameId: string; users: string[] } | null>(null);
  const sheet = animations.sheets.find((s) => s.id === selectedId) ?? null;
  const imageOf = (id: string) => images.find((a) => a.id === id);
  const image = sheet ? imageOf(sheet.assetId) : undefined;
  const chosen = imageOf(assetId) ?? images[0];
  return (
    <section data-testid="sheet-editor">
      <h3>Sheets</h3>
      <p className="muted">Prototype. Sheets, frames and animations are stored, previewed and exported by Studio. A sheet becomes the native atlas in the Native sprites section below; the animation data itself is Studio data.</p>
      <ul className="asset-list">
        {animations.sheets.map((s) => (
          <li key={s.id} data-testid={`sheet-row-${s.id}`} data-selected={s.id === selectedId ? "true" : undefined}>
            <span><code>{s.id}</code> on <code>{s.assetId}</code>, {s.frames.length} frames</span>
            <button type="button" data-testid={`sheet-select-${s.id}`} aria-pressed={s.id === selectedId} onClick={() => onSelect(s.id === selectedId ? null : s.id)}>Edit</button>
          </li>
        ))}
        {animations.sheets.length === 0 && <li className="muted" data-testid="sheet-empty">No sheets yet.</li>}
      </ul>
      <fieldset data-testid="sheet-new">
        <legend>New sheet</legend>
        {images.length === 0 ? <p className="muted">Import an image in Asset Studio first.</p> : (
          <>
            <label>Image{" "}
              <select data-testid="sheet-new-asset" value={chosen?.id ?? ""} onChange={(e) => setAssetId(e.target.value)}>
                {images.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.file}, {a.width}x{a.height})</option>)}
              </select>
            </label>
            <GridForm grid={newGrid} onChange={setNewGrid} />
            <button type="button" data-testid="sheet-create" disabled={!chosen}
              onClick={() => { if (chosen) apply(addSheet(animations, nextFreeId("sheet", animations.sheets), chosen, newGrid), "animations.sheets"); }}>Slice into a new sheet</button>
          </>
        )}
      </fieldset>
      {sheet && (
        <div data-testid={`sheet-detail-${sheet.id}`}>
          <h4>{sheet.id}</h4>
          {preview}
          {image === undefined && <p role="alert" className="error">The image asset {sheet.assetId} is missing, so this sheet cannot be edited.</p>}
          <fieldset>
            <legend>Grid</legend>
            <GridForm grid={sheet.grid} onChange={(g) => { if (image) apply(resliceSheet(animations, sheet.id, image, g), `animations.${sheet.id}.grid`); }} />
            <small className="muted">Changing the grid re-slices the sheet and replaces its frames. It is refused when an animation uses a frame the new grid does not produce.</small>
          </fieldset>
          <table data-testid="frame-list">
            <thead><tr><th>Frame</th><th>X</th><th>Y</th><th>Width</th><th>Height</th><th>Actions</th></tr></thead>
            <tbody>
              {sheet.frames.map((f, i) => (
                <tr key={f.id} data-testid={`frame-row-${f.id}`}>
                  <td><code>{f.id}</code></td>
                  <td><IntField label={`${f.id} x`} value={f.x} onApply={(n) => image && apply(moveFrame(animations, sheet.id, f.id, n, f.y, image), `animations.${sheet.id}.${f.id}.pos`)} /></td>
                  <td><IntField label={`${f.id} y`} value={f.y} onApply={(n) => image && apply(moveFrame(animations, sheet.id, f.id, f.x, n, image), `animations.${sheet.id}.${f.id}.pos`)} /></td>
                  <td><IntField label={`${f.id} width`} value={f.w} onApply={(n) => image && apply(resizeFrame(animations, sheet.id, f.id, n, f.h, image), `animations.${sheet.id}.${f.id}.size`)} /></td>
                  <td><IntField label={`${f.id} height`} value={f.h} onApply={(n) => image && apply(resizeFrame(animations, sheet.id, f.id, f.w, n, image), `animations.${sheet.id}.${f.id}.size`)} /></td>
                  <td className="actions small">
                    <button type="button" data-testid={`frame-up-${f.id}`} disabled={i === 0} aria-label={`Move ${f.id} up`} onClick={() => apply(reorderSheetFrame(animations, sheet.id, i, i - 1), "animations.frames")}>Up</button>
                    <button type="button" data-testid={`frame-down-${f.id}`} disabled={i === sheet.frames.length - 1} aria-label={`Move ${f.id} down`} onClick={() => apply(reorderSheetFrame(animations, sheet.id, i, i + 1), "animations.frames")}>Down</button>
                    <button type="button" data-testid={`frame-duplicate-${f.id}`} aria-label={`Duplicate ${f.id}`} onClick={() => apply(duplicateSheetFrame(animations, sheet.id, i), "animations.frames")}>Duplicate</button>
                    <button type="button" data-testid={`frame-remove-${f.id}`} aria-label={`Remove ${f.id}`}
                      onClick={() => {
                        const users = animationsUsingFrame(animations, sheet.id, f.id);
                        if (users.length > 0) setConfirm({ frameId: f.id, users }); else apply(removeSheetFrame(animations, sheet.id, f.id), "animations.frames");
                      }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {confirm && (
            <div role="alertdialog" aria-label="Frame is in use" data-testid="frame-remove-confirm" className="banner">
              <p>Frame {confirm.frameId} is used by animation {confirm.users.join(", ")}. Removing it also removes it from those sequences.</p>
              <button type="button" data-testid="frame-remove-confirm-yes" onClick={() => { apply(removeSheetFrame(animations, sheet.id, confirm.frameId, true), "animations.frames"); setConfirm(null); }}>Remove from sequences too</button>{" "}
              <button type="button" data-testid="frame-remove-confirm-no" onClick={() => setConfirm(null)}>Keep it</button>
            </div>
          )}
          <fieldset data-testid="frame-add">
            <legend>Add a frame by rectangle (whole pixels)</legend>
            <div className="actions small">
              {(["x", "y", "w", "h"] as const).map((k) => (
                <label key={k}>{k === "w" ? "Width" : k === "h" ? "Height" : k.toUpperCase()} <IntField label={`new frame ${k}`} value={rect[k]} testId={`frame-add-${k}`} onApply={(n) => setRect({ ...rect, [k]: n })} /></label>
              ))}
              <button type="button" data-testid="frame-add-submit" onClick={() => image && apply(addFrame(animations, sheet.id, rect, image), "animations.frames")}>Add frame</button>
            </div>
          </fieldset>
          <button type="button" data-testid="sheet-delete" onClick={() => { apply(removeSheet(animations, sheet.id), "animations.sheets"); }}>Delete sheet</button>
        </div>
      )}
    </section>
  );
}
