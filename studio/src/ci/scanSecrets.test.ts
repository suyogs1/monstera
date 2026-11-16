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
