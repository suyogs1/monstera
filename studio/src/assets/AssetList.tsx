import type { ReactNode } from "react";
import type { Asset } from "../project/manifests";
import { filterAssets, type LibraryFilter } from "./library";
const CATEGORIES: Asset["category"][] = ["sprite", "background", "ui", "sfx", "music"];
const sizeText = (a: Asset): string => (a.kind === "image" ? `${a.width}×${a.height} px` : `${(a.durationMs / 1000).toFixed(2)} s`);
/**
 * The asset library: filters (category, kind, linked entity) and one row per asset. Presentational: the container owns the
 * filter, the preview and the actions. `preview` is rendered inside the row of `previewId` only.
 */
export function AssetList({ assets, filter, kindIds, previewId, preview, onFilter, onPreview, onDelete, onAssign }: {
  assets: readonly Asset[]; filter: LibraryFilter; kindIds: readonly string[]; previewId: string | null; preview: ReactNode;
  onFilter(next: LibraryFilter): void; onPreview(id: string | null): void; onDelete(id: string): void;
  /** Replaces the kinds linked to one asset (task 2.3). */
  onAssign?(id: string, kindIds: string[]): void;
}) {
  const shown = filterAssets(assets, filter);
  return (
    <div data-testid="asset-library">
      <div className="actions small">
        <label>Category{" "}
          <select data-testid="asset-filter-category" value={filter.category ?? "all"} onChange={(e) => onFilter({ ...filter, category: e.target.value as LibraryFilter["category"] })}>
            <option value="all">all</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>Kind{" "}
          <select data-testid="asset-filter-kind" value={filter.kind ?? "all"} onChange={(e) => onFilter({ ...filter, kind: e.target.value as LibraryFilter["kind"] })}>
            <option value="all">all</option><option value="image">image</option><option value="audio">audio</option>
          </select>
        </label>
        <label>Entity{" "}
          <select data-testid="asset-filter-entity" value={filter.kindRef ?? "all"} onChange={(e) => onFilter({ ...filter, kindRef: e.target.value })}>
            <option value="all">all</option>
            {kindIds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <span className="muted" data-testid="asset-count">{shown.length} of {assets.length}</span>
      </div>
      <ul className="asset-list">
        {shown.map((a) => (
          <li key={a.id} data-testid={`asset-row-${a.id}`} data-kind={a.kind} data-category={a.category}>
            <span><strong>{a.file}</strong> <code>{a.id}</code> <span className="badge-inline">{a.category}</span>{" "}
              <span className="muted">{a.mime}, {sizeText(a)}, {a.bytes} bytes</span><br />
              <small className="muted">sha256 <code>{a.sha256.slice(0, 12)}</code> · {a.provenance.origin} · license {a.provenance.license}{a.provenance.author !== "" ? ` · ${a.provenance.author}` : ""}{a.kindRefs.length > 0 ? ` · linked: ${a.kindRefs.join(", ")}` : ""}</small>
            </span>
            <span className="actions small">
              <button type="button" data-testid={`asset-preview-${a.id}`} aria-pressed={previewId === a.id} onClick={() => onPreview(previewId === a.id ? null : a.id)}>
                {previewId === a.id ? "Hide preview" : "Preview"}
              </button>
              <button type="button" data-testid={`asset-delete-${a.id}`} aria-label={`Delete ${a.file}`} onClick={() => onDelete(a.id)}>Delete</button>
            </span>
            {onAssign && (
              <details className="asset-assign" data-testid={`asset-assign-${a.id}`}>
                <summary>Linked kinds ({a.kindRefs.length})</summary>
                {kindIds.length === 0 && <span className="muted small">This game has no kinds yet.</span>}
                {kindIds.map((k) => (
                  <label key={k} className="small">
                    <input type="checkbox" data-testid={`asset-assign-${a.id}-${k}`} checked={a.kindRefs.includes(k)}
                      onChange={(e) => onAssign(a.id, e.target.checked ? [...a.kindRefs, k] : a.kindRefs.filter((x) => x !== k))} /> {k}
                  </label>
                ))}
              </details>
            )}
            {previewId === a.id && <div className="asset-preview" data-testid={`asset-preview-pane-${a.id}`}>{preview}</div>}
          </li>
        ))}
        {shown.length === 0 && <li className="muted" data-testid="asset-empty">{assets.length === 0 ? "No assets yet. Import an image or audio file below." : "No asset matches these filters."}</li>}
      </ul>
    </div>
  );
}
