import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { secretRules } from "../integrations/secrets";
import { exportPack, type PackFile } from "./export";
import { classOf } from "./layout";
import { kiroTemplates } from "./kiroTemplates";
const dec = new TextDecoder();
const repo = join(__dirname, "..", "..", "..");
const enc = new TextEncoder();
/** A sample export: the templates plus one file of each other class, through the real exporter. */
async function sampleExport(): Promise<PackFile[]> {
  const files: PackFile[] = [
    { path: "monstera.spec.json", data: enc.encode("{}\n") },
    { path: "studio-pack/project.json", data: enc.encode("{}\n") },
    ...kiroTemplates("sample-game"),
  ];
  const r = await exportPack({ files });
  if (!r.ok) throw new Error(r.error);
  return r.entries.map((e) => ({ path: e.path, data: e.data }));
}
const python = (): string[] | null => {
  for (const c of [["python3"], ["python"], ["py", "-3"]]) {
    const r = spawnSync(c[0] as string, [...c.slice(1), "--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
};
describe("kiroTemplates", () => {
  it("produces steering for ownership, units, never-edit-generated and drift commands, a spec skeleton and a hook", () => {
    const paths = kiroTemplates("sample-game").map((f) => f.path);
    expect(paths).toEqual([
      ".kiro/steering/studio-ownership.md", ".kiro/steering/studio-units.md", ".kiro/steering/studio-never-edit-generated.md",
      ".kiro/steering/studio-drift.md", ".kiro/specs/sample-game/requirements.md", ".kiro/specs/sample-game/design.md",
      ".kiro/specs/sample-game/tasks.md", ".kiro/hooks/studio-drift-check.json",
    ]);
  });
  it("every file is write-once and none replaces the engine-owned steering file", () => {
    for (const f of kiroTemplates("sample-game")) expect(classOf(f.path)).toBe("write-once");
    expect(kiroTemplates("sample-game").some((f) => f.path.endsWith("monstera-generated.md"))).toBe(false);
  });
  it("is deterministic and contains no secret-shaped text", () => {
    const a = kiroTemplates("sample-game"), b = kiroTemplates("sample-game");
    expect(a.map((f) => dec.decode(f.data))).toEqual(b.map((f) => dec.decode(f.data)));
    for (const f of a) expect(secretRules(dec.decode(f.data)), f.path).toEqual([]);
  });
  it("names the commands the pack provides, with LF endings and a final newline", () => {
    const text = Object.fromEntries(kiroTemplates("sample-game").map((f) => [f.path, dec.decode(f.data)]));
    expect(text[".kiro/steering/studio-drift.md"]).toContain("sh tools/check-drift.sh");
    expect(text[".kiro/steering/studio-units.md"]).toContain("65536");
    for (const [p, t] of Object.entries(text)) { expect(t.includes("\r"), p).toBe(false); expect(t.endsWith("\n"), p).toBe(true); }
  });
  it("refuses an id the spec schema would refuse", () => {
    for (const id of ["", "A", "a", "../x", "x/y", "1x", "a".repeat(33)]) expect(() => kiroTemplates(id)).toThrow();
  });
  it("a second export keeps developer-edited Kiro files (write-once)", async () => {
    const first = await sampleExport();
    const edited = first.map((f) => (f.path === ".kiro/steering/studio-units.md" ? { ...f, data: enc.encode("mine\n") } : f));
    const r = await exportPack({ files: [{ path: "monstera.spec.json", data: enc.encode("{}\n") }, ...kiroTemplates("sample-game")], existing: edited });
    if (!r.ok) throw new Error(r.error);
    expect(r.kept).toContain(".kiro/steering/studio-units.md");
    expect(dec.decode(r.entries.find((e) => e.path === ".kiro/steering/studio-units.md")?.data)).toBe("mine\n");
  });
  const py = python();
  it.skipIf(py === null)("the exported .kiro passes the existing kirocheck rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monstera-kiro-"));
    try {
      for (const f of await sampleExport()) {
        const p = join(dir, ...f.path.split("/"));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.data);
      }
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const cmd = py as string[];
      const code = "import sys, json; from pathlib import Path; from monstera import kirocheck; print(json.dumps(kirocheck.check(Path(sys.argv[1]))))";
      const out = execFileSync(cmd[0] as string, [...cmd.slice(1), "-c", code, dir], { cwd: join(repo, "tools", "monstera"), encoding: "utf8" });
      // `.kiro/governance.json` is this repository's own governance file, not part of an export: the only problem allowed.
      const problems = (JSON.parse(out) as string[]).filter((p) => p !== ".kiro/governance.json: missing");
      expect(problems).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
