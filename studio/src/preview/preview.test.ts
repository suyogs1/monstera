import { describe, expect, it } from "vitest";
import type { EngineEvent, PreviewFrame, PreviewStart } from "../engine/protocol";
import { PreviewController, type PreviewEngine } from "./controller";
import { coalesce, event, keyEvents, PointerMapper, TAP_SLOP_PX } from "./input";
import { Layout, Texts } from "./presentation";

const types = (es: EngineEvent[]) => es.map((e) => e.type);

describe("pointer mapping follows the shell (GameScreen.kt)", () => {
  it("a still tap before the start card is dismissed starts the session and sends nothing", () => {
    const m = new PointerMapper("drag", 0);
    expect(m.pointerDown(10, 10, false).events).toEqual([]);
    expect(m.pointerUp(false, false)).toEqual({ events: [], action: "start" });
  });
  it("a tap while playing sends press, release, tap; on the end card it restarts", () => {
    const m = new PointerMapper("drag", 0);
    expect(types(m.pointerDown(0, 0, true).events)).toEqual(["press"]);
    expect(m.pointerMove(TAP_SLOP_PX - 1, 0, true, 0.5).events).toEqual([]);
    expect(types(m.pointerUp(true, false).events)).toEqual(["release", "tap"]);
    m.pointerDown(0, 0, true);
    expect(m.pointerUp(true, true).action).toBe("restart");
  });
  it("drag: deltas after the slop become raw world-unit drags (pixels / scale * 65536)", () => {
    const m = new PointerMapper("drag", 0);
    m.pointerDown(0, 0, true);
    expect(m.pointerMove(13, 0, true, 0.5).events).toEqual([event("drag", 13 / 0.5 * 65536, 0)]);
    expect(m.pointerMove(14, -1, true, 0.5).events).toEqual([event("drag", 131072, -131072)]);
    expect(types(m.pointerUp(true, false).events)).toEqual(["release"]);
  });
  it("lanes: one +-swipeSpeed drag per mostly horizontal gesture, no continuous drags", () => {
    const m = new PointerMapper("lanes", 30146560);
    m.pointerDown(0, 0, true);
    expect(m.pointerMove(-40, 5, true, 0.2).events).toEqual([]);
    expect(m.pointerUp(true, false).events).toEqual([event("release"), event("drag", -30146560, 0)]);
  });
  it("swipe: one swipe in the dominant direction", () => {
    const m = new PointerMapper("swipe", 393216);
    m.pointerDown(0, 0, true);
    m.pointerMove(5, -40, true, 0.2);
    expect(m.pointerUp(true, false).events).toEqual([event("release"), event("swipe", 0, 0, "up")]);
  });
  it("keyboard equivalents", () => {
    expect(keyEvents("Enter", "drag", 0, 100, 100, false, false).action).toBe("start");
    expect(keyEvents("ArrowLeft", "swipe", 0, 100, 100, true, false).events).toEqual([event("swipe", 0, 0, "left")]);
    expect(keyEvents("ArrowRight", "lanes", 7, 100, 100, true, false).events).toEqual([event("drag", 7, 0)]);
    expect(keyEvents("ArrowUp", "lanes", 7, 100, 100, true, false).events).toEqual([]);
  });
  it("consecutive drags are summed (bounded pending list); other events keep their order", () => {
    const out = coalesce([event("drag", 1, 2)], [event("drag", 3, 4), event("tap"), event("drag", 5, 0), event("drag", 1, 1)]);
    expect(out).toEqual([event("drag", 4, 6), event("tap"), event("drag", 6, 1)]);
  });
});

