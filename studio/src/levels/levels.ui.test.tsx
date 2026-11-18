// Static-markup checks of the Level Studio views (the interactive flow is scripts/a5-levels.mjs, in a real browser).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isEditable, resolveHash } from "../app/router";
import { SECTION_ROUTES } from "../app/router";
import type { CompiledSpawner } from "../derive/levels";
import { xrefManifests } from "../project/xref.testkit";
import { LevelList } from "./LevelList";
import { Timeline } from "./Timeline";
import { Unsupported, UNSUPPORTED_LEVEL_FEATURES } from "./Unsupported";

const noop = () => undefined;
describe("level list", () => {
  it("shows editing and active separately, and every management action per level", () => {
    const levels = xrefManifests().levels.levels;
    const html = renderToStaticMarkup(<LevelList levels={levels} editingId="level-2" activeId="level-1" onEdit={noop} onAdd={noop} onDuplicate={noop} onMove={noop} onDelete={noop} />);
    expect(html).toMatch(/data-testid="level-row-level-1"[^>]*data-active="true"/);
    expect(html).toMatch(/data-testid="level-row-level-2"[^>]*data-editing="true"/);
    for (const l of levels) for (const a of ["edit", "up", "down", "duplicate", "delete"]) expect(html).toContain(`data-testid="level-${a}-${l.id}"`);
    expect(html).toContain('data-testid="level-add"');
  });
  it("disables moving the first level up and the last level down", () => {
    const levels = xrefManifests().levels.levels;
    const html = renderToStaticMarkup(<LevelList levels={levels} editingId={null} activeId={null} onEdit={noop} onAdd={noop} onDuplicate={noop} onMove={noop} onDelete={noop} />);
    expect(html).toMatch(/<button[^>]*data-testid="level-up-level-1"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*data-testid="level-down-level-2"[^>]*disabled/);
  });
});
describe("unsupported capabilities", () => {
  it("lists every reason as text and renders no control", () => {
    const html = renderToStaticMarkup(<Unsupported />);
    for (const u of UNSUPPORTED_LEVEL_FEATURES) { expect(html).toContain(`data-testid="unsupported-${u.id}"`); expect(html).toContain(u.label); }
    expect(html).not.toMatch(/<(input|button|select|textarea|form)\b/i);
    expect(html).toContain("multi-level-in-app");
  });
});
describe("spawn timeline", () => {
  const sp = (startTick: number, intervalTicks: number): CompiledSpawner => ({ stream: "s", kind: "bat", startTick, intervalTicks, xMin: 0, xMax: 0, yMin: 0, yMax: 0, vx: 0, vy: 0 });
  it("has a row per spawner with its start and interval, and tags difficulty steps", () => {
    const html = renderToStaticMarkup(<Timeline spawners={[sp(30, 90), sp(600, 45)]} steps={1} tickRate={60} />);
    expect(html).toMatch(/data-testid="tl-row-0"[^>]*data-kind="wave"[^>]*data-start="30"[^>]*data-interval="90"/);
    expect(html).toMatch(/data-testid="tl-row-1"[^>]*data-kind="step"[^>]*data-start="600"[^>]*data-interval="45"/);
    expect((html.match(/class="tl-mark"/g) ?? []).length).toBe(Math.floor((3600 - 30) / 90) + 1);
  });
  it("says so when there is nothing to show", () => {
    expect(renderToStaticMarkup(<Timeline spawners={[]} steps={0} tickRate={60} />)).toContain("No spawners");
  });
});
describe("routing and registry", () => {
  it("the levels module is editable and #/levels opens the Level Studio view", () => {
    expect(isEditable("levels")).toBe(true);
    expect(SECTION_ROUTES.some((r) => r.id === "levels" && r.module === "levels")).toBe(true);
    expect(resolveHash("#/levels").route).toMatchObject({ kind: "section", module: "levels", sectionId: "levels" });
    expect(resolveHash("#/levels").canonical).toBe("#/levels/editor");
  });
});
