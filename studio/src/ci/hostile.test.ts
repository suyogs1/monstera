// Task 9.3 (A10, R14.5): the hostile-input suite in one place, plus the secret scan over what Studio exports.
// Every class named in R14.5 is driven through the real entry point and must fail closed: a refusal with a reason, no
// project or manifest in the result, the input state unchanged. Narrower per-module cases stay in their own files
// (zip.adversarial, hardening, sniff, import); this file proves each class once, end to end.
//
// Pending, not covered here: task 1.6 (the owner's report-only Vercel deployment and review of production violations).
// The deployed site's headers are therefore not tested; only the header policy file and the local run are (headers.test.ts, smoke).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../../scripts/scan-secrets.mjs";
import { MAX_ASSETS, MAX_FILE_BYTES, MAX_IMAGE_SIDE, MAX_PROJECT_BYTES } from "../assets/limits";
import { planImport, type ImportInput } from "../assets/import";
import { png, svg, txt, u8, wav } from "../assets/fixtures.testkit";
import { vetAsset } from "../assets/sniff";
import { assetPath, exportBundle, importBundle, manifestPath, SPEC_PATH, type BundleProject } from "../export/bundle";
import { MAX_ENTRIES, readZip } from "../export/unzip";
import { buildZip, unsafePath } from "../export/zip";
import { rawZip } from "../export/zip.testkit";
import { emitScaffold } from "../integrations/scaffold";
import { findSecrets } from "../integrations/secrets";
import { kiroTemplates } from "../pack/kiroTemplates";
import { exportPack, type PackFile } from "../pack/export";
import { importPack } from "../pack/import";
import { MANIFEST_NAMES, parseManifest, serializeManifest, validateManifest, type AssetsManifest, type Provenance } from "../project/manifests";
import { MAX_DEPTH, MAX_JSON_BYTES, parseStrictJson } from "../project/manifests/strictJson";
import { manifestsFor, pumpkinText } from "../project/testkit";

const enc = new TextEncoder();
const prov: Provenance = { origin: "user-owned", author: "Test", license: "proprietary-owned", source: "made for the test", tool: "", model: "", promptSha256: "", acquiredOn: "2026-11-16", notes: "" };
const emptyAssets = (): AssetsManifest => structuredClone(manifestsFor("pumpkin-blaster").assets);
const importInput = (bytes: Uint8Array, fileName = "x.png"): ImportInput => ({ fileName, bytes, category: "sprite", provenance: { ...prov } });
const freeze = (v: unknown): string => JSON.stringify(v);

describe("A10 oversized input", () => {
  it("a file over the per-file limit is refused by sniffing and by import, and the manifest is untouched", async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(png(4, 4));
    expect(vetAsset(big, { count: 0, totalBytes: 0 }).ok).toBe(false);
    const m = emptyAssets();
    const before = freeze(m);
    const r = await planImport(m, importInput(big));
    expect(r.ok).toBe(false);
    expect("manifest" in r).toBe(false);
    expect(freeze(m)).toBe(before);
  });
  it("an empty file, a full library and a full project budget are refused", () => {
    const ok = png(4, 4);
    expect(vetAsset(new Uint8Array(0), { count: 0, totalBytes: 0 }).ok).toBe(false);
    expect(vetAsset(ok, { count: MAX_ASSETS, totalBytes: 0 }).ok).toBe(false);
    expect(vetAsset(ok, { count: 0, totalBytes: MAX_PROJECT_BYTES }).ok).toBe(false);
    expect(vetAsset(ok, { count: Number.NaN, totalBytes: 0 }).ok).toBe(false);
  });
  it("JSON text and bytes over the size limit are refused before parsing", () => {
    const huge = `"${"a".repeat(MAX_JSON_BYTES + 1)}"`;
    expect(parseStrictJson(huge)).toMatchObject({ ok: false, issue: { code: "too-large" } });
    const r = parseManifest("gameplay", new Uint8Array(MAX_JSON_BYTES + 1));
    expect(r.ok).toBe(false);
  });
  it("JSON nested past the depth limit is refused without a stack overflow", () => {
    const deep = "[".repeat(MAX_DEPTH + 50) + "]".repeat(MAX_DEPTH + 50);
    expect(parseStrictJson(deep)).toMatchObject({ ok: false, issue: { code: "too-deep" } });
    const wide = "[".repeat(200000);
    expect(parseStrictJson(wide).ok).toBe(false);
  });
});

