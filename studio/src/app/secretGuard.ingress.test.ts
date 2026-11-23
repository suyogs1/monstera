// Task 9.4 remediation: every path that brings a whole document into the project or commits one refuses credential-shaped
// values in the spec AND in the manifests, with a message that never contains the value, and exports fail closed.
import { describe, expect, it } from "vitest";
import { png } from "../assets/fixtures.testkit";
import { exportBundle, importBundle } from "../export/bundle";
import { refuseSecrets } from "../integrations/secrets";
import { parseProposal, type Proposal } from "../kiro/proposal";
import { releaseExport } from "../release/exportPack";
import type { Provenance } from "../project/manifests";
import { memoryMarker, newFactory, pumpkinText, rawAll } from "../project/testkit";
import { drain, harness, type Harness } from "./session.testkit";

// An AWS access key id, the shape the guard knows; the project schema allows any display name, so the engine does not refuse it.
const SECRET = "AKIAIOSFODNN7EXAMPLE";
const prov: Provenance = { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" };
const specWithSecret = (): string => {
  const doc = JSON.parse(pumpkinText) as { project: { displayName: string } };
  doc.project.displayName = SECRET;
  return JSON.stringify(doc);
};
async function boot(factory: IDBFactory = newFactory()): Promise<{ h: Harness; factory: IDBFactory }> {
  const h = harness({ marker: memoryMarker(), factory });
  await h.session.start();
  await drain(h);
  return { h, factory };
}
const snapshot = (h: Harness) => ({ doc: JSON.stringify(h.session.store.getState().doc), manifests: JSON.stringify(h.session.project.getState().manifests), key: h.session.project.getState().projectKey, revision: h.session.store.getState().revision });
const STORES = ["projects", "blobs", "meta"];
async function storedText(factory: IDBFactory): Promise<string> {
  const out: unknown[] = [];
  for (const s of STORES) out.push(await rawAll(factory, s));
  return JSON.stringify(out, (_k, v: unknown) => (v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)).map((c) => String.fromCharCode(c)).join("") : v));
}
const proposal = (target: Proposal["target"], ops: Proposal["ops"]): Proposal => ({ schema: "monstera.studio.proposal", version: 1, target, summary: "t", ops });

