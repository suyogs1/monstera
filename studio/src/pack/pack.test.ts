import { describe, expect, it } from "vitest";
import { exportPack, type PackFile } from "./export";
import { importPack } from "./import";
import { classOf, MANIFEST_PATH } from "./layout";
import { parsePackManifest } from "./manifest";
const enc = new TextEncoder();
const dec = new TextDecoder();
const f = (path: string, text: string): PackFile => ({ path, data: enc.encode(text) });
const base = (): PackFile[] => [
  f("monstera.spec.json", "{}\n"),
  f("android/app/x.kt", "// engine\n"),
  f("studio-pack/assets.json", "not validated here\n"),
  f("studio-pack/derived/levels/one/monstera.spec.json", "{\"id\":\"one\"}\n"),
  f("studio-pack/scaffold/android/Ads.kt", "// scaffold v1\n"),
  f("studio-pack/PROJECT-NOTES.md", "# Notes (template)\n"),
  f("extensions/android/README.md", "template\n"),
  f("tools/check-drift.sh", "#!/bin/sh\n"),
];
const ok = async (input: Parameters<typeof exportPack>[0]) => {
  const r = await exportPack(input);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const tree = (r: Awaited<ReturnType<typeof ok>>): PackFile[] => r.entries.map((e) => ({ path: e.path, data: e.data }));
const edit = (t: PackFile[], path: string, text: string) => t.map((x) => (x.path === path ? f(path, text) : x));

describe("layout", () => {
  it.each([
    ["monstera.spec.json", "spec"], ["ios/App.swift", "engine-owned"], [".kiro/steering/monstera-generated.md", "engine-owned"],
    ["studio-pack/levels.json", "studio-data"], ["studio-pack/assets/a/b.png", "studio-data"],
    ["studio-pack/derived/levels/x/monstera.spec.json", "studio-scaffold"], ["studio-pack/scaffold/ios/A.swift", "studio-scaffold"],
    ["studio-pack/PROJECT-NOTES.md", "write-once"], ["extensions/ios/README.md", "write-once"], [".kiro/hooks/h.json", "write-once"],
    ["studio-pack/other/x", null], ["random.txt", null], [MANIFEST_PATH, null],
  ])("%s -> %s", (p, c) => expect(classOf(p)).toBe(c));
});

describe("exportPack", () => {
  it("double export is byte-identical, whatever the input order", async () => {
    const a = await ok({ files: base() });
    const b = await ok({ files: base().reverse() });
    expect(a.zip).toEqual(b.zip);
  });
  it("lists every Studio-written file with class and sha256, and not the spec or engine files", async () => {
    const r = await ok({ files: base() });
    const m = parsePackManifest(r.entries.find((e) => e.path === MANIFEST_PATH)!.data);
    expect(m.ok && m.value.files.map((x) => `${x.class}:${x.path}`)).toEqual([
      "write-once:extensions/android/README.md", "write-once:studio-pack/PROJECT-NOTES.md", "studio-data:studio-pack/assets.json",
      "studio-scaffold:studio-pack/derived/levels/one/monstera.spec.json", "studio-scaffold:studio-pack/scaffold/android/Ads.kt",
      "studio-scaffold:tools/check-drift.sh",
    ]);
    expect(r.entries.map((e) => e.path)).toContain("monstera.spec.json");
  });
  it("re-export of an untouched tree is byte-identical", async () => {
    const a = await ok({ files: base() });
    expect((await ok({ files: base(), existing: tree(a) })).zip).toEqual(a.zip);
  });
  it("a write-once file edited by the developer stays after re-export", async () => {
    const a = await ok({ files: base() });
    const edited = edit(tree(a), "studio-pack/PROJECT-NOTES.md", "# my notes\n");
    const b = await ok({ files: base(), existing: edited });
    expect(dec.decode(b.entries.find((e) => e.path === "studio-pack/PROJECT-NOTES.md")!.data)).toBe("# my notes\n");
    expect(b.kept).toContain("studio-pack/PROJECT-NOTES.md");
  });
  it("an edited scaffold file triggers the choice path and is not overwritten silently", async () => {
    const a = await ok({ files: base() });
    const edited = edit(tree(a), "studio-pack/scaffold/android/Ads.kt", "// dev change\n");
    const next = edit(base(), "studio-pack/scaffold/android/Ads.kt", "// scaffold v2\n");
    const r = await exportPack({ files: next, existing: edited });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.conflicts.map((c) => c.path)).toEqual(["studio-pack/scaffold/android/Ads.kt"]);
    const path = "studio-pack/scaffold/android/Ads.kt";
    const over = await ok({ files: next, existing: edited, choices: { [path]: "overwrite" } });
    expect(dec.decode(over.entries.find((e) => e.path === path)!.data)).toBe("// scaffold v2\n");
    const keep = await ok({ files: next, existing: edited, choices: { [path]: "keep" } });
    expect(dec.decode(keep.entries.find((e) => e.path === path)!.data)).toBe("// dev change\n");
    // Kept file still shows as drift after import.
    const imp = await importPack(tree(keep));
    expect(imp.ok && imp.value.drift.map((d) => d.path)).toEqual([path]);
  });
  it("an unedited scaffold file is regenerated without a choice", async () => {
    const a = await ok({ files: base() });
    const next = edit(base(), "studio-pack/scaffold/android/Ads.kt", "// scaffold v2\n");
    const b = await ok({ files: next, existing: tree(a) });
    expect(dec.decode(b.entries.find((e) => e.path === "studio-pack/scaffold/android/Ads.kt")!.data)).toBe("// scaffold v2\n");
  });
  it("rewrites studio-data even when edited, and rewrites a deleted scaffold file", async () => {
    const a = await ok({ files: base() });
    const t = edit(tree(a), "studio-pack/assets.json", "hand edit\n").filter((x) => !x.path.includes("scaffold"));
    const b = await ok({ files: base(), existing: t });
    expect(dec.decode(b.entries.find((e) => e.path === "studio-pack/assets.json")!.data)).toBe("not validated here\n");
    expect(b.entries.some((e) => e.path === "studio-pack/scaffold/android/Ads.kt")).toBe(true);
  });
  it("refuses a path outside the layout, a duplicate and an invalid existing manifest", async () => {
    expect((await exportPack({ files: [f("random.txt", "x")] })).ok).toBe(false);
    expect((await exportPack({ files: [f("monstera.spec.json", "a"), f("monstera.spec.json", "b")] })).ok).toBe(false);
    expect((await exportPack({ files: base(), existing: [f(MANIFEST_PATH, "{}")] })).ok).toBe(false);
  });
});

