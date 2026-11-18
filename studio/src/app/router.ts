// Hash router: `#/<module>[/<section>]`. Module ids come from the capability registry (studio/capabilities.json); this file adds only
// what the registry cannot know: which existing editor view lives under which module and slug, and the legacy single-segment hashes
// that earlier Studio versions, bookmarks and the acceptance scripts use. Resolution is pure so it can be tested without a browser.
//
// Invariant: a module whose registry status is `planned` or `unsupported` never resolves to an editor route, whatever SECTION_ROUTES
// still says. Every function below that lists or resolves editor views takes the registry and applies `isEditable`.
import { MODULE_ORDER, REGISTRY, type CapabilityRegistry, type CapabilityStatus, type ModuleId } from "./capabilities";
import { SECTIONS, type SectionId } from "./sections";

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
  { id: "levels", module: "levels", slug: "editor" },
  { id: "gameplay-modules", module: "gameplay", slug: "modules" },
  { id: "gameplay-planned", module: "gameplay", slug: "planned" },
  { id: "assets", module: "assets", slug: "library" },
  { id: "sprites", module: "sprites", slug: "editor" },
  { id: "dashboard-projects", module: "dashboard", slug: "projects" },
  { id: "dashboard-status", module: "dashboard", slug: "status" },
];

export type Route =
  | { kind: "section"; module: ModuleId; slug: string; sectionId: SectionId }
  | { kind: "card"; module: ModuleId };

export interface Resolved { route: Route; /** The canonical hash for the route, e.g. `#/designer/entities`. */ canonical: string; /** True when the input hash is not the canonical one. */ redirected: boolean }

export const DEFAULT_SECTION: SectionId = "overview";
const MODULE_IDS: readonly string[] = MODULE_ORDER.map(([id]) => id);
/** Statuses that must never show editors. */
const NOT_EDITABLE: readonly CapabilityStatus[] = ["planned", "unsupported"];

/** True when the registry allows editors in this module: it is not planned or unsupported. An unknown module is not editable. */
export function isEditable(module: ModuleId, registry: CapabilityRegistry = REGISTRY): boolean {
  const m = registry.modules.find((x) => x.id === module);
  return m !== undefined && !NOT_EDITABLE.includes(m.status);
}

/** The editor views of a module. Empty when the registry does not allow editors there, even if SECTION_ROUTES lists some. */
export const sectionsOf = (module: ModuleId, registry: CapabilityRegistry = REGISTRY): SectionRoute[] =>
  isEditable(module, registry) ? SECTION_ROUTES.filter((r) => r.module === module) : [];
export const hasViews = (module: ModuleId, registry: CapabilityRegistry = REGISTRY): boolean => sectionsOf(module, registry).length > 0;
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
export function moduleHash(module: ModuleId, registry: CapabilityRegistry = REGISTRY): string {
  const first = sectionsOf(module, registry)[0];
  return first ? sectionHash(first) : cardHash(module);
}

const sectionResolved = (r: SectionRoute): Route => ({ kind: "section", module: r.module, slug: r.slug, sectionId: r.id });
const hashOfRoute = (route: Route): string => (route.kind === "card" ? cardHash(route.module) : sectionHash(route));

function finish(route: Route, input: string): Resolved {
  const canonical = hashOfRoute(route);
  return { route, canonical, redirected: input !== canonical };
}

/** Maps any location hash to a route. Never throws; an unknown hash lands on the Designer overview, as before. */
export function resolveHash(hash: string, registry: CapabilityRegistry = REGISTRY): Resolved {
  /** An editor view, or the card of its module when the registry does not allow editors there. */
  const viewOrCard = (r: SectionRoute): Route => (isEditable(r.module, registry) ? sectionResolved(r) : { kind: "card", module: r.module });
  const fallback = (): Resolved => finish(viewOrCard(routeOf(DEFAULT_SECTION)), hash);
  if (!/^#?\/?[A-Za-z0-9/-]*$/.test(hash)) return fallback();
  const parts = hash.replace(/^#\/?/, "").replace(/\/+$/, "").split("/");
  if (parts.some((p) => p === "") || parts.length > 2) return fallback();
  const [first = "", second] = parts;

  if (second === undefined) {
    const legacy = SECTIONS.find((s) => s.id === first);
    if (legacy) return finish(viewOrCard(routeOf(legacy.id)), hash); // legacy hash wins over a module of the same id
    if (MODULE_IDS.includes(first)) {
      const module = first as ModuleId;
      const home = sectionsOf(module, registry)[0];
      return finish(home ? sectionResolved(home) : { kind: "card", module }, hash);
    }
    return fallback();
  }
  if (!MODULE_IDS.includes(first)) return fallback();
  const module = first as ModuleId;
  const sections = sectionsOf(module, registry);
  if (sections.length === 0) return finish({ kind: "card", module }, hash); // no editors: any second segment normalizes away
  const match = sections.find((s) => s.slug === second);
  return finish(sectionResolved(match ?? (sections[0] as SectionRoute)), hash);
}

/** The hash that opens a given editor view. If the registry does not allow editors in its module, resolving it gives the card. */
export const hashForSection = (id: SectionId): string => sectionHash(routeOf(id));