describe("A10 huge or invalid image dimensions", () => {
  const usage = { count: 0, totalBytes: 0 };
  it.each([
    ["width over the limit", png(MAX_IMAGE_SIDE + 1, 1)],
    ["height over the limit", png(1, MAX_IMAGE_SIDE + 1)],
    ["both sides at 2^32-1", png(0xffffffff, 0xffffffff)],
    ["zero width", png(0, 4)],
    ["zero height", png(4, 0)],
  ])("%s", async (_name, bytes) => {
    expect(vetAsset(bytes, usage).ok).toBe(false);
    const m = emptyAssets();
    const before = freeze(m);
    expect((await planImport(m, importInput(bytes))).ok).toBe(false);
    expect(freeze(m)).toBe(before);
  });
  it("the largest allowed side is accepted, so the limit is exact", () => {
    expect(vetAsset(png(MAX_IMAGE_SIDE, 1), usage).ok).toBe(true);
  });
});

describe("A10 content that is not an allowed asset, whatever it is called", () => {
  const usage = { count: 0, totalBytes: 0 };
  it("SVG with script, HTML, JavaScript and a PNG with trailing data are refused", async () => {
    const html = u8(txt("<!doctype html><script>alert(1)</script>"));
    const js = u8(txt("alert(document.cookie)"));
    const polyglot = u8([...png(4, 4), ...txt("<script>alert(1)</script>")]);
    for (const [name, bytes] of [["a.png", svg()], ["a.png", html], ["a.png", js], ["a.png", polyglot], ["a.svg", svg()]] as const) {
      expect(vetAsset(bytes, usage).ok, name).toBe(false);
      expect((await planImport(emptyAssets(), importInput(bytes, name))).ok, name).toBe(false);
    }
  });
  it("a truncated PNG and a truncated WAV are refused", () => {
    const p = png(4, 4);
    expect(vetAsset(p.slice(0, p.length - 6), usage).ok).toBe(false);
    expect(vetAsset(wav().slice(0, 30), usage).ok).toBe(false);
  });
  it("an import without a license is refused", async () => {
    const r = await planImport(emptyAssets(), { ...importInput(png(4, 4)), provenance: { ...prov, license: "" } });
    expect(r.ok).toBe(false);
  });
});

describe("A10 zip-slip, duplicates, bombs and malformed archives (read side)", () => {
  const body = enc.encode("{}");
  const refused = async (zip: Uint8Array, code: string) => {
    const r = await importBundle(zip);
    expect(r).toMatchObject({ ok: false, code });
    expect("project" in r).toBe(false);
  };
  it("zip-slip, absolute, backslash and drive-letter names", async () => {
    await refused(rawZip([{ name: "../evil.json", plain: body }]), "unsafe-path");
    await refused(rawZip([{ name: "studio-pack/../../evil.json", plain: body }]), "unsafe-path");
    await refused(rawZip([{ name: "/etc/passwd", plain: body }]), "unsafe-path");
    await refused(rawZip([{ name: "studio-pack\\x.json", plain: body }]), "unsafe-path");
    await refused(rawZip([{ name: "C:/x.json", plain: body }]), "unsafe-path");
  });
  it("duplicate entries, exact and by case", async () => {
    await refused(rawZip([{ name: SPEC_PATH, plain: body }, { name: SPEC_PATH, plain: body }]), "duplicate");
    await refused(rawZip([{ name: SPEC_PATH, plain: body }, { name: "MONSTERA.spec.json", plain: body }]), "duplicate");
  });
  it("a decompression bomb, an over-ratio entry and a lying declared size", async () => {
    await refused(rawZip([{ name: SPEC_PATH, plain: new Uint8Array(2 * 1024 * 1024), method: 8, size: 4096 }]), "bomb");
    await refused(rawZip([{ name: SPEC_PATH, plain: new Uint8Array(1024 * 1024), method: 8 }]), "ratio");
    await refused(rawZip([{ name: "studio-pack/assets/a/f.png", plain: body, method: 8, size: 6 * 1024 * 1024, comp: 100000 }]), "too-large");
  });
  it("too many entries, a symlink, encryption and non-ZIP input", async () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ name: `studio-pack/assets/a${i}/f.png`, plain: body }));
    await refused(rawZip(many), "too-many-entries");
    await refused(rawZip([{ name: SPEC_PATH, plain: body, mode: 0o120777 }]), "symlink");
    await refused(rawZip([{ name: SPEC_PATH, plain: body, flags: 0x0801 }]), "unsupported");
    await refused(new Uint8Array(100), "malformed");
  });
  it("readZip alone produces no entries for a hostile archive", async () => {
    const r = await readZip(rawZip([{ name: "../x", plain: body }]), () => ({ max: 10 }));
    expect(r.ok).toBe(false);
    expect("entries" in r).toBe(false);
  });
});

