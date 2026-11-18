import { useEffect, useState } from "react";
import { useProject } from "../project/context";
import type { Asset, Provenance } from "../project/manifests";
import { useKindIds } from "../ui/fields";
import { AssetList } from "./AssetList";
import type { LibraryFilter } from "./library";
const ORIGINS: Provenance["origin"][] = ["user-owned", "third-party-licensed", "ai-generated"];
const CATEGORIES: Asset["category"][] = ["sprite", "background", "ui", "sfx", "music"];
/** Image or audio element on a blob: URL made from the stored bytes. Audio never autoplays. The URL is revoked on close. */
function AssetPreview({ asset }: { asset: Asset }) {
  const project = useProject();
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const { assetBytes } = project;
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void assetBytes(asset.id).then((bytes) => {
      if (!live) return;
      if (bytes === null) { setMissing(true); return; }
      made = URL.createObjectURL(new Blob([bytes.slice()], { type: asset.mime }));
      setUrl(made);
    });
    return () => { live = false; if (made !== null) URL.revokeObjectURL(made); };
  }, [asset.id, asset.mime, assetBytes]);
  if (missing) return <p className="muted" role="alert">The stored bytes for {asset.id} are not available, so it cannot be previewed.</p>;
  if (url === null) return <p className="muted">Loading preview…</p>;
  return asset.kind === "image"
    ? <img src={url} alt={`Preview of ${asset.file}`} data-testid="asset-preview-image" style={{ imageRendering: "pixelated", maxWidth: "100%", maxHeight: 256 }} />
    : <audio src={url} controls preload="none" data-testid="asset-preview-audio" />;
}
function ImportForm() {
  const project = useProject();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [origin, setOrigin] = useState<Provenance["origin"]>("user-owned");
  return (
    <form data-testid="asset-import" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const f = new FormData(form);
      const file = f.get("file");
      const text = (k: string): string => String(f.get(k) ?? "").trim();
      if (!(file instanceof File) || file.size === 0) { setError("Choose a file to import."); return; }
      setBusy(true); setError(null); setNotices([]);
      void file.arrayBuffer().then((buf) => project.importAsset({
        fileName: file.name, declaredMime: file.type, bytes: new Uint8Array(buf), category: text("category") as Asset["category"],
        provenance: {
          origin, author: text("author"), license: text("license"), source: text("source"), notes: text("notes"),
          tool: origin === "ai-generated" ? text("tool") : "", model: origin === "ai-generated" ? text("model") : "", promptSha256: "", acquiredOn: text("acquiredOn"),
        },
      })).then((r) => {
        if (r.ok) { setNotices(r.notices); form.reset(); setOrigin("user-owned"); } else setError(r.reason);
      }).catch(() => setError("The file could not be read.")).finally(() => setBusy(false));
    }}>
      <h3>Import</h3>
      <p className="muted">Images (PNG, JPEG, WebP, GIF) and audio (WAV, OGG, MP3), up to 5 MiB each. The type is decided by the file content, not its name.</p>
      <div className="actions small">
        <label>File <input type="file" name="file" data-testid="asset-file" accept=".png,.jpg,.jpeg,.webp,.gif,.wav,.ogg,.mp3" /></label>
        <label>Category{" "}
          <select name="category" data-testid="asset-category" defaultValue="sprite">{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
      </div>
      <fieldset>
        <legend>Provenance</legend>
        <p className="muted">These are your declarations. Studio checks only the shape of the license value; it does not check the SPDX list, whether the license is valid, or that you own the asset.</p>
        <div className="actions small">
          <label>Origin{" "}
            <select name="origin" data-testid="asset-origin" value={origin} onChange={(e) => setOrigin(e.target.value as Provenance["origin"])}>{ORIGINS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
          </label>
          <label>Author <input name="author" type="text" maxLength={500} data-testid="asset-author" autoComplete="off" /></label>
          <label>License (required) <input name="license" type="text" required maxLength={100} data-testid="asset-license" autoComplete="off" placeholder="proprietary-owned or CC0-1.0" /></label>
          <label>Source <input name="source" type="text" maxLength={500} data-testid="asset-source" autoComplete="off" /></label>
          <label>Acquired on <input name="acquiredOn" type="text" maxLength={10} placeholder="YYYY-MM-DD" data-testid="asset-acquired" autoComplete="off" /></label>
          {origin === "ai-generated" && <>
            <label>Tool <input name="tool" type="text" maxLength={500} data-testid="asset-tool" autoComplete="off" /></label>
            <label>Model <input name="model" type="text" maxLength={500} data-testid="asset-model" autoComplete="off" /></label>
          </>}
          <label>Notes <input name="notes" type="text" maxLength={500} data-testid="asset-notes" autoComplete="off" /></label>
        </div>
      </fieldset>
      <button type="submit" data-testid="asset-import-submit" disabled={busy}>{busy ? "Importing…" : "Import asset"}</button>
      {error !== null && <p role="alert" className="error" data-testid="asset-import-error">{error}</p>}
      {notices.map((n) => <p key={n} role="status" className="muted" data-testid="asset-import-notice">{n}</p>)}
    </form>
  );
}
/** Asset Studio: library, in-place preview, import with provenance, and delete with a reference check. */
export function AssetLibrary() {
  const project = useProject();
  const kindIds = useKindIds();
  const [filter, setFilter] = useState<LibraryFilter>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const assets = project.manifests?.assets.assets ?? [];
  const open = assets.find((a) => a.id === previewId);
  return (
    <div className="asset-studio">
      <p className="banner" data-testid="asset-status-note">Prototype. Assets are stored, previewed and exported by Studio. The generated native apps do not render or play them yet.</p>
      <AssetList
        assets={assets} filter={filter} kindIds={kindIds} previewId={open ? open.id : null}
        preview={open ? <AssetPreview asset={open} /> : null}
        onFilter={setFilter} onPreview={setPreviewId}
        onDelete={(id) => {
          const r = project.deleteAsset(id);
          setMessage(r.ok ? `Deleted ${id}. Its id is not reused.` : r.reason);
          if (r.ok && previewId === id) setPreviewId(null);
        }}
      />
      {message !== null && <p role="status" data-testid="asset-message">{message}</p>}
      <ImportForm />
    </div>
  );
}
