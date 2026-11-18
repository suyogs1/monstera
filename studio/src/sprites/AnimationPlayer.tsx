import { useEffect, useRef, useState } from "react";
import type { Animation, Sheet } from "../project/manifests/types";
import { advance, frameAt, initialPlayer, pause, play, restart, step, type PlayerState } from "./player";

/**
 * Preview player for one animation: play, pause and single-step. Frame choice comes from `frameIndex`; the canvas
 * draws the chosen sheet rectangle without smoothing. `imageUrl` is a blob: URL of the sheet image.
 */
export function AnimationPlayer({ animation, sheet, tickRate, imageUrl }: {
  animation: Animation; sheet: Sheet; tickRate: number; imageUrl: string;
}) {
  const [state, setState] = useState<PlayerState>(initialPlayer);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const shown = frameAt(animation, sheet, tickRate, state.tick);

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImg(el);
    el.src = imageUrl;
    return () => { el.onload = null; };
  }, [imageUrl]);

  useEffect(() => {
    if (!state.playing) return;
    let raf = 0, last = performance.now(), carry = 0;
    const loop = (now: number) => {
      const r = advance({ tick: 0, playing: true }, tickRate, now - last, carry);
      last = now; carry = r.carryMs;
      const n = r.state.tick;
      if (n > 0) setState((s) => (s.playing ? { ...s, tick: s.tick + n } : s));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart the clock only when playback or timing changes
  }, [state.playing, tickRate]);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !canvas.current) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.current.width, canvas.current.height);
    if (img && shown.ok) {
      const { x, y, w, h } = shown.frame;
      ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    }
  }, [img, shown.ok ? shown.frame : null]);

  const w = shown.ok ? shown.frame.w : sheet.grid.frameWidth;
  const h = shown.ok ? shown.frame.h : sheet.grid.frameHeight;
  return (
    <div data-testid="animation-player">
      <canvas ref={canvas} width={w} height={h} data-testid="animation-canvas"
        style={{ imageRendering: "pixelated", width: w * 4, height: h * 4, maxWidth: "100%" }} />
      <div role="group" aria-label="Animation preview controls">
        <button type="button" onClick={() => setState((s) => step(s, -1))}>Step back</button>
        {state.playing
          ? <button type="button" onClick={() => setState(pause)}>Pause</button>
          : <button type="button" onClick={() => setState(play)}>Play</button>}
        <button type="button" onClick={() => setState((s) => step(s, 1))}>Step</button>
        <button type="button" onClick={() => setState(restart)}>Restart</button>
      </div>
      <p className="muted" data-testid="animation-readout">
        {shown.ok ? `tick ${state.tick}, sequence entry ${shown.index}, frame ${shown.frame.id}` : shown.error}
      </p>
    </div>
  );
}
