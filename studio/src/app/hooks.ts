import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { DraftState } from "../draft/store";
import type { Session } from "./session";
import { sectionFromHash, type SectionId } from "./sections";

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

export function useSection(): [SectionId, (id: SectionId) => void] {
  const [id, setId] = useState<SectionId>(() => sectionFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setId(sectionFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return [id, (next) => { window.location.hash = `/${next}`; }];
}
