// Credential-shaped strings are assembled at run time so no source file holds one.
const j = (...p: string[]) => p.join("");
export const SECRET_SAMPLES: Record<string, string> = {
  "google-api-key": j("AI", "za", "A".repeat(35)),
  "private-key-block": j("-----BEGIN ", "RSA PRIVATE KEY-----"),
  "service-account-json": j('{"type": ', '"service_', 'account"}'),
  "admob-id": j("ca-app", "-pub-", "3940256099942544~3347511713"),
  "aws-access-key-id": j("AK", "IA", "ABCDEFGHIJKLMNOP"),
  "firebase-key-assignment": j("firebase", "ApiKey", "=", "x".repeat(20)),
  "named-secret-assignment": j("SERVICE_", "TOKEN", "=", "x".repeat(20)),
  "ai-provider-host": j("https://api.", "openai", ".com/v1"),
  "github-token": j("gh", "p_", "a".repeat(36)),
  "slack-token": j("xo", "xb-", "1234567890-abcdef"),
  "stripe-live-key": j("sk", "_live_", "a".repeat(24)),
  "llm-api-key": j("sk", "-ant-", "a".repeat(40)),
  "npm-token": j("npm", "_", "a".repeat(36)),
  jwt: j("ey", "J", "a".repeat(12), ".ey", "J", "b".repeat(12), ".", "c".repeat(12)),
  "url-with-credentials": j("https://", "user", ":", "hunter22", "@example.com"),
  "google-oauth-client-secret": j("GOC", "SPX-", "a".repeat(24)),
};
