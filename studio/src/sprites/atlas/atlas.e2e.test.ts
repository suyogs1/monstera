// Sprite authoring end to end: the authored spec persists, undoes, exports and imports; the REAL oracle reproduces every recorded
// checkpoint for it; and the real generator turns it into both native projects with the atlas and the sprite mappings intact.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drain, harness, type Harness } from "../../app/session.testkit";
import { png as stubPng } from "../../assets/fixtures.testkit";
import { Engine } from "../../derive/testEngine";
import { STORE_PROJECTS } from "../../project/idb";
import { addSheet, emptyAnimations } from "../edit";
import type { ProjectRecord } from "../../project/record";
import type { Provenance } from "../../project/manifests";
import { memoryMarker, newFactory, rawAll } from "../../project/testkit";
import { NEUTRAL_ATLAS } from "../../project/specV5";
import type { Json } from "../../schema/schema";
import { applySprites, spritesOfDoc, type SpriteChange } from "./apply";
import { buildAtlas } from "./build";
import { fromBase64 } from "./png";
import { LIMITS, paintedSheet } from "./atlas.testkit";

const repo = join(__dirname, "..", "..", "..", "..");
const prov: Provenance = { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" };

function py(args: string[], cwd = repo): string {
  let last: unknown;
  for (const c of [["python3"], ["python"], ["py", "-3"]]) {
    try { return execFileSync(c[0]!, [...c.slice(1), ...args], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { last = e; }
  }
  throw last;
}

async function boot(factory = newFactory()): Promise<{ h: Harness; factory: IDBFactory }> {
  const h = harness({ marker: memoryMarker(), factory });
  await h.session.start();
  await drain(h);
  return { h, factory };
}
const specText = (h: Harness) => JSON.stringify(h.session.store.getState().doc);

/** Imports an image asset, slices it into a sheet of the animations manifest (the existing editors' operations), builds the atlas. */
async function authorChange(h: Harness): Promise<SpriteChange> {
  const c = h.session.project.actions;
  const added = await c.importAsset({ fileName: "hero.png", bytes: stubPng(32, 32), category: "sprite", provenance: prov });
  if (!added.ok) throw new Error(added.reason);
  await drain(h);
  const image = h.session.project.getState().manifests!.assets.assets.find((a) => a.id === added.id)!;
  const pixels = paintedSheet({ columns: 2, rows: 2, cell: 16 });
  const sheet = addSheet({ ...emptyAnimations(), sheets: [], animations: [], schema: "", version: 1 } as never, "hero", image, { frameWidth: 16, frameHeight: 16, columns: 2, rows: 2, margin: 0, spacing: 0 });
  if (!sheet.ok) throw new Error(sheet.error);
  const kinds = spritesOfDoc(h.session.store.getState().doc as Json).kinds.map((k) => k.id);
  const built = await buildAtlas(pixels.image, sheet.value.sheets[0]!, LIMITS);
  if (!built.ok) throw new Error(built.error);
  return { atlas: built.atlas, sprites: { [kinds[0]!]: { frames: [0], ticksPerFrame: 1 }, [kinds[2]!]: { frames: [1, 2, 3], ticksPerFrame: 5 } } };
}
const neutral = (h: Harness): SpriteChange => ({ atlas: { ...NEUTRAL_ATLAS }, sprites: Object.fromEntries(spritesOfDoc(h.session.store.getState().doc as Json).kinds.map((k) => [k.id, { frames: [], ticksPerFrame: 1 }])) });

describe("authored sprites through the project", { timeout: 60_000 }, () => {
  it("apply is one undo step, is persisted, survives a reload, and undo and redo restore it", async () => {
    const { h, factory } = await boot();
    const sink = h.session.project;
    expect(await applySprites(sink, new Engine(), neutral(h))).toMatchObject({ ok: true });
    await drain(h);
    const blank = specText(h);
    const change = await authorChange(h);
    await drain(h);
    const r = await applySprites(sink, new Engine(), change);
    if (!r.ok) throw new Error(JSON.stringify(r));
    await drain(h);
    const authored = specText(h);
    expect(authored).not.toBe(blank);
    expect(spritesOfDoc(h.session.store.getState().doc as Json).atlas).toEqual(change.atlas);
    const [stored] = (await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[];
    expect(JSON.parse(stored!.specText).game.atlas).toEqual(change.atlas);
    // reload from storage: a new Session on the same database opens the authored spec
    const again = harness({ marker: memoryMarker(), factory });
    await again.session.start();
    await drain(again);
    expect(spritesOfDoc(again.session.store.getState().doc as Json).atlas).toEqual(change.atlas);
    // one undo step, then redo
    expect(sink.actions.undo()).toBe(true);
    await drain(h);
    expect(spritesOfDoc(h.session.store.getState().doc as Json).atlas).toEqual(NEUTRAL_ATLAS);
    expect(sink.actions.redo()).toBe(true);
    await drain(h);
    expect(specText(h)).toBe(authored);
  });
  it("a refused plan leaves the project, its history and its stored copy untouched", async () => {
    const { h } = await boot();
    const before = specText(h);
    const r = await applySprites(h.session.project, new Engine(), { sprites: { nope: { frames: [], ticksPerFrame: 1 } } });
    expect(r.ok).toBe(false);
    const bad = await applySprites(h.session.project, new Engine(), { sprites: { [spritesOfDoc(h.session.store.getState().doc as Json).kinds[0]!.id]: { frames: [250], ticksPerFrame: 1 } } });
    expect(bad).toMatchObject({ ok: false, stage: "engine" });
    expect(specText(h)).toBe(before);
  });
  it("the authored atlas and sprites export in a project bundle and import into another browser identically", async () => {
    const a = (await boot()).h;
    await applySprites(a.session.project, new Engine(), neutral(a));
    await drain(a);
    const change = await authorChange(a);
    expect(await applySprites(a.session.project, new Engine(), change)).toMatchObject({ ok: true });
    await drain(a);
    const out = await a.session.exportBundleBytes();
    if (!out.ok) throw new Error(out.message);
    const b = (await boot()).h;
    expect(await b.session.importBundleBytes(out.bytes, "sprites.zip")).toEqual({ ok: true });
    await drain(b);
    expect(specText(b)).toBe(specText(a));
    expect(spritesOfDoc(b.session.store.getState().doc as Json).kinds.map((k) => k.sprite)).toEqual(spritesOfDoc(a.session.store.getState().doc as Json).kinds.map((k) => k.sprite));
    // the sheet and the source asset (with its provenance) travel with it
    expect(b.session.project.getState().manifests!.assets.assets[0]!.provenance).toEqual(prov);
  });
});

describe("the authored spec against the real engine, oracle and generator", { timeout: 120_000 }, () => {
  async function authoredSpec(): Promise<{ file: string; doc: { game: { atlas: { png: string }; runtime: { kinds: { id: string; sprite: { frames: number[]; ticksPerFrame: number } }[] } } }; dir: string }> {
    const { h } = await boot();
    await applySprites(h.session.project, new Engine(), neutral(h));
    await drain(h);
    const change = await authorChange(h);
    const r = await applySprites(h.session.project, new Engine(), change);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const dir = mkdtempSync(join(tmpdir(), "monstera-atlas-"));
    const file = join(dir, "monstera.spec.json");
    writeFileSync(file, r.canonicalText);
    return { file, doc: JSON.parse(r.canonicalText), dir };
  }

  it("the Python CLI validates it and the real oracle reproduces every recorded checkpoint of the unchanged simulation", async () => {
    const { file } = await authoredSpec();
    expect(JSON.parse(py(["tools/monstera/monstera.py", "validate", file, "--json"]))).toMatchObject({ valid: true });
    const script = [
      "import json, sys",
      "sys.path.insert(0, 'tools/monstera')",
      "from monstera import scenario",
      "from monstera.jsonio import load_path",
      "from monstera.oracle import sim",
      "spec = json.load(open(sys.argv[1]))",
      "checked = bad = 0",
      "for p in scenario.scenario_files('pumpkin-blaster'):",
      "    data = load_path(p)",
      "    if data['frames']['count']: continue",
      "    got = [{'tick': r['tick'], 'hash': format(r['hash'], '016x'), 'observe': r['observe']} for r in sim.run_scenario(sim.Config(spec['game']), data)]",
      "    checked += 1",
      "    bad += got != data['checkpoints']",
      "print(json.dumps({'checked': checked, 'bad': bad}))",
    ].join("\n");
    const r = JSON.parse(py(["-c", script, file])) as { checked: number; bad: number };
    expect(r.checked).toBeGreaterThanOrEqual(3);
    expect(r.bad).toBe(0);
  });

  it("generates both native projects with the atlas bytes and every sprite mapping intact", async () => {
    const { doc, dir } = await authoredSpec();
    // Recorded goldens are bound to the spec text of their project, so a spec with a new project id (a fork) is generated without them;
    // the Studio export plan omits them for an edited draft the same way.
    const forked = { ...doc, project: { ...(doc as unknown as { project: object }).project, id: "atlas-authored" } };
    const file = join(dir, "fork.spec.json");
    writeFileSync(file, JSON.stringify(forked, null, 2));
    const out = join(dir, "out");
    py(["tools/monstera/monstera.py", "generate", file, "--out", out, "--layout", "fixture"]);
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const files = walk(out).map((f) => f.slice(out.length + 1).replaceAll("\\", "/"));
    const atlasAndroid = files.filter((f) => f === "android/app/src/main/assets/monstera-atlas.png");
    const atlasIos = files.filter((f) => /^ios\/Sources\/[^/]+\/Resources\/monstera-atlas\.png$/.test(f));
    expect(atlasAndroid).toHaveLength(1);
    expect(atlasIos).toHaveLength(1);
    const expected = Buffer.from(fromBase64(doc.game.atlas.png)!);
    for (const f of [...atlasAndroid, ...atlasIos]) expect(readFileSync(join(out, f)).equals(expected)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, "MONSTERA-MANIFEST.json"), "utf8")) as { files: { path: string; sha256: string }[] };
    const sha = createHash("sha256").update(expected).digest("hex");
    for (const f of [...atlasAndroid, ...atlasIos]) expect(manifest.files.find((m) => m.path === f)?.sha256).toBe(sha);
    // The apps read the sprites from the spec they bundle: it is the authored spec's game section.
    const embedded = files.filter((f) => /monstera\.spec\.json$/.test(f) && (f.startsWith("android/app/src/main/assets/") || /^ios\/Sources\/[^/]+\/Resources\//.test(f)));
    expect(embedded).toHaveLength(2);
    for (const f of embedded) {
      const spec = JSON.parse(readFileSync(join(out, f), "utf8")) as typeof doc;
      expect(spec.game.atlas).toEqual(doc.game.atlas);
      expect(spec.game.runtime.kinds.map((k) => [k.id, k.sprite])).toEqual(doc.game.runtime.kinds.map((k) => [k.id, k.sprite]));
    }
    expect(doc.game.runtime.kinds.filter((k) => k.sprite.frames.length > 1)).toHaveLength(1);
  });
});

describe("Priority 4 E2E: arbitrary crops (>128x128, mixed sizes, transparency) -> normalized atlas -> engine -> native Android/iOS", { timeout: 120_000 }, () => {
  it("preserves source crops, normalizes into uniform Spec v5 cells, validates, persists, exports/imports, and generates Android & iOS", async () => {
    const { h, factory } = await boot();
    const c = h.session.project.actions;
    const added = await c.importAsset({ fileName: "mixed-hero.png", bytes: stubPng(240, 160), category: "sprite", provenance: prov });
    if (!added.ok) throw new Error(added.reason);
    await drain(h);
    const asset = h.session.project.getState().manifests!.assets.assets.find((a) => a.id === added.id)!;

    // 4 arbitrary crops: one >128x128 (160x140), plus 48x24, 32x32, 64x40, with transparent background (alpha=0)
    const width = 240, height = 160;
    const data = new Uint8Array(width * height * 4); // initialized to transparent (0,0,0,0)
    const paint = (rx: number, ry: number, rw: number, rh: number, rgba: [number, number, number, number]) => {
      for (let y = ry + 4; y < ry + rh - 4; y++) {
        for (let x = rx + 4; x < rx + rw - 4; x++) {
          data.set(rgba, (y * width + x) * 4);
        }
      }
    };
    paint(0, 0, 160, 140, [255, 110, 0, 255]);    // hero-big (160x140)
    paint(160, 0, 48, 24, [40, 220, 120, 255]);   // step-a (48x24)
    paint(160, 30, 32, 32, [60, 160, 255, 255]);  // step-b (32x32)
    paint(160, 70, 64, 40, [240, 80, 200, 255]);  // step-c (64x40)

    const customFrames = [
      { id: "hero-big", x: 0, y: 0, w: 160, h: 140 },
      { id: "step-a", x: 160, y: 0, w: 48, h: 24 },
      { id: "step-b", x: 160, y: 30, w: 32, h: 32 },
      { id: "step-c", x: 160, y: 70, w: 64, h: 40 },
    ];
    const animManifest = {
      ...emptyAnimations(),
      schema: "monstera.studio.animations" as const,
      version: 1 as const,
      sheets: [{ id: "mixed-sheet", assetId: asset.id, grid: { frameWidth: 32, frameHeight: 32, columns: 4, rows: 1, margin: 0, spacing: 0 }, frames: customFrames }],
    };
    expect(c.commitManifest("animations", animManifest, "animations.sheets")).toMatchObject({ ok: true });
    await drain(h);

    // Normalize to uniform 64x64 cells with Contain + Nearest-neighbour
    const built = await buildAtlas({ width, height, data }, animManifest.sheets[0]!, LIMITS, {
      normalization: { cellWidth: 64, cellHeight: 64, fit: "contain", scaling: "nearest" },
    });
    if (!built.ok) throw new Error(built.error);
    expect(built.normalized).toBe(true);
    expect(built.atlas).toMatchObject({ frameWidth: 64, frameHeight: 64, columns: 4, rows: 1 });
    expect(built.sourceSizes).toEqual([
      { id: "hero-big", w: 160, h: 140 },
      { id: "step-a", w: 48, h: 24 },
      { id: "step-b", w: 32, h: 32 },
      { id: "step-c", w: 64, h: 40 },
    ]);

    const kinds = spritesOfDoc(h.session.store.getState().doc as Json).kinds.map((k) => k.id);
    const change: SpriteChange = {
      atlas: built.atlas,
      sprites: {
        ...Object.fromEntries(kinds.map((id) => [id, { frames: [], ticksPerFrame: 1 }])),
        [kinds[0]!]: { frames: [0], ticksPerFrame: 1 },
        [kinds[2]!]: { frames: [1, 2, 3], ticksPerFrame: 4 },
      },
    };

    const applied = await applySprites(h.session.project, new Engine(), change);
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    await drain(h);

    // 1. Source crops preserved in Studio manifest
    expect(h.session.project.getState().manifests!.animations.sheets[0]!.frames).toEqual(customFrames);
    // 2. Canonical spec has normalized atlas & sprite assignments
    expect(spritesOfDoc(h.session.store.getState().doc as Json).atlas).toEqual(built.atlas);
    expect(spritesOfDoc(h.session.store.getState().doc as Json).kinds.find((k) => k.id === kinds[2])?.sprite).toEqual({ frames: [1, 2, 3], ticksPerFrame: 4 });

    // 3. Reload from IndexedDB preserves both source crops and normalized atlas
    const reloaded = harness({ marker: memoryMarker(), factory });
    await reloaded.session.start();
    await drain(reloaded);
    expect(reloaded.session.project.getState().manifests!.animations.sheets[0]!.frames).toEqual(customFrames);
    expect(spritesOfDoc(reloaded.session.store.getState().doc as Json).atlas).toEqual(built.atlas);

    // 4. Bundle export/import preserves source crops and normalized atlas byte-for-byte
    const exported = await h.session.exportBundleBytes();
    if (!exported.ok) throw new Error(exported.message);
    const imported = (await boot()).h;
    expect(await imported.session.importBundleBytes(exported.bytes, "mixed.zip")).toEqual({ ok: true });
    await drain(imported);
    expect(imported.session.project.getState().manifests!.animations.sheets[0]!.frames).toEqual(customFrames);
    expect(spritesOfDoc(imported.session.store.getState().doc as Json).atlas).toEqual(built.atlas);

    // 5. Real Python CLI validate + real generator for Android & iOS
    const dir = mkdtempSync(join(tmpdir(), "monstera-norm-"));
    const specObj = JSON.parse(applied.canonicalText);
    specObj.project.id = "norm-e2e";
    const specFile = join(dir, "monstera.spec.json");
    writeFileSync(specFile, JSON.stringify(specObj, null, 2));
    expect(JSON.parse(py(["tools/monstera/monstera.py", "validate", specFile, "--json"]))).toMatchObject({ valid: true });

    const out = join(dir, "out");
    py(["tools/monstera/monstera.py", "generate", specFile, "--out", out, "--layout", "fixture"]);
    const expectedPng = Buffer.from(fromBase64(built.atlas.png)!);
    const androidAtlas = readFileSync(join(out, "android/app/src/main/assets/monstera-atlas.png"));
    const iosDirs = readdirSync(join(out, "ios/Sources"));
    const iosAtlas = readFileSync(join(out, `ios/Sources/${iosDirs[0]!}/Resources/monstera-atlas.png`));
    expect(androidAtlas.equals(expectedPng)).toBe(true);
    expect(iosAtlas.equals(expectedPng)).toBe(true);
  });
});
