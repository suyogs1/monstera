// Browser-script helpers for Studio's storage model: projects live in IndexedDB ('monstera-studio'), localStorage only
// holds preferences and the eviction marker. Scripts must start from a known state and must read persistence from
// IndexedDB, never from the absence of an old localStorage key.
const DB = "monstera-studio";
const prompts = new WeakMap();

/** Accepts beforeunload prompts (a reload with unsaved work legitimately raises one) and counts them. */
export function acceptUnloadDialogs(page) {
  if (prompts.has(page)) return prompts.get(page);
  const state = { count: 0 };
  prompts.set(page, state);
  page.on("dialog", (d) => { if (d.type() === "beforeunload") { state.count++; void d.accept(); } });
  return state;
}

/**
 * Deterministic reset: waits for the app, clears localStorage (preferences, eviction marker), deletes the IndexedDB database
 * (waiting for success; the app's own connection closes on versionchange), then reloads so the next boot starts empty.
 * The caller waits for window.ready afterwards, as before.
 */
export async function resetStudioStorage(page) {
  acceptUnloadDialogs(page);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  const outcome = await page.evaluate((name) => new Promise((resolve) => {
    localStorage.clear();
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve("deleted");
    r.onerror = () => resolve(`error: ${r.error?.name}`);
    r.onblocked = () => { /* waits for the app's connection to close on versionchange */ };
  }), DB);
  if (outcome !== "deleted") throw new Error(`could not reset IndexedDB: ${outcome}`);
  await page.reload();
}

/** The records in the 'projects' store, read straight from IndexedDB (never opens or creates the database if it is absent). */
export function storedProjects(page) {
  return page.evaluate(async (name) => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name }];
    if (!dbs.some((d) => d.name === name)) return [];
    return await new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const q = db.transaction("projects", "readonly").objectStore("projects").getAll();
        q.onerror = () => { db.close(); reject(q.error); };
        q.onsuccess = () => { db.close(); resolve(q.result.map((r) => ({ projectKey: r.projectKey, name: r.name, projectId: r.projectId, specText: r.specText, specSha256: r.specSha256 }))); };
      };
    });
  }, DB);
}

export const livesOf = (rec) => JSON.parse(rec.specText).game.runtime.lives;
export const indicatorKind = (page) => page.locator('[data-testid="persistence-status"]').getAttribute("data-kind");
export const waitIndicator = (page, kind, timeout = 15000) =>
  page.waitForSelector(`[data-testid="persistence-status"][data-kind="${kind}"]`, { timeout });
export const waitSaved = (page, timeout) => waitIndicator(page, "saved", timeout);

/** The stored record of the project that is open now (templates and imports create their own projects). */
export async function activeRecord(page) {
  const key = await page.evaluate(() => window.session.project.getState().projectKey);
  return (await storedProjects(page)).find((r) => r.projectKey === key) ?? null;
}

/** Every entry of the 'meta' store (active-project pointer, migration flag), read straight from IndexedDB; [] when the database is absent. */
export function storedMeta(page) {
  return page.evaluate(async (name) => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name }];
    if (!dbs.some((d) => d.name === name)) return [];
    return await new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const q = db.transaction("meta", "readonly").objectStore("meta").getAll();
        q.onerror = () => { db.close(); reject(q.error); };
        q.onsuccess = () => { db.close(); resolve(q.result); };
      };
    });
  }, DB);
}

/** Whether the IndexedDB database exists at all (never creates it). */
export const studioDbExists = (page) => page.evaluate(async (name) => (await indexedDB.databases()).some((d) => d.name === name), DB);
