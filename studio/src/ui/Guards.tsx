// Window-level guards: undo/redo keyboard shortcuts and the beforeunload prompt. Both read the latest controller view
// through a ref, so the listeners are registered once.
import { useEffect, useRef } from "react";
import { useProject } from "../project/context";
import { isMacPlatform, runShortcut, shortcutOf, shouldWarnBeforeUnload } from "./persistence";

export const isMac = (): boolean => typeof navigator !== "undefined" && isMacPlatform(navigator as Navigator & { userAgentData?: { platform?: string } });

export function Guards() {
  const api = useProject();
  const latest = useRef(api);
  latest.current = api;
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      const s = shortcutOf(e, mac);
      if (s !== null && runShortcut(s, latest.current, latest.current)) e.preventDefault();
    };
    // Standard browser prompt only. The pagehide flush is best-effort and does not make leaving safe.
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!shouldWarnBeforeUnload(latest.current)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onUnload); };
  }, []);
  return null;
}
