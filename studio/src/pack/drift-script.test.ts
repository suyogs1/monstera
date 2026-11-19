// tools/check-drift.sh against a real exported pack tree (task 7.2): unchanged, edited, missing, unknown, exit codes, and the
// same classification as the importer. Needs bash (Git Bash on Windows). Linux CI always has it, so a missing bash fails there.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportPack, type PackFile } from "./export";
import { importPack } from "./import";
import { MANIFEST_PATH } from "./layout";
const SCRIPT = readFileSync(new URL("../../../tools/check-drift.sh", import.meta.url), "utf8");
const gitBash = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) => existsSync(p));
const BASH = process.platform === "win32" ? gitBash : "bash";
const enc = new TextEncoder();
const f = (path: string, text: string): PackFile => ({ path, data: enc.encode(text) });
const base = (): PackFile[] => [
  f("monstera.spec.json", "{}\n"),
  f("MONSTERA-MANIFEST.json", "{}\n"),
  f("android/app/x.kt", "// engine\n"),
  f("ios/App.swift", "// engine\n"),
  f("studio-pack/assets.json", "{}\n"),
  f("studio-pack/assets/a b/hero.png", "png bytes\n"),
  f("studio-pack/derived/levels/one/monstera.spec.json", "{\"id\":\"one\"}\n"),
  f("studio-pack/scaffold/android/Ads.kt", "// scaffold\n"),
  f("studio-pack/PROJECT-NOTES.md", "# Notes\n"),
  f("extensions/android/README.md", "template\n"),
  f("tools/check-drift.sh", SCRIPT),
];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function materialise(files: PackFile[] = base()): Promise<string> {
  const r = await exportPack({ files });
  if (!r.ok) throw new Error(r.error);
  const root = mkdtempSync(join(tmpdir(), "drift-"));
  dirs.push(root);
  for (const e of r.entries) put(root, e.path, e.data);
  return root;
}
const put = (root: string, path: string, data: Uint8Array | string) => {
  const p = join(root, ...path.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const run = (root: string, args: string[] = []) => {
  const r = spawnSync(BASH as string, ["tools/check-drift.sh", ...args], { cwd: root, encoding: "utf8" });
  const rows = new Map<string, { state: string; cls: string }>();
  for (const line of r.stdout.split("\n")) {
    const m = /^(unchanged|edited|missing|unknown)\s+(\S+)\s+(.+)$/.exec(line);
    if (m) rows.set(m[3] as string, { state: m[1] as string, cls: m[2] as string });
  }
  return { code: r.status, rows, out: r.stdout, err: r.stderr };
};
const state = (r: ReturnType<typeof run>, p: string) => r.rows.get(p)?.state;

describe.skipIf(BASH === undefined)("tools/check-drift.sh", () => {
  it("an untouched export is all unchanged, ignores engine files and the spec, and exits 0", async () => {
    const r = run(await materialise());
    expect(r.code).toBe(0);
    expect(state(r, "studio-pack/scaffold/android/Ads.kt")).toBe("unchanged");
    expect(state(r, "studio-pack/assets/a b/hero.png")).toBe("unchanged");
    expect([...r.rows.values()].every((x) => x.state === "unchanged")).toBe(true);
    expect(r.rows.has("android/app/x.kt")).toBe(false);
    expect(r.rows.has("monstera.spec.json")).toBe(false);
    expect(r.rows.has(MANIFEST_PATH)).toBe(false);
    expect(r.out).toContain("scaffold-drift=0");
  });
  it("an edited scaffold file is drift: reported edited, exit 1", async () => {
    const root = await materialise();
    put(root, "studio-pack/scaffold/android/Ads.kt", "// hand edit\n");
    const r = run(root);
    expect(r.code).toBe(1);
    expect(state(r, "studio-pack/scaffold/android/Ads.kt")).toBe("edited");
    expect(state(r, "studio-pack/derived/levels/one/monstera.spec.json")).toBe("unchanged");
  });
  it("a missing scaffold file is drift: reported missing, exit 1", async () => {
    const root = await materialise();
    rmSync(join(root, "studio-pack", "derived", "levels", "one", "monstera.spec.json"));
    const r = run(root);
    expect(r.code).toBe(1);
    expect(state(r, "studio-pack/derived/levels/one/monstera.spec.json")).toBe("missing");
  });
  it("an edited or missing write-once file is never drift (exit 0)", async () => {
    const root = await materialise();
    put(root, "studio-pack/PROJECT-NOTES.md", "# my own notes\n");
    rmSync(join(root, "extensions", "android", "README.md"));
    const r = run(root);
    expect(r.code).toBe(0);
    expect(state(r, "studio-pack/PROJECT-NOTES.md")).toBe("edited");
    expect(state(r, "extensions/android/README.md")).toBe("missing");
  });
  it("edited studio-data is reported edited but is not drift (exit 0)", async () => {
    const root = await materialise();
    put(root, "studio-pack/assets.json", "{\"hand\":true}\n");
    const r = run(root);
    expect(r.code).toBe(0);
    expect(state(r, "studio-pack/assets.json")).toBe("edited");
  });
  it("a file outside the manifest is unknown (exit 0); edits to engine-owned files and the spec are not this script's concern", async () => {
    const root = await materialise();
    put(root, "studio-pack/scaffold/android/Extra.kt", "// new\n");
    put(root, "notes.txt", "x\n");
    put(root, "android/app/x.kt", "// engine edited\n");
    put(root, "monstera.spec.json", "{\"edited\":1}\n");
    const r = run(root);
    expect(r.code).toBe(0);
    expect(state(r, "studio-pack/scaffold/android/Extra.kt")).toBe("unknown");
    expect(state(r, "notes.txt")).toBe("unknown");
    expect(r.rows.has("android/app/x.kt")).toBe(false);
    expect(r.rows.has("monstera.spec.json")).toBe(false);
  });
  it("matches importPack on a tree with every state", async () => {
    const root = await materialise();
    put(root, "studio-pack/scaffold/android/Ads.kt", "// hand edit\n");
    rmSync(join(root, "extensions", "android", "README.md"));
    put(root, "notes.txt", "x\n");
    const ex = await exportPack({ files: base() });
    if (!ex.ok) throw new Error(ex.error);
    const tree: PackFile[] = ex.entries
      .filter((e) => e.path !== "extensions/android/README.md")
      .map((e) => (e.path === "studio-pack/scaffold/android/Ads.kt" ? f(e.path, "// hand edit\n") : { path: e.path, data: e.data }));
    tree.push(f("notes.txt", "x\n"));
    const imp = await importPack(tree);
    if (!imp.ok) throw new Error(imp.error);
    const r = run(root);
    const expected = new Map(imp.value.files.map((c) => [c.path, c.state]));
    const actual = new Map([...r.rows].map(([p, v]) => [p, v.state]));
    expect(actual).toEqual(expected);
    expect(r.code).toBe(imp.value.drift.length > 0 ? 1 : 0);
  });
  it("lists files in path order", async () => {
    const r = run(await materialise());
    const paths = [...r.rows.keys()];
    expect(paths).toEqual([...paths].sort());
  });
  it("accepts an explicit project directory and a CRLF manifest", async () => {
    const root = await materialise();
    const m = readFileSync(join(root, MANIFEST_PATH), "utf8").replace(/\n/g, "\r\n");
    writeFileSync(join(root, MANIFEST_PATH), m);
    const r = run(root, ["."]);
    expect(r.code).toBe(0);
    expect(state(r, "studio-pack/scaffold/android/Ads.kt")).toBe("unchanged");
  });
  it("exits 2 when the manifest is missing", async () => {
    const root = await materialise();
    rmSync(join(root, MANIFEST_PATH));
    const r = run(root);
    expect(r.code).toBe(2);
    expect(r.err).toContain("missing");
  });
  it.each([
    ["bad schema", (m: string) => m.replace("monstera.studio.pack-manifest", "other")],
    ["bad version", (m: string) => m.replace('"version": 1', '"version": 2')],
    ["bad sha256", (m: string) => m.replace(/"sha256": "[0-9a-f]{64}"/, '"sha256": "xyz"')],
    ["bad class", (m: string) => m.replace('"class": "write-once"', '"class": "engine-owned"')],
    ["unsafe path", (m: string) => m.replace('"path": "extensions/android/README.md"', '"path": "../outside.txt"')],
    ["not a manifest", () => "hello\n"],
  ])("exits 2 for an invalid manifest: %s", async (_name, mutate) => {
    const root = await materialise();
    writeFileSync(join(root, MANIFEST_PATH), mutate(readFileSync(join(root, MANIFEST_PATH), "utf8")));
    const r = run(root);
    expect(r.code).toBe(2);
    expect(r.err).toContain("check-drift:");
  });
  it("exits 2 for a project directory that does not exist or too many arguments", async () => {
    const root = await materialise();
    expect(run(root, ["no-such-dir"]).code).toBe(2);
    expect(run(root, ["a", "b"]).code).toBe(2);
  });
});
