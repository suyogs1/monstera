import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Baseline } from "../draft/store";
import { buildDefaultManifests, buildDefaultManifestsOrThrow, deriveBaseline, DefaultManifestsFailure, migrationDefaultManifests, type DefaultManifestsInput } from "./defaults";
import { STORE_PROJECTS, openDb } from "./idb";
import { MANIFEST_NAMES, parseManifest, serializeManifest } from "./manifests";
import { LEGACY_KEY, LEGACY_PROJECT_KEY, migrateLegacyDraft, readLegacyDraft } from "./migrate";
import { sha256Hex, type ProjectRecord } from "./record";
import { baseline, identityCanonicalize, manifestsFor, newFactory, pumpkinText, rawGet, readOnlyStorage } from "./testkit";

const h = (c: string): string => c.repeat(64);
const input = (over: Partial<DefaultManifestsInput> = {}): DefaultManifestsInput =>
  ({ projectId: "my-game", specBaseSha256: h("a"), specCurrentSha256: h("a"), engine: { gitCommit: "b".repeat(40) }, runtime: { lives: 4, winScore: 250 }, ...over });

describe("buildDefaultManifests", () => {
  it("builds valid, project-specific manifests for every name, from the given inputs only", () => {
    const r = buildDefaultManifests(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const n of MANIFEST_NAMES) expect(parseManifest(n, serializeManifest(n, r.manifests[n] as never)).ok).toBe(true);
    expect(r.manifests.project).toMatchObject({ projectId: "my-game", spec: { baseSha256: h("a"), currentSha256: h("a") }, engine: { gitCommit: "b".repeat(40) } });
    expect(r.manifests.project.derivation).toEqual({ levels: false, gameplay: false, activeLevel: "" });
    expect(r.manifests.project.derived.inputsSha256).toBe("");
  });

  it("holds no sample content: it differs from the Lantern Run fixtures and contains nothing of them", () => {
    const r = buildDefaultManifests(input());
    if (!r.ok) throw new Error("unreachable");
    const fixtures = manifestsFor("my-game");
    for (const n of ["assets", "animations", "levels", "gameplay", "integrations", "proposal"] as const) expect(r.manifests[n]).not.toEqual(fixtures[n]);
    const text = MANIFEST_NAMES.map((n) => serializeManifest(n, r.manifests[n] as never)).join("");
    expect(text).not.toMatch(/lantern|wisp|keeper|asset-0001|71c77e4/i);
    expect(r.manifests.assets.assets).toEqual([]);
    expect(r.manifests.levels.levels).toEqual([]);
    expect(r.manifests.integrations.monetization).toEqual({ provider: "admob", mode: "mock", placements: [] });
  });

  it("is deterministic and depends on its inputs", () => {
    expect(buildDefaultManifests(input())).toEqual(buildDefaultManifests(input()));
    const other = buildDefaultManifests(input({ projectId: "other-game", engine: { gitCommit: "c".repeat(40) } }));
    expect(other.ok && other.manifests.project.projectId).toBe("other-game");
    expect(other.ok && other.manifests.project.engine.gitCommit).toBe("c".repeat(40));
  });

  it.each([
    ["no projectId", { projectId: "" }, ["projectId"]],
    ["no base hash", { specBaseSha256: null }, ["specBaseSha256"]],
    ["no current hash", { specCurrentSha256: null }, ["specCurrentSha256"]],
    ["no engine commit", { engine: { gitCommit: undefined } }, ["engine.gitCommit"]],
    ["several", { specBaseSha256: null, engine: { gitCommit: "" } }, ["specBaseSha256", "engine.gitCommit"]],
    ["no runtime lives", { runtime: { lives: undefined, winScore: 250 } }, ["runtime.lives"]],
    ["no runtime win score", { runtime: { lives: 4, winScore: null } }, ["runtime.winScore"]],
    ["no runtime facts at all", { runtime: { lives: null, winScore: null } }, ["runtime.lives", "runtime.winScore"]],
  ])("%s: a typed missing-input error listing exactly what is missing, nothing invented", (_n, over, missing) => {
    const r = buildDefaultManifests(input(over as Partial<DefaultManifestsInput>));
    expect(r).toMatchObject({ ok: false, error: { code: "missing-input", missing } });
    expect("manifests" in r).toBe(false);
  });

  it.each([
    ["a short engine commit", { engine: { gitCommit: "abc123" } }, "engine.gitCommit"],
    ["a placeholder engine commit", { engine: { gitCommit: "unknown" } }, "engine.gitCommit"],
    ["an upper-case hash", { specBaseSha256: h("A") }, "specBaseSha256"],
    ["a short current hash", { specCurrentSha256: "abc" }, "specCurrentSha256"],
    ["fractional lives", { runtime: { lives: 2.5, winScore: 0 } }, "runtime.lives"],
    ["a string win score", { runtime: { lives: 3, winScore: "1000" as unknown as number } }, "runtime.winScore"],
  ])("%s is invalid-input", (_n, over, field) => {
    expect(buildDefaultManifests(input(over as Partial<DefaultManifestsInput>))).toMatchObject({ ok: false, error: { code: "invalid-input", field } });
  });

  it("out-of-range runtime values are rejected by the gameplay manifest's own validator, not clamped", () => {
    expect(buildDefaultManifests(input({ runtime: { lives: 0, winScore: 0 } }))).toMatchObject({ ok: false, error: { code: "invalid-manifest", manifest: "gameplay" } });
    expect(buildDefaultManifests(input({ runtime: { lives: 3, winScore: -1 } }))).toMatchObject({ ok: false, error: { code: "invalid-manifest", manifest: "gameplay" } });
  });

  it("gameplay mirrors the given runtime values and stays unconfigured otherwise", () => {
    const r = buildDefaultManifests(input());
    expect(r.ok && r.manifests.gameplay).toMatchObject({ lives: { start: 4 }, score: { winScore: 250 }, collectibles: [], enemies: [] });
    expect(r.ok && r.manifests.project.derivation.gameplay).toBe(false);
  });

  it("a base hash that differs from the current hash is reported, not hidden (no derivation is on)", () => {
    expect(buildDefaultManifests(input({ specCurrentSha256: h("d") }))).toMatchObject({ ok: false, error: { code: "spec-hash-mismatch" } });
  });

  it("an invalid project id surfaces as invalid-manifest", () => {
    expect(buildDefaultManifests(input({ projectId: "Bad Id" }))).toMatchObject({ ok: false, error: { code: "invalid-manifest", manifest: "project" } });
  });

  it("the throwing form carries the typed error", () => {
    expect(() => buildDefaultManifestsOrThrow(input({ specBaseSha256: null }))).toThrow(DefaultManifestsFailure);
    expect(buildDefaultManifestsOrThrow(input()).project.projectId).toBe("my-game");
  });

  it("plugs into the migration's defaultManifests runtime: ctx carries the baseline and spec hashes; missing inputs refuse the draft", async () => {
    const raw = JSON.stringify({ version: 1, docText: pumpkinText, baseline });
    const specSha = await sha256Hex(pumpkinText);
    const rt = (gitCommit: string | undefined) => ({
      legacy: readOnlyStorage({ [LEGACY_KEY]: raw }), sha256: sha256Hex, canonicalize: identityCanonicalize,
      defaultManifests: (ctx: { projectId: string; specSha256: string; baselineSha256: string | null }) =>
        buildDefaultManifestsOrThrow({ projectId: ctx.projectId, specBaseSha256: specSha, specCurrentSha256: ctx.specSha256, engine: { gitCommit }, runtime: { lives: 5, winScore: 1000 } }),
    });
    const ok = await readLegacyDraft(rt("e".repeat(40)));
    expect(ok.status === "recovered" && ok.snapshot.manifests.project.spec.currentSha256).toBe(specSha);
    expect(ok.status === "recovered" && ok.snapshot.manifests.project.engine.gitCommit).toBe("e".repeat(40));
    expect(await readLegacyDraft(rt(undefined))).toMatchObject({ status: "refused", reason: "inputs-unavailable" });
    const seen: (string | null)[] = [];
    await readLegacyDraft({ ...rt("e".repeat(40)), defaultManifests: (ctx) => { seen.push(ctx.baselineSha256); return manifestsFor(ctx.projectId); } });
    expect(seen).toEqual([baseline.sha256]);
    const noSha = JSON.stringify({ version: 1, docText: pumpkinText, baseline: { ...baseline, sha256: null } });
    await readLegacyDraft({ ...rt("e".repeat(40)), legacy: readOnlyStorage({ [LEGACY_KEY]: noSha }), defaultManifests: (ctx) => { seen.push(ctx.baselineSha256); return manifestsFor(ctx.projectId); } });
    expect(seen[1]).toBe(await sha256Hex(pumpkinText)); // derived from baseline.canonicalText
  });
});

