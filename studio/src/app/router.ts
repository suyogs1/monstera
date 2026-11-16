// Hash router: `#/<module>[/<section>]`. Module ids come from the capability registry (studio/capabilities.json); this file adds only
// what the registry cannot know: which existing editor view lives under which module and slug, and the legacy single-segment hashes
// that earlier Studio versions, bookmarks and the acceptance scripts use. Resolution is pure so it can be tested without a browser.
import { SECTIONS, type SectionId } from "./sections";
import { MODULE_ORDER, type ModuleId } from "./capabilities";

export interface SectionRoute { id: SectionId; module: ModuleId; slug: string }

/** Where each existing editor view lives now. Order within a module is display order. */
export const SECTION_ROUTES: readonly SectionRoute[] = [
  { id: "overview", module: "designer", slug: "overview" },
  { id: "platforms", module: "designer", slug: "platforms" },
  { id: "gameplay", module: "designer", slug: "world" },
  { id: "entities", module: "designer", slug: "entities" },
  { id: "rules", module: "designer", slug: "rules" },
  { id: "spawns", module: "designer", slug: "spawns" },
  { id: "presentation", module: "designer", slug: "presentation" },
  { id: "spec", module: "designer", slug: "spec" },
  { id: "determinism", module: "preview", slug: "determinism" },
  { id: "export", module: "release", slug: "export" },
  { id: "integration", module: "kiro", slug: "integration" },
];

export type Route =
  | { kind: "section"; module: ModuleId; slug: string; sectionId: SectionId }
  | { kind: "card"; module: ModuleId };

export interface Resolved { route: Route; /** The canonical hash for the route, e.g. `#/designer/entities`. */ canonical: string; /** True when the input hash is not the canonical one. */ redirected: boolean }

export const DEFAULT_SECTION: SectionId = "overview";
const MODULE_IDS: readonly string[] = MODULE_ORDER.map(([id]) => id);

/** A module has editor views (and so a section list) exactly when SECTION_ROUTES names it. */
export const sectionsOf = (module: ModuleId): SectionRoute[] => SECTION_ROUTES.filter((r) => r.module === module);
export const hasViews = (module: ModuleId): boolean => sectionsOf(module).length > 0;
export const routeOf = (id: SectionId): SectionRoute => {
  const r = SECTION_ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`no route for section ${id}`);
  return r;
};

/**
 * `#/gameplay` is a legacy hash (the old Gameplay section, now the designer module's world section), so the gameplay module's card
 * cannot use the bare module id. It lives at `#/gameplay/modules`, the section name the design gives it.
 */
export function cardHash(module: ModuleId): string {
  return module === "gameplay" ? "#/gameplay/modules" : `#/${module}`;
}
export const sectionHash = (r: { module: ModuleId; slug: string }): string => `#/${r.module}/${r.slug}`;
/** The hash the navigation rail links to for a module. */
export function moduleHash(module: ModuleId): string {
  const first = sectionsOf(module)[0];
  return first ? sectionHash(first) : cardHash(module);
}

const sectionResolved = (r: SectionRoute): Route => ({ kind: "section", module: r.module, slug: r.slug, sectionId: r.id });
const hashOfRoute = (route: Route): string => (route.kind === "card" ? cardHash(route.module) : sectionHash(route));

function finish(route: Route, input: string): Resolved {
  const canonical = hashOfRoute(route);
  return { route, canonical, redirected: input !== canonical };
}

/** Maps any location hash to a route. Never throws; an unknown hash lands on the Designer overview, as before. */
export function resolveHash(hash: string): Resolved {
  const fallback = (): Resolved => finish(sectionResolved(routeOf(DEFAULT_SECTION)), hash);
  if (!/^#?\/?[A-Za-z0-9/-]*$/.test(hash)) return fallback();
  const parts = hash.replace(/^#\/?/, "").replace(/\/+$/, "").split("/");
  if (parts.some((p) => p === "") || parts.length > 2) return fallback();
  const [first = "", second] = parts;

  if (second === undefined) {
    const legacy = SECTIONS.find((s) => s.id === first);
    if (legacy) return finish(sectionResolved(routeOf(legacy.id)), hash); // legacy hash wins over a module of the same id
    if (MODULE_IDS.includes(first)) {
      const module = first as ModuleId;
      const home = sectionsOf(module)[0];
      return finish(home ? sectionResolved(home) : { kind: "card", module }, hash);
    }
    return fallback();
  }
  if (!MODULE_IDS.includes(first)) return fallback();
  const module = first as ModuleId;
  const sections = sectionsOf(module);
  if (sections.length === 0) return finish({ kind: "card", module }, hash); // a card module has no sections: any second segment normalizes away
  const match = sections.find((s) => s.slug === second);
  return finish(sectionResolved(match ?? (sections[0] as SectionRoute)), hash);
}

/** The hash that opens a given editor view. */
export const hashForSection = (id: SectionId): string => sectionHash(routeOf(id));


