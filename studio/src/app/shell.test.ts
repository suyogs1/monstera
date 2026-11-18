import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_ORDER, REGISTRY, type CapabilityRegistry, type ModuleId } from "./capabilities";
import { SECTION_ROUTES, cardHash, hasViews, hashForSection, moduleHash, resolveHash, routeOf, sectionsOf } from "./router";
import { SECTIONS, sectionForPath } from "./sections";
import { moduleOf, navItems, unbuilt } from "./shell";

const copy = (): CapabilityRegistry => JSON.parse(JSON.stringify(REGISTRY));
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("router: legacy hashes (acceptance of task 1.1)", () => {
  // design.md section 2: overview platforms entities rules spawns presentation spec -> designer/*; gameplay -> designer/world;
  // determinism -> preview/determinism; export -> release/export; integration -> kiro/integration.
  const expected: Record<string, string> = {
    overview: "#/designer/overview", platforms: "#/designer/platforms", entities: "#/designer/entities", rules: "#/designer/rules",
    spawns: "#/designer/spawns", presentation: "#/designer/presentation", spec: "#/designer/spec",
    gameplay: "#/designer/world", determinism: "#/preview/determinism", export: "#/release/export", integration: "#/kiro/integration",
    levels: "#/levels/editor",
    assets: "#/assets/library",
    sprites: "#/sprites/editor",
  };

  it("lists exactly the fourteen legacy section ids", () => {
    expect(SECTIONS.map((s) => s.id).sort()).toEqual(Object.keys(expected).sort());
  });
  it.each(Object.entries(expected))("#/%s redirects to %s", (legacy, target) => {
    for (const form of [`#/${legacy}`, `#${legacy}`, `#/${legacy}/`, legacy]) {
      const r = resolveHash(form);
      expect(r.canonical, form).toBe(target);
      expect(r.route.kind).toBe("section");
    }
    expect(resolveHash(`#/${legacy}`).redirected).toBe(true);
    expect(resolveHash(target).redirected).toBe(false);
  });
  it("a canonical hash resolves to itself and to the same editor view the legacy hash opened", () => {
    for (const r of SECTION_ROUTES) {
      const got = resolveHash(`#/${r.module}/${r.slug}`);
      expect(got.redirected).toBe(false);
      expect(got.route).toEqual({ kind: "section", module: r.module, slug: r.slug, sectionId: r.id });
      expect(hashForSection(r.id)).toBe(`#/${r.module}/${r.slug}`);
    }
  });
  it("every editor view that a validation issue can point at has a route", () => {
    const ids = new Set(SECTION_ROUTES.map((r) => r.id));
    const samples = [["project", "platforms"], ["project"], ["game", "palette"], ["game", "runtime", "kinds", 0], ["game", "runtime", "spawners"], ["game", "runtime", "lives"], ["game", "world"], ["specVersion"]];
    for (const p of samples) expect(ids.has(sectionForPath(p)), JSON.stringify(p)).toBe(true);
  });
});

describe("router: modules, partial and unknown hashes", () => {
  it("opens the first view of a module that has views", () => {
    expect(resolveHash("#/designer").canonical).toBe("#/designer/overview");
    expect(resolveHash("#/preview").canonical).toBe("#/preview/determinism");
    expect(resolveHash("#/release").canonical).toBe("#/release/export");
    expect(resolveHash("#/kiro").canonical).toBe("#/kiro/integration");
  });
  it("an unknown section of a known module opens that module's first view", () => {
    expect(resolveHash("#/designer/nope").canonical).toBe("#/designer/overview");
    expect(resolveHash("#/kiro/drift").canonical).toBe("#/kiro/integration");
  });
  it("modules that are not built resolve to a card", () => {
    for (const id of ["dashboard", "backend", "monetization"] as const) {
      expect(resolveHash(`#/${id}`).route).toEqual({ kind: "card", module: id });
      expect(resolveHash(`#/${id}/anything`).canonical).toBe(`#/${id}`);
    }
  });
  it("Gameplay Systems has its own card although #/gameplay is the legacy Designer hash", () => {
    expect(resolveHash("#/gameplay").canonical).toBe("#/designer/world");
    expect(resolveHash("#/gameplay/modules").route).toEqual({ kind: "card", module: "gameplay" });
    expect(resolveHash("#/gameplay/modules").redirected).toBe(false);
    expect(cardHash("gameplay")).toBe("#/gameplay/modules");
    expect(moduleHash("gameplay")).toBe("#/gameplay/modules");
  });
  it("empty, unknown and hostile hashes land on the Designer overview and never throw", () => {
    for (const h of ["", "#", "#/", "#/nope", "#/a/b/c", "#//designer", "#/designer//x", "#/__proto__", "#/constructor", "#/designer/__proto__", "#/<script>", "#/%2e%2e", "#/designer?x=1", "#/toString"]) {
      expect(resolveHash(h).canonical, h).toBe("#/designer/overview");
    }
  });
  it("the canonical hash of every resolution resolves to itself (idempotent)", () => {
    for (const h of ["", "#/gameplay", "#/levels/x", "#/preview", "#/designer/nope", "#/export", "#/gameplay/modules"]) {
      const once = resolveHash(h);
      const twice = resolveHash(once.canonical);
      expect(twice.canonical).toBe(once.canonical);
      expect(twice.redirected).toBe(false);
      expect(twice.route).toEqual(once.route);
    }
  });
});

