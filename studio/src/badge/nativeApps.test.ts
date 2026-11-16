import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNativeIndex, evaluatePlatform, GAMES, parseAppLog, parsePng, projectLabel, specSha256 } from "../../scripts/native-evidence.mjs";
import { matchNativeApps, nativeLabelFor } from "./nativeApps";
const repo = join(__dirname, "..", "..", "..");
const ev = (platform: string, game: string, file: string) => join(repo, "docs", "evidence", "m3-native-apps", platform, game, file);
const GAME = "pumpkin-blaster";
const specBytes = readFileSync(join(repo, GAMES[0]!.specPath));
const SHA = specSha256(specBytes);
const load = (platform: "android" | "ios", game = GAME) => ({
  platform, gameId: game, specSha256: specSha256(readFileSync(join(repo, GAMES.find((g) => g.id === game)!.specPath))),
  report: readFileSync(ev(platform, game, "report.json"), "utf8"), results: readFileSync(ev(platform, game, "results.jsonl"), "utf8"),
  logs: readFileSync(ev(platform, game, "logs.txt"), "utf8"), screenshot: readFileSync(ev(platform, game, "01-launched.png")) as Uint8Array | null,
});
const states = (r: ReturnType<typeof evaluatePlatform>) => Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v.state]));
const index = buildNativeIndex(repo);

describe("committed Phase 1 evidence", () => {
  it("every game and platform is verified from its own reports and logs", () => {
    for (const g of index.games) {
      expect(g.label).toBe("SIMULATOR-TESTED");
      for (const p of g.platforms) {
        expect(p.problem).toBeNull();
        expect(Object.values(states(p)).every((s) => s === "pass")).toBe(true);
        expect(p.loggedSha256).toBe(g.specSha256);
        expect(p.ticks).toBe(60);
        expect(p.screenshot!.width).toBeGreaterThan(0);
      }
    }
  });
  it("spec hashes come from the canonical spec files, not from SUMMARY.md", () => {
    const summary = readFileSync(join(repo, "docs", "evidence", "m3-native-apps", "SUMMARY.md"), "utf8");
    for (const g of index.games) {
      expect(g.specSha256).toBe(specSha256(readFileSync(join(repo, g.specPath))));
      expect(summary).toContain(g.specSha256); // the summary agrees, but is not the source
    }
  });
  it("a CRLF checkout of a spec has the same identity", () => {
    expect(specSha256(Buffer.from(specBytes.toString("utf8").replace(/\n/g, "\r\n")))).toBe(SHA);
  });
});

describe("hash verification", () => {
  it("a log that carries a different valid hash is stale and gets no label", () => {
    const i = load("android");
    const r = evaluatePlatform({ ...i, specSha256: "0".repeat(64) });
    expect(r.checks.specHash.state).toBe("stale");
    expect(r.label).toBe("GENERATED");
  });
  it("a missing hash line is missing evidence", () => {
    const i = load("android");
    const r = evaluatePlatform({ ...i, logs: i.logs.split("\n").filter((l) => !l.includes("MonsteraSpec")).join("\n") });
    expect(r.checks.specHash.state).toBe("missing");
    expect(r.label).toBe("GENERATED");
  });
  it("an uppercase or truncated hash is malformed, not a match", () => {
    const i = load("ios");
    expect(evaluatePlatform({ ...i, logs: i.logs.replace(SHA, SHA.toUpperCase()) }).checks.specHash.state).toBe("fail");
    expect(evaluatePlatform({ ...i, logs: i.logs.replace(SHA, SHA.slice(0, 40)) }).checks.specHash.state).toBe("fail");
  });
  it("two different hashes in one log are inconsistent", () => {
    const i = load("android");
    const line = i.logs.split("\n").find((l) => l.includes("MonsteraSpec"))!;
    const r = evaluatePlatform({ ...i, logs: `${i.logs}\n${line.replace(SHA, "1".repeat(64))}` });
    expect(r.checks.specHash.state).toBe("fail");
    expect(r.label).toBe("GENERATED");
  });
  it("bundledMatches=false or decodedMatches=false fails integrity", () => {
    const a = load("android");
    expect(evaluatePlatform({ ...a, logs: a.logs.replace("bundledMatches=true", "bundledMatches=false") }).checks.integrity.state).toBe("fail");
    const i = load("ios");
    const r = evaluatePlatform({ ...i, logs: i.logs.replace("decodedMatches=true", "decodedMatches=false") });
    expect(r.checks.integrity.state).toBe("fail");
    expect(r.label).toBe("GENERATED");
  });
  it("hash text in an unrelated log line is ignored", () => {
    const i = load("android");
    const logs = `11-16 09:55:37.119 I/Other( 1): spec sha256=${SHA} bundledMatches=true\n`;
    expect(parseAppLog("android", logs, SHA).specHash.state).toBe("missing");
    expect(evaluatePlatform({ ...i, logs }).label).toBe("GENERATED");
  });
  it("an Android-format line is not accepted as iOS evidence and the reverse", () => {
    expect(parseAppLog("ios", load("android").logs, SHA).specHash.state).toBe("missing");
    expect(parseAppLog("android", load("ios").logs, SHA).specHash.state).toBe("missing");
  });
});