describe("importPack", () => {
  it("classifies unchanged, edited, missing and unknown; only scaffold counts as drift", async () => {
    const a = await ok({ files: base() });
    let t = edit(tree(a), "studio-pack/PROJECT-NOTES.md", "mine\n");
    t = edit(t, "studio-pack/scaffold/android/Ads.kt", "changed\n");
    t = t.filter((x) => x.path !== "tools/check-drift.sh");
    t.push(f("extensions/android/Mine.kt", "x"));
    const r = await importPack(t);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const state = (p: string) => r.value.files.find((x) => x.path === p)?.state;
    expect(state("studio-pack/PROJECT-NOTES.md")).toBe("edited");
    expect(state("studio-pack/assets.json")).toBe("unchanged");
    expect(state("tools/check-drift.sh")).toBe("missing");
    expect(state("extensions/android/Mine.kt")).toBe("unknown");
    expect(state("monstera.spec.json")).toBeUndefined();
    expect(r.value.drift.map((d) => d.path)).toEqual(["studio-pack/scaffold/android/Ads.kt", "tools/check-drift.sh"]);
  });
  it("rejects a missing or malformed manifest, an unsafe path and a class that contradicts the layout", async () => {
    const a = await ok({ files: base() });
    expect((await importPack(tree(a).filter((x) => x.path !== MANIFEST_PATH))).ok).toBe(false);
    expect((await importPack([f(MANIFEST_PATH, "{\"schema\":1}")])).ok).toBe(false);
    expect((await importPack([...tree(a), f("../x", "y")])).ok).toBe(false);
    const text = dec.decode(a.entries.find((e) => e.path === MANIFEST_PATH)!.data).replace('"write-once"', '"studio-data"');
    expect((await importPack(edit(tree(a), MANIFEST_PATH, text))).ok).toBe(false);
  });
  it("reports a hand-edited studio-pack manifest that fails its schema", async () => {
    const a = await ok({ files: base() });
    const r = await importPack(tree(a));
    expect(r.ok && r.value.invalid.map((i) => i.path)).toEqual(["studio-pack/assets.json"]);
  });
});
