import { describe, expect, it } from "vitest";
import { cspText, loadPolicy, resolveHeaders, toVercelConfig, type HeadersPolicy } from "../../scripts/headers.mjs";

const policy = loadPolicy();
const directive = (p: HeadersPolicy, name: string) => p.directives[name] ?? [];

describe("Studio response header policy", () => {
  it("always sends X-Content-Type-Options: nosniff", () => {
    for (const mode of ["report-only", "enforce"]) {
      expect(resolveHeaders(policy, mode)).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    }
  });
  it("ships the CSP as report-only until the policy is proven, then as an enforced header", () => {
    expect(policy.mode).toBe("report-only");
    expect(resolveHeaders(policy).map((h) => h.key)).toEqual(["X-Content-Type-Options", "Content-Security-Policy-Report-Only"]);
    expect(resolveHeaders(policy, "enforce").map((h) => h.key)).toEqual(["X-Content-Type-Options", "Content-Security-Policy"]);
    expect(() => resolveHeaders(policy, "off")).toThrow(/unknown mode/);
  });
  it("is deny-by-default and allows no script execution beyond WebAssembly", () => {
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "connect-src")).toEqual(["'self'"]);
    const text = cspText(policy);
    expect(text).not.toMatch(/'unsafe-eval'/);
    expect(text).not.toMatch(/https?:|\*/); // no remote origin and no wildcard
    expect(text).not.toMatch(/report-(uri|to)/); // a static site has no collector; nothing leaves the origin
  });
  it("allows inline style attributes only, never inline styles or scripts", () => {
    expect(directive(policy, "style-src")).toEqual(["'self'"]);
    expect(directive(policy, "style-src-attr")).toEqual(["'unsafe-inline'"]);
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
  });
  it("renders a Vercel headers block that applies to every path", () => {
    const v = toVercelConfig(policy);
    expect(v.headers).toHaveLength(1);
    expect(v.headers[0]?.source).toBe("/(.*)");
    expect(v.headers[0]?.headers).toEqual(resolveHeaders(policy));
  });
  it("rejects a policy file of the wrong format or mode", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hdr-"));
    const bad = (obj: unknown) => { const p = join(dir, "h.json"); writeFileSync(p, JSON.stringify(obj)); return () => loadPolicy(p); };
    expect(bad({ ...policy, mode: "off" })).toThrow(/mode/);
    expect(bad({ ...policy, version: 2 })).toThrow(/format/);
  });
});
