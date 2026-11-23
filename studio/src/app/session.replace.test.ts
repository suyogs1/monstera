// Task 9.4 remediation: replacing the open project (template, spec import, bundle import) is refused by default when it would
// lose data, never silently, and a refusal leaves the open project, the draft and storage exactly as they were.
import { describe, expect, it } from "vitest";
import { png } from "../assets/fixtures.testkit";
import { STORE_PROJECTS } from "../project/idb";
import type { Provenance } from "../project/manifests";
import { instrumentedOpen, memoryMarker, newFactory, pumpkinText, rawAll, readOnlyStorage } from "../project/testkit";
import { replaceWithConfirm } from "../ui/replaceConfirm";
import { drain, FakeEngine, harness, type Harness } from "./session.testkit";
import type { SessionDeps } from "./session";

const prov: Provenance = { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" };
async function boot(deps: Omit<SessionDeps, "engine" | "schedule"> = {}, engine = new FakeEngine()): Promise<Harness> {
  const h = harness({ marker: memoryMarker(), ...deps }, engine);
  await h.session.start();
  await drain(h);
  return h;
}
const setLives = (h: Harness, n: number): void => { h.session.store.set(["game", "runtime", "lives"], n); };
const snapshot = (h: Harness) => ({
  doc: JSON.stringify(h.session.store.getState().doc), manifests: JSON.stringify(h.session.project.getState().manifests),
  key: h.session.project.getState().projectKey, revision: h.session.store.getState().revision, name: h.session.project.getState().name,
});
const stored = async (f: IDBFactory): Promise<string> => JSON.stringify(await rawAll(f, STORE_PROJECTS));
const otherSpec = (): string => { const d = JSON.parse(pumpkinText) as { project: { displayName: string } }; d.project.displayName = "Another Game"; return JSON.stringify(d); };
async function aBundle(): Promise<Uint8Array> {
  const a = await boot({ factory: newFactory() });
  await a.session.project.actions.importAsset({ fileName: "hero.png", bytes: png(32, 32), category: "sprite", provenance: prov });
  await drain(a);
  const out = await a.session.exportBundleBytes();
  if (!out.ok) throw new Error(out.message);
  return out.bytes;
}
type Attempt = (h: Harness, opts?: { discardUnsaved?: boolean }) => Promise<{ ok: boolean; code?: string; message?: string }>;
const bundle = await aBundle();
const attempts: [string, Attempt][] = [
  ["create from a template", (h, o) => h.session.loadTemplate("pumpkin-blaster", o)],
  ["import a spec file", (h, o) => h.session.importText(otherSpec(), "other.json", o)],
  ["import a bundle", (h, o) => h.session.importBundleBytes(bundle, "bundle.zip", o)],
];

describe.each(attempts)("%s", (_name, attempt) => {
  it("is refused while the open project has an invalid unsaved specification; nothing changes; discard replaces it", async () => {
    const engine = new FakeEngine();
    const factory = newFactory();
    const h = await boot({ factory }, engine);
    engine.invalid = (text) => text.includes('"lives":99') || text.includes('"lives": 99');
    setLives(h, 99);
    await drain(h);
    expect(h.session.project.getState().dirty).toBe(true);
    const before = snapshot(h);
    const rows = await stored(factory);
    const r = await attempt(h);
    expect(r).toMatchObject({ ok: false, code: "would-lose-data" });
    expect(r.message).toMatch(/edits that cannot be saved yet/);
    await drain(h);
    expect(snapshot(h)).toEqual(before);
    expect(await stored(factory)).toBe(rows);
    const forced = await attempt(h, { discardUnsaved: true });
    expect(forced.ok).toBe(true);
    await drain(h);
    expect(snapshot(h).key).not.toBe(before.key);
  });

  it("is refused while the last save failed; nothing changes; it proceeds once storage recovers", async () => {
    const factory = newFactory();
    let failing = false;
    const h = await boot({ factory, projectDeps: { openConnection: instrumentedOpen({
      onCall: (store, method, mode) => { if (failing && store === STORE_PROJECTS && method === "get" && mode === "readwrite") throw new Error("disk full-ish"); },
    }) } });
    failing = true;
    setLives(h, 7);
    await drain(h);
    expect(h.session.project.getState().status).toBe("failed");
    const before = snapshot(h);
    const rows = await stored(factory);
    const r = await attempt(h);
    expect(r).toMatchObject({ ok: false, code: "would-lose-data" });
    expect(r.message).toMatch(/last save failed/);
    await drain(h);
    expect(snapshot(h)).toEqual(before);
    expect(await stored(factory)).toBe(rows);
    failing = false; // storage recovers: the preflight retries the save, stores the edit, and the replacement proceeds
    expect((await attempt(h)).ok).toBe(true);
    await drain(h);
    expect(snapshot(h).key).not.toBe(before.key);
    expect(await stored(factory)).toContain('\\"lives\\": 7');
  });

  it("is refused for a memory-only project, says so, changes nothing, and replaces only on an explicit discard", async () => {
    const h = await boot({ factory: null, legacy: readOnlyStorage({}) });
    expect(h.session.project.getState().status).toBe("memory-only");
    setLives(h, 7);
    await drain(h);
    const before = snapshot(h);
    const r = await attempt(h);
    expect(r).toMatchObject({ ok: false, code: "would-lose-data" });
    expect(r.message).toMatch(/exists only in memory/);
    await drain(h);
    expect(snapshot(h)).toEqual(before);
    expect(h.session.project.getState().status).toBe("memory-only");
    expect((await attempt(h, { discardUnsaved: true })).ok).toBe(true);
    await drain(h);
    expect(snapshot(h).key).not.toBe(before.key);
    expect(h.session.project.getState().status).toBe("memory-only"); // still never claimed saved
  });

  it("proceeds without any prompt when the open project is saved", async () => {
    const h = await boot({ factory: newFactory() });
    setLives(h, 7); // a valid edit: the preflight waits for its save
    const before = snapshot(h);
    expect((await attempt(h)).ok).toBe(true);
    await drain(h);
    expect(snapshot(h).key).not.toBe(before.key);
  });
});

describe("the confirmation step of the UI", () => {
  it("asks once with the consequences, retries only on an explicit yes, and does nothing on no", async () => {
    const h = await boot({ factory: null, legacy: readOnlyStorage({}) });
    setLives(h, 7);
    await drain(h);
    const before = snapshot(h);
    const asked: string[] = [];
    const no = await replaceWithConfirm((o) => h.session.loadTemplate("pumpkin-blaster", o), (t) => { asked.push(t); return false; });
    expect(no.ok).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/only in memory/);
    expect(asked[0]).toMatch(/cannot be recovered/);
    expect(snapshot(h)).toEqual(before);
    const yes = await replaceWithConfirm((o) => h.session.loadTemplate("pumpkin-blaster", o), () => true);
    expect(yes.ok).toBe(true);
    await drain(h);
    expect(snapshot(h).key).not.toBe(before.key);
  });
  it("does not ask when nothing would be lost", async () => {
    const h = await boot({ factory: newFactory() });
    let asked = 0;
    const r = await replaceWithConfirm((o) => h.session.loadTemplate("pumpkin-blaster", o), () => { asked++; return true; });
    expect(r.ok).toBe(true);
    expect(asked).toBe(0);
  });
});
