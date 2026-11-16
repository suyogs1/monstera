// Native app evidence (M3 Phase 1): turns the committed Device Lab output under docs/evidence/m3-native-apps/ into an index
// that Studio shows. Pure functions plus one build-time driver; nothing here contacts a service or runs a build.
//
// The rules fail closed. A claim is "pass" only when the committed files prove it and agree with each other; a missing,
// malformed, inconsistent or stale file yields "missing", "fail" or "stale", never a success label. The spec SHA-256
// comes from the canonical specification file itself, never from a hand-written summary.
//
// Verified here: build, install, launch, screenshot and log capture succeeded, the app logged the canonical spec
// SHA-256, confirmed its bundled specification, and started the fixed-tick runtime. Not verified: gameplay, input,
// restart, performance, haptics, or any physical device.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const PLATFORMS = {
  android: { target: "android-emulator", device: "Android emulator" },
  ios: { target: "ios-simulator", device: "iOS simulator" },
};
/** The three Phase 1 projects. The id must equal project.id inside the canonical spec (checked at build time). */
export const GAMES = [
  { id: "pumpkin-blaster", specPath: "apps/pumpkin-blaster/monstera.spec.json" },
  { id: "trick-or-treat-rush", specPath: "apps/trick-or-treat-rush/monstera.spec.json" },
  { id: "lantern-run", specPath: "spec/samples/lantern-run/monstera.spec.json" },
];
export const FILES = { report: "report.json", results: "results.jsonl", logs: "logs.txt", screenshot: "01-launched.png" };
export const EVIDENCE_DIR = "docs/evidence/m3-native-apps";
export const SCOPE_NOTE = "Phase 1 verifies build, install, launch and runtime startup only. It does not prove gameplay, input handling, restart, performance, haptics or physical-device behaviour.";

const SHA = /^[0-9a-f]{64}$/;
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const OPS = ["build", "install", "launch", "screenshot", "logs", "stop", "report"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Canonical spec files are LF; a CRLF checkout must not change the identity of a specification. */
export const specSha256 = (bytes) => sha256(Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n"), "utf8"));
const pass = (detail) => ({ state: "pass", detail });
const fail = (detail) => ({ state: "fail", detail });
const missing = (detail) => ({ state: "missing", detail });
const stale = (detail) => ({ state: "stale", detail });
const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// ------------------------------------------------------------------ Device Lab report + results
/** Returns { ops, runId, problem }. `problem` set means the operation records cannot be trusted. */
export function parseOperations(platform, gameId, reportText, resultsText) {
  const target = PLATFORMS[platform].target;
  if (reportText == null) return { ops: {}, runId: null, problem: "report.json is missing" };
  let report;
  try { report = JSON.parse(reportText); } catch { return { ops: {}, runId: null, problem: "report.json is not valid JSON" }; }
  if (!Array.isArray(report) || report.length === 0) return { ops: {}, runId: null, problem: "report.json is not a non-empty array of operations" };
  const ops = {};
  for (const e of report) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return { ops: {}, runId: null, problem: "report.json contains an entry that is not an object" };
    for (const k of ["op", "target", "status", "run_id", "timestamp"]) {
      if (typeof e[k] !== "string" || e[k] === "") return { ops: {}, runId: null, problem: `report.json entry is missing "${k}"` };
    }
    if (!OPS.includes(e.op)) return { ops: {}, runId: null, problem: `report.json has an unknown operation "${e.op}"` };
    if (e.target !== target) return { ops: {}, runId: null, problem: `report.json entry "${e.op}" targets ${e.target}, expected ${target}` };
    if (!TS.test(e.timestamp) || Number.isNaN(Date.parse(e.timestamp))) return { ops: {}, runId: null, problem: `report.json entry "${e.op}" has a malformed timestamp` };
    if (ops[e.op]) return { ops: {}, runId: null, problem: `report.json records "${e.op}" more than once` };
    ops[e.op] = e;
  }
  const runIds = new Set(report.map((e) => e.run_id));
  if (runIds.size !== 1) return { ops, runId: null, problem: "report.json mixes several run ids" };
  const [runId] = [...runIds];
  if (!runId.endsWith(`-${gameId}`)) return { ops, runId, problem: `run id ${runId} does not belong to ${gameId}` };
  const order = ["build", "install", "launch", "screenshot", "logs"].filter((o) => ops[o]);
  for (let i = 1; i < order.length; i++) {
    if (Date.parse(ops[order[i]].timestamp) < Date.parse(ops[order[i - 1]].timestamp)) return { ops, runId, problem: `"${order[i]}" is recorded before "${order[i - 1]}"` };
  }
  // results.jsonl is the adapters' own line-per-operation log; it must say exactly what report.json says.
  if (resultsText == null) return { ops, runId, problem: "results.jsonl is missing" };
  const lines = resultsText.split(/\r?\n/).filter((l) => l.trim() !== "");
  const seen = {};
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { return { ops, runId, problem: "results.jsonl contains a line that is not valid JSON" }; }
    if (!e || typeof e.op !== "string" || seen[e.op]) return { ops, runId, problem: "results.jsonl has a malformed or repeated operation" };
    seen[e.op] = e;
  }
  for (const [op, e] of Object.entries(ops)) {
    if (!seen[op] || stable(seen[op]) !== stable(e)) return { ops, runId, problem: `results.jsonl disagrees with report.json about "${op}"` };
  }
  const extra = Object.keys(seen).filter((o) => !ops[o] && o !== "report");
  if (extra.length) return { ops, runId, problem: `results.jsonl has operations report.json lacks: ${extra.join(", ")}` };
  if (seen.report?.status !== "ok" || seen.report?.run_id !== runId || seen.report?.target !== target) return { ops, runId, problem: "results.jsonl does not end in a successful report operation for this run" };
  return { ops, runId, problem: null };
}

