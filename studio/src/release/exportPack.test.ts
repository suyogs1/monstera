// Task 8.1: the release export is the Task 7.1 pack exporter behind the completeness gate.
import { readFileSync } from "node:fs";
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
  ok: true, projectId: "pumpkin-blaster", specSha256: "a".repeat(64), label: "apps/pumpkin-blaster/monstera.spec.json", layout: "app", manifestSha256: "b".repeat(64),
  scenariosIncluded: 0, scenariosOmitted: null,
  files: [file("MONSTERA-MANIFEST.json", "{}"), file("android/Main.kt", "fun main() {}\n"), file("ios/Main.swift", "print(1)\n"), { ...file("android/gradlew", "#!/bin/sh\n"), mode: 0o755 }],
};
const manifests = xrefManifests();
const assets = new Map(manifests.assets.assets.map((a) => [a.id, enc.encode(`bytes of ${a.id}`)]));
const ready = (over: Partial<ReleaseExportInput> = {}): ReleaseExportInput =>
  ({ items: [], plan, planChecks: [], specText: "{\"project\":{\"platforms\":{\"ios\":{\"deploymentTarget\":\"17.0\"}}}}\n", manifests, assets, driftScript: "#!/bin/sh\nexit 0\n", ...over });
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
  it("carries the drift script, the scaffold and the Kiro files, classed in the Studio manifest (A7)", async () => {
    const r = await releaseExport(ready());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cls = new Map(r.manifest.map((f) => [f.path, f.class]));
    expect(cls.get("tools/check-drift.sh")).toBe("studio-scaffold");
    const scaffold = [...cls].filter(([p]) => p.startsWith("studio-pack/scaffold/"));
    expect(scaffold.length).toBeGreaterThan(0);
    expect(scaffold.every(([, c]) => c === "studio-scaffold")).toBe(true);
    expect(cls.get(".kiro/steering/studio-drift.md")).toBe("write-once");
    // E2: the native sources are write-once under extensions/, and Studio's only scaffold file is the map that lists them.
    expect(scaffold.map(([p]) => p)).toEqual(["studio-pack/scaffold/EXTENSIONS.md"]);
    const once = [...cls].filter(([p]) => p.startsWith("extensions/"));
    expect(once.length).toBeGreaterThan(10);
    expect(once.every(([, c]) => c === "write-once")).toBe(true);
    expect(cls.get("extensions/ios/MonsteraExtensions/Package.swift")).toBe("write-once");
    expect(cls.get("extensions/android/src/main/kotlin/monstera/extensions/MonsteraExtensions.kt")).toBe("write-once");    expect(r.entries.find((e) => e.path === "tools/check-drift.sh")?.mode).toBe(0o755);
  });
  it("keeps an edited extension file on re-export, byte for byte (E2 ownership)", async () => {
    const first = await releaseExport(ready());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const mine = "extensions/android/src/main/kotlin/monstera/extensions/MonsteraExtensions.kt";
    const existing = first.entries.map((e) => (e.path === mine ? { path: e.path, data: enc.encode("// mine\n") } : { path: e.path, data: e.data }));
    const again = await releaseExport(ready({ existing }));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(new TextDecoder().decode(again.entries.find((e) => e.path === mine)?.data)).toBe("// mine\n");
    expect(again.kept).toContain(mine);
  });
  it("refuses a spec without an iOS deployment target instead of guessing one", async () => {
    expect(await releaseExport(ready({ specText: "{\"project\":{}}\n" }))).toMatchObject({ ok: false, reason: "no-project" });
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

/** Unix mode of every entry, read from the external attributes of the central directory (upper 16 bits). */
function externalModes(zip: Uint8Array): Map<string, number> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const n = v.getUint16(p + 28, true), m = v.getUint16(p + 30, true), c = v.getUint16(p + 32, true);
    out.set(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + n)), (v.getUint32(p + 38, true) >>> 16) & 0o7777);
    p += 46 + n + m + c;
  }
  return out;
}
describe("release export: entry modes", () => {
  it("stores android/gradlew as 0755 and everything else as 0644", async () => {
    const r = await releaseExport(ready());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const modes = externalModes(r.zip);
    expect(modes.get("android/gradlew")).toBe(0o755);
    expect(modes.get("tools/check-drift.sh")).toBe(0o755);
    for (const p of ["android/Main.kt", "ios/Main.swift", "monstera.spec.json", MANIFEST_PATH, ".kiro/steering/studio-drift.md"]) expect(modes.get(p)).toBe(0o644);
    expect([...modes].filter(([, m]) => m === 0o755).map(([p]) => p).sort()).toEqual(["android/gradlew", "tools/check-drift.sh"]);
  });
  it.each(["pumpkin-blaster", "trick-or-treat-rush"])("agrees with the committed manifest modes of %s", async (id) => {
    const m = JSON.parse(readFileSync(new URL(`../../../apps/${id}/MONSTERA-MANIFEST.json`, import.meta.url), "utf8")) as { files: { path: string; mode: string }[] };
    const rows = m.files.filter((x) => x.path.startsWith("android/") || x.path.startsWith("ios/"));
    const p: typeof plan = { ...plan, projectId: id, files: rows.map((x) => ({ ...file(x.path, "x"), mode: parseInt(x.mode, 8) })) };
    const r = await releaseExport(ready({ plan: p }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const modes = externalModes(r.zip);
    for (const x of rows) expect(modes.get(x.path), x.path).toBe(parseInt(x.mode, 8));
    expect(rows.filter((x) => x.mode === "755").map((x) => x.path)).toEqual(["android/gradlew"]);
  });
});