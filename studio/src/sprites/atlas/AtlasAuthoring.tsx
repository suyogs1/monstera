import { useEffect, useMemo, useRef, useState } from "react";
import { useSession, useDraft } from "../../app/hooks";
import { getAt } from "../../draft/path";
import { useProject } from "../../project/context";
import { drawEntityBox, type AtlasMeta, type Kind } from "../../preview/worldDraw";
import { NEUTRAL_ATLAS } from "../../project/specV5";
import type { Json } from "../../schema/schema";
import { IconArrowRight } from "../../ui/icons";
import { describeIssues, spritesOfDoc, type KindSprite, type SpriteChange } from "./apply";
import { parseFrames, parseTicksPerFrame, spriteFromAnimation } from "./assign";
import { atlasLimits, buildAtlas, normalizeFrameRgba, suggestNormalization, type AtlasBuild, type AtlasFitMode, type AtlasNormalization, type AtlasScalingMode } from "./build";
import { decodeImage } from "./decode";
import type { RgbaImage } from "./png";
import { IntField } from "../IntField";

type Row = { framesText: string; ticksPerFrame: number };
const framesText = (s: KindSprite | null) => (s ? s.frames.join(", ") : "");
const PREVIEW_PX = 64;
const rowsOf = (kinds: { id: string; sprite: KindSprite | null }[]): Record<string, Row> =>
  Object.fromEntries(kinds.map((k) => [k.id, { framesText: framesText(k.sprite), ticksPerFrame: k.sprite?.ticksPerFrame ?? 1 }]));

/** One kind's sprite drawn with the live preview's own drawing function at a simulation tick. */
function KindPreview({ kind, sprite, atlas, tick }: { kind: Kind; sprite: KindSprite; atlas: AtlasMeta; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    const c = ref.current,
      ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    drawEntityBox(ctx, { ...kind, sprite }, { x: 0, y: 0, w: c.width, h: c.height }, tick, atlas);
    // The atlas image decodes asynchronously the first time; draw again shortly so the frame appears.
    const t = setTimeout(() => bump((n) => n + 1), 60);
    return () => clearTimeout(t);
  }, [kind, sprite, atlas, tick]);
  return (
    <canvas
      ref={ref}
      width={PREVIEW_PX}
      height={PREVIEW_PX}
      data-testid={`sprite-preview-${kind.id}`}
      style={{ imageRendering: "pixelated", width: PREVIEW_PX, height: PREVIEW_PX, border: "1px solid var(--border, #888)" }}
    />
  );
}

/** Draws a single frame cell from the compiled base64 atlas PNG. */
function AtlasFrameThumb({ atlas, frameIndex, size = 32 }: { atlas: AtlasMeta; frameIndex: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !atlas.png) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = false;
      const col = frameIndex % atlas.columns;
      const row = Math.floor(frameIndex / atlas.columns);
      const sx = col * atlas.frameWidth;
      const sy = row * atlas.frameHeight;
      const scale = Math.min(size / atlas.frameWidth, size / atlas.frameHeight);
      const dw = Math.max(1, Math.round(atlas.frameWidth * scale));
      const dh = Math.max(1, Math.round(atlas.frameHeight * scale));
      const dx = Math.floor((size - dw) / 2);
      const dy = Math.floor((size - dh) / 2);
      ctx.drawImage(img, sx, sy, atlas.frameWidth, atlas.frameHeight, dx, dy, dw, dh);
    };
    img.src = `data:image/png;base64,${atlas.png}`;
    return () => {
      cancelled = true;
    };
  }, [atlas.png, atlas.columns, atlas.frameWidth, atlas.frameHeight, frameIndex, size]);

  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size, imageRendering: "pixelated", display: "block" }} />;
}

/** Live preview of a single normalized frame buffer before building the full atlas. */
function NormalizedPreviewCanvas({ rgba, width, height, scaling }: { rgba: Uint8Array; width: number; height: number; scaling: AtlasScalingMode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const imgData = new ImageData(new Uint8ClampedArray(rgba), width, height);
    ctx.putImageData(imgData, 0, 0);
  }, [rgba, width, height]);
  const scale = Math.min(72 / Math.max(1, width), 72 / Math.max(1, height));
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      data-testid="normalized-frame-preview"
      style={{
        width: Math.max(24, Math.round(width * scale)),
        height: Math.max(24, Math.round(height * scale)),
        imageRendering: scaling === "nearest" ? "pixelated" : "auto",
        border: "1px solid var(--border, #888)",
        background: "#0b0c10",
      }}
    />
  );
}

