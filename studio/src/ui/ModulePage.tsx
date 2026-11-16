import type { ReactNode } from "react";
import { REGISTRY, type CapabilityRegistry } from "../app/capabilities";
import { isEditable, type Route } from "../app/router";
import type { SectionId } from "../app/sections";
import { ModuleCard, ModuleHeader } from "./ModuleCard";

/**
 * The main area for a route. Editors render only for a section route whose module the registry allows to have editors.
 * A card route, or a section route that reached here while its module is planned or unsupported, renders the card and never calls
 * `renderSection`, so no editing control can appear for a module that is not built.
 */
export function ModulePage({ route, registry = REGISTRY, loading, renderSection }: {
  route: Route; registry?: CapabilityRegistry; loading: boolean; renderSection: (id: SectionId) => ReactNode;
}) {
  if (route.kind === "card" || !isEditable(route.module, registry)) return <ModuleCard module={route.module} registry={registry} />;
  if (loading) return <p>Loading…</p>;
  return (
    <>
      <ModuleHeader module={route.module} registry={registry} />
      {renderSection(route.sectionId) ?? <p className="muted">This section is not available yet.</p>}
    </>
  );
}
