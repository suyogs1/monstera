// Live preview session control. Plain TypeScript (no React, no DOM) so back-pressure can be tested.
// Every tick is run by the engine's GameLoop in the worker; this file only decides WHEN to ask for a frame:
//  - at most ONE engine request (start or frame) is in flight; a display frame that comes while it is busy is
//    skipped, never queued, and its time is carried into the next request (the GameLoop then clamps a long gap to
//    maxTicksPerFrame and drops the backlog, exactly as on a device after a hitch);
//  - pending input events are coalesced while waiting (consecutive drags summed), so they stay bounded.
import type { EngineEvent, PreviewFrame, PreviewSnapshot, PreviewStart } from "../engine/protocol";
import { coalesce } from "./input";

export interface PreviewEngine {
  previewStart(text: string, seed: number): Promise<PreviewStart>;
  previewFrame(session: number, elapsedNanos: number, events: EngineEvent[]): Promise<PreviewFrame>;
}

export type PreviewStatus = "idle" | "starting" | "running" | "paused" | "error";

export interface PreviewState {
  status: PreviewStatus;
  message: string;
  session: number;
  sha256: string | null;
  seed: number;
  /** The canonical text of the running session (its display fields are drawn from it). */
  text: string | null;
  started: boolean;
  snapshot: PreviewSnapshot | null;
  /** Bumped when a snapshot arrives. */
  frame: number;
  /** Inspect mode holds the preview (no frames, no input). */
  held: boolean;
}

const SAMPLES = 600;
class Samples {
  private v: number[] = [];
  push(x: number) { this.v.push(x); if (this.v.length > SAMPLES) this.v.shift(); }
  summary() {
    const s = [...this.v].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0);
    return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.length ? s[s.length - 1]! : 0 };
  }
  clear() { this.v = []; }
}

export interface PreviewStats {
  framesSent: number;
  framesSkippedBusy: number;
  roundTripMs: ReturnType<Samples["summary"]>;
  engineFrameMs: ReturnType<Samples["summary"]>;
  snapshotBytes: ReturnType<Samples["summary"]>;
  parseMs: ReturnType<Samples["summary"]>;
  entities: ReturnType<Samples["summary"]>;
  restartRequestedAt: number | null;
  firstFrameAt: number | null;
  firstFrameSha: string | null;
}

/** A seed in 0..2^53-1, chosen outside the core like the shells do (exact in JSON). */
export function freshSeed(): number {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0]! & 0x1fffff) * 0x100000000 + a[1]!;
}

type Listener = () => void;

export class PreviewController {
  private st: PreviewState = { status: "idle", message: "", session: 0, sha256: null, seed: 0, text: null, started: false, snapshot: null, frame: 0, held: false };
  private readonly listeners = new Set<Listener>();
  private busy = false;
  private pending: EngineEvent[] = [];
  private lastSentAt: number | null = null;
  private wantRestart: { text: string; seed: number; started: boolean; at: number } | null = null;
  private stats = { framesSent: 0, framesSkippedBusy: 0, restartRequestedAt: null as number | null, firstFrameAt: null as number | null, firstFrameSha: null as string | null };
  private readonly roundTrip = new Samples();
  private readonly engineMs = new Samples();
  private readonly bytes = new Samples();
  private readonly parse = new Samples();
  private readonly entities = new Samples();

  constructor(private readonly engine: PreviewEngine, private readonly clock: () => number = () => performance.now()) {}

  getState = (): PreviewState => this.st;
  subscribe = (l: Listener): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  private set(next: Partial<PreviewState>): void { this.st = { ...this.st, ...next }; for (const l of this.listeners) l(); }

  getStats(): PreviewStats {
    return { ...this.stats, roundTripMs: this.roundTrip.summary(), engineFrameMs: this.engineMs.summary(), snapshotBytes: this.bytes.summary(),
      parseMs: this.parse.summary(), entities: this.entities.summary() };
  }
  resetStats(): void {
    this.stats.framesSent = 0; this.stats.framesSkippedBusy = 0;
    for (const s of [this.roundTrip, this.engineMs, this.bytes, this.parse, this.entities]) s.clear();
  }