describe("A10 hostile names on the write side", () => {
  const e = (path: string) => ({ path, data: enc.encode("x"), mode: 0o644 });
  it("buildZip refuses traversal, device names and duplicate names", () => {
    expect(() => buildZip([e("p/../x")])).toThrow();
    expect(() => buildZip([e("/abs")])).toThrow();
    expect(() => buildZip([e("p/CON")])).toThrow();
    expect(() => buildZip([e("p/a"), e("p/a")])).toThrow();
    expect(unsafePath("p/a\\b")).not.toBeNull();
  });
  it("exportPack refuses a path outside the pack layout and a duplicate path", async () => {
    expect((await exportPack({ files: [{ path: "../x", data: enc.encode("x") }] })).ok).toBe(false);
    const f: PackFile = { path: SPEC_PATH, data: enc.encode("{}") };
    expect((await exportPack({ files: [f, f] })).ok).toBe(false);
  });
});

describe("A10 duplicate keys and prototype-pollution keys", () => {
  const polluted = () => ({}) as Record<string, unknown>;
  it("duplicate keys are refused, at the root and nested", () => {
    expect(parseStrictJson('{"a":1,"a":2}')).toMatchObject({ ok: false, issue: { code: "duplicate-key" } });
    expect(parseStrictJson('{"a":{"b":1,"b":2}}')).toMatchObject({ ok: false, issue: { code: "duplicate-key" } });
  });
  it.each(["__proto__", "constructor", "prototype"])("key %s is refused in every manifest and nothing leaks into Object.prototype", (key) => {
    for (const name of MANIFEST_NAMES) {
      const text = `{"${key}":{"polluted":true}}`;
      expect(parseManifest(name, text).ok, `${name} ${key}`).toBe(false);
    }
    expect(parseStrictJson(`{"x":{"${key}":1}}`).ok).toBe(false);
    expect(polluted().polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("an own __proto__ key on an already parsed value fails validation and does not pollute", () => {
    const base = JSON.parse(serializeManifest("gameplay", manifestsFor("pumpkin-blaster").gameplay));
    Object.defineProperty(base, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
    expect(validateManifest("gameplay", base).ok).toBe(false);
    expect(polluted().polluted).toBeUndefined();
  });
  it("invalid UTF-8 and a byte order mark are refused", () => {
    expect(parseManifest("gameplay", new Uint8Array([0x7b, 0xff, 0x7d])).ok).toBe(false);
    expect(parseManifest("gameplay", new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])).ok).toBe(false);
  });
});

describe("A10 pasted secrets are refused by manifest validation", () => {
  // Assembled at run time so this file holds none.
  const aws = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  const admob = ["ca-app", "-pub-", "1234567890123456", "~", "1234567890"].join("");
  it.each([["AWS key id", aws], ["AdMob id", admob]])("%s in an integrations string field", (_n, secret) => {
    const m = structuredClone(manifestsFor("pumpkin-blaster").integrations);
    m.backend.configFiles = [secret];
    const r = validateManifest("integrations", m);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(findSecrets({ x: secret })).not.toEqual([]);
  });
});

// A project with every hostile-adjacent feature a sample export can hold: two assets, all manifests, spec text.
async function sampleProject(): Promise<BundleProject> {
  const img = png(4, 4), snd = wav();
  const base = manifestsFor("pumpkin-blaster");
  const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b.slice().buffer))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const manifests = {
    ...base,
    assets: {
      ...base.assets, nextSeq: 3,
      assets: [
        { id: "asset-0001", kind: "image", category: "sprite", file: "hero.png", mime: "image/png", bytes: img.length, sha256: await sha(img), width: 4, height: 4, durationMs: 0, kindRefs: [], provenance: { ...prov } },
        { id: "asset-0002", kind: "audio", category: "sfx", file: "beep.wav", mime: "audio/wav", bytes: snd.length, sha256: await sha(snd), width: 0, height: 0, durationMs: 50, kindRefs: [], provenance: { ...prov } },
      ],
    },
  } as BundleProject["manifests"];
  return { specText: pumpkinText, manifests, assets: new Map([["asset-0001", img], ["asset-0002", snd]]) };
}

