// Field guard for the integrations module (design section 8): refuses text shaped like a credential before it can enter
// state, a manifest or an export. Studio stores no ad unit ids, keys or service files, so any match is refused. Findings
// carry a rule name and a path, never the matched value.
export interface SecretRule { rule: string; pattern: RegExp }
export const SECRET_RULES: readonly SecretRule[] = [
  { rule: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { rule: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/ },
  { rule: "service-account-json", pattern: /\\?"type\\?"\s*:\s*\\?"service_account/ },
  { rule: "admob-id", pattern: /ca-app-pub-/i },
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "firebase-key-assignment", pattern: /firebase[\w.-]*(?:api[_-]?key|secret|token)\s*[:=]\s*\S{8,}/i },
  { rule: "named-secret-assignment", pattern: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)\s*[:=]\s*["']?[^\s"']{8,}/ },
  { rule: "ai-provider-host", pattern: /\b(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(?:ai|com)|api\.groq\.com|api\.deepseek\.com|api\.x\.ai|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com|openrouter\.ai\/api)\b/i },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { rule: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "stripe-live-key", pattern: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/ },
  { rule: "llm-api-key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
  { rule: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "url-with-credentials", pattern: /\bhttps?:\/\/[^/\s:@"'`]+:[^/\s:@"'`]{3,}@[A-Za-z0-9.-]+/ },
  { rule: "google-oauth-client-secret", pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
];
/** Names of the rules the text matches. Empty means the text is acceptable. */
export function secretRules(text: string): string[] {
  return SECRET_RULES.filter((r) => r.pattern.test(text)).map((r) => r.rule);
}
export const looksSecret = (text: string): boolean => secretRules(text).length > 0;
export interface SecretFinding { path: (string | number)[]; rule: string }
/** A path for a message. A credential can be an object key, so a segment that itself matches a rule is never echoed. */
export const safePath = (p: readonly (string | number)[]): string =>
  p.map((s) => (typeof s === "string" && secretRules(s).length > 0 ? "<key>" : String(s))).join(".") || "value";
/**
 * The one guard for a whole project: the spec document and every Studio manifest. Returns a refusal message that names the
 * rule and a redacted location and never the matched value, or null when nothing credential-shaped is present. Every path that
 * commits or exports a full project state goes through this function.
 */
export function refuseSecrets(state: { doc: unknown; manifests: unknown }): string | null {
  const inSpec = findSecrets(state.doc)[0];
  if (inSpec) return `a credential-shaped value (${inSpec.rule}) at specification ${safePath(inSpec.path)} is not accepted. Studio never stores keys`;
  const inManifest = findSecrets(state.manifests)[0];
  if (inManifest) return `a credential-shaped value (${inManifest.rule}) at manifest ${safePath(inManifest.path)} is not accepted. Studio never stores keys`;
  return null;
}
/** Walks every string value and object key of a parsed value. */
export function findSecrets(value: unknown, path: (string | number)[] = []): SecretFinding[] {
  if (typeof value === "string") return secretRules(value).map((rule) => ({ path, rule }));
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, [...path, i]));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [
      ...secretRules(k).map((rule) => ({ path: [...path, k], rule })),
      ...findSecrets(v, [...path, k]),
    ]);
  }
  return [];
}