  /** A new session for `text` (a validated draft). Applied at the next free moment; a newer request replaces it. */
  restart(text: string, opts: { seed?: number; started?: boolean } = {}): void {
    const at = this.clock();
    this.pausedWith = null;
    this.wantRestart = { text, seed: opts.seed ?? (this.st.seed || freshSeed()), started: opts.started ?? this.st.started, at };
    this.stats.restartRequestedAt = at;
    this.stats.firstFrameAt = null;
    this.stats.firstFrameSha = null;
    void this.pump();
  }

  /** The draft is not runnable (invalid): stop stepping and say why; the last frame stays on screen. */
  pause(message: string): void {
    this.wantRestart = null;
    this.pausedWith = message;
    if (this.st.status !== "paused" || this.st.message !== message) this.set({ status: "paused", message });
  }

  private held = false;
  /** The reason of the latest pause() since the latest restart(), or null. */
  private pausedWith: string | null = null;

  /** Inspect mode: no frames are requested and no input is accepted while held. On release the next frame reports
   *  zero elapsed time (like an app returning to the foreground), so a long inspection is not fed to the GameLoop. */
  hold(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    this.pending = [];
    if (!on) this.lastSentAt = null;
    this.set({ held: on });
  }
  isHeld(): boolean { return this.held; }

  /** Called by the shell for user input. */
  submit(events: EngineEvent[]): void { if (events.length && this.st.status === "running" && !this.held) this.pending = coalesce(this.pending, events); }

  /** First tap (start) or tap on the end card (restart): a fresh session with a fresh seed, as the shells do. */
  newSession(): void { if (this.st.text) this.restart(this.st.text, { seed: freshSeed(), started: true }); }

  /** Called once per display frame (requestAnimationFrame). Never queues: returns false when it skipped. */
  tick(): boolean {
    if (this.held && !this.wantRestart) return false;
    if (this.busy) { if (this.st.status === "running") this.stats.framesSkippedBusy++; return false; }
    void this.pump();
    return true;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const restart = this.wantRestart;
    if (restart) {
      this.wantRestart = null;
      this.busy = true;
      this.set({ status: "starting" });
      try {
        const r = await this.engine.previewStart(restart.text, restart.seed);
        if (r.ok) {
          this.pending = [];
          this.lastSentAt = null;
          // A pause() that arrived while this start was in flight wins: the session is kept, but not stepped.
          const paused = this.pausedWith;
          this.set({ status: paused === null ? "running" : "paused", message: paused ?? "", session: r.session, sha256: r.sha256, seed: r.seed, text: restart.text, started: restart.started, snapshot: r.snapshot, frame: this.st.frame + 1 });
        } else this.set({ status: "paused", message: r.message });
      } catch (e) {
        this.set({ status: "error", message: (e as Error).message });
      } finally {
        this.busy = false;
      }
      return;
    }
    if (this.st.status !== "running") return;
    const now = this.clock();
    const elapsedNanos = this.lastSentAt === null ? 0 : Math.max(0, Math.round((now - this.lastSentAt) * 1e6));
    this.lastSentAt = now;
    const events = this.pending;
    this.pending = [];
    const session = this.st.session;
    this.busy = true;
    try {
      const t0 = this.clock();
      const r = await this.engine.previewFrame(session, elapsedNanos, events);
      const t1 = this.clock();
      this.stats.framesSent++;
      if (r.ok && r.session === this.st.session && !this.wantRestart) {
        this.roundTrip.push(t1 - t0);
        this.engineMs.push(r.snapshot.ms);
        this.entities.push(r.snapshot.entities.length / 7);
        if (this.stats.firstFrameAt === null && this.stats.restartRequestedAt !== null) { this.stats.firstFrameAt = t1; this.stats.firstFrameSha = this.st.sha256; }
        this.set({ snapshot: r.snapshot, frame: this.st.frame + 1 });
      }
    } catch (e) {
      this.set({ status: "error", message: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }

  /** Recorded by the engine client wrapper: size and parse time of each frame reply (snapshot cost). */
  noteReply(bytes: number, parseMs: number): void { this.bytes.push(bytes); this.parse.push(parseMs); }
}
