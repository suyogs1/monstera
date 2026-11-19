// Task 8.1: the release export is the Task 7.1 pack exporter behind the completeness gate.
import { describe, expect, it } from "vitest";
import { readZip } from "../export/unzip";
import type { ExportPlan } from "../engine/protocol";
import { xrefManifests } from "../project/xref.testkit";
import { MANIFEST_PATH } from "../pack/layout";
import { ERROR_CLASSES, type CheckClass, type CheckItem } from "./completeness";
import { releaseExport, type ReleaseExportInput } from "./exportPack";
const enc = new TextEncoder();
const b64 = (s: string): string => btoa(s);
const file = (path: string, text: string) => ({ path, mode: 0o644, size: text.length, sha256: "0".repeat(64), kind: "template", data: b64(text) });
const plan: Extract<ExportPlan, { ok: true }> = {
  ok: true, projectId: "p", specSha256: "a".repeat(64), label: "apps/p/monstera.spec.json", layout: "app", manifestSha256: "b".repeat(64),
  scenariosIncluded: 0, scenariosOmitted: null,
  files: [file("MONSTERA-MANIFEST.json", "{}"), file("android/Main.kt", "fun main() {}\n"), file("ios/Main.swift", "print(1)\n")],
};
const manifests = xrefManifests();
const assets = new Map(manifests.assets.assets.map((a) => [a.id, enc.encode(`bytes of ${a.id}`)]));
const ready = (over: Partial<ReleaseExportInput> = {}): ReleaseExportInput =>
  ({ items: [], plan, planChecks: [], specText: "{\"project\":{}}\n", manifests, assets, ...over });
const err = (c: CheckClass): CheckItem => ({ class: c, severity: "error", message: `${c} problem`, module: null, pathText: null });
const warn: CheckItem = { class: "asset-unused", severity: "warning", message: "unused", module: null, pathText: null };
describe("release export: blocked by every completeness error class", () => {
  for (const c of ERROR_CLASSES) {
    it(`${c} blocks the export and no archive is produced`, async () => {
      const r = await releaseExport(c === "plan-mismatch" ? ready({ planChecks: [err(c)] }) : ready({ items: [err(c)] }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("blocked");
        if (r.reason === "blocked") expect(r.blockers.map((b) => b.class)).toEqual([c]);
      }
    });
  }
});
describe("release export: ready project", () => {
  it("includes the pack, written by the pack exporter, and warnings do not block", async () => {
    const r = await releaseExport(ready({ items: [warn] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const z = await readZip(r.zip, () => ({ max: 1 << 20 }));
    expect(z.ok).toBe(true);
    if (!z.ok) return;
    const paths = z.entries.map((e) => e.path);
    expect(paths).toContain(MANIFEST_PATH);
    expect(paths).toContain("monstera.spec.json");
    expect(paths).toContain("android/Main.kt");
    expect(paths.some((p) => p.startsWith("studio-pack/assets/"))).toBe(true);
    expect(paths.some((p) => /^studio-pack\/[^/]+\.json$/.test(p))).toBe(true);
    expect(r.manifest.some((f) => f.path === "android/Main.kt")).toBe(false);
  });
  it("is deterministic", async () => {
    const a = await releaseExport(ready());
    const b = await releaseExport(ready());
    expect(a.ok && b.ok && a.zip).toEqual(b.ok && a.ok ? b.zip : null);
  });
  it("asks for generated files first and refuses a project whose asset file is missing", async () => {
    expect(await releaseExport(ready({ plan: null }))).toMatchObject({ ok: false, reason: "no-plan" });
    expect(await releaseExport(ready({ assets: new Map() }))).toMatchObject({ ok: false, reason: "missing-asset" });
  });
});
