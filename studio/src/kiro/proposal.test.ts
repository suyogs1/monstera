import { describe, expect, it } from "vitest";
import { drain, harness } from "../app/session.testkit";
import { Engine } from "../derive/testEngine";
import { getAt } from "../draft/path";
import { stableText } from "../project/record";
import { memoryMarker } from "../project/testkit";
import { pumpkinDoc, xrefManifests } from "../project/xref.testkit";
import { parseProposal, planProposal, type Proposal } from "./proposal";
const make = (target: Proposal["target"], ops: Proposal["ops"]): Proposal => ({ schema: "monstera.studio.proposal", version: 1, target, summary: "test", ops });
const state = () => ({ doc: pumpkinDoc(), manifests: xrefManifests() });
describe("parseProposal", () => {
  const text = (o: object) => JSON.stringify({ schema: "monstera.studio.proposal", version: 1, target: "gameplay", summary: "s", ops: [], ...o });
  it("accepts a well-formed proposal", () => {
    expect(parseProposal(text({ ops: [{ op: "set", path: "/lives/start", value: "5" }] })).ok).toBe(true);
  });
  it("refuses unknown targets, wrong schema, non-JSON values, forbidden keys and duplicate keys", () => {
    expect(parseProposal(text({ target: "android" })).ok).toBe(false);
    expect(parseProposal(text({ schema: "other" })).ok).toBe(false);
    expect(parseProposal(text({ ops: [{ op: "set", path: "/a", value: "not json" }] })).ok).toBe(false);
    expect(parseProposal(text({ ops: [{ op: "set", path: "/__proto__/x", value: "1" }] })).ok).toBe(false);
    expect(parseProposal('{"schema":"monstera.studio.proposal","schema":"x"}').ok).toBe(false);
    expect(parseProposal("{").ok).toBe(false);
  });
});
describe("planProposal on a manifest target", () => {
  it("applies set, add and remove to a copy and leaves the input untouched", async () => {
    const s = state();
    const before = stableText(s.manifests.gameplay as never);
    const p = make("gameplay", [{ op: "set", path: "/lives/start", value: "5" }]);
    const r = await planProposal(s, p, new Engine());
    if (!r.ok) throw new Error(r.message);
    expect(r.manifests.gameplay.lives.start).toBe(5);
    expect(r.diff).toEqual([{ op: "set", path: "/lives/start", before: String(s.manifests.gameplay.lives.start), after: "5" }]);
    expect(stableText(s.manifests.gameplay as never)).toBe(before);
    expect(r.doc).toBe(s.doc);
  });
  it("a result that fails the manifest schema is refused at the validate stage", async () => {
    const r = await planProposal(state(), make("gameplay", [{ op: "set", path: "/lives/start", value: "\"many\"" }]), new Engine());
    expect(r).toMatchObject({ ok: false, stage: "validate" });
  });
  it("a path that does not exist, an add over an existing field and the whole document are refused at the apply stage", async () => {
    for (const op of [
      { op: "set" as const, path: "/lives/nope", value: "1" },
      { op: "add" as const, path: "/lives/start", value: "1" },
      { op: "set" as const, path: "", value: "{}" },
      { op: "remove" as const, path: "/collectibles/99", value: "" },
    ]) expect(await planProposal(state(), make("gameplay", [op]), new Engine())).toMatchObject({ ok: false, stage: "apply", opIndex: 0 });
  });
  it("one bad operation refuses the whole proposal", async () => {
    const r = await planProposal(state(), make("gameplay", [{ op: "set", path: "/lives/start", value: "5" }, { op: "set", path: "/nope", value: "1" }]), new Engine());
    expect(r).toMatchObject({ ok: false, stage: "apply", opIndex: 1 });
  });
});
describe("planProposal on the spec", () => {
  it("passes the engine and gives the canonical document and hash", async () => {
    const e = new Engine();
    const s = state();
    const r = await planProposal(s, make("spec", [{ op: "set", path: "/game/runtime/winScore", value: "7" }]), e);
    if (!r.ok) throw new Error(r.message);
    expect(e.calls).toBe(1);
    expect(getAt(r.doc, ["game", "runtime", "winScore"])).toBe(7);
    expect(r.manifests.project.spec.currentSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("an engine-invalid result is refused at the engine stage", async () => {
    const r = await planProposal(state(), make("spec", [{ op: "set", path: "/game/runtime/lives", value: "\"x\"" }]), new Engine());
    expect(r).toMatchObject({ ok: false, stage: "engine" });
  });
  it("a failing oracle run refuses the proposal", async () => {
    const e = new Engine(); e.failOracle = "tick 3";
    expect(await planProposal(state(), make("spec", [{ op: "set", path: "/game/runtime/winScore", value: "7" }]), e)).toMatchObject({ ok: false, stage: "oracle" });
  });
  it("a pointer owned by a deriving module, or a parent of one, is refused before the engine is called", async () => {
    const s = state();
    s.manifests = { ...s.manifests, project: { ...s.manifests.project, derivation: { levels: false, gameplay: true, activeLevel: "" } } };
    const e = new Engine();
    expect(await planProposal(s, make("spec", [{ op: "set", path: "/game/runtime/winScore", value: "7" }]), e)).toMatchObject({ ok: false, stage: "precondition" });
    expect(await planProposal(s, make("spec", [{ op: "set", path: "/game/runtime", value: "{}" }]), e)).toMatchObject({ ok: false, stage: "precondition" });
    expect(e.calls).toBe(0);
  });
});
describe("inbox through the session: reject changes nothing, accept is one undo step", () => {
  async function boot() {
    const h = harness({ marker: memoryMarker() });
    await h.session.start();
    await drain(h);
    return h;
  }
  const snap = (h: Awaited<ReturnType<typeof boot>>) => ({ doc: h.session.project.currentState()?.doc, manifests: h.session.project.currentState()?.manifests });
  it("reviewing a proposal and then dropping it leaves the document and the manifests the very same objects", async () => {
    const h = await boot();
    const before = snap(h);
    const r = await h.session.reviewProposal(make("gameplay", [{ op: "set", path: "/lives/start", value: "5" }]));
    expect(r.ok).toBe(true);
    const after = snap(h);
    expect(after.doc).toBe(before.doc);
    expect(after.manifests).toBe(before.manifests);
  });
  it("a refused proposal changes nothing either", async () => {
    const h = await boot();
    const before = snap(h);
    expect(await h.session.reviewProposal(make("gameplay", [{ op: "set", path: "/lives/start", value: "\"x\"" }]))).toMatchObject({ ok: false });
    expect(snap(h).manifests).toBe(before.manifests);
  });
  it("accepting commits the reviewed result, undo restores it, and a changed project refuses a stale review", async () => {
    const h = await boot();
    const before = snap(h);
    const review = await h.session.reviewProposal(make("gameplay", [{ op: "set", path: "/lives/start", value: "5" }]));
    if (!review.ok) throw new Error(review.message);
    expect(h.session.applyReviewedProposal(review)).toEqual({ ok: true });
    expect(h.session.project.currentState()?.manifests.gameplay.lives.start).toBe(5);
    expect(h.session.project.undo()).toBe(true);
    expect(snap(h).manifests?.gameplay).toEqual(before.manifests?.gameplay);
    const stale = await h.session.reviewProposal(make("gameplay", [{ op: "set", path: "/lives/start", value: "6" }]));
    if (!stale.ok) throw new Error(stale.message);
    h.session.project.commitManifest("gameplay", { ...h.session.project.currentState()!.manifests.gameplay, lives: { ...h.session.project.currentState()!.manifests.gameplay.lives, start: 2 } }, "x");
    expect(h.session.applyReviewedProposal(stale)).toMatchObject({ ok: false, stage: "precondition" });
    expect(h.session.project.currentState()?.manifests.gameplay.lives.start).toBe(2);
  });
});
