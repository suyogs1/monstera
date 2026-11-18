// Static-markup checks of the Gameplay Systems views (the interactive flow needs a browser: studio/scripts/shell.mjs opens the route).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../app/capabilities";
import { SECTION_ROUTES, isEditable, resolveHash, sectionsOf } from "../app/router";
import { planGameplayApply } from "../derive/apply";
import { gameplayIssues } from "../derive/gameplayOps";
import { Engine } from "../derive/testEngine";
import { kindIds } from "../draft/ops";
import { pumpkinDoc, xrefManifests } from "../project/xref.testkit";
import type { Json } from "../schema/schema";
import { GameplayModulesView, type GameplayModulesViewProps } from "./Modules";
import { GameplayPlanned, PLANNED_GAMEPLAY } from "./Planned";

const noop = () => undefined;
function props(over: Partial<GameplayModulesViewProps> = {}, doc: Json = pumpkinDoc()): GameplayModulesViewProps {
  const gameplay = xrefManifests().gameplay;
  return {
    gameplay, kinds: kindIds(doc), issues: gameplayIssues(gameplay, doc, false), on: false, validated: true, inSync: false, busy: false,
    notice: null, plan: null, stale: false, outcome: null, act: noop, onToggle: noop, onReview: noop, onApply: noop, ...over,
  };
}
const CONTROL_IN = (html: string, id: string) => new RegExp(`<(input|button|select)[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";

describe("Modules section", () => {
  it("shows forms for lives, win score, collectibles and enemies; derivation is off and both actions are disabled", () => {
    const p = props();
    const html = renderToStaticMarkup(<GameplayModulesView {...p} />);
    for (const id of ["region-rules", "region-collectibles", "region-enemies", "region-derive"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain('aria-label="Starting lives"');
    expect(html).toContain('aria-label="Winning score"');
    expect(html).toContain(`data-testid="collectible-${p.gameplay.collectibles[0]!.id}"`);
    expect(html).toContain(`data-testid="enemy-${p.gameplay.enemies[0]!.id}"`);
    expect(CONTROL_IN(html, "gameplay-derivation-toggle")).not.toContain("checked");
    expect(CONTROL_IN(html, "gameplay-review")).toContain("disabled");
    expect(CONTROL_IN(html, "gameplay-apply")).toContain("disabled");
    expect(html).toContain('data-state="off"');
    expect(html).not.toContain('data-testid="region-issues"');
  });
  it("with derivation on and a valid draft, Review is enabled and Apply still waits for a review", () => {
    const html = renderToStaticMarkup(<GameplayModulesView {...props({ on: true })} />);
    expect(CONTROL_IN(html, "gameplay-derivation-toggle")).toContain("checked");
    expect(CONTROL_IN(html, "gameplay-review")).not.toContain("disabled");
    expect(CONTROL_IN(html, "gameplay-apply")).toContain("disabled");
    expect(html).toContain('data-state="stale"');
  });
  it("a reviewed plan shows the diff, the rows that would be removed, and enables Apply; a stale review disables it", async () => {
    const m = xrefManifests();
    m.project = { ...m.project, derivation: { levels: false, gameplay: true, activeLevel: "" } };
    const plan = await planGameplayApply(pumpkinDoc(), m, new Engine());
    if (!plan.ok) throw new Error("plan failed");
    const html = renderToStaticMarkup(<GameplayModulesView {...props({ on: true, plan })} />);
    expect(html).toContain('data-testid="gameplay-diff"');
    expect(html).toContain("runtime.collisions");
    expect(html).toContain("Nothing has been written yet");
    if (plan.removedRows.length > 0) expect(html).toContain('data-testid="gameplay-removed"');
    expect(CONTROL_IN(html, "gameplay-apply")).not.toContain("disabled");
    const old = renderToStaticMarkup(<GameplayModulesView {...props({ on: true, plan, stale: true })} />);
    expect(CONTROL_IN(old, "gameplay-apply")).toContain("disabled");
    expect(old).toContain('data-testid="gameplay-review-stale"');
  });
  it("a refused apply says the spec is unchanged and lists each issue with its field path", () => {
    const outcome = { kind: "refused" as const, stage: "engine", issues: [{ source: "gameplay", path: ["lives", "start"], message: "too many" }] };
    const html = renderToStaticMarkup(<GameplayModulesView {...props({ on: true, outcome })} />);
    expect(html).toContain("the spec is unchanged");
    expect(html).toContain("gameplay: lives.start: too many");
  });
  it("shows a collision-pair conflict with a Designer-owned row at the module row that causes it", () => {
    const col = xrefManifests().gameplay.collectibles[0]!;
    const doc = pumpkinDoc() as any;
    doc.game.runtime.collisions = [{ a: col.kind, b: col.collectorKind, despawnA: false, despawnB: false, score: 999, lives: 0 }];
    const html = renderToStaticMarkup(<GameplayModulesView {...props({}, doc as Json)} />);
    expect(html).toMatch(new RegExp(`data-testid="collectible-${col.id}"[^>]*data-invalid="true"`));
    expect(html).toContain('data-testid="issue-collectibles-0"');
    expect(html).toContain('data-code="collision-conflict"');
  });
  it("shows an unknown kind at its field and offers it as '(no such kind)' instead of silently changing it", () => {
    const p = props();
    const gameplay = { ...p.gameplay, enemies: [{ ...p.gameplay.enemies[0]!, targetKind: "ghost" }] };
    const html = renderToStaticMarkup(<GameplayModulesView {...p} gameplay={gameplay} issues={gameplayIssues(gameplay, pumpkinDoc(), false)} />);
    expect(html).toContain('data-testid="issue-enemies-0"');
    expect(html).toContain("ghost (no such kind)");
  });
});

describe("Planned section", () => {
  const html = renderToStaticMarkup(<GameplayPlanned />);
  it("names health, power-ups and progression, each with the missing contract piece", () => {
    expect(PLANNED_GAMEPLAY.map((p) => p.id)).toEqual(["health", "power-ups", "progression"]);
    for (const p of PLANNED_GAMEPLAY) {
      expect(html).toContain(`data-testid="planned-${p.id}"`);
      expect(html).toContain(p.label);
      expect(html).toContain("Missing contract piece");
    }
    expect(html).toMatch(/timed state/);
    expect(html).toMatch(/persistence/);
  });
  it("has no input, select, textarea, button or form", () => {
    expect(html).not.toMatch(/<(input|button|select|textarea|form)\b|contenteditable/i);
  });
  it("quotes the registry entry, which is still planned", () => {
    const cap = REGISTRY.capabilities.find((c) => c.id === "gameplay-unbuilt-modules");
    expect(cap?.status).toBe("planned");
    expect(html).toContain("gameplay-unbuilt-modules");
  });
});

describe("routing and registry", () => {
  it("the gameplay module is editable and has exactly the Modules and Planned sections", () => {
    expect(isEditable("gameplay")).toBe(true);
    expect(sectionsOf("gameplay").map((r) => r.slug)).toEqual(["modules", "planned"]);
    expect(SECTION_ROUTES.filter((r) => r.module === "gameplay").map((r) => r.id)).toEqual(["gameplay-modules", "gameplay-planned"]);
  });
  it("#/gameplay/modules and #/gameplay/planned open the views; #/gameplay is still the Designer's world section", () => {
    expect(resolveHash("#/gameplay/modules").route).toMatchObject({ kind: "section", module: "gameplay", sectionId: "gameplay-modules" });
    expect(resolveHash("#/gameplay/planned").route).toMatchObject({ kind: "section", module: "gameplay", sectionId: "gameplay-planned" });
    expect(resolveHash("#/gameplay").canonical).toBe("#/designer/world");
  });
  it("the planned capabilities stay planned and cite no evidence", () => {
    const cap = REGISTRY.capabilities.find((c) => c.id === "gameplay-unbuilt-modules");
    expect(cap).toMatchObject({ status: "planned", nativeOutput: "planned", evidence: [] });
  });
});