describe("missing and malformed evidence", () => {
  it("missing report.json: nothing is verified", () => {
    const r = evaluatePlatform({ ...load("android"), report: null });
    expect(r.problem).toMatch(/missing/);
    expect(r.checks.compile.state).toBe("missing");
    expect(r.label).toBe("GENERATED");
  });
  it.each([["not JSON", "{oops"], ["not an array", "{}"], ["empty array", "[]"]])("report.json %s", (_, report) => {
    const r = evaluatePlatform({ ...load("ios"), report });
    expect(r.problem).not.toBeNull();
    expect(r.label).toBe("GENERATED");
    expect(r.checks.compile.state).not.toBe("pass");
  });
  it("a failed launch yields COMPILED at most, and a failed build yields GENERATED", () => {
    const i = load("android");
    const flip = (op: string) => {
      const edit = (text: string, sep: string) => text.split(sep).map((l) => (l.includes(`"op":"${op}"`) ? l.replace('"status":"ok"', '"status":"failed"') : l)).join(sep);
      return { ...i, report: edit(i.report, "\n"), results: edit(i.results, "\n") };
    };
    const launch = evaluatePlatform(flip("launch"));
    expect(launch.checks.launch.state).toBe("fail");
    expect(launch.label).toBe("COMPILED");
    const build = evaluatePlatform(flip("build"));
    expect(build.checks.compile.state).toBe("fail");
    expect(build.label).toBe("GENERATED");
  });
  it("a screenshot that is absent or not a PNG is not launch evidence", () => {
    const i = load("android");
    expect(evaluatePlatform({ ...i, screenshot: null }).label).toBe("COMPILED");
    const bad = evaluatePlatform({ ...i, screenshot: Buffer.from("not a png at all, long enough to pass the length guard ......") });
    expect(bad.checks.screenshot.state).toBe("fail");
    expect(bad.label).toBe("COMPILED");
    expect(parsePng(Buffer.alloc(10))).toBeNull();
  });
  it("a screenshot without a build or hash is never enough on its own", () => {
    const r = evaluatePlatform({ ...load("android"), report: null, results: null, logs: null });
    expect(r.label).toBe("GENERATED");
  });
  it("a launched app that never logged runtime ticks is only COMPILED", () => {
    const i = load("android");
    const r = evaluatePlatform({ ...i, logs: i.logs.split("\n").filter((l) => !l.includes("MonsteraRuntime")).join("\n") });
    expect(r.checks.runtime.state).toBe("missing");
    expect(r.label).toBe("COMPILED");
    expect(evaluatePlatform({ ...i, logs: i.logs.replace("runtime ticks=60", "runtime ticks=0") }).checks.runtime.state).toBe("fail");
  });
  it("runtime ticks from a different process than the specification check do not count", () => {
    const i = load("android");
    const r = evaluatePlatform({ ...i, logs: i.logs.replace("MonsteraRuntime( 4962)", "MonsteraRuntime( 1111)") });
    expect(r.checks.runtime.state).toBe("fail");
    expect(r.label).toBe("COMPILED");
    const j = load("ios");
    expect(evaluatePlatform({ ...j, logs: j.logs.replace("PumpkinBlaster[10741:8854] [app.monstera.pumpkinblaster:spec]", "PumpkinBlaster[99:8854] [app.monstera.pumpkinblaster:spec]") }).checks.runtime.state).toBe("fail");
  });
  it("results.jsonl must agree with report.json", () => {
    const i = load("ios");
    const r = evaluatePlatform({ ...i, results: i.results.replace('"op":"install","target":"ios-simulator","status":"ok"', '"op":"install","target":"ios-simulator","status":"failed"') });
    expect(r.problem).toMatch(/disagrees/);
    expect(r.label).toBe("GENERATED");
    expect(evaluatePlatform({ ...i, results: null }).label).toBe("GENERATED");
  });
  it("a report copied from another game or target is rejected", () => {
    const other = load("android", "lantern-run");
    expect(evaluatePlatform({ ...load("android"), report: other.report, results: other.results }).problem).toMatch(/does not belong/);
    const ios = load("ios");
    expect(evaluatePlatform({ ...load("android"), report: ios.report, results: ios.results }).problem).toMatch(/targets/);
  });
  it("a repeated operation or out-of-order timestamps are inconsistent", () => {
    const i = load("android");
    const lines = i.report.split("\n");
    const dup = [...lines.slice(0, 3), lines[2]!, ...lines.slice(3)].join("\n");
    expect(evaluatePlatform({ ...i, report: dup }).problem).toMatch(/more than once/);
    const early = i.report.replace('"timestamp":"2026-11-16T04:26:07Z"', '"timestamp":"2026-11-16T04:00:00Z"');
    expect(evaluatePlatform({ ...i, report: early }).problem).toMatch(/before/);
  });
  it("partial platform results: the project label is the weakest platform", () => {
    const android = evaluatePlatform(load("android"));
    const ios = evaluatePlatform({ ...load("ios"), report: null });
    expect(projectLabel([android, ios])).toBe("GENERATED");
    expect(projectLabel([android])).toBe("GENERATED");
    expect(projectLabel([android, evaluatePlatform(load("ios"))])).toBe("SIMULATOR-TESTED");
  });
});

