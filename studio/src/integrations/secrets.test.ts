import { describe, expect, it } from "vitest";
import { RULES } from "../../scripts/scan-secrets.mjs";
import { SECRET_RULES, findSecrets, looksSecret, secretRules } from "./secrets";
import { SECRET_SAMPLES } from "./secrets.testkit";
describe("field secret guard", () => {
  it("has one sample per rule and refuses each with its rule name", () => {
    expect(Object.keys(SECRET_SAMPLES).sort()).toEqual(SECRET_RULES.map((r) => r.rule).sort());
    for (const [rule, sample] of Object.entries(SECRET_SAMPLES)) {
      expect(secretRules(sample), rule).toContain(rule);
      expect(looksSecret(sample), rule).toBe(true);
    }
  });
  it("accepts ordinary text", () => {
    for (const s of ["rewarded-extra-life", "google-services.json", "Pumpkin Blaster", "https://example.com/a"]) expect(looksSecret(s), s).toBe(false);
  });
  it("reports rule and path, never the value", () => {
    for (const [rule, sample] of Object.entries(SECRET_SAMPLES)) {
      const f = findSecrets({ a: [{ b: sample }] });
      expect(f.map((x) => x.rule), rule).toContain(rule);
      expect(f[0]?.path).toEqual(["a", 0, "b"]);
      expect(JSON.stringify(f)).not.toContain(sample);
    }
  });
  it("matches every rule of the 1.6 scan (same patterns), except the pinned admob asymmetry", () => {
    const rules = RULES as { id: string; re: RegExp }[];
    for (const r of rules.filter((x) => x.id !== "admob-id")) {
      const sample = SECRET_SAMPLES[r.id];
      expect(sample, `guard sample for scan rule ${r.id}`).toBeDefined();
      expect(secretRules(sample!), r.id).toContain(r.id);
      expect(new RegExp(r.re.source, r.re.flags.replace("g", "")).test(r.id === "named-secret-assignment" ? sample!.replace("=", '="') + '"' : sample!), `scan matches ${r.id}`).toBe(true);
    }
    const testPublisher = SECRET_SAMPLES["admob-id"]!;
    expect(looksSecret(testPublisher)).toBe(true); // the guard refuses every ad unit id
    const admob = rules.find((x) => x.id === "admob-id")!;
    expect(new RegExp(admob.re.source).test(testPublisher)).toBe(false); // the scan allows Google's test publisher
  });
});