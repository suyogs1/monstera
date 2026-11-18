import { describe, expect, it } from "vitest";
import { png, wav } from "../assets/fixtures.testkit";
import { sha256Bytes } from "../assets/import";
import { manifestsFor, pumpkinText } from "../project/testkit";
import type { ManifestMap } from "../project/manifests";
import { assetPath, exportBundle, importBundle, manifestPath, SPEC_PATH, type BundleProject } from "./bundle";
import { readZip } from "./unzip";
import { rawZip } from "./zip.testkit";

async function entriesOf(zip: Uint8Array) {
  const r = await readZip(zip, () => ({ max: 1 << 24 }));
  if (!r.ok) throw new Error(r.message);
  return r.entries;
}

async function project(): Promise<BundleProject> {
  const img = png(4, 4), snd = wav();
  const base = manifestsFor("pumpkin-blaster");
  const prov = { origin: "user-owned", author: "Test", license: "proprietary-owned", source: "made for the test", tool: "", model: "", promptSha256: "", acquiredOn: "2026-11-16", notes: "" } as const;
  const manifests: ManifestMap = {
    ...base,
    assets: {
      ...base.assets, nextSeq: 3,
      assets: [
        { id: "asset-0001", kind: "image", category: "sprite", file: "hero.png", mime: "image/png", bytes: img.length, sha256: await sha256Bytes(img), width: 4, height: 4, durationMs: 0, kindRefs: [], provenance: { ...prov } },
        { id: "asset-0002", kind: "audio", category: "sfx", file: "beep.wav", mime: "audio/wav", bytes: snd.length, sha256: await sha256Bytes(snd), width: 0, height: 0, durationMs: 50, kindRefs: [], provenance: { ...prov } },
      ],
    },
  };
  return { specText: pumpkinText, manifests, assets: new Map([["asset-0002", snd], ["asset-0001", img]]) };
}

describe("bundle export and import", () => {
  it("exports byte-identical archives twice, whatever the asset map order", async () => {
    const p = await project();
    const reversed = { ...p, assets: new Map([...p.assets].reverse()) };
    expect(exportBundle(p)).toEqual(exportBundle(p));
    expect(exportBundle(reversed)).toEqual(exportBundle(p));
  });

  it("round-trips: import returns the same spec text, manifests and asset bytes, and re-export is byte-identical", async () => {
    const p = await project();
    const zip = exportBundle(p);
    const r = await importBundle(zip);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.specText).toBe(p.specText);
    expect(r.project.manifests).toEqual(p.manifests);
    expect([...r.project.assets.keys()].sort()).toEqual(["asset-0001", "asset-0002"]);
    expect(r.project.assets.get("asset-0001")).toEqual(p.assets.get("asset-0001"));
    expect(exportBundle(r.project)).toEqual(zip);
  });

  it("refuses to export bytes that the manifest does not list, or a listed asset without bytes", async () => {
    const p = await project();
    expect(() => exportBundle({ ...p, assets: new Map([...p.assets, ["asset-0009", png(1, 1)]]) })).toThrow(/not listed/);
    expect(() => exportBundle({ ...p, assets: new Map([["asset-0001", png(4, 4)]]) })).toThrow(/no bytes/);
  });

  it("refuses an archive missing a manifest, and gives no partial project", async () => {
    const r = await importBundle(rawZip([{ name: SPEC_PATH, plain: new TextEncoder().encode(pumpkinText) }]));
    expect(r).toMatchObject({ ok: false, code: "missing-entry" });
    expect("project" in r).toBe(false);
  });

  it("refuses a manifest that fails validation", async () => {
    const p = await project();
    const files = new Map<string, Uint8Array>();
    for (const e of await entriesOf(exportBundle(p))) files.set(e.path, e.data);
    files.set(manifestPath("gameplay"), new TextEncoder().encode('{"schema":"monstera.studio.gameplay","version":1}'));
    const r = await importBundle(rawZip([...files].map(([name, plain]) => ({ name, plain }))));
    expect(r).toMatchObject({ ok: false, code: "invalid-manifest" });
  });

  it("refuses when the asset bytes do not match the manifest hash, content type or are not listed", async () => {
    const p = await project();
    const base = await entriesOf(exportBundle(p));
    const make = (change: (m: Map<string, Uint8Array>) => void) => {
      const m = new Map(base.map((e) => [e.path, e.data]));
      change(m);
      return rawZip([...m].map(([name, plain]) => ({ name, plain })));
    };
    const tampered = png(4, 4).slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! + 1) & 0xff;
    expect(await importBundle(make((m) => m.set(assetPath("asset-0001", "hero.png"), tampered)))).toMatchObject({ ok: false, code: "asset-mismatch" });
    expect(await importBundle(make((m) => m.set(assetPath("asset-0001", "hero.png"), new TextEncoder().encode("<svg/>"))))).toMatchObject({ ok: false, code: "asset-mismatch" });
    expect(await importBundle(make((m) => m.set(assetPath("asset-0077", "extra.png"), png(2, 2))))).toMatchObject({ ok: false, code: "asset-mismatch" });
  });

  it("refuses a spec whose project id differs from the project manifest", async () => {
    const p = await project();
    const r = await importBundle(exportBundle({ ...p, specText: p.specText.replace('"id": "pumpkin-blaster"', '"id": "other-game"') }));
    expect(r).toMatchObject({ ok: false, code: "project-mismatch" });
  });
});
