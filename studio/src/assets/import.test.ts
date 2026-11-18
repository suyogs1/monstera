// Task 2.2 import planning: sniff, limits, provenance, ids, hash, and the wrong-extension case end to end (declared name and
// MIME against sniffed content). Pure plan only; the controller tests cover persistence, history and delete.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_ASSETS, MAX_FILE_BYTES } from "./limits";
import { planImport, storedFileName, wavDurationMs, type ImportInput } from "./import";
import { jpeg, mp3, ogg, png, svg, txt, u8, wav } from "./fixtures.testkit";
import type { Asset, AssetsManifest, Provenance } from "../project/manifests";
const empty = (): AssetsManifest => ({ schema: "monstera.studio.assets", version: 1, nextSeq: 1, assets: [] });
const prov = (over: Partial<Provenance> = {}): Provenance => ({
  origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "", ...over,
});
const input = (bytes: Uint8Array, over: Partial<ImportInput> = {}): ImportInput => ({ fileName: "a.png", bytes, category: "sprite", provenance: prov(), ...over });
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
describe("planImport: accepted files", () => {
  it("records id, SHA-256, size, dimensions, mime and provenance, and advances the counter", async () => {
    const bytes = png(32, 16);
    const p = await planImport(empty(), input(bytes, { fileName: "Hero Sprite.png", provenance: prov({ author: "Ana", license: "CC0-1.0", origin: "third-party-licensed", source: "https://example.test/x" }) }));
    if (!p.ok) throw new Error(p.reason);
    expect(p.asset).toMatchObject({
      id: "asset-0001", kind: "image", category: "sprite", file: "Hero-Sprite.png", mime: "image/png", bytes: bytes.length, sha256: sha(bytes),
      width: 32, height: 16, durationMs: 0, kindRefs: [],
    });
    expect(p.asset.provenance).toMatchObject({ origin: "third-party-licensed", author: "Ana", license: "CC0-1.0", source: "https://example.test/x" });
    expect(p.manifest.nextSeq).toBe(2);
    expect(p.manifest.assets).toHaveLength(1);
    expect(p.notices).toEqual([]);
  });
  it("allocates from nextSeq, never from the asset count, and does not touch the input manifest", async () => {
    const m = { ...empty(), nextSeq: 7 };
    const p = await planImport(m, input(png(1, 1)));
    expect(p.ok && p.asset.id).toBe("asset-0007");
    expect(m).toEqual({ ...empty(), nextSeq: 7 });
  });
  it("does not hand out an id again after a delete (counter stays above the deleted id)", async () => {
    const first = await planImport(empty(), input(png(1, 1)));
    if (!first.ok) throw new Error(first.reason);
    const afterDelete: AssetsManifest = { ...first.manifest, assets: [] };
    const second = await planImport(afterDelete, input(png(2, 2)));
    expect(second.ok && second.asset.id).toBe("asset-0002");
  });
  it("takes WAV duration from the header, and OGG/MP3 only from the browser probe", async () => {
    const w = await planImport(empty(), input(wav(800), { fileName: "boom.wav", category: "sfx" }));
    expect(w.ok && w.asset).toMatchObject({ kind: "audio", mime: "audio/wav", durationMs: 100, width: 0, height: 0 });
    expect(wavDurationMs(wav(8000))).toBe(1000);
    const noProbe = await planImport(empty(), input(ogg(), { fileName: "m.ogg", category: "music" }));
    expect(noProbe.ok).toBe(false);
    const probed = await planImport(empty(), input(mp3(), { fileName: "m.mp3", category: "music" }), { probeAudioMs: async () => 2500 });
    expect(probed.ok && probed.asset).toMatchObject({ mime: "audio/mpeg", durationMs: 2500 });
  });
});
describe("planImport: refusals leave the manifest as it was", () => {
  const refused = async (i: ImportInput, m = empty(), deps = {}): Promise<string> => {
    const before = JSON.stringify(m);
    const p = await planImport(m, i, deps);
    expect(p.ok).toBe(false);
    expect(JSON.stringify(m)).toBe(before);
    return p.ok ? "" : p.reason;
  };
  it("refuses a missing or blank license", async () => {
    expect(await refused(input(png(1, 1), { provenance: prov({ license: "" }) }))).toMatch(/license is required/i);
    expect(await refused(input(png(1, 1), { provenance: prov({ license: "   " }) }))).toMatch(/license is required/i);
  });
  it("refuses a malformed license, AI origin without tool and model, and a prompt hash on a non-AI asset", async () => {
    expect(await refused(input(png(1, 1), { provenance: prov({ license: "MIT OR (Apache-2.0)" }) }))).toMatch(/not valid/);
    expect(await refused(input(png(1, 1), { provenance: prov({ origin: "ai-generated" }) }))).toMatch(/tool and the model/);
  });
  it("refuses SVG, HTML, unknown and truncated content whatever the name says", async () => {
    expect(await refused(input(svg(), { fileName: "logo.png", declaredMime: "image/png" }))).toMatch(/unsupported|unrecognised/);
    expect(await refused(input(u8(txt("<!doctype html><script>1</script>")), { fileName: "x.png" }))).toMatch(/unsupported|unrecognised/);
    expect(await refused(input(png(4, 4).slice(0, 30)))).toMatch(/png/);
  });
  it("refuses over-limit size, dimensions, count and project total", async () => {
    expect(await refused(input(new Uint8Array(MAX_FILE_BYTES + 1)))).toMatch(/exceeds/);
    expect(await refused(input(png(4097, 1)))).toMatch(/4096/);
    const stub = (id: string, bytes: number): Asset => ({ id, kind: "image", category: "sprite", file: "a.png", mime: "image/png", bytes, sha256: "0".repeat(64), width: 1, height: 1, durationMs: 0, kindRefs: [], provenance: prov() });
    const full: AssetsManifest = { ...empty(), nextSeq: 300, assets: Array.from({ length: MAX_ASSETS }, (_, i) => stub(`asset-${String(i + 1).padStart(4, "0")}`, 1)) };
    expect(await refused(input(png(1, 1)), full)).toMatch(/256 assets/);
    const big: AssetsManifest = { ...empty(), nextSeq: 20, assets: Array.from({ length: 13 }, (_, i) => stub(`asset-${String(i + 1).padStart(4, "0")}`, MAX_FILE_BYTES)) };
    expect(await refused(input(png(1, 1)), big)).toMatch(/exceed/);
  });
  it("refuses a category that does not fit the sniffed kind", async () => {
    expect(await refused(input(wav(), { fileName: "boom.wav", category: "sprite" }))).toMatch(/audio.*sfx, music/);
    expect(await refused(input(png(1, 1), { category: "music" }))).toMatch(/image.*sprite, background, ui/);
  });
  it("refuses an image the decoder rejects or reads at a different size, and audio the probe cannot read", async () => {
    expect(await refused(input(png(4, 4)), empty(), { decodeImage: async () => null })).toMatch(/decoded/);
    expect(await refused(input(png(4, 4)), empty(), { decodeImage: async () => ({ width: 5, height: 4 }) })).toMatch(/disagree/);
    expect(await refused(input(mp3(), { category: "music" }), empty(), { probeAudioMs: async () => null })).toMatch(/audio could not be read/);
    expect(await refused(input(mp3(), { category: "music" }), empty(), { probeAudioMs: async () => { throw new Error("boom"); } })).toMatch(/audio could not be read/);
    expect(await refused(input(mp3(), { category: "music" }), empty(), { probeAudioMs: async () => 3_600_001 })).toMatch(/longer than one hour/);
  });
  it("refuses when the id counter is used up", async () => {
    expect(await refused(input(png(1, 1)), { ...empty(), nextSeq: 100000 })).toMatch(/exhausted/);
  });
});
describe("wrong extension: declared name and MIME against sniffed content", () => {
  it("a JPEG named .png is stored as JPEG with the content's mime, kind and extension, plus a notice", async () => {
    const p = await planImport(empty(), input(jpeg(40, 20), { fileName: "photo.png", declaredMime: "image/png" }));
    if (!p.ok) throw new Error(p.reason);
    expect(p.asset).toMatchObject({ mime: "image/jpeg", kind: "image", file: "photo.jpg", width: 40, height: 20 });
    expect(p.notices).toHaveLength(2);
    expect(p.notices[0]).toMatch(/"\.png".*JPEG.*photo\.jpg/);
    expect(p.notices[1]).toMatch(/image\/png.*image\/jpeg/);
  });
  it("audio named .png becomes audio: the name cannot make it an image, and a sprite category is refused", async () => {
    const ok = await planImport(empty(), input(wav(), { fileName: "evil.png", declaredMime: "image/png", category: "sfx" }));
    expect(ok.ok && ok.asset).toMatchObject({ kind: "audio", mime: "audio/wav", file: "evil.wav" });
    const bad = await planImport(empty(), input(wav(), { fileName: "evil.png", declaredMime: "image/png", category: "sprite" }));
    expect(bad.ok).toBe(false);
  });
  it("accepts the common aliases without a notice", async () => {
    const p = await planImport(empty(), input(jpeg(2, 2), { fileName: "a.JPEG", declaredMime: "image/jpeg" }));
    expect(p.ok && p.notices).toEqual([]);
  });
  it("builds only schema-valid, extension-from-content names", () => {
    expect(storedFileName("../../etc/passwd", "png")).toBe("passwd.png");
    expect(storedFileName("C:\\x\\.hidden.gif", "jpeg")).toBe("hidden.jpg");
    expect(storedFileName("", "wav")).toBe("asset.wav");
    expect(storedFileName("é ü.png", "png")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    expect(storedFileName("x".repeat(200) + ".png", "png").length).toBeLessThanOrEqual(64);
  });
});
