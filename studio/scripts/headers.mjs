// Response header policy for the Studio: X-Content-Type-Options and a Content-Security-Policy that ships report-only first.
// The policy lives in security/headers.json. This module turns it into headers for three consumers: the local production
// preview used by the smoke test, the Vercel configuration the owner places at the project's Root Directory, and unit tests.
// Usage: node scripts/headers.mjs --vercel    prints the Vercel "headers" block for the current mode
//        node scripts/headers.mjs [mode]      prints the header list (mode: report-only | enforce)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const POLICY_PATH = join(here, "..", "security", "headers.json");
export const MODES = ["report-only", "enforce"];

export function loadPolicy(path = POLICY_PATH) {
  const policy = JSON.parse(readFileSync(path, "utf8"));
  if (policy.schema !== "monstera.studio.headers" || policy.version !== 1) throw new Error("unknown headers policy format");
  if (!MODES.includes(policy.mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  return policy;
}

export function cspText(policy) {
  return Object.entries(policy.directives).map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

/** @param {string} [mode] defaults to the policy's deployed mode */
export function resolveHeaders(policy = loadPolicy(), mode = policy.mode) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  return [
    { key: "X-Content-Type-Options", value: policy.nosniff },
    { key: mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", value: cspText(policy) },
  ];
}

export function toVercelConfig(policy = loadPolicy(), mode = policy.mode) {
  return { headers: [{ source: "/(.*)", headers: resolveHeaders(policy, mode) }] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const out = arg === "--vercel" ? toVercelConfig() : resolveHeaders(loadPolicy(), arg);
  console.log(JSON.stringify(out, null, 2));
}
