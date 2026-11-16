export type CheckState = "pass" | "fail" | "missing" | "stale";
export interface Check { state: CheckState; detail: string }
export type NativeLabel = "GENERATED" | "COMPILED" | "SIMULATOR-TESTED";
export interface EvidenceFile { name: string; url: string; repoPath: string; bytes: number; sha256: string }
export interface PlatformEvidence {
  platform: "android" | "ios"; target: string; device: string; runId: string | null; problem: string | null;
  checks: { compile: Check; launch: Check; screenshot: Check; logs: Check; specHash: Check; integrity: Check; runtime: Check };
  label: NativeLabel; loggedSha256: string | null; ticks: number | null; screenshot: { width: number; height: number } | null;
  files: Record<"report" | "results" | "logs" | "screenshot", EvidenceFile | null>;
}
export interface GameEvidence { id: string; specPath: string; specSha256: string; label: NativeLabel; platforms: PlatformEvidence[] }
export interface NativeIndex { evidenceDir: string; scope: string; games: GameEvidence[] }
export const SCOPE_NOTE: string;
export const PLATFORMS: Record<string, { target: string; device: string }>;
export const GAMES: { id: string; specPath: string }[];
export const FILES: Record<string, string>;
export function sha256(bytes: Uint8Array): string;
export function specSha256(bytes: Uint8Array): string;
export function parseOperations(platform: string, gameId: string, report: string | null, results: string | null): { ops: Record<string, unknown>; runId: string | null; problem: string | null };
export function parseAppLog(platform: string, text: string | null, canonicalSha: string): { specHash: Check; integrity: Check; runtime: Check; loggedSha256: string | null; ticks: number | null };
export function parsePng(bytes: Uint8Array | null): { width: number; height: number } | null;
export function evaluatePlatform(i: { platform: "android" | "ios"; gameId: string; specSha256: string; report: string | null; results: string | null; logs: string | null; screenshot: Uint8Array | null }): Omit<PlatformEvidence, "files">;
export function projectLabel(platforms: { platform: string; label: NativeLabel }[]): NativeLabel;
export function buildNativeIndex(repo: string, publicDir?: string): NativeIndex;
