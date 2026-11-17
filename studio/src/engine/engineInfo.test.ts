import { describe, expect, it } from "vitest";
import { parseEngineInfo } from "./engineInfo";

const sha = "1e78607c0c39ec8e658e179c4b792ce4727e1460";
describe("parseEngineInfo", () => {
  it("accepts the shapes build-engine.mjs writes", () => {
    expect(parseEngineInfo({ gitCommit: sha, dirty: false, source: "git" })).toEqual({ gitCommit: sha, dirty: false, source: "git" });
    expect(parseEngineInfo({ gitCommit: sha, dirty: true, source: "git" }).dirty).toBe(true);
    expect(parseEngineInfo({ gitCommit: sha, dirty: null, source: "VERCEL_GIT_COMMIT_SHA" })).toEqual({ gitCommit: sha, dirty: null, source: "VERCEL_GIT_COMMIT_SHA" });
  });
  it.each([
    ["missing", undefined], ["null", null], ["an array", []], ["no commit", { dirty: false, source: "git" }],
    ["a short commit", { gitCommit: sha.slice(0, 7), dirty: false, source: "git" }], ["an upper-case commit", { gitCommit: sha.toUpperCase(), dirty: false, source: "git" }],
    ["a placeholder", { gitCommit: "unknown", dirty: false, source: "git" }], ["a non-hex 40-char commit", { gitCommit: "z".repeat(40), dirty: false, source: "git" }],
    ["a non-string commit", { gitCommit: 5, dirty: false, source: "git" }], ["no dirty flag", { gitCommit: sha, source: "git" }],
    ["an unknown source", { gitCommit: sha, dirty: false, source: "inventory" }],
    ["git with unknown cleanliness", { gitCommit: sha, dirty: null, source: "git" }],
    ["a Vercel build claiming to be clean", { gitCommit: sha, dirty: false, source: "VERCEL_GIT_COMMIT_SHA" }],
    ["a Vercel build claiming to be dirty", { gitCommit: sha, dirty: true, source: "VERCEL_GIT_COMMIT_SHA" }],
    ["a Vercel build without a dirty field", { gitCommit: sha, source: "VERCEL_GIT_COMMIT_SHA" }],
  ])("rejects %s", (_n, v) => {
    expect(() => parseEngineInfo(v)).toThrow();
  });
});
