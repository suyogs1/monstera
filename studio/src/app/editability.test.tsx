// Invariant (review of task 1.1): a module whose registry status is planned or unsupported never exposes editor routes or controls,
// even while SECTION_ROUTES still maps editor views to it. These tests change a COPY of the registry and check the consequence;
// they do not rely on today's registry values.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MODULE_ORDER, REGISTRY, type CapabilityRegistry, type CapabilityStatus, type ModuleId } from "./capabilities";
import { SECTION_ROUTES, cardHash, hasViews, isEditable, moduleHash, resolveHash, sectionsOf, type Route } from "./router";
import { SECTIONS } from "./sections";
import { navItems } from "./shell";
import { ModulePage } from "../ui/ModulePage";

const BLOCKED: CapabilityStatus[] = ["planned", "unsupported"];
const withStatus = (module: ModuleId, status: CapabilityStatus): CapabilityRegistry => {
  const r: CapabilityRegistry = JSON.parse(JSON.stringify(REGISTRY));
  const m = r.modules.find((x) => x.id === module);
  if (!m) throw new Error(`no module ${module}`);
  m.status = status;
  return r;
};
/** Modules that today have editor routes in SECTION_ROUTES. */
const EDITOR_MODULES = [...new Set(SECTION_ROUTES.map((r) => r.module))];
const CONTROL = /<(input|button|select|textarea|form)\b|contenteditable/i;
/**
 * Every hash that could open an editor of `module`: canonical, legacy ids, bare module, with slugs, with a trailing slash.
 * A bare module hash that is also a legacy section id (`#/gameplay`) belongs to that legacy section, not to the module.
 */
const hashesFor = (module: ModuleId): string[] => {
  const own = SECTION_ROUTES.filter((r) => r.module === module);
  const bare = SECTIONS.some((s) => s.id === module) ? [] : [`#/${module}`, `#/${module}/`];
  return [
    ...bare, `#/${module}/unknown`,
    ...own.flatMap((r) => [`#/${module}/${r.slug}`, `#/${module}/${r.slug}/`, `#/${r.id}`, `#${r.id}`, r.id]),
  ];
};
const cardOf = (module: ModuleId): Route => ({ kind: "card", module });

describe("the module set under test", () => {
  it("covers the six modules that have editor routes today", () => {
    expect([...EDITOR_MODULES].sort()).toEqual(["designer", "gameplay", "kiro", "levels", "preview", "release"]);
  });
});

