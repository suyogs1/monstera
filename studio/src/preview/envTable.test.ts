import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { buildNativeIndex, E1_DIR, GAMES, specSha256 } from "../../scripts/native-evidence.mjs";
import type { Verdict } from "../badge/badge";
import type { ConformanceReport } from "../badge/native";
import type { NativeIndex } from "../badge/nativeApps";
import { Environments } from "./Environments";
import { ENVIRONMENTS, NO_EVIDENCE, environmentTable, type EnvRow } from "./envTable";

const repo = resolve(__dirname, "..", "..", "..");

/** The committed conformance reports, read the way scripts/build-inventory.mjs indexes them. */
function committedReports(): ConformanceReport[] {
  const out: ConformanceReport[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".report.json")) {
        const r = JSON.parse(readFileSync(full, "utf8")) as { specSha256: string; verdict: string; platforms?: { platform: string; status: string }[]; scenarios?: { name: string }[] };
        out.push({ file: full.slice(repo.length + 1).split("\\").join("/"), specSha256: r.specSha256, verdict: r.verdict,
          platforms: (r.platforms ?? []).map((p) => ({ platform: p.platform, status: p.status })), scenarios: (r.scenarios ?? []).map((s) => s.name) });
      }
    }
  };
  walk(join(repo, "docs", "evidence"));
  return out;
}

const REPORTS = committedReports();
const NATIVE = buildNativeIndex(repo) as unknown as NativeIndex;
const row = (rows: EnvRow[], env: string) => rows.find((r) => r.env === env) as EnvRow;
const none = (sha: string | null, extra: Partial<Parameters<typeof environmentTable>[0]> = {}) =>
  environmentTable({ sha, reports: REPORTS, native: NATIVE, browser: null, ...extra });
const sha = (c: string) => c.repeat(64);

describe("environments table: the three templates", () => {
  for (const g of GAMES) {
    const templateSha = specSha256(readFileSync(join(repo, g.specPath)));
    it(`${g.id}: recorded evidence for its own hash`, () => {
      const rows = none(templateSha);
      expect(rows.map((r) => r.env)).toEqual([...ENVIRONMENTS]);
      if (g.evidenceDir !== E1_DIR) {
        // Only historical (spec v4) records exist for this project: none of them is evidence for its v5 hash.
        for (const env of ["oracle", "jvm", "swift-test", "simulator", "device", "browser"]) expect(row(rows, env), env).toMatchObject({ state: NO_EVIDENCE, sources: [] });
        return;
      }
      for (const env of ["oracle", "jvm", "swift-test"]) {
        const r = row(rows, env);
        expect(r.state, env).toBe("passed");
        expect(r.sources.length, env).toBeGreaterThan(0);
        expect(r.sources.every((s) => s.startsWith("docs/evidence/") && s.endsWith(".report.json")), env).toBe(true);
      }
      const label = NATIVE.games.find((x) => x.id === g.id)?.label;
      expect(row(rows, "simulator").state).toBe(label === "SIMULATOR-TESTED" ? "passed" : "not run");
      expect(row(rows, "simulator").sources.every((s) => s.startsWith("docs/evidence/"))).toBe(true);
      // No physical device record exists, and the table must not invent one.
      expect(row(rows, "device")).toMatchObject({ state: NO_EVIDENCE, sources: [] });
      // Never run in this page yet: not inferred from the committed records.
      expect(row(rows, "browser")).toMatchObject({ state: NO_EVIDENCE, sources: [] });
    });
    it(`${g.id}: an edited hash shows no evidence in every row`, () => {
      const edited = specSha256(Buffer.from(readFileSync(join(repo, g.specPath), "utf8").replace(/"score"/, '"score "')));
      expect(edited).not.toBe(templateSha);
      for (const r of none(edited)) expect(r, r.env).toMatchObject({ state: NO_EVIDENCE, sources: [] });
    });
  }
});

