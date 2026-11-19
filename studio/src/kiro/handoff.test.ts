import { describe, expect, it } from "vitest";
import { handoffPrompts, PROPOSAL_EXAMPLE } from "./handoff";
import { parseProposal } from "./proposal";
describe("handoff prompts", () => {
  const prompts = handoffPrompts("lantern-run");
  it("keeps the two repository prompts and adds two pack prompts", () => {
    expect(prompts.map((p) => p.id)).toEqual(["validate", "change", "continue-export", "propose"]);
    expect(prompts[0]?.text).toContain("spec/samples/lantern-run/monstera.spec.json");
  });
  it("the pack prompts name the manifest, the drift command and the write-once root, and never ask to edit generated code", () => {
    const text = prompts[2]?.text ?? "";
    for (const s of ["MONSTERA-STUDIO-MANIFEST.json", "bash tools/check-drift.sh", "extensions/", "Do not edit android/, ios/"]) expect(text).toContain(s);
  });
  it("the example in the proposal prompt is itself a valid proposal", () => {
    expect(parseProposal(PROPOSAL_EXAMPLE).ok).toBe(true);
    expect(prompts[3]?.text).toContain(PROPOSAL_EXAMPLE);
  });
  it("no prompt implies a Kiro connection, a live service or store readiness", () => {
    for (const p of prompts) expect(p.text).not.toMatch(/connect|online|\blive\b|production|store-ready|synced/i);
  });
});
