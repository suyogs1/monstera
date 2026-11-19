// Task 8.1: one fixture per error class blocks export; warnings do not; the plan check; the readiness wording.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../assets/import";
import type { DraftValidation, ExportPlan } from "../engine/protocol";
import { unnegatedClaims } from "../integrations/scaffold/scan";
import type { ManifestMap } from "../project/manifests";
import { aggregateValidation } from "../project/validation";
import { pumpkinDoc, xrefManifests } from "../project/xref.testkit";
import { REGISTRY } from "../app/capabilities";
import { blocking, canExport, checkCompleteness, ERROR_CLASSES, verifyPlan, type CheckClass, type CompletenessInput } from "./completeness";
import { CompletenessView, ReadinessView } from "./Release";
import { NOT_CLAIMED, readiness } from "./readiness";

const clean: DraftValidation = { ok: true, parsed: true, issues: [], sha256: "a".repeat(64), canonicalText: "{}" };
const input = (over: Partial<{ engine: DraftValidation | null; manifests: ManifestMap } & Omit<CompletenessInput, "aggregate" | "manifests">> = {}): CompletenessInput => {
  const manifests = over.manifests ?? xrefManifests();
  const engine = over.engine === undefined ? clean : over.engine;
  return {
    pending: over.pending ?? false,
    aggregate: aggregateValidation({ engine, doc: pumpkinDoc(), manifests }),
    manifests,
    derivation: over.derivation === undefined ? "none" : over.derivation,
    derivationOn: over.derivationOn ?? false,
    missingBlobs: over.missingBlobs === undefined ? [] : over.missingBlobs,
  };
};
const classes = (i: CompletenessInput) => new Set(checkCompleteness(i).filter((x) => x.severity === "error").map((x) => x.class));

describe("completeness check: a consistent project", () => {
  it("has no error, so export is allowed", () => {
    const items = checkCompleteness(input());
    expect(blocking(items)).toEqual([]);
    expect(canExport(items)).toBe(true);
  });
});

describe("completeness check: one fixture per error class blocks export", () => {
  const m = xrefManifests();
  const fixtures: Record<Exclude<CheckClass, "plan-mismatch" | "goldens-omitted" | "asset-unused">, () => CompletenessInput> = {
    engine: () => input({ engine: { ok: false, parsed: true, sha256: null, canonicalText: null, issues: [{ path: "$.game.runtime.lives", code: "range", message: "lives out of range" }] } }),
    "not-validated": () => input({ engine: null, pending: true }),
    manifest: () => input({ manifests: { ...m, gameplay: { ...m.gameplay, collectibles: [...m.gameplay.collectibles, m.gameplay.collectibles[0] as never] } } }),
    "asset-missing": () => input({ manifests: { ...m, animations: { ...m.animations, sheets: m.animations.sheets.map((s) => ({ ...s, assetId: "asset-999" })) } } }),
    "reference-missing": () => input({ manifests: { ...m, levels: { ...m.levels, levels: m.levels.levels.map((l) => ({ ...l, waves: l.waves.map((w) => ({ ...w, kind: "phantom" })) })) } } }),
    "animation-frame": () => input({ manifests: { ...m, animations: { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, sequence: [{ frameId: "nope", holdFrames: 1 }] })) } } }),
    "unknown-ad": () => input({ manifests: { ...m, integrations: { ...m.integrations, monetization: { ...m.integrations.monetization, placements: [{ ...(m.integrations.monetization.placements[0] as object), trigger: "on-moon" } as never] } } } }),
    "derived-stale": () => input({ derivation: "stale", derivationOn: true }),
    "asset-bytes": () => input({ missingBlobs: [m.assets.assets[0]?.id ?? "asset-1"] }),
    unverified: () => input({ derivation: null, derivationOn: true }),
  };
  for (const [cls, make] of Object.entries(fixtures)) {
    it(`${cls} is an error and blocks export`, () => {
      const items = checkCompleteness(make());
      expect(items.some((i) => i.class === cls && i.severity === "error"), JSON.stringify(items)).toBe(true);
      expect(canExport(items)).toBe(false);
    });
  }
  it("every error class except the plan check has a fixture, and the plan check has its own tests below", () => {
    expect(Object.keys(fixtures).sort()).toEqual(ERROR_CLASSES.filter((c) => c !== "plan-mismatch").slice().sort());
  });
  it("a check that has not run is not a clean result: unread stored files and unread derivation block", () => {
    expect(classes(input({ missingBlobs: null }))).toContain("unverified");
    expect(classes(input({ derivation: null, derivationOn: true }))).toContain("unverified");
  });
  it("derivation freshness is ignored while no derivation is on", () => {
    expect(canExport(checkCompleteness(input({ derivation: "stale", derivationOn: false })))).toBe(true);
  });
});

describe("completeness check: warnings do not block", () => {
  it("an image that no entity or sheet uses is a warning only", () => {
    const m = xrefManifests();
    const sheetAssets = new Set(m.animations.sheets.map((s) => s.assetId));
    const free = m.assets.assets.find((a) => a.kind === "image" && !sheetAssets.has(a.id));
    const manifests = free ? { ...m, assets: { ...m.assets, assets: m.assets.assets.map((a) => (a === free ? { ...a, kindRefs: [] } : a)) } } : m;
    const items = checkCompleteness(input({ manifests }));
    if (free) expect(items.some((i) => i.class === "asset-unused" && i.severity === "warning")).toBe(true);
    expect(canExport(items)).toBe(true);
  });
});

