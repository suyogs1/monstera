import { describe, expect, it, vi } from "vitest";
import { REGISTRY, type CapabilityRegistry } from "./capabilities";
import { createRouteStore, type LocationLike } from "./routeStore";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A browser stand-in: `replace` changes the hash and fires `hashchange` like the real one (here synchronously, the harder case). */
function fakeBrowser(initial: string) {
  const listeners = new Set<() => void>();
  const calls = { add: 0, remove: 0, replace: [] as string[] };
  const loc: LocationLike = {
    hash: initial,
    replace(url) { calls.replace.push(url); loc.hash = url; for (const l of [...listeners]) l(); },
  };
  const target = {
    addEventListener(_t: "hashchange", l: () => void) { calls.add++; listeners.add(l); },
    removeEventListener(_t: "hashchange", l: () => void) { calls.remove++; listeners.delete(l); },
  };
  const navigate = (hash: string) => { loc.hash = hash; for (const l of [...listeners]) l(); };
  return { loc, target, calls, listeners, navigate };
}

describe("route store: one subscription, one replace", () => {
  it("any number of subscribers share one hashchange listener", () => {
    const b = fakeBrowser("#/designer/overview");
    const store = createRouteStore(b.loc, b.target);
    const offs = [store.subscribe(() => {}), store.subscribe(() => {}), store.subscribe(() => {})];
    expect(b.calls.add).toBe(1);
    expect(b.listeners.size).toBe(1);
    offs[0]?.(); offs[1]?.();
    expect(b.listeners.size).toBe(1); // still attached for the last subscriber
    offs[2]?.();
    expect(b.calls.remove).toBe(1);
    expect(b.listeners.size).toBe(0);
  });
  it("a legacy hash is replaced exactly once, however many subscribers there are", () => {
    for (const n of [1, 3, 8]) {
      const b = fakeBrowser("#/entities");
      const store = createRouteStore(b.loc, b.target);
      for (let i = 0; i < n; i++) store.subscribe(() => {});
      expect(b.calls.replace, `${n} subscribers`).toEqual(["#/designer/entities"]);
      expect(b.loc.hash).toBe("#/designer/entities");
      expect(store.getSnapshot()).toMatchObject({ kind: "section", module: "designer", sectionId: "entities" });
    }
  });
  it("a canonical hash causes no replace at all", () => {
    const b = fakeBrowser("#/preview/determinism");
    const store = createRouteStore(b.loc, b.target);
    store.subscribe(() => {}); store.subscribe(() => {});
    expect(b.calls.replace).toEqual([]);
  });
  it("later navigation to a legacy hash is replaced once and notifies subscribers once per route change", () => {
    const b = fakeBrowser("#/designer/overview");
    const store = createRouteStore(b.loc, b.target);
    const seen = vi.fn();
    store.subscribe(seen);
    store.subscribe(() => {});
    b.navigate("#/determinism");
    expect(b.calls.replace).toEqual(["#/preview/determinism"]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ kind: "section", module: "preview" });
    b.navigate("#/backend"); // the module id redirects once to its first editor view
    expect(b.calls.replace).toEqual(["#/preview/determinism", "#/backend/firebase"]);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ kind: "section", module: "backend" });
  });
  it("an unknown hash is replaced once with the Designer overview", () => {
    const b = fakeBrowser("#/nope");
    const store = createRouteStore(b.loc, b.target);
    store.subscribe(() => {}); store.subscribe(() => {});
    expect(b.calls.replace).toEqual(["#/designer/overview"]);
  });
  it("the snapshot keeps its identity while the route does not change (required by useSyncExternalStore)", () => {
    const b = fakeBrowser("#/designer/rules");
    const store = createRouteStore(b.loc, b.target);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(first);
    b.navigate("#/designer/rules/"); // same route, different spelling
    expect(store.getSnapshot()).toBe(first);
  });
  it("before anyone subscribes it reads the location but never writes it", () => {
    const b = fakeBrowser("#/entities");
    const store = createRouteStore(b.loc, b.target);
    expect(store.getSnapshot()).toMatchObject({ module: "designer", sectionId: "entities" });
    expect(b.calls.replace).toEqual([]);
    expect(b.calls.add).toBe(0);
  });
  it("resubscribing after everyone left attaches one listener again", () => {
    const b = fakeBrowser("#/designer/overview");
    const store = createRouteStore(b.loc, b.target);
    store.subscribe(() => {})();
    store.subscribe(() => {});
    expect(b.calls.add).toBe(2);
    expect(b.listeners.size).toBe(1);
  });
  it("follows a registry in which the module is blocked: the legacy hash is replaced once by the card hash", () => {
    const registry: CapabilityRegistry = JSON.parse(JSON.stringify(REGISTRY));
    const m = registry.modules.find((x) => x.id === "designer");
    if (m) m.status = "planned";
    const b = fakeBrowser("#/entities");
    const store = createRouteStore(b.loc, b.target, registry);
    store.subscribe(() => {}); store.subscribe(() => {});
    expect(b.calls.replace).toEqual(["#/designer"]);
    expect(store.getSnapshot()).toEqual({ kind: "card", module: "designer" });
  });
});

describe("the application shell has one route subscription (source check)", () => {
  const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("only routeStore.ts adds a hashchange listener or calls location.replace", () => {
    for (const file of ["App.tsx", "app/hooks.ts", "app/router.ts", "app/shell.ts", "ui/ModulePage.tsx", "ui/ModuleCard.tsx", "ui/TopBar.tsx", "ui/ValidationPanel.tsx", "preview/Preview.tsx", "ui/sections/Entities.tsx", "ui/sections/Overview.tsx", "ui/sections/Presentation.tsx"]) {
      const text = src(file);
      expect(text, file).not.toMatch(/addEventListener\(\s*["']hashchange/);
      expect(text, file).not.toMatch(/location\.replace\(/);
    }
    expect(src("app/routeStore.ts")).toMatch(/addEventListener\("hashchange"/);
  });
  it("App reads the route once: no useSection call in App.tsx", () => {
    const app = src("App.tsx");
    expect(app.match(/useRoute\(/g)?.length).toBe(1);
    expect(app).not.toMatch(/useSection\(/);
  });
});
