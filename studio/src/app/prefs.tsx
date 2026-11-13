import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/** Display preference only: which form Q16.16 quantities take in the editors. The spec always stores raw integers. */
export type NumberMode = "units" | "raw";

const KEY = "monstera.studio.numberMode";

interface Prefs { mode: NumberMode; setMode(m: NumberMode): void }
const PrefsContext = createContext<Prefs>({ mode: "units", setMode: () => undefined });

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<NumberMode>(() => (window.localStorage.getItem(KEY) === "raw" ? "raw" : "units"));
  const setMode = useCallback((m: NumberMode) => {
    setModeState(m);
    try { window.localStorage.setItem(KEY, m); } catch { /* preference stays in memory */ }
  }, []);
  return <PrefsContext.Provider value={{ mode, setMode }}>{children}</PrefsContext.Provider>;
}

export const usePrefs = (): Prefs => useContext(PrefsContext);
