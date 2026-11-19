import { describe, expect, it } from "vitest";
import { xrefManifests } from "../project/xref.testkit";
import { addPlacement, removePlacement, setMode, setPlacement, setService } from "./ops";
import { SECRET_SAMPLES } from "./secrets.testkit";
const base = () => xrefManifests().integrations;
const ok = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
describe("integrations ops", () => {
  it("toggles a service and leaves the others", () => {
    const r = ok(setService(base(), "auth", true));
    expect(r.integrations.backend.services).toEqual({ analytics: true, auth: true, crashlytics: true, firestore: false, remoteConfig: false });
    expect(setService(base(), "bogus", true).ok).toBe(false);
  });
  it("changes mock to test, and refuses production at run time", () => {
    expect(ok(setMode(base(), "test")).integrations.monetization.mode).toBe("test");
    // @ts-expect-error production is not representable
    const r = setMode(base(), "production");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("mock and test only");
  });
  it("adds a placement with a unique id and keeps ids sorted", () => {
    const a = ok(addPlacement(base())).integrations;
    expect(a.monetization.placements.map((p) => p.id)).toEqual(["interstitial-lost", "placement-1", "rewarded-extra-life"]);
    const b = ok(addPlacement(a)).integrations;
    expect(b.monetization.placements.map((p) => p.id)).toEqual(["interstitial-lost", "placement-1", "placement-2", "rewarded-extra-life"]);
  });
  it("renaming re-sorts; changing to a non-rewarded type clears the reward; to rewarded sets a valid default", () => {
    const renamed = ok(setPlacement(base(), "interstitial-lost", "id", "zz-last")).integrations;
    expect(renamed.monetization.placements.map((p) => p.id)).toEqual(["rewarded-extra-life", "zz-last"]);
    const cleared = ok(setPlacement(base(), "rewarded-extra-life", "type", "banner")).integrations.monetization.placements[1];
    expect([cleared?.type, cleared?.rewardKind, cleared?.rewardAmount]).toEqual(["banner", "", 0]);
    const rewarded = ok(setPlacement(base(), "interstitial-lost", "type", "rewarded")).integrations.monetization.placements[0];
    expect([rewarded?.rewardKind, rewarded?.rewardAmount]).toEqual(["reward", 1]);
  });
  it("refuses a rewarded placement with amount 0 using the manifest message", () => {
    const r = setPlacement(base(), "rewarded-extra-life", "rewardAmount", 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("a rewarded placement needs a reward kind and an amount of at least 1");
  });
  it("refuses secret-looking and ad-unit-shaped ids", () => {
    for (const k of ["admob-id", "google-api-key"]) {
      const r = setPlacement(base(), "interstitial-lost", "id", SECRET_SAMPLES[k] as string);
      expect(r.ok, k).toBe(false);
    }
    const r = setPlacement(base(), "interstitial-lost", "rewardKind", SECRET_SAMPLES["admob-id"] as string);
    expect(r.ok).toBe(false);
  });
  it("removes a placement and refuses an unknown one", () => {
    expect(ok(removePlacement(base(), "interstitial-lost")).integrations.monetization.placements.map((p) => p.id)).toEqual(["rewarded-extra-life"]);
    expect(removePlacement(base(), "nope").ok).toBe(false);
  });
});
