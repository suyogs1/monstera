import { describe, expect, it } from "vitest";
import { setAt } from "../draft/path";
import type { Json } from "../schema/schema";
import { MANIFEST_NAMES } from "./manifests";
import { buildXrefIndex, XrefCache, XrefIndex, type XrefEntry, type XrefRefType } from "./xref";
import { validateManifest } from "./manifests";
import { pumpkinDoc, xrefManifests } from "./xref.testkit";
const where = (list: readonly XrefEntry[], type: XrefRefType): string[] => list.filter((e) => e.type === type).map((e) => e.pathText);
describe("references indexed per source", () => {
  const index = buildXrefIndex(pumpkinDoc(), xrefManifests());
  it("spec (designer): tapKind, starting entity, spawner and both sides of a collision", () => {
    expect(index.referencesToKind("bullet").filter((e) => e.manifest === "spec").map((e) => [e.type, e.pathText, e.module])).toEqual([
      ["spec.input.tapKind", "$.game.input.tapKind", "designer"],
      ["spec.collision.a", "$.game.runtime.collisions[0].a", "designer"],
      ["spec.collision.a", "$.game.runtime.collisions[1].a", "designer"],
    ]);
    expect(where(index.referencesToKind("player"), "spec.initialEntity.kind")).toEqual(["$.game.runtime.initialEntities[0].kind"]);
    expect(where(index.referencesToKind("player"), "spec.collision.b")).toEqual(
      ["$.game.runtime.collisions[2].b", "$.game.runtime.collisions[3].b", "$.game.runtime.collisions[4].b"]);
    expect(where(index.referencesToKind("star"), "spec.spawner.kind")).toEqual(["$.game.runtime.spawners[3].kind"]);
  });
  it("assets: every kindRefs element, with the owning asset", () => {
    expect(where(index.referencesToKind("star"), "assets.kindRefs")).toEqual(["assets:$.assets[0].kindRefs[0]"]);
    expect(where(index.referencesToKind("bat"), "assets.kindRefs")).toEqual(["assets:$.assets[1].kindRefs[0]"]);
    expect(where(index.referencesToKind("bullet"), "assets.kindRefs")).toEqual(["assets:$.assets[1].kindRefs[1]"]);
    expect(index.referencesToKind("bat").find((e) => e.type === "assets.kindRefs")).toMatchObject({ module: "assets", manifest: "assets", targetType: "kind", targetId: "bat" });
  });
  it("animations: kindRef (module sprites) and the sheet's asset id", () => {
    expect(where(index.referencesToKind("star"), "animations.kindRef")).toEqual(["animations:$.animations[0].kindRef"]);
    expect(index.referencesToKind("star").find((e) => e.type === "animations.kindRef")?.module).toBe("sprites");
    expect(index.referencesTo("asset", "asset-0001").map((e) => [e.type, e.pathText])).toEqual([["animations.sheet.assetId", "animations:$.sheets[0].assetId"]]);
  });
  it("levels: placements and waves of every level, not difficulty steps or streams", () => {
    const player = index.referencesToKind("player").filter((e) => e.manifest === "levels").map((e) => [e.type, e.pathText]);
    expect(player).toEqual([
      ["levels.placement.kind", "levels:$.levels[0].placements[0].kind"],
      ["levels.placement.kind", "levels:$.levels[1].placements[0].kind"],
    ]);
    expect(where(index.referencesToKind("star"), "levels.wave.kind")).toEqual(["levels:$.levels[0].waves[0].kind"]);
    expect(index.entries.some((e) => e.pathText.includes("difficulty") || e.pathText.includes("stream"))).toBe(false);
  });
  it("gameplay: all four kind fields", () => {
    expect(where(index.referencesToKind("star"), "gameplay.collectible.kind")).toEqual(["gameplay:$.collectibles[0].kind"]);
    expect(where(index.referencesToKind("player"), "gameplay.collectible.collectorKind")).toEqual(["gameplay:$.collectibles[0].collectorKind"]);
    expect(where(index.referencesToKind("bat"), "gameplay.enemy.kind")).toEqual(["gameplay:$.enemies[0].kind"]);
    expect(where(index.referencesToKind("player"), "gameplay.enemy.targetKind")).toEqual(["gameplay:$.enemies[0].targetKind"]);
  });
  it("integrations reward names and proposal paths are not references", () => {
    expect(index.entries.some((e) => e.manifest === "integrations" || e.manifest === "proposal")).toBe(false);
    const m = xrefManifests();
    const withReward = { ...m, integrations: { ...m.integrations, monetization: { ...m.integrations.monetization, placements: m.integrations.monetization.placements.map((p) => (p.type === "rewarded" ? { ...p, rewardKind: "star" } : p)) } } };
    expect(buildXrefIndex(pumpkinDoc(), withReward).entries.length).toBe(index.entries.length);
  });
  it("the project's active level is a level reference only while set", () => {
    expect(index.entries.some((e) => e.type === "project.activeLevel")).toBe(false);
    const m = xrefManifests();
    const on = buildXrefIndex(pumpkinDoc(), { ...m, project: { ...m.project, derivation: { ...m.project.derivation, activeLevel: "level-one" } } });
    expect(on.referencesTo("level", "level-one").map((e) => [e.module, e.pathText])).toEqual([["dashboard", "project:$.derivation.activeLevel"]]);
  });
  it("every manifest type that can hold a kind appears in the index", () => {
    expect([...new Set(index.entries.map((e) => e.manifest))]).toEqual(["spec", "assets", "animations", "levels", "gameplay"]);
    expect(MANIFEST_NAMES.length).toBe(7);
  });
});
describe("lookup", () => {
  const index = buildXrefIndex(pumpkinDoc(), xrefManifests());
  it("several references to one kind come back together, in index order", () => {
    const star = index.referencesToKind("star");
    expect(star.map((e) => e.manifest)).toEqual(["spec", "assets", "animations", "levels", "gameplay"]);
    expect(star.length).toBeGreaterThanOrEqual(5);
    expect(star).toEqual([...star].sort((a, b) => index.entries.indexOf(a) - index.entries.indexOf(b)));
  });
  it("a kind nobody refers to, an unknown kind and the empty id have no references", () => {
    expect(index.referencesToKind("ember").map((e) => e.manifest)).toEqual(["spec", "spec"]); // spawner + collision only
    expect(index.referencesToKind("ghost")).toEqual([]);
    expect(index.referencesToKind("")).toEqual([]);
  });
  it("missing and unknown kind ids: a manifest may name a kind the spec does not define", () => {
    const m = xrefManifests();
    const dangling = { ...m, animations: { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, kindRef: "ghost" })) } };
    const idx = buildXrefIndex(pumpkinDoc(), dangling);
    expect(idx.referencesToKind("ghost")).toHaveLength(1);
    expect(idx.isDefined("kind", "ghost")).toBe(false);
    expect(idx.isDefined("kind", "star")).toBe(true);
    expect(idx.isDefined("asset", "asset-0001")).toBe(true);
  });
  it("empty kind references (none) are skipped", () => {
    const doc = setAt(pumpkinDoc(), ["game", "input", "tapKind"], "");
    expect(buildXrefIndex(doc, xrefManifests()).entries.some((e) => e.type === "spec.input.tapKind")).toBe(false);
  });
  it("no document or no manifests still indexes what exists", () => {
    expect(buildXrefIndex(null, null).entries).toEqual([]);
    expect(buildXrefIndex(pumpkinDoc(), null).entries.every((e) => e.manifest === "spec")).toBe(true);
    expect(buildXrefIndex(null, xrefManifests()).entries.every((e) => e.manifest !== "spec")).toBe(true);
  });
});
describe("deterministic", () => {
  it("equal inputs give identical entry lists, regardless of key order in the inputs", () => {
    const a = buildXrefIndex(pumpkinDoc(), xrefManifests());
    const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v);
    const b = buildXrefIndex(reorder(pumpkinDoc()) as Json, reorder(xrefManifests()) as ReturnType<typeof xrefManifests>);
    expect(b.entries).toEqual(a.entries);
    expect(JSON.stringify(buildXrefIndex(pumpkinDoc(), xrefManifests()).entries)).toBe(JSON.stringify(a.entries));
  });
  it("entries are sorted by module, source and numeric path position (collisions[2] before collisions[10])", () => {
    const doc = pumpkinDoc();
    const rt = (doc as { game: { runtime: { collisions: unknown[] } } }).game.runtime;
    const many = { ...(doc as object), game: { ...(doc as { game: object }).game, runtime: { ...rt, collisions: Array.from({ length: 12 }, () => ({ a: "player", b: "bat", despawnA: false, despawnB: false, score: 0, lives: 0 })) } } } as Json;
    const paths = buildXrefIndex(many, null).entries.filter((e) => e.type === "spec.collision.a").map((e) => e.path[3]);
    expect(paths).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const modules = buildXrefIndex(pumpkinDoc(), xrefManifests()).entries.map((e) => e.module);
    expect(modules).toEqual([...modules].sort((x, y) => ["designer", "assets", "sprites", "levels", "gameplay"].indexOf(x) - ["designer", "assets", "sprites", "levels", "gameplay"].indexOf(y)));
  });
  it("the index is read-only and holds no editable kind list", () => {
    const idx = buildXrefIndex(pumpkinDoc(), xrefManifests());
    expect(Object.isFrozen(idx.entries)).toBe(true);
    expect(() => (idx.entries as XrefEntry[]).push(idx.entries[0] as XrefEntry)).toThrow();
    expect(Object.keys(idx)).toEqual(["entries"]); // lookup, definition sets and source inputs are private, not properties
  });
});
describe("stale and rebuilt index (XrefCache)", () => {
  it("reuses the index for the same objects and rebuilds when either input changes", () => {
    const cache = new XrefCache();
    const doc = pumpkinDoc(), m = xrefManifests();
    const first = cache.get(doc, m);
    expect(cache.get(doc, m)).toBe(first);
    expect(cache.builds).toBe(1);
    expect(first.isCurrent(doc, m)).toBe(true);
    const doc2 = setAt(doc, ["game", "input", "tapKind"], "star");
    expect(first.isCurrent(doc2, m)).toBe(false); // stale
    const second = cache.get(doc2, m);
    expect(second).not.toBe(first);
    expect(second.referencesToKind("star").some((e) => e.type === "spec.input.tapKind")).toBe(true);
    expect(first.referencesToKind("star").some((e) => e.type === "spec.input.tapKind")).toBe(false); // the old one is untouched
    const m2 = { ...m, gameplay: { ...m.gameplay, enemies: [] } };
    expect(cache.get(doc2, m2).referencesToKind("bat").some((e) => e.manifest === "gameplay")).toBe(false);
    expect(cache.builds).toBe(3);
  });
  it("invalidate forces a rebuild of identical inputs", () => {
    const cache = new XrefCache();
    const doc = pumpkinDoc(), m = xrefManifests();
    const a = cache.get(doc, m);
    cache.invalidate();
    const b = cache.get(doc, m);
    expect(b).not.toBe(a);
    expect(b.entries).toEqual(a.entries);
  });
});
describe("identifiers that share a kind id are still not kind references", () => {
  // Level streams, wave ids and the spec's spawner streams use the same id pattern as kinds. Here they are set to ids
  // that really ARE kinds of this spec (star, bat, bullet, player), so a scanner that matched by value would index them.
  it("wave ids, difficulty waveId and PRNG streams of a level", () => {
    const m = xrefManifests();
    const base = buildXrefIndex(pumpkinDoc(), m).entries;
    const levels = m.levels.levels.map((l) => ({
      ...l,
      waves: l.waves.map((w, j) => ({ ...w, id: j === 0 ? "star" : "bullet", stream: j === 0 ? "bat" : "player" })),
      difficulty: l.difficulty.map((d) => ({ ...d, waveId: l.waves.length > 1 ? "bullet" : "star", stream: "ember" })),
    }));
    const collided = { ...m, levels: { ...m.levels, levels } };
    expect(validateManifest("levels", collided.levels).ok).toBe(true); // the collision case is a valid manifest
    const idx = buildXrefIndex(pumpkinDoc(), collided);
    expect(idx.entries.map((e) => e.pathText)).toEqual(base.map((e) => e.pathText)); // exactly the same references
    const levelRefs = idx.entries.filter((e) => e.manifest === "levels");
    expect(levelRefs.every((e) => /\.(placements\[\d+\]|waves\[\d+\])\.kind$/.test(e.pathText))).toBe(true);
    expect(idx.entries.some((e) => /stream|waveId|\.id$/.test(e.pathText))).toBe(false);
    // the ids that collide gain no extra references
    expect(idx.referencesToKind("ember").map((e) => e.manifest)).toEqual(["spec", "spec"]);
  });
  it("a spec spawner's stream name equal to a kind id", () => {
    const doc = pumpkinDoc();
    const base = buildXrefIndex(doc, null).entries.length;
    const rt = (doc as { game: { runtime: { spawners: { stream: string }[] } } }).game.runtime;
    const renamed = setAt(doc, ["game", "runtime", "spawners"], rt.spawners.map((s, i) => ({ ...s, stream: ["player", "bullet", "star", "bat"][i] as string })) as Json);
    const idx = buildXrefIndex(renamed, null);
    expect(idx.entries.length).toBe(base);
    expect(idx.entries.some((e) => e.pathText.endsWith(".stream"))).toBe(false);
    expect(idx.entries.filter((e) => e.type === "spec.spawner.kind").map((e) => e.targetId)).toEqual(["pumpkin", "bat", "ember", "star"]);
  });
});
describe("the index is read-only at runtime", () => {
  const index = buildXrefIndex(pumpkinDoc(), xrefManifests());
  it("the instance, the entry list, every entry and every path are frozen", () => {
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index.entries)).toBe(true);
    for (const e of index.entries) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.path)).toBe(true);
    }
  });
  it("assigning to or extending any of them throws", () => {
    const e = index.entries[0] as XrefEntry;
    expect(() => { (e as { targetId: string }).targetId = "x"; }).toThrow(TypeError);
    expect(() => { (e as { module: string }).module = "assets"; }).toThrow(TypeError);
    expect(() => (e.path as (string | number)[]).push("x")).toThrow(TypeError);
    expect(() => { (e.path as (string | number)[])[0] = "x"; }).toThrow(TypeError);
    expect(() => (index.entries as XrefEntry[]).pop()).toThrow(TypeError);
    expect(() => { (index as unknown as { entries: XrefEntry[] }).entries = []; }).toThrow(TypeError);
    expect(() => { (index as unknown as { sourceDoc: Json }).sourceDoc = null; }).toThrow(TypeError); // nothing of that name to replace on a frozen instance
  });
  it("lists returned by referencesTo and referencesToKind are frozen, and so is the empty result", () => {
    for (const list of [index.referencesToKind("star"), index.referencesTo("kind", "player"), index.referencesTo("asset", "asset-0001"), index.referencesToKind("ghost"), index.referencesTo("level", "none")]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(() => (list as XrefEntry[]).push(index.entries[0] as XrefEntry)).toThrow(TypeError);
      expect(() => (list as XrefEntry[]).splice(0)).toThrow(TypeError);
    }
  });
  it("lookup and entry list stay the same objects and the same answers after attempted tampering", () => {
    const before = JSON.stringify(index.entries);
    const star = index.referencesToKind("star");
    try { (star as XrefEntry[]).length = 0; } catch { /* frozen */ }
    try { (star[0] as { targetId: string }).targetId = "x"; } catch { /* frozen */ }
    expect(JSON.stringify(index.entries)).toBe(before);
    expect(index.referencesToKind("star")).toBe(star);
    expect(star.every((e) => index.entries.includes(e))).toBe(true); // the same entry objects, so the two cannot disagree
    expect(index.referencesToKind("x")).toEqual([]);
  });
});
describe("definition sources", () => {
  it("a missing, malformed or unreadable kind list is not an empty kind set", () => {
    const m = xrefManifests();
    const empty = buildXrefIndex({ game: { runtime: { kinds: [] } } }, m);
    expect(empty.canJudge("kind")).toBe(true); // an empty list is readable: it defines nothing
    for (const doc of [null, {}, { game: { runtime: {} } }, { game: { runtime: { kinds: "x" } } }, { game: { runtime: { kinds: [{ glyph: "" }] } } }, { game: { runtime: { kinds: [{ id: 3 }] } } }] as (Json | null)[]) {
      const idx = buildXrefIndex(doc, m);
      expect(idx.canJudge("kind")).toBe(false);
      expect(idx.isDefined("kind", "star")).toBe(false);
    }
  });
  it("a missing assets or levels manifest is not an empty asset or level set", () => {
    const m = xrefManifests();
    const { assets: _a, levels: _l, ...rest } = m;
    void _a; void _l;
    const idx = buildXrefIndex(pumpkinDoc(), rest);
    expect([idx.canJudge("asset"), idx.canJudge("level"), idx.canJudge("kind")]).toEqual([false, false, true]);
    expect(buildXrefIndex(pumpkinDoc(), m).canJudge("asset")).toBe(true);
  });
});describe("lookup and definition storage cannot be reached or mutated from outside", () => {
  const make = () => buildXrefIndex(pumpkinDoc(), xrefManifests());
  const answers = (idx: XrefIndex) => ({
    star: idx.referencesToKind("star").map((e) => e.pathText),
    asset: idx.referencesTo("asset", "asset-0001").map((e) => e.pathText),
    defined: [idx.isDefined("kind", "star"), idx.isDefined("kind", "ghost"), idx.isDefined("asset", "asset-0001"), idx.isDefined("asset", "asset-9999"), idx.isDefined("level", "level-1"), idx.isDefined("level", "level-9")],
    judge: [idx.canJudge("kind"), idx.canJudge("asset"), idx.canJudge("level")],
  });
  it("neither the lookup Map nor the definition Sets are properties of the instance or its prototype", () => {
    const idx = make();
    const keys = Reflect.ownKeys(idx);
    expect(keys.map(String)).toEqual(["entries"]);
    for (const k of keys) expect([Map, Set].some((T) => (idx as unknown as Record<string | symbol, unknown>)[k] instanceof T)).toBe(false);
    expect(Reflect.ownKeys(XrefIndex.prototype).map(String).sort()).toEqual(["canJudge", "constructor", "isCurrent", "isDefined", "referencesTo", "referencesToKind"]);
    const loose = idx as unknown as Record<string, unknown>;
    for (const name of ["byTarget", "kinds", "assets", "levels", "definitions", "sourceDoc", "sourceManifests", "#byTarget", "#kinds", "#assets", "#levels", "#sourceDoc", "#sourceManifests"]) expect(loose[name]).toBeUndefined();
  });
  it("attempts to mutate the lookup or the definitions through the instance fail and change no answer", () => {
    const idx = make();
    const before = answers(idx);
    const loose = idx as unknown as Record<string, { set: (k: string, v: unknown) => void; add: (v: string) => void; clear: () => void } | undefined>;
    expect(() => loose["byTarget"]?.clear()).not.toThrow(); // undefined?.: there is nothing to reach
    expect(() => (loose["byTarget"] as unknown as { set: () => void }).set()).toThrow(TypeError);
    expect(() => (loose["kinds"] as unknown as { add: (v: string) => void }).add("ghost")).toThrow(TypeError);
    expect(() => Object.defineProperty(idx, "byTarget", { value: new Map() })).toThrow(TypeError); // frozen: no new properties either
    expect(() => Object.defineProperty(idx, "kinds", { value: new Set(["ghost"]) })).toThrow(TypeError);
    expect(answers(idx)).toEqual(before);
    expect(before.defined).toEqual([true, false, true, false, true, false]);
    expect(before.star).toHaveLength(5);
    expect(before.asset).toEqual(["animations:$.sheets[0].assetId"]);
  });
  it("the methods only work on a real index, so they cannot be pointed at attacker-controlled storage", () => {
    const fake = { byTarget: new Map(), kinds: new Set(["ghost"]) };
    expect(() => XrefIndex.prototype.isDefined.call(fake as unknown as XrefIndex, "kind", "ghost")).toThrow(TypeError);
    expect(() => XrefIndex.prototype.referencesTo.call(fake as unknown as XrefIndex, "kind", "star")).toThrow(TypeError);
    expect(() => XrefIndex.prototype.canJudge.call(fake as unknown as XrefIndex, "kind")).toThrow(TypeError);
  });
  it("two indexes never share storage: tampering with a returned list or one index leaves the other correct", () => {
    const a = make(), b = make();
    const star = a.referencesToKind("star");
    try { (star as XrefEntry[]).length = 0; } catch { /* frozen */ }
    expect(answers(b)).toEqual(answers(a));
    expect(a.referencesToKind("star")).toBe(star);
    expect(b.referencesToKind("star")).not.toBe(star);
  });
  it("isDefined, canJudge and referencesTo stay correct for present, unknown and unavailable sources", () => {
    const m = xrefManifests();
    const full = make();
    expect(answers(full).judge).toEqual([true, true, true]);
    const { assets: _a, ...noAssets } = m;
    void _a;
    const partial = buildXrefIndex(pumpkinDoc(), noAssets);
    expect(partial.canJudge("asset")).toBe(false);
    expect(partial.isDefined("asset", "asset-0001")).toBe(false); // unavailable is not "defined"; canJudge says it could not be answered
    expect(partial.referencesTo("asset", "asset-0001")).toHaveLength(1); // the reference itself is still indexed
    expect(partial.isDefined("kind", "star")).toBe(true);
    expect(buildXrefIndex(null, null).referencesToKind("star")).toEqual([]);
  });
});
describe("the input references are private, and staleness is still detected from them", () => {
  it("sourceDoc and sourceManifests cannot be read, replaced or redefined by a consumer", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const idx = buildXrefIndex(doc, m);
    const loose = idx as unknown as Record<string, unknown>;
    expect(loose["sourceDoc"]).toBeUndefined();
    expect(loose["sourceManifests"]).toBeUndefined();
    expect(Object.getOwnPropertyNames(idx)).toEqual(["entries"]);
    expect(() => { loose["sourceDoc"] = null; }).toThrow(TypeError);
    expect(() => { loose["sourceManifests"] = null; }).toThrow(TypeError);
    expect(() => Object.defineProperty(idx, "sourceDoc", { value: null })).toThrow(TypeError);
    expect(idx.isCurrent(doc, m)).toBe(true); // the private references are untouched
    expect(idx.isCurrent(null, null)).toBe(false);
    expect(idx.isCurrent(doc, null)).toBe(false);
    expect(idx.isCurrent(null, m)).toBe(false);
    expect(() => XrefIndex.prototype.isCurrent.call({ sourceDoc: doc, sourceManifests: m } as unknown as XrefIndex, doc, m)).toThrow(TypeError);
  });
  it("isCurrent is an identity check on both inputs", () => {
    const doc = pumpkinDoc(), m = xrefManifests();
    const idx = buildXrefIndex(doc, m);
    expect(idx.isCurrent(doc, m)).toBe(true);
    expect(idx.isCurrent(pumpkinDoc(), m)).toBe(false); // equal content, different object: not the same input
    expect(idx.isCurrent(doc, { ...m })).toBe(false);
    expect(buildXrefIndex(null, null).isCurrent(null, null)).toBe(true);
  });
  it("XrefCache rebuilds whenever either input identity changes and never hands back an index of other inputs", () => {
    const cache = new XrefCache();
    const d1 = pumpkinDoc(), d2 = setAt(d1, ["game", "input", "tapKind"], "star");
    const m1 = xrefManifests(), m2 = { ...m1, gameplay: { ...m1.gameplay, enemies: [] } };
    const steps: [Json, ReturnType<typeof xrefManifests>][] = [[d1, m1], [d2, m1], [d2, m2], [d1, m2], [d1, m1]];
    let last: XrefIndex | null = null;
    steps.forEach(([d, m], i) => {
      const idx = cache.get(d, m);
      expect(idx.isCurrent(d, m)).toBe(true);
      expect(idx).not.toBe(last); // each step changed an input, so each step is a new index (the old one is not reused)
      expect(cache.get(d, m)).toBe(idx); // unchanged inputs reuse it
      expect(JSON.stringify(idx.entries)).toBe(JSON.stringify(buildXrefIndex(d, m).entries));
      expect(cache.builds).toBe(i + 1);
      last = idx;
    });
    expect(cache.get(d2, m1).isCurrent(d1, m1)).toBe(false);
    const stale = cache.get(d1, m1);
    cache.invalidate();
    expect(cache.get(d1, m1)).not.toBe(stale);
  });
});