describe("navigation comes from the registry", () => {
  it("has one item for each of the 11 registry modules, in registry order", () => {
    expect(navItems().map((n) => n.id)).toEqual(REGISTRY.modules.map((m) => m.id));
    expect(navItems().map((n) => n.id)).toEqual(MODULE_ORDER.map(([id]) => id));
    expect(navItems()).toHaveLength(11);
  });
  it("takes title, status and target status from the registry", () => {
    for (const [i, n] of navItems().entries()) {
      const m = REGISTRY.modules[i];
      expect([n.title, n.status, n.targetStatus]).toEqual([m?.title, m?.status, m?.targetStatus]);
    }
  });
  it("follows a changed registry: reordering, renaming and a new status show up without any other edit", () => {
    const r = copy();
    r.modules.reverse();
    const first = r.modules[0];
    if (!first) throw new Error("empty");
    first.title = "Renamed";
    first.status = "prototype";
    const items = navItems(r);
    expect(items.map((n) => n.id)).toEqual(r.modules.map((m) => m.id));
    expect(items[0]).toMatchObject({ title: "Renamed", status: "prototype" });
  });
  it("every module link resolves to a route in that module and needs no redirect", () => {
    for (const n of navItems()) {
      const r = resolveHash(n.href);
      expect(r.route.module, n.id).toBe(n.id);
      expect(r.redirected, n.id).toBe(false);
      for (const s of n.sections) expect(resolveHash(s.href).redirected, s.href).toBe(false);
    }
  });
  it("lists every existing editor view under a module and none twice", () => {
    const all = navItems().flatMap((n) => n.sections.map((s) => s.id));
    expect(all.sort()).toEqual(SECTIONS.map((s) => s.id).sort());
  });
});

describe("honesty: what may have editors, and what a card says", () => {
  it("only modules the registry does not call planned have editor views", () => {
    for (const m of REGISTRY.modules) if (hasViews(m.id)) expect(m.status, m.id).not.toBe("planned");
  });
  it("every planned module is a card and every module with views is not planned", () => {
    for (const n of navItems()) expect(n.hasViews, n.id).toBe(n.status !== "planned");
  });
  it("no module has views that the registry does not list as implemented or prototype", () => {
    for (const m of REGISTRY.modules) if (sectionsOf(m.id).length > 0) expect(["implemented", "prototype"]).toContain(m.status);
  });
  it("every card module has something to explain: at least one planned or unsupported capability, each with a reason", () => {
    for (const n of navItems().filter((x) => !x.hasViews)) {
      const caps = unbuilt(n.id);
      expect(caps.length, n.id).toBeGreaterThan(0);
      for (const c of caps) { expect(c.limits.length, c.id).toBeGreaterThan(0); expect(c.requires.length, c.id).toBeGreaterThan(0); }
    }
  });
  it("a card module's header facts equal the registry", () => {
    const m = moduleOf("levels");
    expect(m).toMatchObject({ status: "prototype", nativeOutput: "compiles to native" });
    expect(unbuilt("levels").map((c) => c.id)).toContain("multi-level-in-app");
  });
  it("the card and header components render no editing controls (source check; the browser check is scripts/shell.mjs)", () => {
    const card = src("ui/ModuleCard.tsx");
    expect(card).not.toMatch(/<(input|button|select|textarea|form)\b/i);
    expect(card).not.toMatch(/\bonClick\b|\bonChange\b|\bonSubmit\b/);
  });
  it("modules of the registry that no route knows about do not exist", () => {
    const known = new Set<ModuleId>(MODULE_ORDER.map(([id]) => id));
    for (const r of SECTION_ROUTES) expect(known.has(r.module), r.id).toBe(true);
    expect(routeOf("overview").module).toBe("designer");
  });
});

describe("no second source of navigation metadata", () => {
  it("shell and router never restate a module title, status or native-output value", () => {
    const text = src("app/shell.ts") + src("app/router.ts") + src("App.tsx") + src("ui/ModuleCard.tsx");
    for (const m of REGISTRY.modules) expect(text, m.title).not.toContain(m.title);
    expect(text).not.toMatch(/"(compiles to native|studio only|scaffold)"/);
  });
});

