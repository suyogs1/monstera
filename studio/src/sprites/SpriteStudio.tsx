import { useState } from "react";
import { useProject } from "../project/context";
import { useKindIds } from "../ui/fields";
import { AnimationEditor } from "./AnimationEditor";
import type { AnimationsManifest, Result } from "./edit";
import { AtlasAuthoring } from "./atlas/AtlasAuthoring";
import { SheetEditor } from "./SheetEditor";

/** Sprite and Animation Editor: sheets and frames, then animations, then native Spec v5 atlas & kind assignment. */
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
    if (!r.ok) {
      setMessage(r.error);
      return;
    }
    const c = project.commitManifest("animations", r.value, field);
    setMessage(c.ok ? null : c.message);
  };

  return (
    <div className="sprite-studio">
      {message !== null && (
        <p role="alert" className="error" data-testid="sprite-error">
          {message}
        </p>
      )}
      <SheetEditor
        animations={animations}
        images={images}
        selectedId={sheetId}
        onSelect={(id) => {
          setSheetId(id);
          setMessage(null);
        }}
        apply={apply}
        interactive
        assetBytes={project.assetBytes}
      />
      <AnimationEditor
        animations={animations}
        kindIds={kindIds}
        selectedId={animId}
        onSelect={(id) => {
          setAnimId(id);
          setMessage(null);
        }}
        apply={apply}
      />
      <AtlasAuthoring />
    </div>
  );
}
