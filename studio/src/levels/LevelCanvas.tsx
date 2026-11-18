import { useEffect, useRef } from "react";
import type { CompiledEntity, CompiledSpawner } from "../derive/levels";
import { Layout } from "../preview/presentation";
import { displayOfDoc, drawLevelWorld, type Display } from "../preview/worldDraw";
import type { Json } from "../schema/schema";

/** Display fields of the draft (palette, world size, kinds), or null when the draft has none yet. */
export function displayOfDraft(doc: Json | null): Display | null {
  try { return doc === null ? null : displayOfDoc(doc as unknown as Parameters<typeof displayOfDoc>[0]); } catch { return null; }
}
/** World preview of ONE level (placements, spawn ranges, spawn direction) with the live preview's drawing rules. No simulation. */
export function LevelCanvas({ display, entities, spawners }: { display: Display; entities: readonly CompiledEntity[]; spawners: readonly CompiledSpawner[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const portrait = display.orientation === "portrait";
  const W = portrait ? 270 : 480, H = portrait ? 480 : 270;
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    drawLevelWorld(ctx, new Layout(W, H, display.worldW, display.worldH), display, entities, spawners);
  }, [display, entities, spawners, W, H]);
  return (
    <canvas ref={ref} width={W} height={H} className="level-canvas" data-testid="level-canvas" role="img"
      data-entities={entities.length} data-spawners={spawners.length}
      aria-label={`World preview: ${entities.length} initial placements and ${spawners.length} spawners. Display only; nothing is simulated.`} />
  );
}
