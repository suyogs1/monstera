import { useEffect, useMemo, useRef, useState } from "react";
import { useSession, useDraft } from "../../app/hooks";
import { getAt } from "../../draft/path";
import { useProject } from "../../project/context";
import { drawEntityBox, type AtlasMeta, type Kind } from "../../preview/worldDraw";
import { NEUTRAL_ATLAS } from "../../project/specV5";
import type { Json } from "../../schema/schema";
import { describeIssues, spritesOfDoc, type KindSprite, type SpriteChange } from "./apply";
import { parseFrames, parseTicksPerFrame, spriteFromAnimation } from "./assign";
import { atlasLimits, buildAtlas, type AtlasBuild } from "./build";
import { decodeImage } from "./decode";
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
    const c = ref.current, ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    drawEntityBox(ctx, { ...kind, sprite }, { x: 0, y: 0, w: c.width, h: c.height }, tick, atlas);
    // The atlas image decodes asynchronously the first time; draw again shortly so the frame appears.
    const t = setTimeout(() => bump((n) => n + 1), 60);
    return () => clearTimeout(t);
  }, [kind, sprite, atlas, tick]);
  return <canvas ref={ref} width={PREVIEW_PX} height={PREVIEW_PX} data-testid={`sprite-preview-${kind.id}`} style={{ imageRendering: "pixelated", width: PREVIEW_PX, height: PREVIEW_PX, border: "1px solid var(--border, #888)" }} />;
}