describe("environments table: states come only from records", () => {
  const report = (platforms: { platform: string; status: string }[], file = "docs/evidence/x/a.report.json", s = sha("a")): ConformanceReport =>
    ({ file, specSha256: s, verdict: "x", platforms, scenarios: [] });
  const table = (reports: ConformanceReport[], browser: Verdict | null = null, native: NativeIndex = { evidenceDir: "", scope: "", games: [] }) =>
    environmentTable({ sha: sha("a"), reports, native, browser });

  it("maps pass, fail, error and skipped; an absent platform has no evidence", () => {
    const rows = table([report([{ platform: "oracle", status: "pass" }, { platform: "kotlin", status: "error" }, { platform: "swift", status: "skipped" }])]);
    expect(row(rows, "oracle").state).toBe("passed");
    expect(row(rows, "jvm").state).toBe("failed");
    expect(row(rows, "swift-test").state).toBe("not run");
    expect(table([report([{ platform: "oracle", status: "pass" }])]).filter((r) => r.state === NO_EVIDENCE).map((r) => r.env)).toEqual(["browser", "jvm", "swift-test", "simulator", "device"]);
  });
  it("a report for another hash is ignored and a failure outranks a pass", () => {
    const rows = table([
      report([{ platform: "oracle", status: "pass" }], "docs/evidence/x/a.report.json"),
      report([{ platform: "oracle", status: "fail" }], "docs/evidence/x/b.report.json"),
      report([{ platform: "jvm", status: "pass" }], "docs/evidence/x/other.report.json", sha("b")),
    ]);
    expect(row(rows, "oracle")).toMatchObject({ state: "failed", sources: ["docs/evidence/x/b.report.json"] });
    expect(row(rows, "jvm").state).toBe(NO_EVIDENCE);
  });
  it("the browser row reads this session's check for the same hash only", () => {
    const run = { scenarios: [{}, {}] } as never;
    expect(row(table([], { kind: "match", run }), "browser")).toMatchObject({ state: "passed", sources: ["determinism check in this page"] });
    expect(row(table([], { kind: "diverged", run, divergedScenarios: 1 } as never), "browser").state).toBe("failed");
    for (const kind of ["not-run", "running", "stale", "no-goldens", "invalid", "error"]) {
      expect(row(table([], { kind, run } as never), "browser").state, kind).toBe(NO_EVIDENCE);
    }
  });
  it("a simulator pass needs the exact hash and a source file", () => {
    const platform = (label: string, report: string | null, launch: string, specHash = "pass") => ({ device: "Android emulator", label, checks: { compile: { state: "pass" }, launch: { state: launch }, specHash: { state: specHash } }, files: { report: report ? { repoPath: report } : null } });
    const game = (platforms: unknown[], specSha256 = sha("a")) => ({ native: { evidenceDir: "", scope: "", games: [{ id: "g", specSha256, platforms }] } as unknown as NativeIndex });
    const ok = platform("SIMULATOR-TESTED", "docs/evidence/m/report.json", "pass");
    expect(row(table([], null, game([ok]).native), "simulator")).toMatchObject({ state: "passed", sources: ["docs/evidence/m/report.json"] });
    expect(row(table([], null, game([platform("SIMULATOR-TESTED", null, "pass")]).native), "simulator").state).toBe(NO_EVIDENCE);
    expect(row(table([], null, game([ok], sha("b")).native), "simulator").state).toBe(NO_EVIDENCE);
    // A record whose app logged another hash (historical evidence) is not cited at all, whatever its label says.
    expect(row(table([], null, game([platform("SIMULATOR-TESTED", "docs/evidence/m/report.json", "pass", "stale")]).native), "simulator")).toMatchObject({ state: NO_EVIDENCE, sources: [] });
    expect(row(table([], null, game([platform("COMPILED", "docs/evidence/m/report.json", "missing")]).native), "simulator").state).toBe("not run");
    expect(row(table([], null, game([ok, platform("GENERATED", "docs/evidence/m/ios.json", "fail")]).native), "simulator").state).toBe("failed");
  });
  it("no validated hash: every row reads no evidence", () => {
    for (const r of none(null)) expect(r).toMatchObject({ state: NO_EVIDENCE, sources: [] });
  });
  it("no row reads passed without a source record, over the committed data and every template hash", () => {
    for (const s of [null, sha("0"), ...GAMES.map((g) => specSha256(readFileSync(join(repo, g.specPath))))]) {
      for (const r of none(s)) if (r.state === "passed") expect(r.sources.length, `${s}/${r.env}`).toBeGreaterThan(0);
    }
  });
  it("renders every environment with its state and sources", () => {
    const rows = none(specSha256(readFileSync(join(repo, GAMES[0]!.specPath))));
    const html = renderToStaticMarkup(createElement(Environments, { rows, sha: sha("a") }));
    for (const env of ENVIRONMENTS) expect(html).toContain(`data-env="${env}"`);
    expect(html).toContain(NO_EVIDENCE);
    expect(html).toContain("passed");
  });
});