// The production wiring (migrationDefaultManifests) over the real readLegacyDraft / migrateLegacyDraft path. runtimeOf
// stands in for Session's engine-validated document: it reads runtime.lives and runtime.winScore from the spec text.
describe("migrationDefaultManifests: production wiring", () => {
  const engine = { gitCommit: "e".repeat(40) };
  const runtimeOf = (t: string) => {
    const r = (JSON.parse(t) as { game: { runtime: { lives: number; winScore: number } } }).game.runtime;
    return { lives: r.lives, winScore: r.winScore };
  };
  const trickText = readFileSync(join(__dirname, "..", "..", "..", "apps", "trick-or-treat-rush", "monstera.spec.json"), "utf8");
  async function m3Baseline(id: string, text: string): Promise<Baseline> {
    return {
      label: id, templateId: id, group: "official", canonicalText: text, sha256: await sha256Hex(text),
      origin: { templateId: id, path: `apps/${id}/monstera.spec.json`, basis: "template", canonicalText: text },
    };
  }
  const runtime = (raw: string) => ({ legacy: readOnlyStorage({ [LEGACY_KEY]: raw }), sha256: sha256Hex, now: () => 1, canonicalize: identityCanonicalize, defaultManifests: migrationDefaultManifests({ engine, runtimeOf }) });

  it("an edited Pumpkin Blaster draft migrates: base = current = edited spec hash, baseline kept, derivation off", async () => {
    const original = await m3Baseline("pumpkin-blaster", pumpkinText);
    expect(pumpkinText.split('"winScore": 1000').length).toBe(2); // exactly one occurrence to edit
    const editedText = pumpkinText.replace('"winScore": 1000', '"winScore": 1500');
    const editedSha = await sha256Hex(editedText);
    expect(editedSha).not.toBe(original.sha256);
    const raw = JSON.stringify({ version: 1, docText: editedText, baseline: original });

    const read = await readLegacyDraft(runtime(raw));
    expect(read.status).toBe("recovered");
    if (read.status !== "recovered") return;
    expect(read.snapshot.baseline).toEqual(original);
    expect(read.snapshot.manifests.project.spec).toEqual({ path: "monstera.spec.json", baseSha256: editedSha, currentSha256: editedSha });
    expect(read.snapshot.manifests.project.derivation).toEqual({ levels: false, gameplay: false, activeLevel: "" });
    expect(read.snapshot.manifests.gameplay).toMatchObject({ lives: { start: 5 }, score: { winScore: 1500 }, collectibles: [], enemies: [] });

    const factory = newFactory();
    const conn = await openDb(factory);
    expect(await migrateLegacyDraft(conn, runtime(raw))).toMatchObject({ status: "migrated", projectKey: LEGACY_PROJECT_KEY });
    const stored = (await rawGet(factory, STORE_PROJECTS, LEGACY_PROJECT_KEY)) as ProjectRecord;
    expect(stored.baseline).toEqual(original);
    expect(stored.specText).toBe(editedText);
    expect(stored.specSha256).toBe(editedSha);
    const pm = parseManifest("project", stored.manifests.project);
    expect(pm.ok && pm.value.spec).toEqual({ path: "monstera.spec.json", baseSha256: editedSha, currentSha256: editedSha });
    expect(pm.ok && pm.value.derivation.gameplay).toBe(false);
    conn.close();
  });

  it.each([
    ["Pumpkin Blaster", "pumpkin-blaster", () => pumpkinText, 5, 1000],
    ["Trick or Treat Rush", "trick-or-treat-rush", () => trickText, 3, 0],
  ])("%s keeps its real lives and win score", async (_n, id, text, lives, winScore) => {
    const t = text();
    const read = await readLegacyDraft(runtime(JSON.stringify({ version: 1, docText: t, baseline: await m3Baseline(id, t) })));
    expect(read.status === "recovered" && read.snapshot.manifests.gameplay).toMatchObject({ lives: { start: lives }, score: { winScore }, collectibles: [], enemies: [] });
    expect(read.status === "recovered" && read.snapshot.manifests.project.projectId).toBe(id);
  });

  it("refuses (never invents) when the engine identity or the validated runtime is unavailable", async () => {
    const raw = JSON.stringify({ version: 1, docText: pumpkinText, baseline: await m3Baseline("pumpkin-blaster", pumpkinText) });
    const noEngine = { ...runtime(raw), defaultManifests: migrationDefaultManifests({ engine: undefined, runtimeOf }) };
    expect(await readLegacyDraft(noEngine)).toMatchObject({ status: "refused", reason: "inputs-unavailable" });
    const rejected = { ...runtime(raw), defaultManifests: migrationDefaultManifests({ engine, runtimeOf: () => null }) };
    expect(await readLegacyDraft(rejected)).toMatchObject({ status: "refused", reason: "inputs-unavailable" });
  });
});