// ------------------------------------------------------------------ app logs
const ANDROID_SPEC = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+ [VDIWEF]\/MonsteraSpec\(\s*(?<pid>\d+)\): spec sha256=(\S+) bundledMatches=(true|false)\s*$/;
const ANDROID_RUNTIME = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+ [VDIWEF]\/MonsteraRuntime\(\s*(?<pid>\d+)\): runtime ticks=(\d+) hash=([0-9a-f]{16}) seed=(\d+)\s*$/;
const IOS_SPEC = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ \w+\s+\S+\[(?<pid>\d+):[0-9a-f]+\] \[(app\.monstera\.[a-z0-9]+):spec\] spec sha256=(\S+) bundledMatches=(true|false) decodedMatches=(true|false)\s*$/;
const IOS_RUNTIME = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ \w+\s+\S+\[(?<pid>\d+):[0-9a-f]+\] \[(app\.monstera\.[a-z0-9]+):runtime\] runtime ticks=(\d+) hash=([0-9a-f]{16}) seed=(\d+)\s*$/;

/** Reads only the app's own MonsteraSpec / MonsteraRuntime (Android) or :spec / :runtime (iOS) lines, strictly. */
export function parseAppLog(platform, text, canonicalSha) {
  const none = { specHash: missing("logs.txt is missing"), integrity: missing("logs.txt is missing"), runtime: missing("logs.txt is missing"), loggedSha256: null, ticks: null };
  if (text == null) return none;
  const android = platform === "android";
  const specRe = android ? ANDROID_SPEC : IOS_SPEC;
  const runRe = android ? ANDROID_RUNTIME : IOS_RUNTIME;
  const lines = text.split(/\r?\n/);
  const specCandidates = lines.filter((l) => (android ? l.includes("/MonsteraSpec(") : /\[app\.monstera\.[^\]]*:spec\]/.test(l)) && l.includes("spec sha256="));
  const runCandidates = lines.filter((l) => (android ? l.includes("/MonsteraRuntime(") : /\[app\.monstera\.[^\]]*:runtime\]/.test(l)) && l.includes("runtime ticks="));
  const out = { ...none };
  // --- spec hash and integrity
  if (specCandidates.length === 0) {
    out.specHash = missing("the app logged no specification hash");
    out.integrity = missing("the app logged no bundled-specification check");
  } else {
    const parsed = specCandidates.map((l) => specRe.exec(l));
    if (parsed.some((m) => !m)) {
      out.specHash = fail("a specification log line is malformed");
      out.integrity = fail("a specification log line is malformed");
    } else {
      const hashes = new Set(parsed.map((m) => m[android ? 2 : 3]));
      const bundleIds = new Set(android ? [] : parsed.map((m) => m[2]));
      if (hashes.size !== 1 || bundleIds.size > 1) {
        out.specHash = fail("the log reports more than one specification hash or app");
        out.integrity = fail("the log reports more than one specification hash or app");
      } else {
        const [logged] = [...hashes];
        out.loggedSha256 = SHA.test(logged) ? logged : null;
        if (!SHA.test(logged)) out.specHash = fail("the logged hash is not a lowercase SHA-256");
        else if (logged !== canonicalSha) out.specHash = stale(`the app logged ${logged.slice(0, 12)}, a different specification from the canonical ${canonicalSha.slice(0, 12)}`);
        else out.specHash = pass("the app logged exactly the canonical specification SHA-256");
        const flags = parsed.every((m) => m[android ? 3 : 4] === "true" && (android || m[5] === "true"));
        out.integrity = flags ? pass(android ? "bundledMatches=true" : "bundledMatches=true, decodedMatches=true") : fail("the app reported that its bundled specification does not match");
      }
    }
  }
  // --- runtime
  if (runCandidates.length === 0) out.runtime = missing("the app logged no runtime ticks");
  else {
    const parsed = runCandidates.map((l) => runRe.exec(l));
    if (parsed.some((m) => !m)) out.runtime = fail("a runtime log line is malformed");
    else {
      const ticks = parsed.map((m) => Number(m[android ? 2 : 3]));
      const specPids = new Set(specCandidates.map((l) => specRe.exec(l)?.groups?.pid));
      if (ticks.some((t) => !Number.isSafeInteger(t) || t < 1)) out.runtime = fail("the runtime logged no ticks");
      else if (specPids.size > 0 && !parsed.every((m) => specPids.has(m.groups?.pid))) out.runtime = fail("the runtime ticks were logged by a different process than the specification check");
      else {
        out.ticks = Math.min(...ticks);
        out.runtime = pass(`the fixed-tick runtime ran ${out.ticks} ticks`);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ screenshot
export function parsePng(bytes) {
  if (!bytes || bytes.length < 45) return null;
  const b = Buffer.from(bytes);
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  if (b.toString("latin1", b.length - 8, b.length - 4) !== "IEND") return null;
  return { width, height };
}

// ------------------------------------------------------------------ one platform
/**
 * @param {{platform:"android"|"ios", gameId:string, specSha256:string, report:string|null, results:string|null, logs:string|null, screenshot:Uint8Array|null}} i
 */
export function evaluatePlatform(i) {
  const { ops, runId, problem } = parseOperations(i.platform, i.gameId, i.report, i.results);
  const log = parseAppLog(i.platform, i.logs, i.specSha256);
  const op = (name, label) => {
    if (problem) return (ops[name] && ops[name].status !== "ok") ? fail(`${label} did not succeed (status ${ops[name].status})`) : (i.report == null ? missing(problem) : fail(`records are unreliable: ${problem}`));
    if (!ops[name]) return missing(`no ${label} operation was recorded`);
    return ops[name].status === "ok" ? pass(`${label} reported ok at ${ops[name].timestamp}`) : fail(`${label} did not succeed (status ${ops[name].status})`);
  };
  const png = i.screenshot == null ? null : parsePng(i.screenshot);
  const shot = op("screenshot", "screenshot");
  const screenshot = shot.state !== "pass" ? shot : i.screenshot == null ? missing("01-launched.png is missing")
    : !png ? fail("01-launched.png is not a valid PNG") : pass(`a ${png.width}x${png.height} PNG was captured`);
  const logOp = op("logs", "log capture");
  const logs = logOp.state !== "pass" ? logOp : i.logs == null ? missing("logs.txt is missing") : i.logs.trim() === "" ? fail("logs.txt is empty") : pass("logs were captured");
  const install = op("install", "install"), launch = op("launch", "launch");
  const launchCheck = install.state !== "pass" ? install : launch;
  const compile = op("build", "build");
  const checks = {
    compile, launch: launchCheck, screenshot, logs,
    specHash: log.specHash, integrity: log.integrity, runtime: log.runtime,
  };
  // A build report has no hash of its own. The app's own log of the canonical hash is what binds the build to this spec.
  const bound = checks.specHash.state === "pass" && checks.integrity.state === "pass";
  const compiled = compile.state === "pass" && bound;
  const launched = compiled && install.state === "pass" && launch.state === "pass" && screenshot.state === "pass" && logs.state === "pass" && checks.runtime.state === "pass";
  const label = launched ? "SIMULATOR-TESTED" : compiled ? "COMPILED" : "GENERATED";
  return { platform: i.platform, target: PLATFORMS[i.platform].target, device: PLATFORMS[i.platform].device, runId, problem, checks, label, loggedSha256: log.loggedSha256, ticks: log.ticks, screenshot: png };
}

/** The label of a whole project is the weakest of its platforms (a missing platform counts as GENERATED). */
export function projectLabel(platforms) {
  const rank = { GENERATED: 0, COMPILED: 1, "SIMULATOR-TESTED": 2 };
  const labels = ["android", "ios"].map((p) => platforms.find((x) => x.platform === p)?.label ?? "GENERATED");
  return labels.reduce((a, b) => (rank[a] <= rank[b] ? a : b));
}

// ------------------------------------------------------------------ build-time driver
const readOpt = (p) => (existsSync(p) ? readFileSync(p) : null);
/** Builds the index from the repository and copies the evidence files to `publicDir` (git-ignored) so Studio can link them. */
export function buildNativeIndex(repo, publicDir) {
  const root = join(repo, ...EVIDENCE_DIR.split("/"));
  if (publicDir) rmSync(publicDir, { recursive: true, force: true });
  const games = GAMES.map((g) => {
    const specBytes = readFileSync(join(repo, ...g.specPath.split("/")));
    const spec = JSON.parse(specBytes.toString("utf8"));
    if (spec?.project?.id !== g.id) throw new Error(`${g.specPath}: project.id is ${spec?.project?.id}, expected ${g.id}`);
    const specHash = specSha256(specBytes);
    const platforms = Object.keys(PLATFORMS).map((platform) => {
      const dir = join(root, platform, g.id);
      const bytes = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readOpt(join(dir, f))]));
      const text = (k) => (bytes[k] == null ? null : bytes[k].toString("utf8"));
      const result = evaluatePlatform({ platform, gameId: g.id, specSha256: specHash, report: text("report"), results: text("results"), logs: text("logs"), screenshot: bytes.screenshot });
      const files = {};
      for (const [k, f] of Object.entries(FILES)) {
        if (bytes[k] == null) { files[k] = null; continue; }
        const rel = `evidence/native-apps/${platform}/${g.id}/${f}`;
        if (publicDir) {
          const target = join(publicDir, platform, g.id, f);
          mkdirSync(join(publicDir, platform, g.id), { recursive: true });
          copyFileSync(join(dir, f), target);
        }
        files[k] = { name: f, url: rel, repoPath: `${EVIDENCE_DIR}/${platform}/${g.id}/${f}`, bytes: bytes[k].length, sha256: sha256(bytes[k]) };
      }
      return { ...result, files };
    });
    return { id: g.id, specPath: g.specPath, specSha256: specHash, label: projectLabel(platforms), platforms };
  });
  return { evidenceDir: EVIDENCE_DIR, scope: SCOPE_NOTE, games };
}