describe("A10 secret scan over exports (R14.4, design 8.1)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "export-scan-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (root: string, path: string, data: Uint8Array) => {
    const p = join(root, ...path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  };
  async function exportedTree(): Promise<{ path: string; data: Uint8Array }[]> {
    const p = await sampleProject();
    const bundle = await readZip(exportBundle(p), () => ({ max: 1 << 24 }));
    if (!bundle.ok) throw new Error(bundle.message);
    const files: PackFile[] = [
      ...bundle.entries,
      ...emitScaffold(p.manifests.integrations, "hostile-suite").map((f) => ({ path: `studio-pack/${f.path}`, data: enc.encode(f.text) })),
      ...kiroTemplates("sample-game"),
    ];
    const pack = await exportPack({ files });
    if (!pack.ok) throw new Error(pack.error);
    return pack.entries.map((e) => ({ path: e.path, data: e.data }));
  }
  it("the bundle, the scaffold, the Kiro templates and the pack manifest hold no credential-shaped string and no source map", async () => {
    const tree = await exportedTree();
    expect(tree.length).toBeGreaterThan(MANIFEST_NAMES.length);
    expect(tree.some((f) => f.path.startsWith("studio-pack/scaffold/"))).toBe(true);
    expect(tree.some((f) => f.path === manifestPath("project"))).toBe(true);
    expect(tree.some((f) => f.path === assetPath("asset-0001", "hero.png"))).toBe(true);
    for (const f of tree) put(dir, f.path, f.data);
    const r = scan(dir);
    expect(r.scanned).toBe(tree.length);
    expect(r.findings).toEqual([]);
  });
  it("negative control: the same scan finds a secret planted in an export and names rule and file, never the value", async () => {
    const tree = await exportedTree();
    for (const f of tree) put(dir, f.path, f.data);
    const planted = ["AK", "IA", "ZYXWVUTSRQPONMLK"].join("");
    put(dir, "studio-pack/scaffold/android/Leak.kt", enc.encode(`val k = "${planted}"`));
    put(dir, "assets/app.js.map", enc.encode("{}"));
    const { findings } = scan(dir);
    expect(findings.map((f) => `${f.rule}@${f.file}`).sort()).toEqual(["aws-access-key-id@studio-pack/scaffold/android/Leak.kt", "source-map-file@assets/app.js.map"]);
    expect(JSON.stringify(findings)).not.toContain(planted);
  });
});

