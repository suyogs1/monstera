import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { DraftState } from "../draft/store";
import type { Session } from "./session";
import { DEFAULT_SECTION, hashForSection, resolveHash, type Route } from "./router";
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

/** The current route. A hash that is not canonical (legacy, partial or unknown) is replaced by its canonical form, without a history entry. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => resolveHash(window.location.hash).route);
  useEffect(() => {
    const sync = () => {
      const r = resolveHash(window.location.hash);
      if (r.redirected) window.location.replace(r.canonical); // fires hashchange again with the canonical hash
      setRoute(r.route);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return route;
}

/** Compatibility wrapper for editors that jump to a field: the current editor view and a setter that opens another view. */
export function useSection(): [SectionId, (id: SectionId) => void] {
  const route = useRoute();
  const id = route.kind === "section" ? route.sectionId : DEFAULT_SECTION;
  return [id, (next) => { window.location.hash = hashForSection(next).slice(1); }];
}