/**
 * Native sprite authoring (spec v5): pick a sheet of the animations manifest, build the project's one atlas from it, give each
 * kind its frames and timing (typed, or taken from an animation), preview them, then apply. Apply goes to the engine
 * (Session.applySprites): nothing is written unless the engine accepts the result and the simulation hash is unchanged.
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
  const [pending, setPending] = useState<(Extract<AtlasBuild, { ok: true }> & { sheetId: string }) | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>(() => rowsOf(current.kinds));
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
  if (!limits) return <p className="muted" role="alert">The engine schema does not state the atlas limits, so native sprites cannot be authored.</p>;
  const sheets = manifests.animations.sheets;
  const sheet = sheets.find((s) => s.id === sheetId);
  const asset = sheet ? manifests.assets.assets.find((a) => a.id === sheet.assetId) : undefined;
  const applied = current.atlas && current.atlas.png !== "" ? current.atlas : null;
  const atlas: AtlasMeta | null = pending ? { ...pending.atlas } : applied;
  const frameCount = atlas ? atlas.columns * atlas.rows : 0;

  const build = async () => {
    if (!sheet || !asset) return;
    setBusy(true); setErrors([]); setInfo(null);
    try {
      const bytes = await project.assetBytes(asset.id);
      if (bytes === null) { setErrors([`The stored bytes for ${asset.id} are not available.`]); return; }
      const image = await decodeImage(bytes);
      const r = await buildAtlas(image, sheet, limits);
      if (!r.ok) { setPending(null); setErrors([r.error]); return; }
      setPending({ ...r, sheetId: sheet.id });
      setInfo(`Atlas built from sheet ${sheet.id}: ${r.atlas.columns} x ${r.atlas.rows} frames of ${r.atlas.frameWidth}x${r.atlas.frameHeight}, ${r.pngBytes} bytes. Not applied yet.`);
    } catch (e) { setErrors([`The image could not be read: ${e instanceof Error ? e.message : String(e)}`]); } finally { setBusy(false); }
  };

  const collect = (): { sprites: Record<string, KindSprite> } | { errors: string[] } => {
    const sprites: Record<string, KindSprite> = {};
    const errs: string[] = [];
    for (const k of current.kinds) {
      const row = rows[k.id];
      if (!row) continue;
      const f = parseFrames(row.framesText, frameCount, limits);
      const t = parseTicksPerFrame(row.ticksPerFrame, limits);
      if (!f.ok) errs.push(`${k.id}: ${f.error}`); else if (!t.ok) errs.push(`${k.id}: ${t.error}`);
      else sprites[k.id] = { frames: f.value, ticksPerFrame: t.value };
    }
    return errs.length > 0 ? { errors: errs } : { sprites };
  };

  const apply = async (change: SpriteChange) => {
    setBusy(true); setErrors([]); setInfo(null);
    try {
      const r = await session.applySprites(change);
      if (!r.ok) { setErrors(r.issues.length > 0 ? describeIssues(r.issues) : [r.message]); return; }
      setPending(null);
      setInfo(`Applied. The engine accepted the specification and the simulation hash is unchanged (${r.oracle.ticks} ticks). Undo reverts it.`);
    } finally { setBusy(false); }
  };
  const applyAll = () => {
    const c = collect();
    if ("errors" in c) { setErrors(c.errors); return; }
    void apply({ ...(pending ? { atlas: pending.atlas } : {}), sprites: c.sprites });
  };
  const removeAtlas = () => void apply({ atlas: { ...NEUTRAL_ATLAS }, sprites: Object.fromEntries(current.kinds.map((k) => [k.id, { frames: [], ticksPerFrame: 1 }])) });
  const fromAnimation = (kindId: string, animId: string) => {
    const anim = manifests.animations.animations.find((a) => a.id === animId);
    const s = anim ? sheets.find((x) => x.id === anim.sheetId) : undefined;
    if (!anim || !s) return;
    if (!pending && !applied) { setErrors(["Build the atlas from the animation's sheet first."]); return; }
    if (pending && pending.sheetId !== s.id) { setErrors([`The pending atlas was built from sheet ${pending.sheetId}; animation ${anim.id} is on sheet ${s.id}. One atlas holds one sheet.`]); return; }
    const r = spriteFromAnimation(anim, s, tickRate ?? 0, limits);
    if (!r.ok) { setErrors([r.error]); return; }
    setErrors([]);
    setRows((all) => ({ ...all, [kindId]: { framesText: framesText(r.value), ticksPerFrame: r.value.ticksPerFrame } }));
  };

  const kindView = (id: string): Kind => {
    const k = (getAt(doc as Json, ["game", "runtime", "kinds"]) as Json[]).find((x) => (x as { id: string }).id === id) as unknown as Kind;
    return k;
  };

  return (
    <section data-testid="atlas-authoring" aria-labelledby="atlas-h">
      <h3 id="atlas-h">Native sprites (spec v5)</h3>
      <p className="muted small">One atlas per project, built from a sheet. Frame numbers are the frame&apos;s position in the sheet. Applying writes game.atlas and the kinds&apos; sprites into the specification through the engine; sprites never change the simulation.</p>
      {errors.length > 0 && <ul role="alert" className="error" data-testid="atlas-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {info !== null && <p role="status" data-testid="atlas-info">{info}</p>}
      <div className="actions">
        <label>Sheet <select data-testid="atlas-sheet" value={sheetId} onChange={(e) => { setSheetId(e.target.value); setErrors([]); }}>
          <option value="">choose a sheet</option>
          {sheets.map((s) => <option key={s.id} value={s.id}>{s.id} ({s.frames.length} frames)</option>)}
        </select></label>
        <button type="button" data-testid="atlas-build" disabled={busy || !sheet} onClick={() => void build()}>Build atlas from sheet</button>
        <button type="button" data-testid="atlas-remove" disabled={busy || !applied} onClick={removeAtlas}>Remove atlas</button>
      </div>
      {asset && (
        <p className="muted small" data-testid="atlas-provenance">
          Source image {asset.id} ({asset.width}x{asset.height}, {asset.bytes} bytes). Origin {asset.provenance.origin}; license {asset.provenance.license || "none recorded"}; source {asset.provenance.source || "none recorded"}; author {asset.provenance.author || "none recorded"}.
        </p>
      )}
      <p className="muted small" data-testid="atlas-state">
        {pending ? `Pending atlas: ${pending.atlas.columns} x ${pending.atlas.rows} frames (not in the specification until applied).` : applied ? `Applied atlas: ${applied.columns} x ${applied.rows} frames of ${applied.frameWidth}x${applied.frameHeight}.` : "No atlas in the specification."}
      </p>
      <table data-testid="atlas-kinds">
        <thead><tr><th>Kind</th><th>Frames</th><th>Ticks per frame</th><th>From animation</th><th>Preview</th></tr></thead>
        <tbody>
          {current.kinds.map((k) => {
            const row = rows[k.id] ?? { framesText: "", ticksPerFrame: 1 };
            const f = parseFrames(row.framesText, frameCount, limits);
            const anims = manifests.animations.animations.filter((a) => a.kindRef === k.id);
            return (
              <tr key={k.id} data-testid={`atlas-kind-${k.id}`}>
                <td>{k.id}</td>
                <td>
                  <input type="text" className="mono" aria-label={`${k.id} frames`} data-testid={`atlas-frames-${k.id}`} value={row.framesText} aria-invalid={!f.ok}
                    onChange={(e) => setRows((all) => ({ ...all, [k.id]: { ...row, framesText: e.target.value } }))} />
                  {!f.ok && <small className="issue-inline" role="alert">{f.error}</small>}
                </td>
                <td><IntField label={`${k.id} ticks per frame`} value={row.ticksPerFrame} testId={`atlas-tpf-${k.id}`} onApply={(n) => setRows((all) => ({ ...all, [k.id]: { ...row, ticksPerFrame: n } }))} /></td>
                <td>
                  <select aria-label={`${k.id} animation`} data-testid={`atlas-anim-${k.id}`} value="" onChange={(e) => { if (e.target.value) fromAnimation(k.id, e.target.value); }}>
                    <option value="">{anims.length === 0 ? "no animation for this kind" : "use animation..."}</option>
                    {anims.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
                  </select>
                </td>
                <td>{atlas && f.ok && f.value.length > 0
                  ? <KindPreview kind={kindView(k.id)} sprite={{ frames: f.value, ticksPerFrame: Math.max(1, row.ticksPerFrame) }} atlas={atlas} tick={tick} />
                  : <span className="muted small">glyph or colour</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="actions" role="group" aria-label="Sprite preview clock">
        <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
        <button type="button" onClick={() => { setPlaying(false); setTick((t) => t + 1); }}>Step</button>
        <button type="button" onClick={() => setTick(0)}>Restart</button>
        <span className="muted small" data-testid="atlas-tick">simulation tick {tick}</span>
      </div>
      <div className="actions">
        <button type="button" data-testid="atlas-apply" disabled={busy || (!pending && !applied)} onClick={applyAll}>Apply to specification</button>
      </div>
    </section>
  );
}
