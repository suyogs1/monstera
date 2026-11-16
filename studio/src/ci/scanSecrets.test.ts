import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../../scripts/scan-secrets.mjs";

// Credential-shaped strings are assembled at run time so this file itself holds none.
const fake = {
  aws: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
  github: ["gh", "p_", "a".repeat(36)].join(""),
  pem: ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
  named: ["VERCEL_", "TOKEN", '="', "x".repeat(20), '"'].join(""),
};
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "scan-")); mkdirSync(join(dir, "assets")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, body: string) => writeFileSync(join(dir, name), body);

describe("secret scan", () => {
  it("passes clean output and a dangling source map reference", () => {
    put("assets/a.js", "console.log(1);\n//# sourceMappingURL=a.js.map\n");
    expect(scan(dir).findings).toEqual([]);
  });
  it("finds credential-shaped strings and reports rule, file and count only", () => {
    put("assets/a.js", `${fake.aws} ${fake.github} ${fake.named}`);
    put("b.txt", fake.pem);
    const { findings } = scan(dir);
    expect(findings.map((f) => `${f.rule}@${f.file}`).sort()).toEqual([
      "aws-access-key-id@assets/a.js", "github-token@assets/a.js", "named-secret-assignment@assets/a.js", "private-key-block@b.txt",
    ]);
    const printed = JSON.stringify(findings);
    for (const v of Object.values(fake)) expect(printed).not.toContain(v);
  });
  it("flags shipped source maps and inline source maps", () => {
    put("assets/a.js.map", '{"sources":["C:\\\\Users\\\\dev\\\\x.ts"]}');
    put("assets/b.js", "//# sourceMappingURL=data:application/json;base64,AAAA");
    expect(scan(dir).findings.map((f) => f.rule).sort()).toEqual(["source-map-file", "source-map-inline", "source-map-local-path"]);
  });
});

describe("secret scan: Studio Foundry rules", () => {
  // Assembled at run time so this file holds none of them.
  const foundry = {
    serviceAccount: ['{"ty', 'pe": "service_', 'account"}'].join(""),
    oauth: ["GOC", "SPX-", "a".repeat(28)].join(""),
    admobUnit: ["ca-app", "-pub-", "1234567890123456", "/", "1234567890"].join(""),
    admobApp: ["ca-app", "-pub-", "1234567890123456", "~", "1234567890"].join(""),
    googleTestUnit: ["ca-app", "-pub-", "3940256099942544", "/", "6300978111"].join(""),
    openai: ["https://api.", "openai", ".com/v1"].join(""),
    anthropic: ["api.", "anthropic", ".com"].join(""),
    gemini: ["generativelanguage", ".googleapis.com"].join(""),
    googleKey: ["AI", "za", "A".repeat(35)].join(""),
  };
  it("finds Firebase service accounts, OAuth client secrets, AdMob ids and AI provider hosts", () => {
    put("assets/a.js", Object.values(foundry).filter((v) => v !== foundry.googleTestUnit).join(" "));
    const rules = scan(dir).findings.map((f) => f.rule).sort();
    expect(rules).toEqual(["admob-id", "ai-provider-host", "google-api-key", "google-oauth-client-secret", "service-account-json"]);
    const counts = Object.fromEntries(scan(dir).findings.map((f) => [f.rule, f.count]));
    expect(counts["admob-id"]).toBe(2); // unit id and app id
    expect(counts["ai-provider-host"]).toBe(3);
  });
  it("allows Google's published AdMob test publisher id", () => {
    put("assets/a.js", foundry.googleTestUnit);
    expect(scan(dir).findings).toEqual([]);
  });
  it("never reports a matched value", () => {
    put("assets/a.js", Object.values(foundry).join(" "));
    const printed = JSON.stringify(scan(dir).findings);
    for (const v of Object.values(foundry)) expect(printed).not.toContain(v);
  });
  it("scans plain text and JSON exports, not only scripts", () => {
    put("setup.md", foundry.admobUnit);
    put("integrations.json", foundry.serviceAccount);
    expect(scan(dir).findings.map((f) => `${f.rule}@${f.file}`).sort()).toEqual(["admob-id@setup.md", "service-account-json@integrations.json"]);
  });
});
