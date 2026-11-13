import type { Path } from "../draft/path";
import { toIssuePath } from "../draft/path";
import { sectionForPath, type SectionId } from "./sections";

/** Focuses the control bound to `path`, or the nearest enclosing element that declares a data-path. */
export function focusPath(path: Path): boolean {
  for (let len = path.length; len >= 0; len--) {
    const el = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(toIssuePath(path.slice(0, len)))}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus({ preventScroll: true });
      el.classList.remove("flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("flash");
      return true;
    }
  }
  return false;
}

/** Opens the section that owns `path`, then focuses the field once it has rendered. */
export function goToPath(path: Path, setSection: (id: SectionId) => void): void {
  setSection(sectionForPath(path));
  let tries = 0;
  const attempt = () => { if (!focusPath(path) && tries++ < 10) requestAnimationFrame(attempt); };
  requestAnimationFrame(attempt);
}
