// The Drift view must classify a tree exactly as tools/check-drift.sh does on the same files (task 7.4). Needs bash (Git Bash on
// Windows); Linux CI always has it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildZip, type ZipEntry } from "../export/zip";
import { exportPack, type PackFile } from "../pack/export";
import { driftFromZip } from "./drift";
import { renderToStaticMarkup } from "react-dom/server";
import { DriftTable } from "./KiroViews";
const SCRIPT = readFileSync(new URL("../../../tools/check-drift.sh", import.meta.url), "utf8");
const gitBash = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) => existsSync(p));
const BASH = process.platform === "win32" ? gitBash : "bash";
const enc = new TextEncoder();
const f = (path: string, text: string): PackFile => ({ path, data: enc.encode(text) });
const base = (): PackFile[] => [
  f("monstera.spec.json", "{}\n"), f("MONSTERA-MANIFEST.json", "{}\n"), f("android/app/x.kt", "// engine\n"),
  f("studio-pack/assets.json", "{}\n"), f("studio-pack/assets/a/hero.png", "png\n"),
  f("studio-pack/derived/levels/one/monstera.spec.json", "{\"id\":\"one\"}\n"),
  f("studio-pack/scaffold/android/Ads.kt", "// scaffold\n"), f("studio-pack/PROJECT-NOTES.md", "# Notes\n"),
  f("extensions/android/README.md", "template\n"), f("tools/check-drift.sh", SCRIPT),
];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
type Mutate = (tree: Map<string, Uint8Array>) => void;
async function tree(mutate: Mutate): Promise<{ root: string; zip: Uint8Array }> {
  const r = await exportPack({ files: base() });
  if (!r.ok) throw new Error(r.error);
  const files = new Map(r.entries.map((e) => [e.path, e.data]));
  mutate(files);
  const root = mkdtempSync(join(tmpdir(), "drift-view-"));
  dirs.push(root);
  const entries: ZipEntry[] = [];
  for (const [path, data] of files) {
    const p = join(root, ...path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    entries.push({ path, data, mode: path.endsWith(".sh") ? 0o755 : 0o644 });
  }
  return { root, zip: buildZip(entries) };
}
const script = (root: string) => {
  const r = spawnSync(BASH as string, ["tools/check-drift.sh"], { cwd: root, encoding: "utf8" });
  const rows = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^(unchanged|edited|missing|unknown)\s+(\S+)\s+(.+)$/.exec(line);
    if (m) rows.set(m[3] as string, m[1] as string);
  }
  return { code: r.status, rows };
};
const CASES: [string, Mutate][] = [
  ["untouched", () => undefined],
  ["edited scaffold", (t) => t.set("studio-pack/scaffold/android/Ads.kt", enc.encode("// hand edit\n"))],
  ["missing scaffold", (t) => t.delete("studio-pack/derived/levels/one/monstera.spec.json")],
  ["edited studio-data and write-once files", (t) => { t.set("studio-pack/assets.json", enc.encode("{\"a\":1}\n")); t.set("extensions/android/README.md", enc.encode("mine\n")); }],
  ["unknown file", (t) => t.set("studio-pack/scaffold/android/Extra.kt", enc.encode("// extra\n"))],
  ["everything at once", (t) => { t.set("studio-pack/scaffold/android/Ads.kt", enc.encode("x\n")); t.delete("studio-pack/assets/a/hero.png"); t.set("studio-pack/new.txt", enc.encode("n\n")); }],
];
describe.skipIf(BASH === undefined)("Drift view equals tools/check-drift.sh", () => {
  for (const [name, mutate] of CASES) {
    it(name, async () => {
      const { root, zip } = await tree(mutate);
      const s = script(root);
      const v = await driftFromZip(zip);
      if (!v.ok) throw new Error(v.error);
      const view = new Map(v.report.files.map((x) => [x.path, x.state]));
      expect(view).toEqual(s.rows);
      expect(v.report.drift.length > 0 ? 1 : 0).toBe(s.code);
    });
  }
});
describe("Drift view", () => {
  it("refuses a file that is not a pack, without throwing", async () => {
    expect(await driftFromZip(enc.encode("not a zip"))).toMatchObject({ ok: false });
    const zip = buildZip([{ path: "readme.txt", data: enc.encode("x"), mode: 0o644 }]);
    expect(await driftFromZip(zip)).toMatchObject({ ok: false, error: expect.stringContaining("MONSTERA-STUDIO-MANIFEST.json") });
  });
  it("renders counts, states and the exit-code statement", async () => {
    const { zip } = await tree((t) => t.set("studio-pack/scaffold/android/Ads.kt", enc.encode("x\n")));
    const v = await driftFromZip(zip);
    if (!v.ok) throw new Error(v.error);
    const html = renderToStaticMarkup(<DriftTable report={v.report} />);
    expect(html).toContain('data-state="edited"');
    expect(html).toContain("1 scaffold file drifted");
    expect(html).toContain("studio-pack/scaffold/android/Ads.kt");
  });
});
