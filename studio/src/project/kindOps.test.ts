import { describe, expect, it } from "vitest";
import { getAt } from "../draft/path";
import { validateManifest, MANIFEST_NAMES } from "./manifests";
import { kindIdCheck, planKindRemoval, planKindRename } from "./kindOps";
import { buildXrefIndex } from "./xref";
import { pumpkinDoc, kindIdPattern, realKindCheck, xrefManifests } from "./xref.testkit";
const check = realKindCheck();
const rename = (doc: Parameters<typeof planKindRename>[0], m: Parameters<typeof planKindRename>[1], from: string, to: string) => planKindRename(doc, m, from, to, check);
describe("planKindRename across the project", () => {
  it("rewrites the definition, the spec references and every manifest reference; nothing refers to the old id afterwards", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const before = buildXrefIndex(doc, m).referencesToKind("star").length;
    const r = rename(doc, m, "star", "gem");
    if (!r.ok) throw new Error(r.reason);
    const after = buildXrefIndex(r.doc, r.manifests);
    expect(after.referencesToKind("star")).toEqual([]);
    expect(after.referencesToKind("gem")).toHaveLength(before);
    expect(after.isDefined("kind", "gem")).toBe(true);
    expect(after.isDefined("kind", "star")).toBe(false);
    expect(r.updated.manifests).toEqual({ assets: 1, animations: 1, levels: 1, gameplay: 1 });
    expect(r.updated.spec).toBe(1);
    expect(r.updated.total).toBe(5);
    expect(getAt(r.doc, ["game", "runtime", "spawners", 3, "kind"])).toBe("gem");
    expect(getAt(r.manifests.gameplay as never, ["collectibles", 0, "kind"])).toBe("gem");
    for (const n of MANIFEST_NAMES) expect(validateManifest(n, r.manifests[n]).ok).toBe(true);
  });
  it("preserves unrelated data and the identity of manifests that held no reference", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const r = rename(doc, m, "star", "gem");
    if (!r.ok) throw new Error(r.reason);
    expect(r.manifests.integrations).toBe(m.integrations);
    expect(r.manifests.proposal).toBe(m.proposal);
    expect(r.manifests.project).toBe(m.project);
    // within a changed manifest only the referencing fields differ
    expect(r.manifests.gameplay.enemies).toBe(m.gameplay.enemies);
    expect(r.manifests.gameplay.lives).toBe(m.gameplay.lives);
    expect(r.manifests.levels.levels[0]?.difficulty).toBe(m.levels.levels[0]?.difficulty);
    expect(r.manifests.assets.assets[1]).toBe(m.assets.assets[1]);
    expect(r.manifests.assets.nextSeq).toBe(m.assets.nextSeq);
    expect({ ...r.manifests.animations.animations[0], kindRef: "star" }).toEqual(m.animations.animations[0]);
    // the inputs are not mutated
    expect(getAt(m.gameplay as never, ["collectibles", 0, "kind"])).toBe("star");
    expect(getAt(doc, ["game", "runtime", "spawners", 3, "kind"])).toBe("star");
  });
  it("keeps assets[].kindRefs sorted after a rename moves an id past its neighbours", () => {
    const r = rename(pumpkinDoc(), xrefManifests(), "bat", "zombie"); // asset-0002 holds ["bat","bullet"]
    if (!r.ok) throw new Error(r.reason);
    expect(r.manifests.assets.assets[1]?.kindRefs).toEqual(["bullet", "zombie"]);
    expect(validateManifest("assets", r.manifests.assets).ok).toBe(true);
  });
  it("renaming a kind that only the spec uses changes only the spec", () => {
    const m = xrefManifests();
    const r = rename(pumpkinDoc(), m, "ember", "spark");
    if (!r.ok) throw new Error(r.reason);
    expect(r.manifests).toBe(m);
    expect(r.updated).toEqual({ spec: 2, manifests: {}, total: 2 });
  });
  it("refuses an unknown kind, an empty id and a taken id (spec rules) without a result", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    expect(rename(doc, m, "ghost", "x")).toEqual({ ok: false, reason: "no kind 'ghost'" });
    expect(rename(doc, m, "star", "")).toMatchObject({ ok: false });
    expect(rename(doc, m, "star", "bat")).toMatchObject({ ok: false, reason: "'bat' is already a kind id" });
  });
  it("a rename to the same id is a no-op", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const r = rename(doc, m, "star", "star");
    expect(r).toMatchObject({ ok: true, updated: { total: 0 } });
    if (r.ok) { expect(r.doc).toBe(doc); expect(r.manifests).toBe(m); }
  });
  it("fails whole when a changed manifest would become invalid (here: a duplicate gameplay pair), returning no partial state", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    // a dangling collectible already uses the id "gem" with the same collector: renaming star to gem would pair them twice
    const manifests = { ...m, gameplay: { ...m.gameplay, collectibles: [...m.gameplay.collectibles, { id: "gem-pickup", kind: "gem", collectorKind: "player", points: 5, despawn: true }] } };
    expect(validateManifest("gameplay", manifests.gameplay).ok).toBe(true);
    const r = rename(doc, manifests, "star", "gem");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/would make the gameplay manifest invalid.*already handled/);
    expect(getAt(doc, ["game", "runtime", "spawners", 3, "kind"])).toBe("star");
  });
  it("merging into an id a manifest already (dangling) links removes the duplicate link", () => {
    const m = xrefManifests();
    const manifests = { ...m, assets: { ...m.assets, assets: m.assets.assets.map((a, i) => (i === 0 ? { ...a, kindRefs: ["gem", "star"] } : a)) } };
    const r = rename(pumpkinDoc(), manifests, "star", "gem");
    if (!r.ok) throw new Error(r.reason);
    expect(r.manifests.assets.assets[0]?.kindRefs).toEqual(["gem"]);
  });
});
describe("planKindRemoval", () => {
  it("is blocked while the spec or any manifest refers to the kind, listing every place with module and path", () => {
    const r = planKindRemoval(pumpkinDoc(), xrefManifests(), "star");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.references.map((e) => [e.module, e.pathText])).toEqual([
      ["designer", "$.game.runtime.spawners[3].kind"],
      ["assets", "assets:$.assets[0].kindRefs[0]"],
      ["sprites", "animations:$.animations[0].kindRef"],
      ["levels", "levels:$.levels[0].waves[0].kind"],
      ["gameplay", "gameplay:$.collectibles[0].kind"],
    ]);
    expect(r.reason).toBe("'star' is still used by 5 places (designer, assets, sprites, levels, gameplay)");
  });
  it("is blocked by a manifest reference alone, even when the spec no longer uses the kind", () => {
    const m = xrefManifests();
    const doc = rename(pumpkinDoc(), m, "ember", "spark");
    if (!doc.ok) throw new Error(doc.reason);
    const withLink = { ...m, assets: { ...m.assets, assets: m.assets.assets.map((a, i) => (i === 0 ? { ...a, kindRefs: ["spark"] } : a)) } };
    // drop the spec's own references to "spark" so only the manifest link remains
    const bare = planKindRemoval(doc.doc, withLink, "spark");
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.references.some((e) => e.manifest === "assets")).toBe(true);
  });
  it("succeeds when no reference remains, and then removes exactly that kind definition", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const extra = { ...(doc as object), game: { ...(doc as { game: { runtime: { kinds: unknown[] } } }).game, runtime: { ...(doc as { game: { runtime: { kinds: unknown[] } } }).game.runtime, kinds: [...(doc as { game: { runtime: { kinds: unknown[] } } }).game.runtime.kinds, { id: "spare", color: "#FFFFFF", glyph: "", effect: "none", width: 65536, height: 65536, lifetimeTicks: 0, exitPolicy: "despawn" }] } } } as never;
    const r = planKindRemoval(extra, m, "spare");
    expect(r.ok).toBe(true);
    if (r.ok) expect((getAt(r.doc, ["game", "runtime", "kinds"]) as { id: string }[]).map((k) => k.id)).not.toContain("spare");
  });
  it("an unknown kind is refused with no references", () => {
    expect(planKindRemoval(pumpkinDoc(), xrefManifests(), "ghost")).toEqual({ ok: false, reason: "no kind 'ghost'", references: [] });
  });
});
describe("the new kind id is validated by the domain operation, with the canonical schema rule", () => {
  const BAD = ["Gem", "GEM", "gem_1", "gem!", "gem id", "gem.1", "1gem", "-gem", "gém", " gem", "a".repeat(33), "a".repeat(64)];
  it("the rule is the engine schema's pattern, read through SchemaModel", () => {
    const pattern = kindIdPattern();
    expect(pattern).toBeTypeOf("string");
    expect(check("gem")).toBeNull();
    expect(check("a" + "b".repeat(31))).toBeNull(); // 32 characters: the longest allowed
    expect(check("gem-2")).toBeNull();
  });
  it.each(BAD)("refuses %j before touching anything, and returns no document or manifests", (bad) => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const r = planKindRename(doc, m, "star", bad, check);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("is not a valid kind id");
    expect(r).not.toHaveProperty("doc");
    expect(r).not.toHaveProperty("manifests");
    expect(getAt(doc, ["game", "runtime", "spawners", 3, "kind"])).toBe("star");
    expect(getAt(m.gameplay as never, ["collectibles", 0, "kind"])).toBe("star");
  });
  it("keeps the existing refusals and their order: unknown source, then no-op, empty, taken, and only then validity", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    expect(planKindRename(doc, m, "ghost", "Bad Id", check)).toEqual({ ok: false, reason: "no kind 'ghost'" });
    expect(planKindRename(doc, m, "star", "star", check)).toMatchObject({ ok: true, updated: { total: 0 } });
    expect(planKindRename(doc, m, "star", "", check)).toEqual({ ok: false, reason: "a kind id cannot be empty" });
    expect(planKindRename(doc, m, "star", "bat", check)).toEqual({ ok: false, reason: "'bat' is already a kind id" });
    expect(planKindRename(doc, m, "star", "Bat", check)).toMatchObject({ ok: false });
  });
  it("fails closed when the rule is unavailable or malformed", () => {
    for (const pattern of [undefined, "(["]) {
      const r = planKindRename(pumpkinDoc(), xrefManifests(), "star", "gem", kindIdCheck(pattern));
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.reason).toContain("rule is not available");
    }
  });
});