describe("direct spec import (Session.importText)", () => {
  it("refuses a credential-shaped project.displayName, redacts the value, and changes neither the project nor storage", async () => {
    const { h, factory } = await boot();
    const before = snapshot(h);
    const r = await h.session.importText(specWithSecret(), "leaky.json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("credential-shaped");
      expect(r.message).not.toContain(SECRET);
    }
    await drain(h);
    expect(snapshot(h)).toEqual(before);
    expect(await storedText(factory)).not.toContain(SECRET);
    expect(h.session.project.getState().status).toBe("saved");
  });
  it("a credential-shaped object key is refused and its path is not echoed", async () => {
    const { h } = await boot();
    const doc = JSON.parse(pumpkinText) as Record<string, unknown>;
    doc[SECRET] = 1;
    const r = await h.session.importText(JSON.stringify(doc), "key.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(SECRET);
  });
  it("a normal valid import still works", async () => {
    const { h } = await boot();
    const before = snapshot(h);
    const doc = JSON.parse(pumpkinText) as { project: { displayName: string } };
    doc.project.displayName = "Pumpkin Blaster Two";
    expect(await h.session.importText(JSON.stringify(doc), "fine.json")).toEqual({ ok: true });
    await drain(h);
    expect(snapshot(h).key).not.toBe(before.key);
    expect(JSON.parse(snapshot(h).doc).project.displayName).toBe("Pumpkin Blaster Two");
  });
});

describe("proposals cannot commit a credential-shaped value", () => {
  it("a spec proposal is refused at review, with no diff and no value in the message", async () => {
    const { h } = await boot();
    const before = snapshot(h);
    const r = await h.session.reviewProposal(proposal("spec", [{ op: "set", path: "/project/displayName", value: JSON.stringify(SECRET) }]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("validate");
      expect(r.message).not.toContain(SECRET);
    }
    expect(snapshot(h)).toEqual(before);
  });
  it("a manifest proposal is refused at review", async () => {
    const { h } = await boot();
    await h.session.project.actions.importAsset({ fileName: "hero.png", bytes: png(32, 32), category: "sprite", provenance: prov });
    await drain(h);
    const before = snapshot(h);
    const r = await h.session.reviewProposal(proposal("assets-metadata", [{ op: "set", path: "/assets/0/provenance/notes", value: JSON.stringify(SECRET) }]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("validate");
      expect(r.message).not.toContain(SECRET);
    }
    expect(snapshot(h)).toEqual(before);
  });
  it("commitDerived, the last seam, refuses a forged reviewed plan carrying a value in the spec or in a manifest", async () => {
    const { h, factory } = await boot();
    const state = h.session.project.currentState();
    if (state === null) throw new Error("no project");
    const before = snapshot(h);
    const forgedDoc = { ...(state.doc as Record<string, unknown>), project: { ...((state.doc as { project: object }).project), displayName: SECRET } };
    const a = h.session.applyReviewedProposal({ expected: state, plan: { ok: true, proposal: proposal("spec", []), doc: forgedDoc as never, manifests: state.manifests, diff: [] } });
    expect(a.ok).toBe(false);
    const forgedManifests = { ...state.manifests, levels: { ...state.manifests.levels, levels: [{ ...(state.manifests.levels.levels[0] ?? {}), id: "level-1", name: SECRET }] } };
    const b = h.session.applyReviewedProposal({ expected: state, plan: { ok: true, proposal: proposal("levels", []), doc: state.doc, manifests: forgedManifests as never, diff: [] } });
    expect(b.ok).toBe(false);
    for (const r of [a, b]) if (!r.ok) expect(r.message).not.toContain(SECRET);
    await drain(h);
    expect(snapshot(h)).toEqual(before);
    expect(await storedText(factory)).not.toContain(SECRET);
  });
  it("a clean proposal still plans and commits", async () => {
    const { h } = await boot();
    const r = await h.session.reviewProposal(proposal("gameplay", [{ op: "set", path: "/lives/start", value: "5" }]));
    if (!r.ok) throw new Error(r.message);
    expect(h.session.applyReviewedProposal(r)).toEqual({ ok: true });
    expect(h.session.project.getState().manifests?.gameplay.lives.start).toBe(5);
  });
  it("parseProposal itself is unchanged for a well-formed text", () => {
    expect(parseProposal(JSON.stringify(proposal("gameplay", [{ op: "set", path: "/lives/start", value: "5" }]))).ok).toBe(true);
  });
});

describe("exports fail closed", () => {
  it("exportBundle refuses a spec or a manifest holding a value and the message omits it", async () => {
    const { h } = await boot();
    const state = h.session.project.currentState();
    if (state === null) throw new Error("no project");
    expect(() => exportBundle({ specText: specWithSecret(), manifests: state.manifests, assets: new Map() })).toThrow(/credential-shaped/);
    try { exportBundle({ specText: specWithSecret(), manifests: state.manifests, assets: new Map() }); } catch (e) { expect((e as Error).message).not.toContain(SECRET); }
    const bad = { ...state.manifests, project: { ...state.manifests.project, projectId: state.manifests.project.projectId }, levels: { ...state.manifests.levels, levels: [{ id: "level-1", name: SECRET }] } };
    expect(() => exportBundle({ specText: pumpkinText, manifests: bad as never, assets: new Map() })).toThrow(/credential-shaped/);
  });
  it("a clean project still exports and the archive does not contain the value", async () => {
    const { h } = await boot();
    const out = await h.session.exportBundleBytes();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const back = await importBundle(out.bytes);
    expect(back.ok).toBe(true);
    if (back.ok) expect(JSON.stringify([back.project.specText, back.project.manifests])).not.toContain(SECRET);
  });
  it("releaseExport refuses before building a pack", async () => {
    const { h } = await boot();
    const state = h.session.project.currentState();
    if (state === null) throw new Error("no project");
    const r = await releaseExport({ items: [], plan: { ok: true, files: [], checks: [], projectId: "x" } as never, planChecks: [], specText: specWithSecret(), manifests: state.manifests, assets: new Map(), driftScript: "" });
    expect(r).toMatchObject({ ok: false, reason: "secret" });
    if (!r.ok && "message" in r) expect(r.message).not.toContain(SECRET);
  });
  it("refuseSecrets names a rule and a place, never the value", () => {
    const m = refuseSecrets({ doc: { a: { b: SECRET } }, manifests: {} });
    expect(m).toContain("a.b");
    expect(m).not.toContain(SECRET);
    expect(refuseSecrets({ doc: { a: "fine" }, manifests: { x: [1] } })).toBeNull();
  });
});
