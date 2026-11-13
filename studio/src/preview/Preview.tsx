import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDraft, useSection, useSession } from "../app/hooks";
import { goToPath } from "../app/navigate";
import type { PreviewSnapshot } from "../engine/protocol";
import { keyEvents, PointerMapper, type Scheme } from "./input";
import { EffectTracker, Layout, Texts, type Effect, type Tracked } from "./presentation";
import { entityBox, hitTest, RAW, STRIDE } from "./select";

interface Kind { id: string; color: string; glyph: string; effect: Effect; width: number; height: number }
interface Display {
  displayName: string; orientation: "landscape" | "portrait"; worldW: number; worldH: number; scheme: Scheme; swipeSpeed: number;
  palette: { primary: string; accent: string; background: string }; hud: { lifeGlyph: string; scoreLabel: string };
  screens: { startHint: string; winTitle: string; loseTitle: string }; kinds: Kind[];
}

/** Display fields of the running session's spec (the same text the engine was started with). */
function displayOf(text: string): Display {
  const d = JSON.parse(text);
  const g = d.game;
  return {
    displayName: d.project.displayName, orientation: g.orientation, worldW: g.world.width, worldH: g.world.height,
    scheme: g.input.scheme, swipeSpeed: g.input.swipeSpeed, palette: g.palette, hud: g.hud, screens: g.screens,
    kinds: g.runtime.kinds.map((k: Kind) => ({ id: k.id, color: k.color, glyph: k.glyph, effect: k.effect, width: k.width, height: k.height })),
  };
}

function tracked(s: PreviewSnapshot, kinds: Kind[]): Tracked[] {
  const out: Tracked[] = [];
  for (let i = 0; i < s.entities.length; i += STRIDE) {
    const k = kinds[s.entities[i + 1]!];
    if (!k) continue;
    out.push({ id: s.entities[i]!, kind: s.entities[i + 1]!, box: { x: s.entities[i + 2]! / RAW, y: s.entities[i + 3]! / RAW, w: k.width / RAW, h: k.height / RAW } });
  }
  return out;
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
}

/** Draws one frame; returns how many visible entities carry the highlight (the selected kind, -1 for none). */
function draw(ctx: CanvasRenderingContext2D, L: Layout, d: Display, s: PreviewSnapshot, fx: EffectTracker, started: boolean, best: number, highlight: number): number {
  let highlighted = 0;
  const { world, scale: k } = L;
  ctx.fillStyle = d.palette.background;
  ctx.fillRect(0, 0, L.viewW, L.viewH);
  ctx.save();
  ctx.beginPath(); ctx.rect(world.x, world.y, world.w, world.h); ctx.clip();
  ctx.translate(fx.shakeX() * k, fx.shakeY() * k);
  for (let i = 0; i < s.entities.length; i += STRIDE) {
    const kind = d.kinds[s.entities[i + 1]!];
    // Interpolated for display only (as the shells do); the engine state is never changed by drawing.
    const box = entityBox(s, i, d.kinds);
    if (!kind || !box || L.visible(box) === null) continue;
    const px = L.toScreen(box);
    if (kind.glyph === "") { ctx.fillStyle = kind.color; ctx.fillRect(px.x, px.y, px.w, px.h); }
    else {
      ctx.font = `${Texts.glyphSize(px)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = kind.color;
      ctx.fillText(kind.glyph, px.x + px.w / 2, px.y + px.h / 2);
    }
    if (s.entities[i + 1] === highlight) {
      highlighted++;
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.strokeRect(px.x - 2, px.y - 2, px.w + 4, px.h + 4);
      ctx.setLineDash([]);
    }
  }
  for (const p of fx.particles) {
    const c = L.toScreen({ x: p.x, y: p.y, w: p.size, h: p.size });
    ctx.fillStyle = withAlpha(d.kinds[p.kind]?.color ?? "#ffffff", 1 - p.age / 0.4);
    ctx.fillRect(c.x - c.w / 2, c.y - c.h / 2, c.w, c.h);
  }
  for (const r of fx.rings) {
    const c = L.toScreen({ x: r.x, y: r.y, w: 0, h: 0 });
    ctx.strokeStyle = withAlpha(d.kinds[r.kind]?.color ?? "#ffffff", 1 - r.age / 0.3); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x, c.y, fx.ringRadius(r) * k, 0, Math.PI * 2); ctx.stroke();
  }
  for (const p of fx.popups) {
    const c = L.toScreen({ x: p.x, y: p.y, w: 0, h: 0 });
    ctx.font = `bold ${Math.max(10, 56 * k)}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.fillStyle = withAlpha(d.palette.accent, 1 - p.age / 0.6);
    ctx.fillText(p.text, c.x, c.y);
  }
  ctx.restore();
  if (fx.flash > 0) { ctx.fillStyle = `rgba(255, 0, 0, ${fx.flash * 0.35})`; ctx.fillRect(world.x, world.y, world.w, world.h); }
  ctx.strokeStyle = d.palette.primary; ctx.lineWidth = 2; ctx.strokeRect(world.x, world.y, world.w, world.h);

  const font = L.hudHeight * 0.45;
  ctx.font = `bold ${font}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`; ctx.fillStyle = d.palette.accent; ctx.textBaseline = "middle";
  ctx.textAlign = "left"; ctx.fillText(Texts.score(d.hud.scoreLabel, s.score), 8, L.hud.y + L.hudHeight / 2);
  ctx.textAlign = "right"; ctx.fillText(Texts.lives(d.hud.lifeGlyph, s.lives), L.viewW - 8, L.hud.y + L.hudHeight / 2);

  if (!started || s.ended) {
    const title = !started ? d.displayName : Texts.endTitle(s.lives, d.screens.winTitle, d.screens.loseTitle);
    const line = !started ? d.screens.startHint : `${Texts.score(d.hud.scoreLabel, s.score)}   best ${best}`;
    const hint = !started ? "Tap to start" : "Tap to restart";
    const w = Math.min(L.viewW * 0.9, Math.max(160, font * 12)), h = font * 5.2;
    const x = (L.viewW - w) / 2, y = world.y + (world.h - h) / 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)"; ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill();
    ctx.textAlign = "center";
    ctx.font = `bold ${font * 1.4}px system-ui, sans-serif`; ctx.fillStyle = d.palette.accent; ctx.fillText(title, L.viewW / 2, y + h * 0.27, w - 12);
    ctx.font = `${font}px system-ui, sans-serif`; ctx.fillStyle = "#ffffff"; ctx.fillText(line, L.viewW / 2, y + h * 0.55, w - 12);
    ctx.fillStyle = d.palette.primary; ctx.fillText(hint, L.viewW / 2, y + h * 0.8, w - 12);
  }
  return highlighted;
}

