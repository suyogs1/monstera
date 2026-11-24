// Static-markup checks of the Backend and Monetization views (task 6.3). The interactive flow needs a browser: studio/scripts/shell.mjs opens the route.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isEditable, sectionsOf } from "../app/router";
import { xrefManifests } from "../project/xref.testkit";
import type { IntegrationsManifest } from "../project/manifests";
import { BackendView } from "./Backend";
import { ALL_LABELS, BACKEND_BANNER, MONETIZATION_BANNER } from "./labels";
import { MockBehaviourView, PlacementsView } from "./Ads";
import { scanScaffoldText, unnegatedClaims } from "./scaffold";

const noop = () => undefined;
const populated = (): IntegrationsManifest => xrefManifests().integrations;
const empty = (): IntegrationsManifest => ({ ...populated(), monetization: { ...populated().monetization, placements: [] } });
const testMode = (): IntegrationsManifest => ({ ...populated(), monetization: { ...populated().monetization, mode: "test" } });
const STATES: [string, IntegrationsManifest][] = [["empty", empty()], ["populated", populated()], ["test mode", testMode()]];

const backend = (m: IntegrationsManifest, notice: string | null = null) => renderToStaticMarkup(<BackendView integrations={m} notice={notice} onToggle={noop} />);
const placements = (m: IntegrationsManifest, notice: string | null = null) =>
  renderToStaticMarkup(<PlacementsView integrations={m} notice={notice} onMode={noop} onAdd={noop} onRemove={noop} onField={noop} />);
const mock = (m: IntegrationsManifest) => renderToStaticMarkup(<MockBehaviourView integrations={m} />);
const views = (m: IntegrationsManifest): [string, string, string][] => [["backend", backend(m), BACKEND_BANNER], ["placements", placements(m), MONETIZATION_BANNER], ["mock", mock(m), MONETIZATION_BANNER]];
const text = (html: string) => html.replace(/<[^>]*>/g, "\n").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe("permanent scaffold and mock banners", () => {
  it("every view shows its banner in every manifest state, with no button or dismiss control inside it", () => {
    for (const [state, m] of STATES) for (const [name, html, banner] of views(m)) {
      const found = /<p[^>]*data-testid="scaffold-banner"[^>]*>([^<]*)<\/p>/.exec(html);
      expect(found?.[1], `${name} ${state}`).toBe(banner);
      expect(found?.[0], `${name} ${state}`).toContain('role="note"');
      expect(found?.[0]).not.toMatch(/button|dismiss|close|hidden/i);
    }
  });
  it("banner text says scaffold, mock, and not connected", () => {
    expect(BACKEND_BANNER).toBe("Scaffold only. Not connected to any backend.");
    expect(MONETIZATION_BANNER).toMatch(/^Mock only\./);
    expect(MONETIZATION_BANNER).toMatch(/labelled MOCK overlay/);
  });
});

describe("no unit id, key or production control", () => {
  const FORBIDDEN = /unit|app ?id|ad ?unit|api ?key|secret|token|credential/i;
  it("no control is labelled or named like an id or key; the id field says it is a placement name", () => {
    for (const [state, m] of STATES) for (const [name, html] of views(m)) {
      for (const tag of html.match(/<(input|select|textarea|button)\b[^>]*>/g) ?? []) {
        for (const attr of ["aria-label", "name", "id", "placeholder"]) {
          const v = new RegExp(`${attr}="([^"]*)"`).exec(tag)?.[1] ?? "";
          expect(v, `${name} ${state} ${attr}`).not.toMatch(FORBIDDEN);
        }
      }
      for (const label of html.match(/<label[^>]*>.*?<\/label>/g) ?? []) expect(text(label), `${name} ${state}`).not.toMatch(FORBIDDEN);
    }
    expect(placements(populated())).toContain("A placement name, not an ad unit id.");
  });
  it("the mode select offers exactly mock and test; no control offers production or live", () => {
    for (const [, m] of STATES) {
      const html = placements(m);
      const select = /<select aria-label="Mode"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? "";
      expect([...select.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1])).toEqual(["mock", "test"]);
      for (const tag of html.match(/<option\b[^>]*>[^<]*/g) ?? []) expect(tag).not.toMatch(/production|live/i);
    }
  });
  it("the Backend view has no text input at all", () => {
    for (const [, m] of STATES) expect(backend(m)).not.toMatch(/<input[^>]*type="text"|<textarea/);
  });
});

describe("honesty scan (design 8.2)", () => {
  it("rendered text of every view in every state has no unnegated claim and no secret", () => {
    for (const [state, m] of STATES) for (const [name, html] of views(m)) {
      const t = text(html);
      expect(unnegatedClaims(t), `${name} ${state}`).toEqual([]);
      expect(scanScaffoldText(t).filter((x) => x.startsWith("secret:")), `${name} ${state}`).toEqual([]);
    }
  });
  it("every exported label passes the same scan", () => {
    for (const l of ALL_LABELS) expect(unnegatedClaims(l), l).toEqual([]);
    expect(scanScaffoldText(ALL_LABELS.join("\n"))).toEqual([]);
  });
  it("the Mock behaviour preview shows the MOCK service and its marker", () => {
    const html = mock(populated());
    expect(html).toContain("MockRewardedAdService");
    expect(html).toContain("IS_MOCK: Boolean = true");
    expect(html).toContain("[MOCK AD]");
    expect(html).toContain('data-testid="frequency-rules"');
  });
  it("the Backend preview shows only Firebase scaffold files", () => {
    const html = backend(populated());
    expect(html).toContain("scaffold/android/FirebaseServices.kt");
    expect(html).toContain("scaffold/ios/FirebaseServices.swift");
    expect(html).not.toContain("MockRewardedAdService");
    expect(html).toContain("google-services.json");
  });
});

describe("notices and placement fields", () => {
  it("a refused edit shows its notice", () => {
    expect(backend(populated(), "Not applied: nope")).toContain("Not applied: nope");
    expect(placements(populated(), "Not applied: nope")).toContain('data-testid="integrations-notice"');
  });
  it("a rewarded placement shows reward fields; a banner or interstitial placement does not", () => {
    const html = placements(populated());
    const part = (id: string) => new RegExp(`<fieldset data-testid="placement-${id}">.*?</fieldset>`).exec(html)?.[0] ?? "";
    expect(part("rewarded-extra-life")).toContain('aria-label="Reward amount rewarded-extra-life"');
    expect(part("interstitial-lost")).not.toContain("Reward amount");
    expect(part("interstitial-lost")).toContain("Only a rewarded placement has a reward.");
  });
});

describe("routing", () => {
  it("backend and monetization list their views and are editable", () => {
    expect(isEditable("backend")).toBe(true);
    expect(isEditable("monetization")).toBe(true);
    expect(sectionsOf("backend").map((s) => s.slug)).toEqual(["firebase"]);
    expect(sectionsOf("monetization").map((s) => s.slug)).toEqual(["placements", "mock"]);
  });
});