describe("deriveBaseline", () => {
  const templates = [{ id: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json", sha256: h("1"), canonicalText: "T" }, { id: "no-text", path: "x", sha256: h("2"), canonicalText: null }];
  const ok = (sha: string | null) => ({ ok: true, canonicalText: "C", sha256: sha });

  it("an import without a matching template has no origin", () => {
    expect(deriveBaseline({ label: "mine.json", validation: ok(h("9")), templates })).toEqual({
      ok: true, baseline: { label: "mine.json", templateId: null, group: "import", canonicalText: "C", sha256: h("9"), origin: null },
    });
  });
  it("a spec identical (canonical SHA-256) to a template takes that template as origin with basis identical", () => {
    expect(deriveBaseline({ label: "copy.json", validation: ok(h("1")), templates })).toEqual({
      ok: true, baseline: { label: "copy.json", templateId: null, group: "import", canonicalText: "C", sha256: h("1"), origin: { templateId: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json", basis: "identical", canonicalText: "T" } },
    });
    const noText = deriveBaseline({ label: "x", validation: ok(h("2")), templates });
    expect(noText.ok && noText.baseline.origin).toBeNull();
  });
  it("refuses a spec the engine did not validate", () => {
    expect(deriveBaseline({ label: "x", validation: { ok: false, canonicalText: null, sha256: null }, templates }).ok).toBe(false);
    expect(deriveBaseline({ label: "x", validation: { ok: true, canonicalText: "C", sha256: null }, templates }).ok).toBe(false);
  });
});
