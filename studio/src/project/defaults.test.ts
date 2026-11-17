import { describe, expect, it } from "vitest";
import { buildDefaultManifests, buildDefaultManifestsOrThrow, deriveBaseline, DefaultManifestsFailure, type DefaultManifestsInput } from "./defaults";
import { MANIFEST_NAMES, parseManifest, serializeManifest } from "./manifests";
import { LEGACY_KEY, readLegacyDraft } from "./migrate";
import { sha256Hex } from "./record";
import { baseline, manifestsFor, pumpkinText, readOnlyStorage } from "./testkit";

const h = (c: string): string => c.repeat(64);
const input = (over: Partial<DefaultManifestsInput> = {}): DefaultManifestsInput =>
  ({ projectId: "my-game", specBaseSha256: h("a"), specCurrentSha256: h("a"), engine: { gitCommit: "b".repeat(40) }, ...over });

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
  ])("%s is invalid-input", (_n, over, field) => {
    expect(buildDefaultManifests(input(over as Partial<DefaultManifestsInput>))).toMatchObject({ ok: false, error: { code: "invalid-input", field } });
  });

  it("a baseline hash that differs from the current hash is reported, not hidden (no derivation is on)", () => {
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
      legacy: readOnlyStorage({ [LEGACY_KEY]: raw }), sha256: sha256Hex,
      defaultManifests: (ctx: { projectId: string; specSha256: string; baselineSha256: string | null }) =>
        buildDefaultManifestsOrThrow({ projectId: ctx.projectId, specBaseSha256: specSha, specCurrentSha256: ctx.specSha256, engine: { gitCommit } }),
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
