import { readFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildNativeIndex, E1_DIR, evaluatePlatform, GAMES, M3_DIR, parseAppLog, parseOperations, parsePng, projectLabel, specSha256 } from "../../scripts/native-evidence.mjs";
import { matchNativeApps, nativeLabelFor } from "./nativeApps";
const repo = join(__dirname, "..", "..", "..");
// Each project's committed evidence directory (E1 for the v5 official games). Negative tests below start from these
// records, which carry the exact current hash, so a mutation is the only reason a check can fail.
const ev = (platform: string, game: string, file: string) => join(repo, ...GAMES.find((g) => g.id === game)!.evidenceDir.split("/"), platform, game, file);
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

const official = index.games.filter((g) => g.evidenceDir === E1_DIR);
describe("committed E1 evidence (current v5 official games)", () => {
  it("both official games are read from the E1 directory", () => {
    expect(official.map((g) => g.id).sort()).toEqual(["pumpkin-blaster", "trick-or-treat-rush"]);
  });
  it("every official game and platform is verified from its own reports and logs", () => {
    for (const g of official) {
      expect(g.label).toBe("SIMULATOR-TESTED");
      for (const p of g.platforms) {
        expect(p.problem).toBeNull();
        expect(Object.values(states(p)).every((s) => s === "pass")).toBe(true);
        expect(p.loggedSha256).toBe(g.specSha256);
        expect(p.ticks).toBeGreaterThanOrEqual(60);
        expect(p.screenshot!.width).toBeGreaterThan(0);
      }
    }
  });
  it("spec hashes come from the canonical spec files, not from SUMMARY.md", () => {
    const summary = readFileSync(join(repo, ...E1_DIR.split("/"), "SUMMARY.md"), "utf8");
    for (const g of official) {
      expect(g.specSha256).toBe(specSha256(readFileSync(join(repo, g.specPath))));
      expect(summary).toContain(g.specSha256); // the summary agrees, but is not the source
    }
  });
  it("the logged atlas matches the spec and every logged frame change follows frames[(tick div ticksPerFrame) mod count]", () => {
    for (const g of official) {
      const spec = JSON.parse(readFileSync(join(repo, g.specPath), "utf8"));
      const atlas = spec.game.atlas;
      const sprites = Object.fromEntries(spec.game.runtime.kinds.map((k: { id: string; sprite: { frames: number[]; ticksPerFrame: number } }) => [k.id, k.sprite]));
      for (const platform of ["android", "ios"] as const) {
        const log = readFileSync(ev(platform, g.id, "logs.txt"), "utf8");
        const size = /sprites atlas=loaded size=(\d+)x(\d+)/.exec(log);
        expect(size, `${g.id} ${platform}`).not.toBeNull();
        expect([Number(size![1]), Number(size![2])]).toEqual([atlas.columns * atlas.frameWidth, atlas.rows * atlas.frameHeight]);
        const changes = [...log.matchAll(/sprites tick=(\d+) kind=([a-z0-9-]+) frame=(\d+)/g)];
        expect(changes.length, `${g.id} ${platform}`).toBeGreaterThanOrEqual(2);
        expect(new Set(changes.map((m) => m[3])).size).toBeGreaterThan(1); // the frame actually changed
        for (const [, tick, kind, frame] of changes) {
          const s = sprites[kind!];
          expect(Number(frame), `${g.id} ${platform} tick ${tick}`).toBe(s.frames[Math.floor(Number(tick) / s.ticksPerFrame) % s.frames.length]);
        }
      }
    }
  });
});
describe("historical M3 evidence (spec v4)", () => {
  it("is never current: against the v5 specs every project and platform is stale and gets no label", () => {
    const m3 = buildNativeIndex(repo, undefined, GAMES.map((g) => ({ ...g, evidenceDir: M3_DIR })));
    for (const g of m3.games) {
      expect(g.label).toBe("GENERATED");
      for (const p of g.platforms) expect(p.checks.specHash.state, `${g.id} ${p.platform}`).toBe("stale");
    }
    const lantern = index.games.find((g) => g.id === "lantern-run")!;
    expect(lantern.evidenceDir).toBe(M3_DIR);
    expect(lantern.label).toBe("GENERATED");
  });
});
describe("repeated operations", () => {
  it("a second screenshot is accepted only when results.jsonl records it identically; any other repeat is refused", () => {
    const i = load("android");
    expect(parseOperations("android", GAME, i.report, i.results).problem).toBeNull();
    const report = JSON.parse(i.report) as { op: string }[];
    expect(report.filter((e) => e.op === "screenshot").length).toBe(2);
    const lines = i.results.split("\n");
    let last = -1;
    lines.forEach((l, n) => { if (l.includes('"op":"screenshot"')) last = n; });
    const dropped = lines.filter((_, n) => n !== last).join("\n");
    expect(parseOperations("android", GAME, i.report, dropped).problem).toMatch(/screenshots/);
    const twice = JSON.stringify([...report, report.find((e) => e.op === "build")]);
    expect(parseOperations("android", GAME, twice, i.results).problem).toMatch(/more than once/);
  });
});
describe("evaluation basics", () => {
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
    expect(i.logs).toMatch(/runtime ticks=\d+ /);
    expect(evaluatePlatform({ ...i, logs: i.logs.replace(/runtime ticks=\d+ /, "runtime ticks=0 ") }).checks.runtime.state).toBe("fail");
  });
  it("runtime ticks from a different process than the specification check do not count", () => {
    const i = load("android");
    expect(evaluatePlatform(i).checks.runtime.state).toBe("pass"); // the unmutated record is valid
    const r = evaluatePlatform({ ...i, logs: i.logs.replace(/MonsteraRuntime\(\s*\d+\)/, "MonsteraRuntime( 1111)") });
    expect(r.checks.runtime.state).toBe("fail");
    expect(r.label).toBe("COMPILED");
    const j = load("ios");
    expect(evaluatePlatform(j).checks.runtime.state).toBe("pass");
    const specLine = /PumpkinBlaster\[\d+:([0-9a-f]+)\] \[app\.monstera\.pumpkinblaster:spec\]/;
    expect(j.logs).toMatch(specLine);
    expect(evaluatePlatform({ ...j, logs: j.logs.replace(specLine, "PumpkinBlaster[99:$1] [app.monstera.pumpkinblaster:spec]") }).checks.runtime.state).toBe("fail");
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
    const launch = (JSON.parse(i.report) as { op: string; timestamp: string }[]).find((e) => e.op === "launch")!.timestamp;
    const early = i.report.replace(`"op":"launch","target":"android-emulator","status":"ok","run_id":"${JSON.parse(i.report)[0].run_id}","timestamp":"${launch}"`,
      `"op":"launch","target":"android-emulator","status":"ok","run_id":"${JSON.parse(i.report)[0].run_id}","timestamp":"2000-01-01T00:00:00Z"`);
    expect(early).not.toBe(i.report);
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

describe("PNG validation", () => {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer, crc?: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc ?? zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = (w = 2, h = 2, interlace = 0) => {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4);
    d.writeUInt8(8, 8); d.writeUInt8(6, 9); d.writeUInt8(interlace, 12); // 8-bit RGBA
    return d;
  };
  /** Scanlines of (filter byte, then pixel bytes). Pixel data is kept apart from the filter selector. */
  const scanlines = (w = 2, h = 2, filters: number[] = [0]) => Buffer.concat(Array.from({ length: h }, (_, y) =>
    Buffer.concat([Buffer.from([filters[y % filters.length] ?? 0]), Buffer.alloc(w * 4, 7)])));
  const pixels = (w = 2, h = 2, filters: number[] = [0]) => zlib.deflateSync(scanlines(w, h, filters));
  const png = (parts: Buffer[]) => Buffer.concat([SIG, ...parts]);
  const good = () => [chunk("IHDR", ihdr()), chunk("IDAT", pixels()), chunk("IEND", Buffer.alloc(0))];
  /** The check this replaces: signature, IHDR length/type, positive dimensions, IEND marker at the end. */
  const oldParsePng = (b: Buffer) => {
    if (b.length < 45 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
    if (width < 1 || height < 1 || b.toString("latin1", b.length - 8, b.length - 4) !== "IEND") return null;
    return { width, height };
  };
  const badCrc = (c: Buffer) => { const x = Buffer.from(c); x.writeUInt8(x.readUInt8(x.length - 1) ^ 0xff, x.length - 1); return x; };
  const withScreenshot = (shot: Buffer | null) => evaluatePlatform({ ...load("android"), screenshot: shot });

  it("accepts a well-formed PNG and the committed screenshots", () => {
    expect(parsePng(png(good()))).toEqual({ width: 2, height: 2 });
    expect(parsePng(png([good()[0]!, chunk("IDAT", pixels().subarray(0, 4)), chunk("IDAT", pixels().subarray(4)).subarray(0, 0), ...[]]))).toBeNull();
    for (const p of ["android", "ios"] as const) expect(parsePng(load(p).screenshot)).not.toBeNull();
  });
  it("accepts image data split across several IDAT chunks", () => {
    const z = pixels();
    expect(parsePng(png([good()[0]!, chunk("IDAT", z.subarray(0, 5)), chunk("IDAT", z.subarray(5)), good()[2]!]))).toEqual({ width: 2, height: 2 });
  });
  const withFilters = (w: number, h: number, filters: number[]) => png([chunk("IHDR", ihdr(w, h)), chunk("IDAT", pixels(w, h, filters)), good()[2]!]);
  it.each([0, 1, 2, 3, 4])("accepts scanline filter type %i", (ft) => {
    expect(parsePng(withFilters(2, 2, [ft]))).toEqual({ width: 2, height: 2 });
  });
  it("accepts a different valid filter type on every scanline", () => {
    expect(parsePng(withFilters(3, 5, [0, 1, 2, 3, 4]))).toEqual({ width: 3, height: 5 });
  });
  const invalid: [string, () => Buffer][] = [
    ["scanline filter type 5", () => withFilters(2, 2, [5])],
    ["scanline filter type 255", () => withFilters(2, 2, [255])],
    ["an invalid filter type on only the last scanline", () => withFilters(2, 4, [0, 1, 2, 7])],
    ["trailing junk bytes after the zlib stream (IDAT CRC recalculated)", () => png([good()[0]!, chunk("IDAT", Buffer.concat([pixels(), Buffer.from([1, 2, 3, 4])])), good()[2]!])],
    ["a second complete zlib stream after the first", () => png([good()[0]!, chunk("IDAT", Buffer.concat([pixels(), pixels()])), good()[2]!])],
    ["trailing junk split across a second IDAT chunk", () => png([good()[0]!, chunk("IDAT", pixels()), chunk("IDAT", Buffer.from([0])), good()[2]!])],
    ["interlaced (Adam7) images, unsupported", () => png([chunk("IHDR", ihdr(2, 2, 1)), chunk("IDAT", pixels()), good()[2]!])],
    ["wrong signature", () => Buffer.concat([Buffer.from("\x89PNX\r\n\x1a\n", "latin1"), ...good()])],
    ["truncated IHDR", () => png(good()).subarray(0, 8 + 8 + 6)],
    ["truncated file (IEND cut off)", () => png(good()).subarray(0, png(good()).length - 5)],
    ["wrong IHDR CRC", () => png([badCrc(good()[0]!), good()[1]!, good()[2]!])],
    ["missing IDAT", () => png([good()[0]!, good()[2]!])],
    ["wrong IDAT CRC", () => png([good()[0]!, badCrc(good()[1]!), good()[2]!])],
    ["missing IEND", () => png([good()[0]!, good()[1]!])],
    ["IEND with data", () => png([good()[0]!, good()[1]!, chunk("IEND", Buffer.from([1]))])],
    ["wrong IEND CRC", () => png([good()[0]!, good()[1]!, badCrc(good()[2]!)])],
    ["trailing bytes after IEND", () => Buffer.concat([png(good()), Buffer.from([0])])],
    ["a second IEND", () => png([...good(), good()[2]!])],
    ["a second IHDR", () => png([good()[0]!, good()[0]!, good()[1]!, good()[2]!])],
    ["IHDR not first", () => png([chunk("tEXt", Buffer.from("a\0b")), ...good()])],
    ["IHDR of the wrong length", () => png([chunk("IHDR", Buffer.concat([ihdr(), Buffer.from([0])])), good()[1]!, good()[2]!])],
    ["zero width", () => png([chunk("IHDR", ihdr(0, 2)), good()[1]!, good()[2]!])],
    ["invalid colour type", () => png([chunk("IHDR", Buffer.concat([ihdr().subarray(0, 9), Buffer.from([5, 0, 0, 0])])), good()[1]!, good()[2]!])],
    ["chunk length beyond the file", () => { const b = png(good()); b.writeUInt32BE(0x7fffffff, 8 + 25 + 0); return b; }],
    ["IDAT that is not zlib data", () => png([good()[0]!, chunk("IDAT", Buffer.from("not compressed data")), good()[2]!])],
    ["corrupt image data with a valid CRC", () => { const z = Buffer.from(pixels()); z.writeUInt8(z.readUInt8(z.length - 6) ^ 0xff, z.length - 6); return png([good()[0]!, chunk("IDAT", z), good()[2]!]); }],
    ["truncated image data with a valid CRC", () => png([good()[0]!, chunk("IDAT", pixels().subarray(0, 8)), good()[2]!])],
    ["image data of the wrong size for the header", () => png([chunk("IHDR", ihdr(9, 9)), chunk("IDAT", pixels()), good()[2]!])],
    ["IDAT after another chunk interrupts the data", () => png([good()[0]!, chunk("IDAT", pixels().subarray(0, 4)), chunk("tEXt", Buffer.from("a\0b")), chunk("IDAT", pixels().subarray(4)), good()[2]!])],
  ];
  it.each(invalid)("rejects: %s", (_, make) => {
    expect(parsePng(make())).toBeNull();
    expect(withScreenshot(make()).label).not.toBe("SIMULATOR-TESTED");
  });
  it("the previous check would have accepted these, the strict one does not", () => {
    const noIdat = png([good()[0]!, good()[2]!]);
    const crc = png([badCrc(good()[0]!), good()[1]!, good()[2]!]);
    const corrupt = (() => { const z = Buffer.from(pixels()); z.writeUInt8(z.readUInt8(z.length - 6) ^ 0xff, z.length - 6); return png([good()[0]!, chunk("IDAT", z), good()[2]!]); })();
    for (const b of [noIdat, crc, corrupt]) {
      expect(oldParsePng(b)).toEqual({ width: 2, height: 2 });
    }
    for (const b of [noIdat, crc, corrupt]) expect(parsePng(b)).toBeNull();
  });
  it("an invalid screenshot downgrades an otherwise complete platform to COMPILED, a valid one keeps SIMULATOR-TESTED", () => {
    const shot = load("android").screenshot as Buffer;
    expect(withScreenshot(shot).label).toBe("SIMULATOR-TESTED");
    const truncated = shot.subarray(0, shot.length - 20);
    const r = withScreenshot(Buffer.from(truncated));
    expect(r.checks.screenshot.state).toBe("fail");
    expect(r.label).toBe("COMPILED");
    const flipped = Buffer.from(shot);
    const at = Math.floor(flipped.length / 2);
    flipped.writeUInt8(flipped.readUInt8(at) ^ 0xff, at);
    expect(withScreenshot(flipped).label).toBe("COMPILED");
  });
});