describe("exact current-spec matching", () => {
  const pb = index.games.find((g) => g.id === GAME)!;
  it("the official hash gets its evidence and label", () => {
    expect(matchNativeApps(index, pb.specSha256, GAME).exact?.id).toBe(GAME);
    expect(nativeLabelFor(index, pb.specSha256)).toBe("SIMULATOR-TESTED");
  });
  it("an edited draft (different hash) never inherits the label, even for the same project", () => {
    const edited = "f".repeat(64);
    const m = matchNativeApps(index, edited, GAME);
    expect(m.exact).toBeNull();
    expect(m.otherSpec?.id).toBe(GAME);
    expect(nativeLabelFor(index, edited)).toBe("GENERATED");
  });
  it("no hash, a malformed hash or a prefix matches nothing", () => {
    for (const sha of [null, "", pb.specSha256.slice(0, 12), pb.specSha256.toUpperCase()]) {
      expect(matchNativeApps(index, sha, GAME).exact).toBeNull();
      expect(nativeLabelFor(index, sha)).toBe("GENERATED");
    }
  });
  it("an unknown project with a foreign hash has no evidence and no stale hint", () => {
    const m = matchNativeApps(index, "e".repeat(64), "someone-elses-game");
    expect(m.exact).toBeNull();
    expect(m.otherSpec).toBeNull();
  });
  it("an imported file with a matching hash gets the evidence regardless of project id", () => {
    expect(matchNativeApps(index, pb.specSha256, null).exact?.id).toBe(GAME);
  });
  it("an edited spec: any change to the canonical bytes changes the hash that evidence is bound to", () => {
    const changed = Buffer.from(specBytes.toString("utf8").replace(/"lives": \d+/, '"lives": 99'));
    expect(specSha256(changed)).not.toBe(pb.specSha256);
  });
});
