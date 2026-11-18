import { useEffect, useState } from "react";
import { useProject } from "../project/context";
import type { Sheet } from "../project/manifests";
import { useKindIds } from "../ui/fields";
import { AnimationEditor } from "./AnimationEditor";
import type { AnimationsManifest, Result } from "./edit";
import { SheetEditor } from "./SheetEditor";
/** The sheet image with one outline per frame (CSS only, pixelated). Bytes come from the asset store; the URL is revoked on close. */
function SheetPreview({ sheet, width, height }: { sheet: Sheet; width: number; height: number }) {
  const { assetBytes } = useProject();
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const { assetId } = sheet;
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null); setMissing(false);
    void assetBytes(assetId).then((bytes) => {
      if (!live) return;
      if (bytes === null) { setMissing(true); return; }
      made = URL.createObjectURL(new Blob([bytes.slice()]));
      setUrl(made);
    });
    return () => { live = false; if (made !== null) URL.revokeObjectURL(made); };
  }, [assetId, assetBytes]);
  if (missing) return <p className="muted" role="alert">The stored bytes for {assetId} are not available, so the sheet cannot be drawn.</p>;
  if (url === null) return <p className="muted">Loading image...</p>;
  return (
    <div data-testid="sheet-preview" style={{ position: "relative", width, height, maxWidth: "100%", overflow: "auto", border: "1px solid var(--border, #888)" }}>
      <img src={url} alt={`Sprite sheet ${sheet.id}`} width={width} height={height} style={{ imageRendering: "pixelated", display: "block" }} />
      {sheet.frames.map((f) => (
        <span key={f.id} title={f.id} data-testid={`frame-outline-${f.id}`} style={{ position: "absolute", left: f.x, top: f.y, width: f.w, height: f.h, outline: "1px solid #f0f", boxSizing: "border-box", pointerEvents: "none" }} />
      ))}
    </div>
  );
}
/** Sprite and Animation Editor: sheets and frames, then animations. Edits go to the animations manifest through the project. */
export function SpriteStudio() {
  const project = useProject();
  const kindIds = useKindIds();
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [animId, setAnimId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const manifests = project.manifests;
  if (!manifests) return <p className="muted">Open a project to edit sprites.</p>;
  const animations = manifests.animations;
  const images = manifests.assets.assets.filter((a) => a.kind === "image");
  const apply = (r: Result<AnimationsManifest>, field: string) => {
    if (!r.ok) { setMessage(r.error); return; }
    const c = project.commitManifest("animations", r.value, field);
    setMessage(c.ok ? null : c.message);
  };
  const sheet = animations.sheets.find((s) => s.id === sheetId);
  const image = sheet ? images.find((a) => a.id === sheet.assetId) : undefined;
  return (
    <div className="sprite-studio">
      {message !== null && <p role="alert" className="error" data-testid="sprite-error">{message}</p>}
      <SheetEditor animations={animations} images={images} selectedId={sheetId} onSelect={(id) => { setSheetId(id); setMessage(null); }} apply={apply}
        preview={sheet && image ? <SheetPreview sheet={sheet} width={image.width} height={image.height} /> : null} />
      <AnimationEditor animations={animations} kindIds={kindIds} selectedId={animId} onSelect={(id) => { setAnimId(id); setMessage(null); }} apply={apply} />
    </div>
  );
}