describe.each(BLOCKED)("a module the registry marks %s", (status) => {
  describe.each(EDITOR_MODULES)("%s", (module) => {
    const registry = withStatus(module, status);

    it("is not editable, has no sections and no views", () => {
      expect(isEditable(module, registry)).toBe(false);
      expect(sectionsOf(module, registry)).toEqual([]);
      expect(hasViews(module, registry)).toBe(false);
    });
    it("resolves every hash that used to open one of its editors to its card", () => {
      for (const h of hashesFor(module)) {
        const r = resolveHash(h, registry);
        expect(r.route, h).toEqual(cardOf(module));
        expect(r.canonical, h).toBe(cardHash(module));
      }
    });
    it("the card hash is stable (resolving it again changes nothing)", () => {
      const r = resolveHash(cardHash(module), registry);
      expect(r.redirected).toBe(false);
      expect(r.route).toEqual(cardOf(module));
    });
    it("the rail shows no sections for it and links to its card", () => {
      const item = navItems(registry).find((n) => n.id === module);
      expect(item).toMatchObject({ hasViews: false, sections: [], href: cardHash(module), status });
      expect(moduleHash(module, registry)).toBe(cardHash(module));
    });
    it("leaves every other module as it was", () => {
      for (const other of EDITOR_MODULES.filter((m) => m !== module)) {
        expect(sectionsOf(other, registry)).toEqual(sectionsOf(other, REGISTRY));
        for (const r of SECTION_ROUTES.filter((x) => x.module === other)) {
          expect(resolveHash(`#/${other}/${r.slug}`, registry).route).toEqual({ kind: "section", module: other, slug: r.slug, sectionId: r.id });
        }
      }
    });
    it("renders a card with no controls, and never calls the editor renderer, even for a stale section route", () => {
      for (const r of SECTION_ROUTES.filter((x) => x.module === module)) {
        const stale: Route = { kind: "section", module, slug: r.slug, sectionId: r.id }; // as if an old mapping survived
        const renderSection = vi.fn(() => <input aria-label="an editor" />);
        const html = renderToStaticMarkup(<ModulePage route={stale} registry={registry} loading={false} renderSection={renderSection} />);
        expect(renderSection, r.id).not.toHaveBeenCalled();
        expect(html, r.id).toContain('data-testid="module-card"');
        expect(html, r.id).toContain(`data-module="${module}"`);
        expect(html, r.id).not.toMatch(CONTROL);
        expect(html, r.id).not.toContain("an editor");
      }
    });
    it("renders a card with no controls for every resolved hash, also while the document is still loading", () => {
      for (const h of hashesFor(module)) {
        for (const loading of [false, true]) {
          const renderSection = vi.fn(() => <input aria-label="an editor" />);
          const html = renderToStaticMarkup(<ModulePage route={resolveHash(h, registry).route} registry={registry} loading={loading} renderSection={renderSection} />);
          expect(renderSection, h).not.toHaveBeenCalled();
          expect(html, h).toContain('data-testid="module-card"');
          expect(html, h).not.toMatch(CONTROL);
        }
      }
    });
  });

  it("every editor module blocked at once leaves only cards, whatever the hash", () => {
    const r: CapabilityRegistry = JSON.parse(JSON.stringify(REGISTRY));
    for (const m of r.modules) m.status = status;
    const hashes = ["", "#/", "#/nope", ...SECTIONS.map((s) => `#/${s.id}`), ...MODULE_ORDER.map(([id]) => `#/${id}`), ...SECTION_ROUTES.map((x) => `#/${x.module}/${x.slug}`), "#/gameplay/modules"];
    for (const h of hashes) expect(resolveHash(h, r).route.kind, h).toBe("card");
    for (const n of navItems(r)) expect(n.sections, n.id).toEqual([]);
  });
});

describe("the unchanged registry still shows editors where it should", () => {
  it("renders the editor renderer for a built module and a header, and no card", () => {
    const renderSection = vi.fn(() => <p>editor body</p>);
    const route = resolveHash("#/designer/entities").route;
    const html = renderToStaticMarkup(<ModulePage route={route} loading={false} renderSection={renderSection} />);
    expect(renderSection).toHaveBeenCalledWith("entities");
    expect(html).toContain("editor body");
    expect(html).toContain('data-testid="module-header"');
    expect(html).not.toContain('data-testid="module-card"');
  });
  it("shows only the loading text, not an editor, while the document loads", () => {
    const renderSection = vi.fn(() => <p>editor body</p>);
    const html = renderToStaticMarkup(<ModulePage route={resolveHash("#/designer/entities").route} loading renderSection={renderSection} />);
    expect(renderSection).not.toHaveBeenCalled();
    expect(html).toContain("Loading");
  });
  it("a section id with no view renders a notice, not a blank page", () => {
    const html = renderToStaticMarkup(<ModulePage route={resolveHash("#/kiro/integration").route} loading={false} renderSection={() => null} />);
    expect(html).toContain("not available yet");
  });
});

describe("the special gameplay routes survive the change", () => {
  it("#/gameplay stays the legacy redirect and #/gameplay/modules the Gameplay Systems editor", () => {
    expect(resolveHash("#/gameplay").canonical).toBe("#/designer/world");
    expect(resolveHash("#/gameplay/modules").route).toMatchObject({ kind: "section", module: "gameplay", sectionId: "gameplay-modules" });
    expect(resolveHash("#/gameplay/modules").redirected).toBe(false);
  });
  it("if the designer is blocked, #/gameplay opens the designer's card and never the Gameplay Systems editor", () => {
    for (const status of BLOCKED) {
      const registry = withStatus("designer", status);
      expect(resolveHash("#/gameplay", registry).route).toEqual(cardOf("designer"));
      expect(resolveHash("#/gameplay/modules", registry).route).toMatchObject({ kind: "section", module: "gameplay" });
    }
  });
  it("the gameplay module being editable does not take over #/gameplay", () => {
    expect(resolveHash("#/gameplay").canonical).toBe("#/designer/world");
    expect(resolveHash("#/gameplay/planned").route).toMatchObject({ kind: "section", module: "gameplay", sectionId: "gameplay-planned" });
  });
});
