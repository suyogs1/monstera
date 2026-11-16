export interface HeadersPolicy {
  schema: string; version: number; note: string; mode: "report-only" | "enforce"; nosniff: string; directives: Record<string, string[]>;
}
export interface Header { key: string; value: string }
export const POLICY_PATH: string;
export const MODES: string[];
export function loadPolicy(path?: string): HeadersPolicy;
export function cspText(policy: HeadersPolicy): string;
export function resolveHeaders(policy?: HeadersPolicy, mode?: string): Header[];
export function toVercelConfig(policy?: HeadersPolicy, mode?: string): { headers: { source: string; headers: Header[] }[] };