// A small plan in the shape the engine returns: a generator manifest listing the other files.
const enc = new TextEncoder();
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
async function planOf(over: { tamper?: boolean; spec?: string; drop?: boolean; omitted?: boolean } = {}): Promise<Extract<ExportPlan, { ok: true }>> {
  const body = enc.encode("fun main() {}\n");
  const bodyHash = await sha256Bytes(body);
  const manifest = enc.encode(JSON.stringify({ files: [{ path: "android/Main.kt", sha256: bodyHash }, ...(over.drop ? [{ path: "ios/Gone.swift", sha256: bodyHash }] : [])] }));
  const file = (path: string, bytes: Uint8Array, sha: string) => ({ path, mode: 0o644, size: bytes.length, sha256: sha, kind: "template", data: b64(bytes) });
  return {
    ok: true, projectId: "p", specSha256: over.spec ?? "a".repeat(64), label: "apps/p/monstera.spec.json", layout: "app", manifestSha256: await sha256Bytes(manifest),
    scenariosIncluded: 0, scenariosOmitted: over.omitted ? { count: 2, reason: "stale" } : null,
    files: [file("MONSTERA-MANIFEST.json", manifest, await sha256Bytes(manifest)), file("android/Main.kt", body, over.tamper ? "0".repeat(64) : bodyHash)],
  };
}
describe("verifyPlan: the generated tree equals the engine plan", () => {
  const cur = "a".repeat(64);
  it("a consistent plan for the current draft has no error", async () => {
    expect(blocking(await verifyPlan(await planOf(), cur))).toEqual([]);
  });
  it("a plan made for another draft is a plan-mismatch error", async () => {
    expect((await verifyPlan(await planOf({ spec: "b".repeat(64) }), cur)).some((i) => i.class === "plan-mismatch")).toBe(true);
  });
  it("a file whose bytes differ from the stated hash is a plan-mismatch error", async () => {
    const items = await verifyPlan(await planOf({ tamper: true }), cur);
    expect(items.some((i) => i.class === "plan-mismatch" && i.message.includes("android/Main.kt"))).toBe(true);
    expect(canExport(items)).toBe(false);
  });
  it("a file the manifest lists but the plan lacks is a plan-mismatch error", async () => {
    expect(canExport(await verifyPlan(await planOf({ drop: true }), cur))).toBe(false);
  });
  it("omitted goldens are a warning and do not block", async () => {
    const items = await verifyPlan(await planOf({ omitted: true }), cur);
    expect(items.some((i) => i.class === "goldens-omitted" && i.severity === "warning")).toBe(true);
    expect(canExport(items)).toBe(true);
  });
});

describe("readiness checklist", () => {
  const hash = "c".repeat(64);
  it("proves only 'generated', and only for the hash the verified plan was made for", () => {
    const r = readiness({ specSha256: hash, generatedFor: hash });
    expect(r.proofs.map((p) => [p.level, p.state])).toEqual([["generated", "proven"], ["compiled", "not-proven"], ["simulator-tested", "not-proven"], ["device-tested", "not-proven"]]);
    expect(readiness({ specSha256: hash, generatedFor: "d".repeat(64) }).proofs[0]?.state).toBe("not-proven");
    expect(readiness({ specSha256: null, generatedFor: hash }).proofs.every((p) => p.state === "not-proven")).toBe(true);
  });
  it("evidence counts only for the same spec hash", () => {
    const ev = [{ level: "compiled" as const, specSha256: hash, source: "CI run" }];
    expect(readiness({ specSha256: hash, generatedFor: null, evidence: ev }).proofs[1]?.state).toBe("proven");
    expect(readiness({ specSha256: "d".repeat(64), generatedFor: null, evidence: ev }).proofs[1]?.state).toBe("not-proven");
  });
  it("lists the developer's own steps", () => {
    expect(readiness({ specSha256: hash, generatedFor: null }).steps.map((s) => s.id)).toEqual(["signing", "store-listing", "privacy", "ad-ids", "firebase-files"]);
  });
});

describe('wording: "store-ready" appears only inside a sentence that says it is not claimed', () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const views = () => [
    renderToStaticMarkup(<ReadinessView specSha256={"c".repeat(64)} generatedFor={"c".repeat(64)} />),
    renderToStaticMarkup(<ReadinessView specSha256={null} generatedFor={null} />),
    renderToStaticMarkup(<CompletenessView items={checkCompleteness(input({ derivation: "stale", derivationOn: true }))} settled />),
  ];
  it("the readiness page says it once, negated, and no view makes an unnegated claim", () => {
    const [ready = ""] = views();
    expect(text(ready)).toContain(NOT_CLAIMED);
    expect(NOT_CLAIMED).toMatch(/does not claim/);
    for (const html of views()) {
      expect(unnegatedClaims(text(html))).toEqual([]);
    }
    expect((text(ready).match(/store-ready/gi) ?? []).length).toBe(1);
  });
  it("the registry entries of the release module never claim it either", () => {
    const texts = [...REGISTRY.modules.filter((m) => m.id === "release").map((m) => m.limits), ...REGISTRY.capabilities.filter((c) => c.module === "release").flatMap((c) => [c.limits, c.requires])];
    for (const t of texts) expect(unnegatedClaims(t)).toEqual([]);
  });
});
