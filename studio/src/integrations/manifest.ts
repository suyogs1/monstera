// Integrations manifest module (task 6.1): the one entry point for reading and writing integrations.json. It adds the
// secret field guard in front of the shared manifest validator. The schema has no production or live value: mode is
// mock or test, backend status is scaffold. Nothing here contacts a service or holds an id.
import { parseManifest, serializeManifest, validateManifest, type Issue, type IntegrationsManifest, type ManifestResult } from "../project/manifests";
import { findSecrets, secretRules } from "./secrets";
export const INTEGRATIONS_MODES = ["mock", "test"] as const;
export const BACKEND_STATUS = "scaffold" as const;
export const AD_TYPES = ["banner", "interstitial", "rewarded"] as const;
export const AD_TRIGGERS = ["game-lost", "game-start", "game-won", "manual"] as const;
const refused = (path: (string | number)[], rule: string): Issue => ({ path, code: "secret-like", message: `refused: the value matches the secret pattern "${rule}"; Studio stores no keys, ids or service files` });
/** Secret guard first, then the shared schema and internal checks. */
export function validateIntegrations(value: unknown): ManifestResult<"integrations"> {
  const found = findSecrets(value);
  if (found.length > 0) return { ok: false, issues: found.map((f) => refused(f.path, f.rule)) };
  return validateManifest("integrations", value);
}
/** Parses integrations.json text or bytes. Text matching a secret rule is refused before it is parsed. */
export function parseIntegrations(input: string | Uint8Array): ManifestResult<"integrations"> {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  const rules = secretRules(text);
  if (rules.length > 0) return { ok: false, issues: rules.map((r) => refused([], r)) };
  return parseManifest("integrations", input);
}
/** Canonical text. Throws on an invalid manifest or on any secret-shaped value. */
export function serializeIntegrations(value: IntegrationsManifest): string {
  const r = validateIntegrations(value);
  if (!r.ok) throw new Error(`cannot serialize integrations: ${r.issues[0]?.path.join(".")} ${r.issues[0]?.code}`);
  return serializeManifest("integrations", value);
}
