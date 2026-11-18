// Field guard for the integrations module (design section 8): refuses text shaped like a credential before it can enter
// state, a manifest or an export. Studio stores no ad unit ids, keys or service files, so any match is refused. Findings
// carry a rule name and a path, never the matched value.
export interface SecretRule { rule: string; pattern: RegExp }
export const SECRET_RULES: readonly SecretRule[] = [
  { rule: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { rule: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { rule: "service-account-json", pattern: /\\?"type\\?"\s*:\s*\\?"service_account/ },
  { rule: "admob-id", pattern: /ca-app-pub-/i },
  { rule: "aws-access-key-id", pattern: /AKIA[0-9A-Z]{16}/ },
  { rule: "firebase-key-assignment", pattern: /firebase[\w.-]*(?:api[_-]?key|secret|token)\s*[:=]\s*\S{8,}/i },
  { rule: "named-secret-assignment", pattern: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)\s*[:=]\s*["']?[^\s"']{8,}/ },
  { rule: "ai-provider-host", pattern: /api\.(?:openai|anthropic)\.com|generativelanguage\.googleapis\.com/i },
];
/** Names of the rules the text matches. Empty means the text is acceptable. */
export function secretRules(text: string): string[] {
  return SECRET_RULES.filter((r) => r.pattern.test(text)).map((r) => r.rule);
}
export const looksSecret = (text: string): boolean => secretRules(text).length > 0;
export interface SecretFinding { path: (string | number)[]; rule: string }
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