describe("presentation port matches Presentation.kt", () => {
  it("HUD bar and fitted world", () => {
    const L = new Layout(1600, 900, 1920, 1080);
    expect(L.hudHeight).toBeCloseTo(81);
    expect(L.scale).toBeCloseTo((900 - 81) / 1080);
    expect(L.world.y).toBeCloseTo(81);
    expect(new Layout(300, 100, 10, 10).hudHeight).toBe(25); // capped at 25 % of the view height
  });
  it("texts", () => {
    expect(Texts.lives("", 3)).toBe("lives 3");
    expect(Texts.lives("x", 10)).toBe("xxxxxxxx +2");
    expect(Texts.endTitle(0, "W", "L")).toBe("L");
  });
});

/** An engine whose replies are released by the test, to observe back-pressure. */
class ManualEngine implements PreviewEngine {
  frames: { session: number; nanos: number; events: EngineEvent[]; resolve: (r: PreviewFrame) => void }[] = [];
  starts = 0;
  async previewStart(_text: string, seed: number): Promise<PreviewStart> {
    this.starts++;
    return { ok: true, session: this.starts, sha256: "a".repeat(64), seed, snapshot: { tick: 0, score: 0, lives: 3, ended: false, alpha: 0, ticks: 0, entities: [], ms: 0 } };
  }
  previewFrame(session: number, nanos: number, events: EngineEvent[]): Promise<PreviewFrame> {
    return new Promise((resolve) => this.frames.push({ session, nanos, events, resolve }));
  }
  reply(i = 0) {
    const f = this.frames.splice(i, 1)[0]!;
    f.resolve({ ok: true, session: f.session, snapshot: { tick: 1, score: 0, lives: 3, ended: false, alpha: 0, ticks: 1, entities: [], ms: 0.1 } });
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PreviewController back-pressure", () => {
  it("never has more than one frame in flight; busy display frames are skipped and their time carried over", async () => {
    let now = 0;
    const eng = new ManualEngine();
    const c = new PreviewController(eng, () => now);
    c.restart("{}", { seed: 7 });
    await flush();
    expect(c.getState().status).toBe("running");
    c.tick();                        // frame 1 sent (elapsed 0)
    for (let i = 0; i < 30; i++) { now += 16; c.tick(); }  // worker busy: 30 display frames skipped
    expect(eng.frames.length).toBe(1);
    expect(c.getStats().framesSkippedBusy).toBe(30);
    eng.reply(); await flush();
    c.tick();
    expect(eng.frames.length).toBe(1);
    expect(eng.frames[0]!.nanos).toBe(480 * 1e6); // the whole busy period goes to the GameLoop (which clamps it)
  });
  it("input submitted while busy is coalesced and sent with the next frame", async () => {
    let now = 0;
    const eng = new ManualEngine();
    const c = new PreviewController(eng, () => now);
    c.restart("{}", { seed: 7 });
    await flush();
    c.tick();
    c.submit([event("drag", 1, 0)]); c.submit([event("drag", 2, 0)]); c.submit([event("tap")]);
    eng.reply(); await flush();
    now += 16; c.tick();
    expect(eng.frames[0]!.events).toEqual([event("drag", 3, 0), event("tap")]);
  });
  it("a restart requested during a frame waits for it, and a stale reply is dropped", async () => {
    const eng = new ManualEngine();
    const c = new PreviewController(eng, () => 0);
    c.restart("{}", { seed: 1 });
    await flush();
    c.tick();
    c.restart("{\"b\":1}", { seed: 2 });
    expect(eng.starts).toBe(1);
    eng.reply(); await flush();
    expect(c.getState().snapshot?.tick).toBe(0); // the old session's reply was not applied
    c.tick(); await flush();
    expect(eng.starts).toBe(2);
    expect(c.getState().session).toBe(2);
    expect(c.getState().text).toBe("{\"b\":1}");
  });
  it("pause stops stepping", async () => {
    const eng = new ManualEngine();
    const c = new PreviewController(eng, () => 0);
    c.restart("{}", { seed: 1 });
    await flush();
    c.pause("invalid");
    c.tick();
    expect(eng.frames.length).toBe(0);
    expect(c.getState().status).toBe("paused");
  });
});
