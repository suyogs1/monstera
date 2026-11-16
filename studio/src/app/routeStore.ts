// The one place that listens to `hashchange`. Components read the route through `useRoute` (hooks.ts), which subscribes to this store,
// so any number of components share one listener and one canonicalizing `location.replace()` per non-canonical hash.
import { REGISTRY, type CapabilityRegistry } from "./capabilities";
import { resolveHash, type Route } from "./router";

export interface LocationLike { hash: string; replace(url: string): void }
export interface HashEventTarget {
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}
export interface RouteStore { subscribe(listener: () => void): () => void; getSnapshot(): Route }

const sameRoute = (a: Route, b: Route): boolean =>
  a.kind === b.kind && a.module === b.module && (a.kind === "card" || (b.kind === "section" && a.sectionId === b.sectionId));

export function createRouteStore(loc: LocationLike, target: HashEventTarget, registry: CapabilityRegistry = REGISTRY): RouteStore {
  let current: Route = resolveHash(loc.hash, registry).route;
  const listeners = new Set<() => void>();
  let attached = false;

  /** Reads the location. A non-canonical hash is replaced once; the replacement's own event finds the canonical hash and does nothing. */
  const sync = (): void => {
    const r = resolveHash(loc.hash, registry);
    if (r.redirected) loc.replace(r.canonical);
    if (sameRoute(current, r.route)) return;
    current = r.route; // a new object only when the route changed, so the snapshot stays stable between renders
    for (const l of [...listeners]) l();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!attached) { attached = true; target.addEventListener("hashchange", sync); sync(); }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && attached) { attached = false; target.removeEventListener("hashchange", sync); }
      };
    },
    getSnapshot() {
      if (!attached) { const r = resolveHash(loc.hash, registry).route; if (!sameRoute(current, r)) current = r; }
      return current;
    },
  };
}
