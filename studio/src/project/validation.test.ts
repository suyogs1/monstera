import { describe, expect, it } from "vitest";
import type { DraftValidation } from "../engine/protocol";
import { aggregateValidation } from "./validation";
import { buildXrefIndex, XREF_REFERENCE_SOURCES } from "./xref";
import type { Json } from "../schema/schema";
import { pumpkinDoc, xrefManifests } from "./xref.testkit";
const clean: DraftValidation = { ok: true, parsed: true, issues: [], sha256: "a".repeat(64), canonicalText: "{}" };
describe("aggregateValidation", () => {
  it("a consistent project with a passing engine verdict has no issues", () => {
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: xrefManifests() });
    expect(r).toMatchObject({ ok: true, issues: [], counts: { engine: 0, manifest: 0, xref: 0 }, engineMissing: false });
  });
  it("combines engine, manifest and cross-reference issues, each with its module and exact path", () => {
    const m = xrefManifests();
    const manifests = {
      ...m,
      gameplay: { ...m.gameplay, collectibles: [...m.gameplay.collectibles, { ...(m.gameplay.collectibles[0] as object), kind: "ghost" } as never] }, // duplicate id (manifest rule) and unknown kind
      animations: { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, kindRef: "ghost" })) },
      levels: { ...m.levels, levels: m.levels.levels.map((l, i) => (i === 1 ? { ...l, waves: l.waves.map((w) => ({ ...w, kind: "phantom" })) } : l)) },
    };
    const engine: DraftValidation = { ok: false, parsed: true, sha256: null, canonicalText: null, issues: [{ path: "$.game.runtime.spawners[1].kind", code: "ref.unknown-kind", message: "unknown kind" }] };
    const r = aggregateValidation({ engine, doc: pumpkinDoc(), manifests });
    const view = r.issues.map((i) => [i.source, i.module, i.manifest, i.pathText, i.code]);
    expect(view).toEqual([
      ["engine", "designer", "spec", "$.game.runtime.spawners[1].kind", "ref.unknown-kind"],
      ["manifest", "gameplay", "gameplay", "gameplay:$.collectibles[1].id", "duplicate-id"],
      ["xref", "sprites", "animations", "animations:$.animations[0].kindRef", "xref.unknown-kind"],
      ["xref", "levels", "levels", "levels:$.levels[1].waves[0].kind", "xref.unknown-kind"],
    ]);
    expect(r.issues[0]?.path).toEqual(["game", "runtime", "spawners", 1, "kind"]);
    expect(r.issues[2]?.path).toEqual(["animations", 0, "kindRef"]);
    expect(r.issues[2]?.message).toContain("'ghost'");
    expect(r.counts).toEqual({ engine: 1, manifest: 1, xref: 2 });
    expect(r.ok).toBe(false);
  });
  it("a manifest that fails its own validation is reported once and skipped by the cross-reference check", () => {
    const m = xrefManifests();
    const broken = { ...m, gameplay: { ...m.gameplay, collectibles: [], enemies: [{ ...(m.gameplay.enemies[0] as object), kind: "ghost", extra: 1 } as never] } };
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: broken });
    expect(r.counts).toEqual({ engine: 0, manifest: 1, xref: 0 });
    expect(r.issues[0]).toMatchObject({ source: "manifest", module: "gameplay", manifest: "gameplay" });
  });
  it("an unknown asset in an animation sheet and an unknown active level are cross-reference issues", () => {
    const m = xrefManifests();
    const manifests = {
      ...m,
      animations: { ...m.animations, sheets: m.animations.sheets.map((s) => ({ ...s, assetId: "asset-9999" })) },
    };
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests });
    expect(r.issues.map((i) => [i.source, i.code, i.pathText])).toEqual([["xref", "xref.unknown-asset", "animations:$.sheets[0].assetId"]]);
  });
  it("integrations issues are routed to Backend or Monetization by path", () => {
    const m = xrefManifests();
    const manifests = { ...m, integrations: { ...m.integrations, monetization: { ...m.integrations.monetization, placements: m.integrations.monetization.placements.map((p) => (p.type === "rewarded" ? { ...p, rewardAmount: 0 } : p)) } } };
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests });
    expect(r.issues.map((i) => [i.source, i.module, i.code])).toEqual([["manifest", "monetization", "reward"]]);
  });
  it("without an engine verdict the other issues are still reported and the project is not ok", () => {
    const r = aggregateValidation({ engine: null, doc: pumpkinDoc(), manifests: xrefManifests() });
    expect(r).toMatchObject({ engineMissing: true, ok: false, issues: [] });
  });
  it("an engine issue whose path is not a plain field path is kept verbatim with an empty path", () => {
    const engine: DraftValidation = { ok: false, parsed: true, sha256: null, canonicalText: null, issues: [{ path: "$", code: "json.syntax", message: "bad" }] };
    expect(aggregateValidation({ engine, doc: null, manifests: null }).issues).toEqual([
      { source: "engine", module: "designer", manifest: "spec", path: [], pathText: "$", code: "json.syntax", message: "bad" }]);
  });
  it("is deterministic and accepts a prebuilt index only for the same objects", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const manifests = { ...m, animations: { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, kindRef: "ghost" })) } };
    const idx = buildXrefIndex(doc, manifests);
    const a = aggregateValidation({ engine: clean, doc, manifests, index: idx });
    expect(aggregateValidation({ engine: clean, doc, manifests })).toEqual(a);
    const stale = aggregateValidation({ engine: clean, doc, manifests: m, index: idx }); // index of other manifests is ignored
    expect(stale.counts.xref).toBe(0);
  });
});
describe("unknown target versus unavailable definition source", () => {
  const view = (r: ReturnType<typeof aggregateValidation>) => r.issues.map((i) => [i.source, i.pathText, i.code]);
  /** A valid project manifest that compiles levels and names an active level. */
  const withActiveLevel = (m: ReturnType<typeof xrefManifests>, activeLevel: string) => ({
    ...m, project: { ...m.project, derivation: { levels: true, gameplay: false, activeLevel }, derived: { inputsSha256: "b".repeat(64) } },
  });
  it("1. an invalid Assets manifest does not make an existing asset unknown", () => {
    const m = xrefManifests();
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: { ...m, assets: { ...m.assets, bogus: 1 } as never } });
    expect(view(r)).toEqual([["manifest", "assets:$.bogus", "additional"]]); // animations reference the existing asset-0001
    expect(r.xrefSkipped).toEqual({ sources: ["assets"], targets: ["asset"] });
  });
  it("2. an invalid Levels manifest does not make an existing active level unknown", () => {
    const m = withActiveLevel(xrefManifests(), "level-1");
    expect(aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: m }).issues).toEqual([]); // valid baseline
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: { ...m, levels: { ...m.levels, bogus: 1 } as never } });
    expect(view(r)).toEqual([["manifest", "levels:$.bogus", "additional"]]);
    expect(r.xrefSkipped).toEqual({ sources: ["levels"], targets: ["level"] });
  });
  it("3. a genuinely unknown asset is still reported while Assets is valid", () => {
    const m = xrefManifests();
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: { ...m, animations: { ...m.animations, sheets: m.animations.sheets.map((s) => ({ ...s, assetId: "asset-9999" })) } } });
    expect(view(r)).toEqual([["xref", "animations:$.sheets[0].assetId", "xref.unknown-asset"]]);
    expect(r.xrefSkipped).toEqual({ sources: [], targets: [] });
  });
  it("4. a genuinely unknown level is still reported while Levels is valid", () => {
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: withActiveLevel(xrefManifests(), "level-9") });
    expect(view(r)).toEqual([["xref", "project:$.derivation.activeLevel", "xref.unknown-level"]]);
    expect(r.issues[0]).toMatchObject({ module: "dashboard", manifest: "project", path: ["derivation", "activeLevel"] });
  });
  it("5. a malformed or unavailable kind-definition source produces no unknown-kind diagnostics, and says so", () => {
    const m = xrefManifests();
    const bad: (Json | null)[] = [{}, { game: { runtime: {} } }, { game: { runtime: { kinds: "x" } } }, { game: { runtime: { kinds: [{ glyph: "" }] } } }, { game: { runtime: { kinds: [{ id: 3 }] } } }];
    for (const doc of bad) {
      const r = aggregateValidation({ engine: clean, doc, manifests: m });
      expect(r.issues, JSON.stringify(doc)).toEqual([]);
      expect(r.xrefSkipped.targets).toEqual(["kind"]);
    }
    // contrast: a readable list that defines no kinds is a real answer, so every manifest kind reference is unknown
    const none = aggregateValidation({ engine: clean, doc: { game: { runtime: { kinds: [] } } }, manifests: m });
    expect(none.counts.xref).toBeGreaterThan(5);
    expect(none.xrefSkipped.targets).toEqual([]);
    expect(aggregateValidation({ engine: clean, doc: null, manifests: m }).issues).toEqual([]);
  });
  it("6. an invalid reference-source manifest keeps its own issues, its outgoing checks are suppressed and reported, and valid manifests are still checked", () => {
    const m = xrefManifests();
    const manifests = {
      ...m,
      gameplay: { ...m.gameplay, enemies: [{ ...(m.gameplay.enemies[0] as object), kind: "ghost", extra: 1 } as never] }, // invalid, and refers to an unknown kind
      animations: { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, kindRef: "ghost" })) }, // valid, unknown kind
    };
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests });
    expect(view(r)).toEqual([
      ["manifest", "gameplay:$.enemies[0].extra", "additional"], // retained
      ["xref", "animations:$.animations[0].kindRef", "xref.unknown-kind"], // valid manifest still checked against the trustworthy kind list
    ]);
    expect(r.xrefSkipped).toEqual({ sources: ["gameplay"], targets: [] }); // the suppression is explicit
    // once the manifest is valid its outgoing references are checked again
    const fixed = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: { ...manifests, gameplay: { ...manifests.gameplay, enemies: [{ ...(m.gameplay.enemies[0] as object), kind: "ghost" } as never] } } });
    expect(view(fixed).map((v) => v[1])).toEqual(["animations:$.animations[0].kindRef", "gameplay:$.enemies[0].kind"]);
    expect(fixed.xrefSkipped.sources).toEqual([]);
  });
  it("a missing definition manifest is likewise unavailable, never empty", () => {
    const { levels: _l, ...rest } = withActiveLevel(xrefManifests(), "level-1");
    void _l;
    const r = aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests: rest });
    expect(r.issues).toEqual([]);
    expect(r.xrefSkipped.targets).toEqual(["level"]);
  });
});describe("ok: a skipped required check is not a pass", () => {
  const withActiveLevel = (m: ReturnType<typeof xrefManifests>, activeLevel: string) => ({
    ...m, project: { ...m.project, derivation: { levels: true, gameplay: false, activeLevel }, derived: { inputsSha256: "b".repeat(64) } },
  });
  const run = (manifests: Parameters<typeof aggregateValidation>[0]["manifests"], doc: Json | null = pumpkinDoc()) => aggregateValidation({ engine: clean, doc, manifests });
  it("a fully valid project is ok, with nothing skipped", () => {
    const r = run(xrefManifests());
    expect(r).toMatchObject({ ok: true, issues: [], xrefSkipped: { sources: [], targets: [] } });
    expect(run(withActiveLevel(xrefManifests(), "level-1"))).toMatchObject({ ok: true, xrefSkipped: { sources: [], targets: [] } });
  });
  it("a missing Assets manifest with a valid Animations manifest referencing an asset: no issue about the asset, but not ok", () => {
    const { assets: _a, ...rest } = xrefManifests();
    void _a;
    const r = run(rest);
    expect(r.issues).toEqual([]); // "could not check" is not "not found"
    expect(r.xrefSkipped).toEqual({ sources: [], targets: ["asset"] });
    expect(r.ok).toBe(false);
  });
  it("a missing Levels manifest with a valid Project manifest referencing an active level: no issue about the level, but not ok", () => {
    const { levels: _l, ...rest } = withActiveLevel(xrefManifests(), "level-1");
    void _l;
    const r = run(rest);
    expect(r.issues).toEqual([]);
    expect(r.xrefSkipped).toEqual({ sources: [], targets: ["level"] });
    expect(r.ok).toBe(false);
  });
  it("a missing definition source that nothing refers to skips nothing, so it does not block ok", () => {
    const { levels: _l, ...rest } = xrefManifests(); // the fixture project has no active level
    void _l;
    expect(run(rest)).toMatchObject({ ok: true, issues: [], xrefSkipped: { sources: [], targets: [] } });
  });
  it("invalid definition sources are not ok (Assets, Levels) and say which targets were not judged", () => {
    const m = withActiveLevel(xrefManifests(), "level-1");
    const assets = run({ ...m, assets: { ...m.assets, bogus: 1 } as never });
    expect(assets).toMatchObject({ ok: false, xrefSkipped: { sources: ["assets"], targets: ["asset"] } });
    const levels = run({ ...m, levels: { ...m.levels, bogus: 1 } as never });
    expect(levels).toMatchObject({ ok: false, xrefSkipped: { sources: ["levels"], targets: ["level"] } });
  });
  it("an unreadable kind source is not ok even though it adds no issue", () => {
    for (const doc of [null, {}, { game: { runtime: { kinds: "x" } } }] as (Json | null)[]) {
      const r = run(xrefManifests(), doc);
      expect(r.issues).toEqual([]);
      expect(r.xrefSkipped.targets).toEqual(["kind"]);
      expect(r.ok).toBe(false);
    }
  });
  it("an invalid reference source is not ok: its manifest issue stays and its outgoing checks are reported as skipped", () => {
    const m = xrefManifests();
    const r = run({ ...m, gameplay: { ...m.gameplay, enemies: [{ ...(m.gameplay.enemies[0] as object), extra: 1 } as never] } });
    expect(r.counts).toEqual({ engine: 0, manifest: 1, xref: 0 });
    expect(r.xrefSkipped).toEqual({ sources: ["gameplay"], targets: [] });
    expect(r.ok).toBe(false);
  });
  it("a genuinely unknown id is an issue (not found), with nothing skipped (it could be checked)", () => {
    const m = xrefManifests();
    const r = run({ ...m, animations: { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, kindRef: "ghost" })) } });
    expect(r.counts.xref).toBe(1);
    expect(r.xrefSkipped).toEqual({ sources: [], targets: [] });
    expect(r.ok).toBe(false);
  });
  it("without manifests or without any reference there is nothing to skip", () => {
    expect(run(null)).toMatchObject({ ok: true, xrefSkipped: { sources: [], targets: [] } });
  });
});
describe("xrefSkipped.sources lists only manifests that can hold indexed references", () => {
  const run = (manifests: Parameters<typeof aggregateValidation>[0]["manifests"]) => aggregateValidation({ engine: clean, doc: pumpkinDoc(), manifests });
  it("an invalid proposal manifest keeps its manifest issue and is not described as a skipped cross-reference source", () => {
    const m = xrefManifests();
    const r = run({ ...m, proposal: { ...m.proposal, bogus: 1 } as never });
    expect(r.issues.map((i) => [i.source, i.manifest, i.pathText, i.code])).toEqual([["manifest", "proposal", "proposal:$.bogus", "additional"]]);
    expect(r.issues[0]?.module).toBe("kiro");
    expect(r.xrefSkipped).toEqual({ sources: [], targets: [] });
    expect(r.ok).toBe(false); // because of the manifest issue, not because a check was skipped
  });
  it("an invalid integrations manifest keeps its manifest issue and is not described as a skipped cross-reference source", () => {
    const m = xrefManifests();
    const r = run({ ...m, integrations: { ...m.integrations, bogus: 1 } as never });
    expect(r.issues.map((i) => [i.source, i.manifest, i.pathText, i.code])).toEqual([["manifest", "integrations", "integrations:$.bogus", "additional"]]);
    expect(r.xrefSkipped).toEqual({ sources: [], targets: [] });
    expect(r.ok).toBe(false);
  });
  it("they do not hide the sources that really are suppressed, and valid manifests are still checked", () => {
    const m = xrefManifests();
    const r = run({
      ...m,
      proposal: { ...m.proposal, bogus: 1 } as never,
      integrations: { ...m.integrations, bogus: 1 } as never,
      gameplay: { ...m.gameplay, enemies: [{ ...(m.gameplay.enemies[0] as object), extra: 1 } as never] },
      animations: { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, kindRef: "ghost" })) },
    });
    expect(r.counts).toEqual({ engine: 0, manifest: 3, xref: 1 });
    expect(r.xrefSkipped).toEqual({ sources: ["gameplay"], targets: [] });
    expect(r.issues.filter((i) => i.source === "manifest").map((i) => i.manifest)).toEqual(["gameplay", "integrations", "proposal"]);
  });
  it("an invalid project manifest does count: it carries the active-level reference", () => {
    const m = xrefManifests();
    const r = run({ ...m, project: { ...m.project, bogus: 1 } as never });
    expect(r.xrefSkipped.sources).toEqual(["project"]);
    expect(r.counts.manifest).toBe(1);
  });
  it("every listed source really is one the index reads references from", () => {
    expect([...XREF_REFERENCE_SOURCES]).toEqual(["assets", "animations", "levels", "gameplay", "project"]);
    const idx = buildXrefIndex(pumpkinDoc(), withEveryReference());
    expect([...new Set(idx.entries.map((e) => e.manifest))].filter((n) => n !== "spec").sort()).toEqual([...XREF_REFERENCE_SOURCES].sort());
  });
  it("missing definition sources that no valid manifest references still do not block ok", () => {
    const { levels: _l, ...rest } = xrefManifests();
    void _l;
    expect(run(rest)).toMatchObject({ ok: true, xrefSkipped: { sources: [], targets: [] } });
  });
});
function withEveryReference() {
  const m = xrefManifests();
  return { ...m, project: { ...m.project, derivation: { levels: true, gameplay: false, activeLevel: "level-1" }, derived: { inputsSha256: "b".repeat(64) } } };
}