import { useEffect, useState } from "react";
import { useProject } from "../project/context";
import { linkedImage } from "./assign";
/** Thumbnail of the first image asset linked to a kind. Shows the asset only; Studio does not substitute it into the game preview. */
export function KindAssetThumb({ kindId }: { kindId: string }) {
  const project = useProject();
  const asset = linkedImage(project.manifests?.assets, kindId);
  const { assetBytes } = project;
  const [url, setUrl] = useState<string | null>(null);
  const id = asset?.id ?? null;
  const mime = asset?.mime ?? "";
  useEffect(() => {
    if (id === null) { setUrl(null); return; }
    let live = true;
    let made: string | null = null;
    void assetBytes(id).then((bytes) => {
      if (!live || bytes === null) return;
      made = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
      setUrl(made);
    });
    return () => { live = false; setUrl(null); if (made !== null) URL.revokeObjectURL(made); };
  }, [id, mime, assetBytes]);
  if (asset === null) return null;
  return url === null
    ? <span className="muted small" data-testid={`kind-asset-${kindId}`}>asset {asset.id}</span>
    : <img src={url} alt={`Linked asset ${asset.file}`} title={`${asset.file} (${asset.id})`} data-testid={`kind-asset-${kindId}`} style={{ imageRendering: "pixelated", maxWidth: 48, maxHeight: 48 }} />;
}
