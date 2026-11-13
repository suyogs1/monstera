// Adversarial regression test for the preview controller (workflow wf_d86b541f4b210b32).
import { describe, expect, it } from "vitest";
import { PreviewController, type PreviewEngine } from "./controller";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("pause() while a start request is in flight", () => {
  it("keeps the preview paused: an invalid draft must not show as running without a notice", async () => {
    const snapshot = { tick: 0, score: 0, lives: 3, ended: false, alpha: 0, ticks: 0, entities: [], ms: 1 };
    let release: () => void = () => {};
    const engine: PreviewEngine = {
      previewStart: (_t, seed) => new Promise((res) => { release = () => res({ ok: true, session: 1, sha256: "s", seed, snapshot }); }),
      previewFrame: async () => { throw new Error("no frames expected"); },
    };
    const c = new PreviewController(engine, () => 0);
    c.restart("{}", { seed: 1, started: true });
    await tick();
    c.pause("the draft has 2 validation issue(s); showing the last valid version");
    release();
    await tick();
    expect(c.getState().status).toBe("paused");
    expect(c.getState().message).not.toBe("");
  });
});
