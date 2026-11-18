import { describe, expect, it } from "vitest";
import fixture from "../project/manifests/fixtures/integrations.valid.json";
import { parseIntegrations, serializeIntegrations, validateIntegrations } from "./manifest";
import { findSecrets, looksSecret } from "./secrets";
import type { IntegrationsManifest } from "../project/manifests";
import golden from "../project/manifests/fixtures/integrations.valid.json?raw";
// Credential-shaped strings are assembled at run time so no source file holds one.
const j = (...p: string[]) => p.join("");
const SAMPLES: Record<string, string> = {
  "google-api-key": j("AI", "za", "A".repeat(35)),
  "private-key-block": j("-----BEGIN ", "RSA PRIVATE KEY-----"),
  "service-account-json": j('{"type": ', '"service_', 'account"}'),
  "admob-id": j("ca-app", "-pub-", "3940256099942544~3347511713"),
  "aws-access-key-id": j("AK", "IA", "ABCDEFGHIJKLMNOP"),
  "firebase-key-assignment": j("firebase", "ApiKey", "=", "x".repeat(20)),
  "named-secret-assignment": j("SERVICE_", "TOKEN", "=", "x".repeat(20)),
  "ai-provider-host": j("https://api.", "openai", ".com/v1"),
};
const base = (): IntegrationsManifest => structuredClone(fixture) as IntegrationsManifest;
describe("integrations manifest", () => {
  it("accepts the valid fixture and round-trips to the golden text", () => {
    const r = validateIntegrations(base());
    expect(r.ok).toBe(true);
    expect(serializeIntegrations(base())).toBe(golden);
    expect(parseIntegrations(golden).ok).toBe(true);
  });
  it("has no production or live value anywhere", () => {
    for (const bad of ["production", "live", "prod"]) {
      const m = base() as unknown as { monetization: { mode: string }; backend: { status: string } };
      m.monetization.mode = bad;
      expect(validateIntegrations(m).ok, bad).toBe(false);
      const b = base() as unknown as { backend: { status: string } };
      b.backend.status = bad;
      expect(validateIntegrations(b).ok, bad).toBe(false);
    }
  });
  it("refuses each secret pattern in any string field, with rule and path but never the value", () => {
    for (const [rule, sample] of Object.entries(SAMPLES)) {
      expect(looksSecret(sample), rule).toBe(true);
      const m = base();
      m.monetization.placements[0]!.rewardKind = sample;
      const r = validateIntegrations(m);
      expect(r.ok, rule).toBe(false);
      if (r.ok) continue;
      expect(r.issues[0]).toMatchObject({ code: "secret-like", path: ["monetization", "placements", 0, "rewardKind"] });
      expect(JSON.stringify(r.issues)).not.toContain(sample);
      expect(r.issues.map((i) => i.message).join()).toContain(rule);
    }
  });
  it("refuses a secret in an unknown key, an id and raw text", () => {
    const k = { ...base(), [SAMPLES["google-api-key"]!]: 1 };
    expect(findSecrets(k).length).toBe(1);
    const m = base();
    m.monetization.placements[0]!.id = SAMPLES["admob-id"]!;
    expect(validateIntegrations(m).ok).toBe(false);
    for (const s of Object.values(SAMPLES)) {
      const r = parseIntegrations(golden.replace("interstitial-lost", JSON.stringify(s).slice(1, -1)));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]?.code).toBe("secret-like");
    }
  });
  it("does not refuse ordinary text, and still reports schema errors for clean input", () => {
    expect(looksSecret("rewarded-extra-life")).toBe(false);
    expect(looksSecret("google-services.json")).toBe(false);
    const m = base() as unknown as { bogus?: number };
    m.bogus = 1;
    const r = validateIntegrations(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("additional");
  });
  it("refuses to serialize a secret-shaped value", () => {
    const m = base();
    m.monetization.placements[0]!.rewardKind = SAMPLES["aws-access-key-id"]!;
    expect(() => serializeIntegrations(m)).toThrow(/secret-like/);
  });
});
