import { describe, expect, it } from "vitest";
import { png } from "../assets/fixtures.testkit";
import { readZip } from "../export/unzip";
import { rawZip } from "../export/zip.testkit";
import { exportPack, type PackFile } from "./export";
import { importPack } from "./import";
// Credential-shaped strings are assembled at run time so no source file holds one.
const j = (...p: string[]) => p.join("");
const AWS = j("AK", "IA", "ABCDEFGHIJKLMNOP");
const KEY = j("-----BEGIN ", "RSA PRIVATE KEY-----");
const NAMED = j("SERVICE_", "TOKEN", "=", "x".repeat(20));
const enc = new TextEncoder();
const f = (path: string, text: string): PackFile => ({ path, data: enc.encode(text) });
const base = (): PackFile[] => [
  f("monstera.spec.json", "{}\n"),
  f("studio-pack/scaffold/android/Ads.kt", "// scaffold: reads the token from the user's own settings\n"),
  f(".kiro/steering/notes.md", "# Notes\n"),
  f(".kiro/hooks/h.json", "{\"name\":\"h\"}\n"),
];
const through = async (extra: PackFile[]) => {
  const e = await exportPack({ files: base() });
  if (!e.ok) throw new Error(e.error);
  const all = [...e.entries.map((x) => ({ name: x.path, plain: x.data })), ...extra.map((x) => ({ name: x.path, plain: x.data }))];
  const z = await readZip(rawZip(all), () => ({ max: 1 << 24 }));
  if (!z.ok) throw new Error(z.message);
  const r = await importPack(z.entries);
  if (!r.ok) throw new Error(r.error);
  return r.value.invalid;
};
describe("pack-import secret scan beyond the manifests", () => {
  it.each([
    ["studio-pack/scaffold/android/Leak.kt", `val k = "${AWS}"\n`, "aws-access-key-id"],
    ["studio-pack/scaffold/ios/Info.plist", `<string>${KEY}</string>\n`, "private-key-block"],
    [".kiro/steering/extra.md", `key ${AWS}\n`, "aws-access-key-id"],
    [".kiro/hooks/x.json", `{"cmd":"${NAMED}"}\n`, "named-secret-assignment"],
  ])("refuses %s", async (path, text, rule) => {
    const inv = await through([f(path, text)]);
    expect(inv).toEqual([{ path, message: `contains a credential-shaped value (${rule})` }]);
    expect(JSON.stringify(inv)).not.toContain(AWS);
    expect(JSON.stringify(inv)).not.toContain("x".repeat(20));
  });
  it("accepts clean text", async () => {
    expect(await through([])).toEqual([]);
  });
  it("does not scan asset bytes as text", async () => {
    const hero = Uint8Array.from([...png(2, 2), ...enc.encode(AWS)]);
    const inv = await through([
      { path: "studio-pack/assets/asset-0001/hero.png", data: hero },
      { path: "STUDIO-PACK/ASSETS/asset-0002/x.txt", data: enc.encode(AWS) },
    ]);
    expect(inv).toEqual([]);
  });
  it.each([
    ["a NUL prefix", Uint8Array.from([0, ...enc.encode(`val k = "${AWS}"`)])],
    ["UTF-16LE with a BOM", Uint8Array.from([0xff, 0xfe, ...[...`val k = "${AWS}"`].flatMap((c) => [c.charCodeAt(0), 0])])],
    ["Latin-1", Uint8Array.from([0xe9, 0x20, ...enc.encode(AWS)])],
  ])("still scans non-UTF-8 text with %s", async (_n, data) => {
    for (const path of [".kiro/steering/enc.md", "studio-pack/scaffold/android/Enc.kt"]) {
      const inv = await through([{ path, data }]);
      expect(inv).toEqual([{ path, message: "contains a credential-shaped value (aws-access-key-id)" }]);
    }
  });
  it("redacts a path that is itself credential-shaped", async () => {
    const inv = await through([f(`studio-pack/scaffold/${AWS}.kt`, `val k = "${AWS}"\n`)]);
    expect(inv).toHaveLength(1);
    expect(JSON.stringify(inv)).not.toContain(AWS);
    expect(inv[0]?.message).toContain("aws-access-key-id");
  });
  it("fails closed on a text file too large to scan", async () => {
    const e = await exportPack({ files: base() });
    if (!e.ok) throw new Error(e.error);
    const r = await importPack([...e.entries, f("studio-pack/scaffold/big.kt", "a".repeat(5 * 1024 * 1024 + 1))]);
    expect(r.ok && r.value.invalid.map((x) => x.message)).toEqual(["too large to scan for credential-shaped values"]);
  });
});