/** Live preview: the engine's GameLoop in the worker, drawn on a canvas with the shells' presentation rules. */
export function Preview() {
  const session = useSession();
  const preview = session.preview;
  const draft = useDraft();
  const st = useSyncExternalStore(preview.subscribe, preview.getState);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const display = useMemo(() => (st.text ? displayOf(st.text) : null), [st.text]);
  const mapper = useMemo(() => (display ? new PointerMapper(display.scheme, display.swipeSpeed) : null), [display]);
  // A new tracker per session (a fresh world), as the shells do.
  const tracker = useMemo(() => (display ? new EffectTracker(display.kinds.map((k) => k.effect), { x: 0, y: 0, w: display.worldW, h: display.worldH }) : null),
    [display, st.session]);
  const best = useRef(0);
  const layoutRef = useRef<Layout | null>(null);
  const trackerRef = useRef<EffectTracker | null>(null);
  trackerRef.current = tracker;
  const displayCache = useRef<{ text: string; d: Display } | null>(null);
  const selection = useSyncExternalStore(session.selection.subscribe, session.selection.getState);
  const [, setSection] = useSection();
  const [note, setNote] = useState<string | null>(null);
  const highlightedRef = useRef(0);

  // Restart on every valid draft change; pause (with the reason) while the draft is invalid.
  const v = draft.validation;
  const current = draft.validatedRevision === draft.revision;
  // A newly loaded document (template or import) opens on the start card, like launching the app; edits keep the mode.
  const docKey = draft.baseline ? `${draft.baseline.label}|${draft.baseline.sha256}` : "";
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!current || !v) return;
    if (!v.ok || v.canonicalText === null) { preview.pause(`the draft has ${v.issues.length} validation issue(s); showing the last valid version`); return; }
    const fresh = loadedKey.current !== docKey;
    if (fresh || v.sha256 !== preview.getState().sha256 || preview.getState().status === "paused") {
      loadedKey.current = docKey;
      preview.restart(v.canonicalText, fresh ? { started: false } : {});
    }
  }, [current, v, preview, docKey]);

  // Observe each new engine snapshot once (effects are inferred from state differences between frames).
  useEffect(() => {
    if (!st.snapshot || !display || !tracker) return;
    tracker.observe(st.snapshot.score, st.snapshot.lives, tracked(st.snapshot, display.kinds));
    if (st.started && st.snapshot.ended && st.snapshot.score > best.current) best.current = st.snapshot.score;
  }, [st.frame, st.snapshot, display, tracker, st.started]);

  // Display loop: one engine request at a time (controller.tick skips while busy), drawing every display frame.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      preview.tick();
      const c = canvasRef.current;
      const s = preview.getState();
      if (!c || !s.snapshot || !s.text) return;
      if (displayCache.current?.text !== s.text) displayCache.current = { text: s.text, d: displayOf(s.text) };
      const d = displayCache.current.d;
      const dpr = window.devicePixelRatio || 1;
      const cssW = c.clientWidth, cssH = c.clientHeight;
      if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) { c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const L = new Layout(cssW, cssH, d.worldW, d.worldH);
      layoutRef.current = L;
      const fx = trackerRef.current;
      if (fx) fx.advance(Math.min(now - last, 100) / 1000);
      last = now;
      const sel = session.selection.getState().kindId;
      const hi = sel === null ? -1 : d.kinds.findIndex((x) => x.id === sel);
      if (fx) highlightedRef.current = draw(ctx, L, d, s.snapshot, fx, s.started, best.current, hi);
      // Handles for the acceptance run (the page's own geometry, as drawn): entity boxes in canvas pixels.
      (window as unknown as { previewDebug: unknown }).previewDebug = {
        highlighted: highlightedRef.current,
        boxes: () => { const out = []; for (let i = 0; i < s.snapshot!.entities.length; i += STRIDE) { const b = entityBox(s.snapshot!, i, d.kinds); const v = b && L.visible(b); out.push({ id: s.snapshot!.entities[i], kind: d.kinds[s.snapshot!.entities[i + 1]!]?.id, controlled: s.snapshot!.entities[i + 6] === 1, visible: v ?? null }); } return out; },
        world: L.world,
      };
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [preview, session.selection]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const act = (m: { events: Parameters<typeof preview.submit>[0]; action: "start" | "restart" | null }) => {
    preview.submit(m.events);
    if (m.action) preview.newSession();
  };
  // Inspect mode: a click selects the kind under the pointer (topmost) and opens it in the Entities editor.
  // Nothing is sent to the engine; the preview is held, so the engine sees no frames until Resume.
  const inspect = (x: number, y: number) => {
    const L = layoutRef.current;
    if (!st.snapshot || !display || !L) return;
    const index = hitTest(st.snapshot, display.kinds, L, x, y);
    if (index === null) { session.selection.set(null, "preview"); setNote("No entity there."); return; }
    const kind = display.kinds[index]!;
    session.selection.set(kind.id, "preview");
    setNote(null);
    const now = (session.store.getState().doc as { game?: { runtime?: { kinds?: { id: string }[] } } } | null)?.game?.runtime?.kinds ?? [];
    const at = now.findIndex((k) => k.id === kind.id);
    if (at >= 0) goToPath(["game", "runtime", "kinds", at], setSection);
    else setNote(`kind ${kind.id} is no longer in the draft`);
  };
  const running = st.status === "running";
  const ended = st.snapshot?.ended ?? false;

  const portrait = display?.orientation === "portrait";
  return (
    <section className="preview" aria-labelledby="preview-h" data-testid="preview" data-status={st.status}>
      <h2 id="preview-h">Live preview</h2>
      <canvas
        ref={canvasRef}
        className={portrait ? "preview-canvas portrait" : "preview-canvas landscape"}
        data-testid="preview-canvas"
        tabIndex={0}
        role="img"
        aria-label={`${display?.displayName ?? "Game"} preview. Press Enter to tap, arrow keys to move.`}
        onPointerDown={(e) => {
          const [x, y] = point(e);
          if (st.held) { inspect(x, y); return; }
          if (!mapper) return; e.currentTarget.setPointerCapture(e.pointerId); act(mapper.pointerDown(x, y, st.started));
        }}
        onPointerMove={(e) => { if (!mapper || st.held) return; const [x, y] = point(e); act(mapper.pointerMove(x, y, st.started, layoutRef.current?.scale ?? 0)); }}
        onPointerUp={(e) => { if (!mapper || st.held) return; act(mapper.pointerUp(st.started, ended)); e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { if (mapper && !st.held) act(mapper.pointerCancel(st.started)); }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && st.held) { preview.hold(false); return; }
          if (!display || st.held) return;
          const m = keyEvents(e.key, display.scheme, display.swipeSpeed, display.worldW * RAW, display.worldH * RAW, st.started, ended);
          if (m.events.length || m.action) { e.preventDefault(); act(m); }
        }}
      />
      <div className="actions small">
        <button type="button" aria-pressed={st.held} data-testid="preview-inspect" onClick={() => { preview.hold(!st.held); setNote(null); }}>
          {st.held ? "Resume" : "Inspect"}
        </button>
        <span className="muted" data-testid="preview-selection" data-kind={selection.kindId ?? ""}>
          {st.held ? "Held. Click an entity to open its kind. " : ""}
          {selection.kindId !== null ? <>Selected kind <code>{selection.kindId}</code></> : note ?? (st.held ? "" : "Inspect holds the game so an entity can be clicked.")}
        </span>
      </div>
      <p className="preview-label" data-testid="preview-label">simulation exact, touch mapping approximate</p>
      <p className={`small ${running ? "muted" : "status pending"}`} role="status" data-testid="preview-status">
        {st.status === "running" && <>Engine tick {st.snapshot?.tick ?? 0} · seed <code>{st.seed}</code> · spec <code>{st.sha256?.slice(0, 12)}</code></>}
        {st.status === "starting" && "Starting the preview…"}
        {st.status === "idle" && "Waiting for a valid draft…"}
        {st.status === "paused" && `Paused: ${st.message}.`}
        {st.status === "error" && `Engine error: ${st.message}`}
      </p>
    </section>
  );
}