/**
 * Native sprite authoring (spec v5): pick a sheet of the animations manifest, build the project's one atlas from it, give each
 * kind its frames and timing (picked visually, typed, or taken from an animation), preview them, then apply. Apply goes to the
 * engine (Session.applySprites): nothing is written unless the engine accepts the result and the simulation hash is unchanged.
 */
export function AtlasAuthoring() {
  const session = useSession();
  const project = useProject();
  const { doc } = useDraft();
  const manifests = project.manifests;
  const limits = useMemo(() => (session.schema ? atlasLimits(session.schema) : null), [session.schema]);
  const current = useMemo(() => (doc ? spritesOfDoc(doc as Json) : { atlas: null, kinds: [] }), [doc]);
  const currentKey = JSON.stringify(current.kinds);
  const [sheetId, setSheetId] = useState("");
  const [norm, setNorm] = useState<AtlasNormalization>({ cellWidth: 32, cellHeight: 32, fit: "contain", scaling: "nearest" });
  const [decodedSheetImage, setDecodedSheetImage] = useState<{ assetId: string; image: RgbaImage } | null>(null);
  const [previewFrameIdx, setPreviewFrameIdx] = useState(0);
  const [pending, setPending] = useState<(Extract<AtlasBuild, { ok: true }> & { sheetId: string }) | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>(() => rowsOf(current.kinds));
  const [activeKindId, setActiveKindId] = useState<string>(() => current.kinds[0]?.id ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setRows(rowsOf(current.kinds));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset the form only when the spec's sprites change (apply, undo, import)
  }, [currentKey]);

  const tickRate = (doc ? getAt(doc as Json, ["game", "simulation", "tickRate"]) : undefined) as number | undefined;
  useEffect(() => {
    if (!playing || typeof tickRate !== "number") return;
    const id = setInterval(() => setTick((t) => t + 1), Math.max(1, Math.round(1000 / tickRate)));
    return () => clearInterval(id);
  }, [playing, tickRate]);

  if (!manifests || !doc) return <p className="muted">Open a project to author native sprites.</p>;
  if (!limits) {
    return (
      <p className="muted" role="alert">
        The engine schema does not state the atlas limits, so native sprites cannot be authored.
      </p>
    );
  }

  const images = manifests.assets.assets.filter((a) => a.kind === "image");
  const sheets = manifests.animations.sheets;
  const sheet = sheets.find((s) => s.id === sheetId);
  const asset = sheet ? manifests.assets.assets.find((a) => a.id === sheet.assetId) : undefined;
  const applied = current.atlas && current.atlas.png !== "" ? current.atlas : null;
  const atlas: AtlasMeta | null = pending ? { ...pending.atlas } : applied;
  const frameCount = atlas ? atlas.columns * atlas.rows : 0;

  useEffect(() => {
    if (!sheet || !limits) return;
    setNorm((prev) => ({ ...suggestNormalization(sheet.frames, limits), fit: prev.fit, scaling: prev.scaling }));
    setPreviewFrameIdx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset suggested cell size when switching sheet
  }, [sheetId]);

  useEffect(() => {
    if (!asset) {
      setDecodedSheetImage(null);
      return;
    }
    let live = true;
    void project.assetBytes(asset.id).then(async (bytes) => {
      if (!live || !bytes) return;
      try {
        const image = await decodeImage(bytes);
        if (live) setDecodedSheetImage({ assetId: asset.id, image });
      } catch {
        if (live) setDecodedSheetImage(null);
      }
    });
    return () => {
      live = false;
    };
  }, [asset, project.assetBytes]);

  // Map each atlas frame index to the entity kinds currently referencing it in the draft form.
  const frameOwners = new Map<number, string[]>();
  let assignedKindCount = 0;
  let animatedKindCount = 0;
  for (const k of current.kinds) {
    const r = rows[k.id];
    if (!r) continue;
    const parsed = parseFrames(r.framesText, frameCount, limits);
    if (parsed.ok && parsed.value.length > 0) {
      assignedKindCount++;
      if (parsed.value.length >= 2) animatedKindCount++;
      for (const idx of parsed.value) {
        const owners = frameOwners.get(idx) ?? [];
        if (!owners.includes(k.id)) owners.push(k.id);
        frameOwners.set(idx, owners);
      }
    }
  }

  const targetKind = current.kinds.some((k) => k.id === activeKindId) ? activeKindId : (current.kinds[0]?.id ?? "");

  const build = async () => {
    if (!sheet || !asset) return;
    setBusy(true);
    setErrors([]);
    setInfo(null);
    try {
      const bytes = await project.assetBytes(asset.id);
      if (bytes === null) {
        setErrors([`The stored bytes for ${asset.id} are not available.`]);
        return;
      }
      const image = await decodeImage(bytes);
      const r = await buildAtlas(image, sheet, limits, { normalization: norm });
      if (!r.ok) {
        setPending(null);
        setErrors([r.error]);
        return;
      }
      setPending({ ...r, sheetId: sheet.id });
      const normNote = r.normalized ? " (normalized from source crops)" : "";
      setInfo(
        `Atlas built from sheet ${sheet.id}: ${r.atlas.columns} x ${r.atlas.rows} frames of ${r.atlas.frameWidth}x${r.atlas.frameHeight}${normNote}, ${r.pngBytes} bytes. Not applied yet.`
      );
    } catch (e) {
      setErrors([`The image could not be read: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setBusy(false);
    }
  };

  const collect = (): { sprites: Record<string, KindSprite> } | { errors: string[] } => {
    const sprites: Record<string, KindSprite> = {};
    const errs: string[] = [];
    for (const k of current.kinds) {
      const row = rows[k.id];
      if (!row) continue;
      const f = parseFrames(row.framesText, frameCount, limits);
      const t = parseTicksPerFrame(row.ticksPerFrame, limits);
      if (!f.ok) errs.push(`${k.id}: ${f.error}`);
      else if (!t.ok) errs.push(`${k.id}: ${t.error}`);
      else sprites[k.id] = { frames: f.value, ticksPerFrame: t.value };
    }
    return errs.length > 0 ? { errors: errs } : { sprites };
  };

  const apply = async (change: SpriteChange) => {
    setBusy(true);
    setErrors([]);
    setInfo(null);
    try {
      const r = await session.applySprites(change);
      if (!r.ok) {
        setErrors(r.issues.length > 0 ? describeIssues(r.issues) : [r.message]);
        return;
      }
      setPending(null);
      setInfo(
        `Applied. The engine accepted the specification and the simulation hash is unchanged (${r.oracle.ticks} ticks). Undo reverts it.`
      );
    } finally {
      setBusy(false);
    }
  };

  const applyAll = () => {
    const c = collect();
    if ("errors" in c) {
      setErrors(c.errors);
      return;
    }
    void apply({ ...(pending ? { atlas: pending.atlas } : {}), sprites: c.sprites });
  };

  const removeAtlas = () =>
    void apply({
      atlas: { ...NEUTRAL_ATLAS },
      sprites: Object.fromEntries(current.kinds.map((k) => [k.id, { frames: [], ticksPerFrame: 1 }])),
    });

  const fromAnimation = (kindId: string, animId: string) => {
    const anim = manifests.animations.animations.find((a) => a.id === animId);
    const s = anim ? sheets.find((x) => x.id === anim.sheetId) : undefined;
    if (!anim || !s) return;
    if (!pending && !applied) {
      setErrors(["Build the atlas from the animation's sheet first."]);
      return;
    }
    if (pending && pending.sheetId !== s.id) {
      setErrors([`The pending atlas was built from sheet ${pending.sheetId}; animation ${anim.id} is on sheet ${s.id}. One atlas holds one sheet.`]);
      return;
    }
    const r = spriteFromAnimation(anim, s, tickRate ?? 0, limits);
    if (!r.ok) {
      setErrors([r.error]);
      return;
    }
    setErrors([]);
    setRows((all) => ({ ...all, [kindId]: { framesText: framesText(r.value), ticksPerFrame: r.value.ticksPerFrame } }));
  };

  const appendFrameToKind = (kindId: string, frameIndex: number) => {
    const row = rows[kindId] ?? { framesText: "", ticksPerFrame: 1 };
    const parsed = parseFrames(row.framesText, frameCount, limits);
    const list = parsed.ok ? [...parsed.value] : [];
    if (list.length >= limits.maxSpriteFrames) {
      setErrors([`${kindId}: a kind may use at most ${limits.maxSpriteFrames} frames`]);
      return;
    }
    list.push(frameIndex);
    setErrors([]);
    setRows((all) => ({ ...all, [kindId]: { ...row, framesText: list.join(", ") } }));
  };

  const removeFrameAt = (kindId: string, pos: number) => {
    const row = rows[kindId] ?? { framesText: "", ticksPerFrame: 1 };
    const parsed = parseFrames(row.framesText, frameCount, limits);
    if (!parsed.ok) return;
    const next = parsed.value.filter((_, idx) => idx !== pos);
    setRows((all) => ({ ...all, [kindId]: { ...row, framesText: next.join(", ") } }));
  };

  const clearKindAssignment = (kindId: string) => {
    setRows((all) => ({ ...all, [kindId]: { ...(all[kindId] ?? { ticksPerFrame: 1 }), framesText: "" } }));
  };

  const kindView = (id: string): Kind => {
    const k = (getAt(doc as Json, ["game", "runtime", "kinds"]) as Json[]).find((x) => (x as { id: string }).id === id) as unknown as Kind;
    return k;
  };

  const hasSlices = sheets.some((s) => s.frames.length > 0);
  const stepAssigned = assignedKindCount > 0;
  const stepApplied = applied !== null && current.kinds.some((k) => (k.sprite?.frames.length ?? 0) > 0);

  return (
    <section data-testid="atlas-authoring" aria-labelledby="atlas-h">
      <h3 id="atlas-h">Native sprites (spec v5)</h3>
      <p className="muted small">
        One atlas per project, built from a sheet. Frame numbers are the frame&apos;s position in the sheet. Applying writes game.atlas and the kinds&apos; sprites into the specification through the engine; sprites never change the simulation.
      </p>

      <div className="sprite-pipeline-strip" data-testid="sprite-pipeline" aria-label="Native sprite pipeline">
        <a href="#/assets" className={`pipeline-pill ${images.length > 0 ? "is-done" : ""}`}>1. Import image</a>
        <IconArrowRight size={13} className="workflow-arrow" />
        <span className={`pipeline-pill ${hasSlices ? "is-done" : ""}`}>2. Slice frames</span>
        <IconArrowRight size={13} className="workflow-arrow" />
        <span className={`pipeline-pill ${stepAssigned ? "is-done" : ""}`}>3. Assign to entity kind</span>
        <IconArrowRight size={13} className="workflow-arrow" />
        <span className={`pipeline-pill ${stepApplied ? "is-done" : ""}`}>4. Apply to canonical spec</span>
        <IconArrowRight size={13} className="workflow-arrow" />
        <a href="#/preview/determinism" className="pipeline-pill">5. Preview</a>
        <IconArrowRight size={13} className="workflow-arrow" />
        <a href="#/release/export" className="pipeline-pill">6. Generate Android/iOS</a>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="error" data-testid="atlas-errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {info !== null && (
        <p role="status" data-testid="atlas-info">
          {info}
        </p>
      )}

      <div className="actions">
        <label>
          Sheet{" "}
          <select
            data-testid="atlas-sheet"
            value={sheetId}
            onChange={(e) => {
              setSheetId(e.target.value);
              setErrors([]);
            }}
          >
            <option value="">choose a sheet</option>
            {sheets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} ({s.frames.length} frames)
              </option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="atlas-build" disabled={busy || !sheet} onClick={() => void build()}>
          Build atlas from sheet
        </button>
        <button type="button" data-testid="atlas-remove" disabled={busy || !applied} onClick={removeAtlas}>
          Remove atlas
        </button>
      </div>

      {sheet && sheet.frames.length > 0 && (() => {
        const safeIdx = Math.min(previewFrameIdx, sheet.frames.length - 1);
        const previewFrame = sheet.frames[safeIdx]!;
        const canPreviewNorm = decodedSheetImage !== null && decodedSheetImage.assetId === sheet.assetId;
        const normRgba = canPreviewNorm ? normalizeFrameRgba(decodedSheetImage.image, previewFrame, norm) : null;
        const needsNorm = sheet.frames.some((fr) => fr.w !== norm.cellWidth || fr.h !== norm.cellHeight);
        return (
          <fieldset className="atlas-norm-panel" data-testid="atlas-normalization">
            <legend>Output Normalization (Spec v5: max {limits.maxFrameWidth}×{limits.maxFrameHeight} uniform cells)</legend>
            <div className="actions small">
              <label>
                Cell width{" "}
                <IntField
                  label="Atlas cell width"
                  value={norm.cellWidth}
                  testId="norm-cell-width"
                  onApply={(n) => setNorm((prev) => ({ ...prev, cellWidth: Math.max(1, Math.min(limits.maxFrameWidth, n)) }))}
                />
              </label>
              <label>
                Cell height{" "}
                <IntField
                  label="Atlas cell height"
                  value={norm.cellHeight}
                  testId="norm-cell-height"
                  onApply={(n) => setNorm((prev) => ({ ...prev, cellHeight: Math.max(1, Math.min(limits.maxFrameHeight, n)) }))}
                />
              </label>
              <button
                type="button"
                className="btn-card-subtle"
                data-testid="norm-auto"
                onClick={() => setNorm((prev) => ({ ...suggestNormalization(sheet.frames, limits), fit: prev.fit, scaling: prev.scaling }))}
              >
                Auto size
              </button>
              <label>
                Fit{" "}
                <select
                  data-testid="norm-fit"
                  value={norm.fit}
                  onChange={(e) => setNorm((prev) => ({ ...prev, fit: e.target.value as AtlasFitMode }))}
                >
                  <option value="contain">Contain (transparent pad)</option>
                  <option value="cover">Cover (crop overflow)</option>
                  <option value="stretch">Stretch</option>
                </select>
              </label>
              <label>
                Scaling{" "}
                <select
                  data-testid="norm-scaling"
                  value={norm.scaling}
                  onChange={(e) => setNorm((prev) => ({ ...prev, scaling: e.target.value as AtlasScalingMode }))}
                >
                  <option value="nearest">Nearest-neighbour (pixel art)</option>
                  <option value="bilinear">Bilinear (raster art)</option>
                </select>
              </label>
            </div>
            <div className="norm-preview-row">
              <label className="small">
                Preview frame{" "}
                <select
                  data-testid="norm-preview-frame"
                  value={safeIdx}
                  onChange={(e) => setPreviewFrameIdx(Number(e.target.value))}
                >
                  {sheet.frames.map((fr, idx) => (
                    <option key={fr.id} value={idx}>
                      #{idx} {fr.id} ({fr.w}×{fr.h})
                    </option>
                  ))}
                </select>
              </label>
              <span className="small muted" data-testid="norm-dimension-diff">
                Original crop: <strong>{previewFrame.w}×{previewFrame.h}px</strong> → Atlas cell:{" "}
                <strong>{norm.cellWidth}×{norm.cellHeight}px</strong>
                {needsNorm ? ` (${norm.fit}, ${norm.scaling})` : " (1:1 exact copy)"}
              </span>
              {normRgba && (
                <NormalizedPreviewCanvas rgba={normRgba} width={norm.cellWidth} height={norm.cellHeight} scaling={norm.scaling} />
              )}
            </div>
          </fieldset>
        );
      })()}

      {asset && (
        <p className="muted small" data-testid="atlas-provenance">
          Source image {asset.id} ({asset.width}x{asset.height}, {asset.bytes} bytes). Origin {asset.provenance.origin}; license{" "}
          {asset.provenance.license || "none recorded"}; source {asset.provenance.source || "none recorded"}; author{" "}
          {asset.provenance.author || "none recorded"}.
        </p>
      )}

      <p className="muted small" data-testid="atlas-state">
        {pending
          ? `Pending atlas: ${pending.atlas.columns} x ${pending.atlas.rows} frames (not in the specification until applied).`
          : applied
            ? `Applied atlas: ${applied.columns} x ${applied.rows} frames of ${applied.frameWidth}x${applied.frameHeight}.`
            : "No atlas in the specification."}
      </p>

      {atlas && frameCount > 0 && (
        <div className="atlas-frame-pool" data-testid="atlas-frame-pool">
          <div className="atlas-pool-header">
            <span className="small">
              <strong>Atlas frames ({frameCount})</strong> — click a frame to assign it to{" "}
              <select
                aria-label="Target entity kind for frame clicks"
                data-testid="atlas-target-kind"
                value={targetKind}
                onChange={(e) => setActiveKindId(e.target.value)}
              >
                {current.kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.id}
                  </option>
                ))}
              </select>
            </span>
            <span className="small muted">
              Assigned: {frameOwners.size} · Unassigned: {frameCount - frameOwners.size} · Animated kinds: {animatedKindCount}/2 max
            </span>
          </div>
          <div className="frame-thumb-strip">
            {Array.from({ length: frameCount }, (_, idx) => {
              const owners = frameOwners.get(idx) ?? [];
              const assigned = owners.length > 0;
              return (
                <button
                  key={idx}
                  type="button"
                  data-testid={`atlas-pool-frame-${idx}`}
                  data-assigned={assigned ? "true" : "false"}
                  className={`atlas-pool-item ${assigned ? "is-assigned" : "is-unassigned"}`}
                  onClick={() => targetKind && appendFrameToKind(targetKind, idx)}
                  title={
                    assigned
                      ? `Frame ${idx} (assigned to ${owners.join(", ")}) — click to add to ${targetKind}`
                      : `Frame ${idx} (unassigned) — click to add to ${targetKind}`
                  }
                >
                  <AtlasFrameThumb atlas={atlas} frameIndex={idx} size={34} />
                  <span className="atlas-pool-idx">#{idx}</span>
                  <span className={`atlas-pool-tag ${assigned ? "is-assigned" : "is-unassigned"}`}>
                    {assigned ? owners.join(",") : "free"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <table data-testid="atlas-kinds">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Frames (up to {limits.maxSpriteFrames})</th>
            <th>Ticks per frame</th>
            <th>From animation</th>
            <th>Preview</th>
          </tr>
        </thead>
        <tbody>
          {current.kinds.map((k) => {
            const row = rows[k.id] ?? { framesText: "", ticksPerFrame: 1 };
            const f = parseFrames(row.framesText, frameCount, limits);
            const anims = manifests.animations.animations.filter((a) => a.kindRef === k.id);
            const isTarget = targetKind === k.id;
            return (
              <tr key={k.id} data-testid={`atlas-kind-${k.id}`} data-selected={isTarget ? "true" : undefined}>
                <td>
                  <button
                    type="button"
                    className={`btn-card-subtle ${isTarget ? "is-active-kind" : ""}`}
                    onClick={() => setActiveKindId(k.id)}
                    title={`Select ${k.id} as target for frame clicks`}
                  >
                    {k.id}
                  </button>
                </td>
                <td>
                  <div className="kind-frames-cell">
                    <input
                      type="text"
                      className="mono"
                      aria-label={`${k.id} frames`}
                      data-testid={`atlas-frames-${k.id}`}
                      value={row.framesText}
                      aria-invalid={!f.ok}
                      onChange={(e) => setRows((all) => ({ ...all, [k.id]: { ...row, framesText: e.target.value } }))}
                    />
                    {f.ok && f.value.length > 0 && (
                      <div className="assigned-chip-row">
                        {f.value.map((idx, pos) => (
                          <span key={`${idx}-${pos}`} className="assigned-frame-chip">
                            #{idx}
                            <button
                              type="button"
                              aria-label={`Remove frame ${idx} from ${k.id}`}
                              onClick={() => removeFrameAt(k.id, pos)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          className="btn-card-subtle"
                          data-testid={`atlas-clear-${k.id}`}
                          onClick={() => clearKindAssignment(k.id)}
                        >
                          Clear
                        </button>
                      </div>
                    )}
                    {!f.ok && (
                      <small className="issue-inline" role="alert">
                        {f.error}
                      </small>
                    )}
                  </div>
                </td>
                <td>
                  <IntField
                    label={`${k.id} ticks per frame`}
                    value={row.ticksPerFrame}
                    testId={`atlas-tpf-${k.id}`}
                    onApply={(n) => setRows((all) => ({ ...all, [k.id]: { ...row, ticksPerFrame: n } }))}
                  />
                </td>
                <td>
                  <select
                    aria-label={`${k.id} animation`}
                    data-testid={`atlas-anim-${k.id}`}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) fromAnimation(k.id, e.target.value);
                    }}
                  >
                    <option value="">{anims.length === 0 ? "no animation for this kind" : "use animation..."}</option>
                    {anims.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.id}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {atlas && f.ok && f.value.length > 0 ? (
                    <KindPreview
                      kind={kindView(k.id)}
                      sprite={{ frames: f.value, ticksPerFrame: Math.max(1, row.ticksPerFrame) }}
                      atlas={atlas}
                      tick={tick}
                    />
                  ) : (
                    <span className="muted small">glyph or colour</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="actions" role="group" aria-label="Sprite preview clock">
        <button type="button" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setTick((t) => t + 1);
          }}
        >
          Step
        </button>
        <button type="button" onClick={() => setTick(0)}>
          Restart
        </button>
        <span className="muted small" data-testid="atlas-tick">
          simulation tick {tick}
        </span>
      </div>
      <div className="actions">
        <button type="button" data-testid="atlas-apply" disabled={busy || (!pending && !applied)} onClick={applyAll}>
          Apply to specification
        </button>
      </div>
    </section>
  );
}