// The controller import path is guarded by secretGuard.controller.test.ts (task 1.7); these cover the bundle and pack importers.
describe("A10 import-path secret guards (R14.4, design 8.1)", () => {
  const aws = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  const admob = ["ca-app", "-pub-", "1234567890123456", "~", "1234567890"].join("");
  const pem = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const refusedSecret = async (p: BundleProject, secret: string) => {
    const r = await importBundle(exportBundle(p));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("secret");
    expect("project" in r).toBe(false);
    expect(r.message).not.toContain(secret);
  };
  it("a clean bundle still imports", async () => {
    expect((await importBundle(exportBundle(await sampleProject()))).ok).toBe(true);
  });
  it("importBundle refuses a credential in a second asset's provenance source", async () => {
    // integrations.json cannot carry one: its backend.configFiles is an enum, so its own validator already refuses it.
    const p = await sampleProject();
    p.manifests.assets.assets[1]!.provenance.source = aws;
    await refusedSecret(p, aws);
  });
  it("importBundle refuses a credential in asset provenance", async () => {
    const p = await sampleProject();
    p.manifests.assets.assets[0]!.provenance.notes = admob;
    await refusedSecret(p, admob);
  });
  it("importBundle refuses a credential in the spec JSON", async () => {
    const p = await sampleProject();
    p.specText = JSON.stringify({ ...(JSON.parse(p.specText) as object), leak: pem });
    await refusedSecret(p, pem);
  });
  it("importBundle never echoes a credential used as a spec key", async () => {
    const p = await sampleProject();
    p.specText = JSON.stringify({ ...(JSON.parse(p.specText) as object), [aws]: 1 });
    await refusedSecret(p, aws);
  });
  // Hand-built archives: exportBundle cannot write a manifest with an unknown key or a spec with a duplicate key.
  const rebuilt = async (patch: (path: string, text: string) => string) => {
    const z = await readZip(exportBundle(await sampleProject()), () => ({ max: MAX_FILE_BYTES }));
    if (!z.ok) throw new Error(z.message);
    const dec = new TextDecoder();
    return rawZip(z.entries.map((e) => ({ name: e.path, plain: e.path.endsWith(".json") ? enc.encode(patch(e.path, dec.decode(e.data))) : e.data })));
  };
  it("importBundle never echoes a credential used as an unknown manifest key", async () => {
    const zip = await rebuilt((p, t) => (p === manifestPath("project") ? JSON.stringify({ ...(JSON.parse(t) as object), [aws]: 1 }) : t));
    const r = await importBundle(zip);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain(aws);
  });
  it("importBundle never echoes a credential used as a duplicate spec key", async () => {
    const zip = await rebuilt((p, t) => (p === SPEC_PATH ? `{"${aws}":1,"${aws}":2,${t.trim().slice(1)}` : t));
    const r = await importBundle(zip);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid-spec");
    expect(r.message).not.toContain(aws);
  });
  it("importPack never echoes a credential used as an unknown manifest key", async () => {
    const m = await sampleProject();
    const text = JSON.stringify({ ...(JSON.parse(serializeManifest("project", m.manifests.project)) as object), [aws]: 1 });
    const pack = await exportPack({ files: [{ path: "studio-pack/project.json", data: enc.encode(text) }] });
    if (!pack.ok) throw new Error(pack.error);
    const r = await importPack(pack.entries.map((e) => ({ path: e.path, data: e.data })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.invalid.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.value.invalid)).not.toContain(aws);
  });
  it("importPack flags a credential in studio-pack/assets.json as invalid without throwing", async () => {
    const m = await sampleProject();
    m.manifests.assets.assets[0]!.provenance.notes = aws;
    const data = enc.encode(serializeManifest("assets", m.manifests.assets));
    const pack = await exportPack({ files: [{ path: "studio-pack/assets.json", data }] });
    if (!pack.ok) throw new Error(pack.error);
    const r = await importPack(pack.entries.map((e) => ({ path: e.path, data: e.data })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.invalid.some((i) => i.path === "studio-pack/assets.json" && i.message.includes("credential"))).toBe(true);
    expect(JSON.stringify(r.value.invalid)).not.toContain(aws);
  });
});

describe("A10 final dist scan (R14.4, design 8.1)", () => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
  const required = process.env.STUDIO_REQUIRE_DIST === "1";
  const present = existsSync(dist);
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  it.skipIf(!present && !required)("the built dist holds no secret, no source map and no inline map (skipped when dist is not built; CI requires it)", () => {
    expect(present, "studio/dist is missing but STUDIO_REQUIRE_DIST=1").toBe(true);
    const r = scan(dist);
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.findings).toEqual([]);
    expect(walk(dist).filter((f) => f.endsWith(".map"))).toEqual([]);
  });
  it("negative control: a planted .map file and an inline data: source map are both found", () => {
    const d = mkdtempSync(join(tmpdir(), "dist-scan-"));
    try {
      writeFileSync(join(d, "app.js.map"), "{}");
      writeFileSync(join(d, "app.js"), "var a=1;\n//# sourceMappingURL=data:application/json;base64,e30=\n");
      const { findings } = scan(d);
      expect(findings.length).toBeGreaterThanOrEqual(2);
      expect(findings.some((f) => f.file === "app.js.map" && f.rule === "source-map-file")).toBe(true);
      expect(findings.some((f) => f.file === "app.js")).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("pending", () => {
  // Needs the owner's report-only Vercel deployment and the review of production violations. Not claimed as passing.
  it.todo("task 1.6: headers observed on the deployed site (nosniff, CSP report-only) and zero production violations");
});
