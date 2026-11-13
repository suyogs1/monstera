// Adversarial regression tests for the badge verdict (workflow wf_d86b541f4b210b32).
import { describe, expect, it } from "vitest";
import { BadgeRunner, verdict, type BadgeRun } from "./badge";

const sha = "a".repeat(64);
const view = { revision: 1, validatedRevision: 1, ok: true, sha256: sha, originPath: "apps/p/monstera.spec.json" };

describe("a failed scenario list is an error, never 'no goldens'", () => {
  it("verdict() of a run whose scenario list could not be read", () => {
    const run: BadgeRun = {
      sha256: sha, revision: 1, origin: { templateId: "p", path: "apps/p/monstera.spec.json", basis: "template" },
      scenarios: [], results: [{ status: "error", file: "(scenario list)", draftSha256: null, message: "engine exploded" }],
      phase: "done", startedAt: 0, ms: 1,
    };
    expect(verdict(run, view).kind).toBe("error");
  });
  it("BadgeRunner when badgeScenarios rejects", async () => {
    const state = { revision: 1, validatedRevision: 1, validation: { ok: true, sha256: sha, canonicalText: "{}" },
      baseline: { origin: { templateId: "p", path: "apps/p/monstera.spec.json", basis: "template" } } };
    const engine = { badgeScenarios: async () => { throw new Error("worker died"); }, badgeCheck: async () => { throw new Error("unused"); } };
    const runner = new BadgeRunner(engine, { getState: () => state } as never);
    await runner.start();
    expect(verdict(runner.getState(), view).kind).toBe("error");
  });
});
