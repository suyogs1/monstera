import { createContext, useContext, useSyncExternalStore } from "react";
import type { DraftState } from "../draft/store";
import type { Session } from "./session";
import { createRouteStore, type RouteStore } from "./routeStore";
import { DEFAULT_SECTION, hashForSection, type Route } from "./router";
import type { SectionId } from "./sections";

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("SessionContext is missing");
  return s;
}

export function useDraft(): DraftState {
  const { store } = useSession();
  return useSyncExternalStore(store.subscribe, store.getState);
}

let routes: RouteStore | null = null;
/** The page's single route store: one `hashchange` listener, however many components read the route. */
const routeStore = (): RouteStore => (routes ??= createRouteStore(window.location, window));

/** The current route. A hash that is not canonical (legacy, partial or unknown) is replaced by its canonical form, once, without a history entry. */
export function useRoute(): Route {
  const s = routeStore();
  return useSyncExternalStore(s.subscribe, s.getSnapshot);
}

/** Opens an editor view (or, when the registry does not allow editors in its module, that module's card). Not a hook. */
export function openSection(id: SectionId): void {
  window.location.hash = hashForSection(id).slice(1);
}

/** Compatibility for editors that jump to a field: the current editor view and a setter. Shares the one route store with `useRoute`. */
export function useSection(): [SectionId, (id: SectionId) => void] {
  const route = useRoute();
  return [route.kind === "section" ? route.sectionId : DEFAULT_SECTION, openSection];
}
