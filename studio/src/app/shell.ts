// Pure view models for the shell: the navigation rail, the module header and the card for modules that are not built.
// Every name, order, status and native-output value is read from the capability registry; nothing is restated here.
import { REGISTRY, type CapabilityEntry, type CapabilityRegistry, type CapabilityStatus, type ModuleEntry, type ModuleId } from "./capabilities";
import { moduleHash, sectionHash, sectionsOf } from "./router";
import { SECTIONS } from "./sections";

export interface NavSection { id: string; title: string; href: string }
export interface NavItem {
  id: ModuleId; title: string; status: CapabilityStatus; targetStatus: CapabilityStatus; href: string;
  /** False for a module that is not built: it opens a card, not editors. */
  hasViews: boolean; sections: NavSection[];
}

export function navItems(registry: CapabilityRegistry = REGISTRY): NavItem[] {
  return registry.modules.map((m) => ({
    id: m.id, title: m.title, status: m.status, targetStatus: m.targetStatus, href: moduleHash(m.id, registry),
    hasViews: sectionsOf(m.id, registry).length > 0,
    sections: sectionsOf(m.id, registry).map((r) => ({
      id: r.id,
      title: r.id === "gameplay" ? "World and input" : (SECTIONS.find((s) => s.id === r.id)?.title ?? r.slug),
      href: sectionHash(r),
    })),
  }));
}

/** Capabilities of a module that are not built (planned) or cannot be built here (unsupported). */
export function unbuilt(module: ModuleId, registry: CapabilityRegistry = REGISTRY): CapabilityEntry[] {
  return registry.capabilities.filter((c) => c.module === module && (c.status === "planned" || c.status === "unsupported"));
}

export function moduleOf(id: ModuleId, registry: CapabilityRegistry = REGISTRY): ModuleEntry {
  const m = registry.modules.find((x) => x.id === id);
  if (!m) throw new Error(`no registry entry for module ${id}`);
  return m;
}

/** One sentence that says what the status means, shown in every module header. */
export const STATUS_MEANING: Record<CapabilityStatus, string> = {
  implemented: "Works end to end.",
  prototype: "A bounded subset works; its limits are listed.",
  mock: "Simulated and labelled MOCK.",
  planned: "Designed, not built. No controls.",
  unsupported: "Cannot be done in Studio. The reason is stated.",
};
