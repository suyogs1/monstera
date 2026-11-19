// Test-environment table (R11.2): which checks exist for the current spec hash at which environment.
// Every row is folded from a record: a committed conformance report, a committed native app evidence record, or this
// session's determinism check, each bound to the exact canonical SHA-256. Nothing is inferred. A row can read `passed`
// only when at least one source record backs it, and a hash with no record reads `no evidence for this hash`.
import type { Verdict } from "../badge/badge";
import type { ConformanceReport } from "../badge/native";
import { matchNativeApps, type NativeIndex } from "../badge/nativeApps";

export const ENVIRONMENTS = ["browser", "oracle", "jvm", "swift-test", "simulator", "device"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
export const NO_EVIDENCE = "no evidence for this hash" as const;
export type EnvState = "passed" | "failed" | "not run" | typeof NO_EVIDENCE;

export interface EnvRow {
  env: Environment;
  state: EnvState;
  /** Records that back the state: repository paths, or the in-page check. Never empty unless the state is `no evidence`. */
  sources: string[];
  detail: string;
}

interface Observation { state: "passed" | "failed" | "not run"; source: string; detail: string }

const WHAT: Record<Environment, string> = {
  browser: "Determinism check run in this page (oracle against recorded goldens), this session only",
  oracle: "Python oracle in `monstera conformance`",
  jvm: "Kotlin core, Gradle unit tests on the JVM (`monstera conformance`)",
  "swift-test": "Swift core, `swift test` (`monstera conformance`)",
  simulator: "Generated app built and launched on an emulator or simulator",
  device: "Generated app run on a physical device",
};

const CONFORMANCE_PLATFORM: Partial<Record<Environment, string>> = { oracle: "oracle", jvm: "kotlin", "swift-test": "swift" };

/** Folds observations: any failure wins, then any pass, then any skipped step. A pass without a source is dropped. */
function fold(env: Environment, observed: Observation[], none: string): EnvRow {
  const backed = observed.filter((o) => o.source !== "");
  const pick = (s: Observation["state"]) => backed.filter((o) => o.state === s);
  const state: EnvState = pick("failed").length ? "failed" : pick("passed").length ? "passed" : pick("not run").length ? "not run" : NO_EVIDENCE;
  if (state === NO_EVIDENCE) return { env, state, sources: [], detail: none };
  const used = pick(state === "failed" ? "failed" : state === "passed" ? "passed" : "not run");
  return { env, state, sources: [...new Set(used.map((o) => o.source))], detail: used.map((o) => o.detail).join("; ") };
}

function conformanceObservations(env: Environment, reports: ConformanceReport[]): Observation[] {
  const platform = CONFORMANCE_PLATFORM[env];
  const out: Observation[] = [];
  for (const r of reports) {
    for (const p of r.platforms) {
      if (p.platform !== platform) continue;
      const state = p.status === "pass" ? "passed" : p.status === "fail" || p.status === "error" ? "failed" : p.status === "skipped" ? "not run" : null;
      if (state) out.push({ state, source: r.file, detail: `${p.platform} ${p.status}` });
    }
  }
  return out;
}

function simulatorObservations(index: NativeIndex, sha: string): Observation[] {
  const game = matchNativeApps(index, sha, null).exact;
  if (!game) return [];
  return game.platforms.map((p): Observation => {
    const source = p.files.report?.repoPath ?? "";
    const failed = p.checks.compile.state === "fail" || p.checks.launch.state === "fail";
    const state = failed ? "failed" : p.label === "SIMULATOR-TESTED" ? "passed" : "not run";
    return { state, source, detail: `${p.device}: ${p.label}` };
  });
}

function browserObservation(v: Verdict | null): Observation[] {
  if (v?.kind === "match") return [{ state: "passed", source: "determinism check in this page", detail: `${v.run.scenarios.length} recorded goldens reproduced` }];
  if (v?.kind === "diverged") return [{ state: "failed", source: "determinism check in this page", detail: `${v.divergedScenarios} of ${v.run.scenarios.length} recorded goldens differ` }];
  return [];
}

export interface EnvInput {
  /** Canonical SHA-256 of the validated current draft; null when there is none. */
  sha: string | null;
  reports: ConformanceReport[];
  native: NativeIndex;
  /** Verdict of this session's determinism check for the current draft, as computed by `verdict()`. */
  browser: Verdict | null;
}

export function environmentTable(input: EnvInput): EnvRow[] {
  const { sha } = input;
  const exact = sha ? input.reports.filter((r) => r.specSha256 === sha) : [];
  return ENVIRONMENTS.map((env) => {
    const none = `${WHAT[env]}: no record for this hash.`;
    if (!sha) return { env, state: NO_EVIDENCE, sources: [], detail: "Waiting for a valid, validated draft." };
    switch (env) {
      case "browser": return fold(env, browserObservation(input.browser), none);
      case "simulator": return fold(env, simulatorObservations(input.native, sha), none);
      case "device": return { env, state: NO_EVIDENCE, sources: [], detail: `${WHAT[env]}: Studio indexes no physical-device evidence, and none is claimed.` };
      default: return fold(env, conformanceObservations(env, exact), none);
    }
  });
}
