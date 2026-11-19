// The project catalog: every project record in the browser, read and changed one at a time. Plain TypeScript, no React.
// ProjectStore stays the only persistence authority; it calls these functions with its own connection. Nothing here
// touches the live project, the status machine or the save queue.
//
//   list      reads every record and evaluates it without trusting it. A record that cannot be read is listed as
//             "unreadable" with its key and the reason; it is never repaired, rewritten or hidden.
//   rename    compare-and-swap on writeSeq (the same rule as a normal save), active pointer untouched.
//   duplicate ONE transaction writes a new record under a new key (expected absent) and copies the asset blobs. The
//             specification text, and therefore project.id, is copied unchanged: Studio never edits a spec silently.
//   delete    ONE transaction removes the record, its asset blobs and the active pointer when it named this project.
import { secretRules } from "../integrations/secrets";
import { STORE_BLOBS, STORE_META, STORE_PROJECTS, runTransaction, type IdbConnection } from "./idb";
import type { ManifestMap } from "./manifests";
import { ACTIVE_KEY, evaluateRecord, readContents, readRecord, writeRecord, type ProjectRecord, type ProjectSnapshot, type Sha256 } from "./record";

/** Studio modules whose sidecar manifest holds user data. Order is display order. */
export type PopulatedModule = "assets" | "sprites" | "levels" | "gameplay" | "backend" | "monetization";
export interface Populated { module: PopulatedModule; detail: string }

export type CatalogEntry =
  | {
    state: "ok"; projectKey: string; name: string; projectId: string; specSha256: string; writeSeq: number;
    targets: string[]; populated: Populated[];
  }
  | { state: "unreadable"; projectKey: string; name: string | null; message: string };

export const MAX_PROJECT_NAME = 80;
/** A project name the user may choose: 1 to 80 characters after trimming, no control characters. Returns the trimmed name or the reason. */
export function checkProjectName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim();
  if (name === "") return { ok: false, reason: "A project name cannot be empty." };
  if (name.length > MAX_PROJECT_NAME) return { ok: false, reason: `A project name has at most ${MAX_PROJECT_NAME} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: "A project name cannot contain control characters." };
  if (secretRules(name).length > 0) return { ok: false, reason: "A project name cannot look like a key or credential." };
  return { ok: true, name };
}

/** The platforms a spec generates for (`project.targets`), from the stored canonical text. Empty when unreadable. */
export function targetsOf(specText: string): string[] {
  try {
    const top = JSON.parse(specText) as { project?: { targets?: unknown } };
    const t = top?.project?.targets;
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Which Studio-pack modules hold data in these manifests, with a short count. A fresh project has none. */
export function populatedModules(m: ManifestMap): Populated[] {
  const out: Populated[] = [];
  const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
  if (m.assets.assets.length > 0) out.push({ module: "assets", detail: n(m.assets.assets.length, "asset") });
  if (m.animations.sheets.length + m.animations.animations.length > 0) {
    out.push({ module: "sprites", detail: `${n(m.animations.sheets.length, "sheet")}, ${n(m.animations.animations.length, "animation")}` });
  }
  if (m.levels.levels.length > 0) out.push({ module: "levels", detail: n(m.levels.levels.length, "level") });
  const modules = m.gameplay.collectibles.length + m.gameplay.enemies.length;
  if (modules > 0 || m.project.derivation.gameplay) out.push({ module: "gameplay", detail: n(modules, "module rule") });
  const services = Object.values(m.integrations.backend.services).filter(Boolean).length;
  if (services > 0) out.push({ module: "backend", detail: n(services, "service") });
  if (m.integrations.monetization.placements.length > 0) out.push({ module: "monetization", detail: n(m.integrations.monetization.placements.length, "placement") });
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rawKey = (raw: unknown): string | null => (isObject(raw) && typeof raw["projectKey"] === "string" ? (raw["projectKey"] as string) : null);
const rawName = (raw: unknown): string | null => (isObject(raw) && typeof raw["name"] === "string" ? (raw["name"] as string) : null);

export interface CatalogListing { entries: CatalogEntry[]; activeKey: string | null }

/** Reads and evaluates every record. `skip` names keys that are not projects of the user (the unverified migration copy). */
export async function listCatalog(conn: IdbConnection, sha256: Sha256, skip: (key: string) => boolean = () => false): Promise<CatalogListing> {
  const { records, meta } = await readContents(conn, [ACTIVE_KEY]);
  const entries: CatalogEntry[] = [];
  for (const raw of records) {
    const key = rawKey(raw);
    if (key === null) { entries.push({ state: "unreadable", projectKey: "(no key)", name: null, message: "A stored value has no project key." }); continue; }
    if (skip(key)) continue;
    const ev = await evaluateRecord(raw, sha256);
    if (ev.kind === "ok") {
      const { record, project } = ev;
      entries.push({
        state: "ok", projectKey: key, name: record.name, projectId: record.projectId, specSha256: record.specSha256, writeSeq: record.writeSeq,
        targets: targetsOf(record.specText), populated: populatedModules(project.manifests),
      });
    } else {
      const message = ev.kind === "newer-format" ? `This project was saved by a newer Studio (record format ${ev.format}).` : (ev.issues[0]?.message ?? "The stored record is not readable.");
      entries.push({ state: "unreadable", projectKey: key, name: rawName(raw), message });
    }
  }
  entries.sort((a, b) => (a.state === "ok" ? a.name : (a.name ?? a.projectKey)).localeCompare(b.state === "ok" ? b.name : (b.name ?? b.projectKey)) || a.projectKey.localeCompare(b.projectKey));
  const active = (meta[ACTIVE_KEY] as { value?: unknown } | undefined)?.value;
  return { entries, activeKey: typeof active === "string" ? active : null };
}

export type ReadOutcome = { ok: true; record: ProjectRecord; project: ProjectSnapshot } | { ok: false; message: string };
/** One record, evaluated. Never throws on content. */
export async function readEvaluated(conn: IdbConnection, projectKey: string, sha256: Sha256): Promise<ReadOutcome> {
  const raw = await readRecord(conn, projectKey);
  if (raw === undefined) return { ok: false, message: "That project is no longer stored." };
  const ev = await evaluateRecord(raw, sha256);
  if (ev.kind === "ok") return { ok: true, record: ev.record, project: ev.project };
  return { ok: false, message: ev.kind === "newer-format" ? `This project was saved by a newer Studio (record format ${ev.format}).` : `This project cannot be read: ${ev.issues[0]?.message ?? "invalid record"}.` };
}

export type RenameOutcome = { ok: true } | { ok: false; message: string };
export async function renameRecord(conn: IdbConnection, projectKey: string, name: string, sha256: Sha256): Promise<RenameOutcome> {
  const r = await readEvaluated(conn, projectKey, sha256);
  if (!r.ok) return r;
  const next: ProjectRecord = { ...r.record, name, writeSeq: r.record.writeSeq + 1 };
  const outcome = await writeRecord(conn, next, r.record.writeSeq, false);
  return outcome === "written" ? { ok: true } : { ok: false, message: "The project changed in another tab. Nothing was renamed; reload the list and try again." };
}

export type DuplicateOutcome = { ok: true; projectKey: string } | { ok: false; message: string };
export async function duplicateRecord(conn: IdbConnection, sourceKey: string, newKey: string, name: string, sha256: Sha256): Promise<DuplicateOutcome> {
  const r = await readEvaluated(conn, sourceKey, sha256);
  if (!r.ok) return r;
  const record: ProjectRecord = { ...r.record, projectKey: newKey, name, writeSeq: 1 };
  let clash = false;
  try {
    await runTransaction(conn, [STORE_PROJECTS, STORE_BLOBS], "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).get(newKey, (existing, t) => {
        if (existing !== undefined) { clash = true; t.abort(); return; }
        t.store(STORE_PROJECTS).put(record);
        t.store(STORE_BLOBS).getAllKeys(null, (keys, t2) => { // keys only; each blob is read and copied inside this same transaction
          for (const k of keys) {
            if (!Array.isArray(k) || k[0] !== sourceKey) continue;
            t2.store(STORE_BLOBS).get<Record<string, unknown>>(k, (row, t3) => {
              if (row !== undefined) t3.store(STORE_BLOBS).put({ ...row, projectKey: newKey });
            });
          }
        });
      });
    }, { durability: "strict" });
  } catch (e) {
    if (clash) return { ok: false, message: "That project key is already in use. Nothing was copied." };
    return { ok: false, message: `The copy could not be stored (${e instanceof Error ? e.message : "storage error"}). Nothing was copied.` };
  }
  return { ok: true, projectKey: newKey };
}

export async function deleteRecord(conn: IdbConnection, projectKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await runTransaction(conn, [STORE_PROJECTS, STORE_BLOBS, STORE_META], "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).delete(projectKey);
      tx.store(STORE_BLOBS).getAllKeys(null, (keys, t) => {
        for (const k of keys) if (Array.isArray(k) && k[0] === projectKey) t.store(STORE_BLOBS).delete(k);
      });
      tx.store(STORE_META).get<{ value?: unknown }>(ACTIVE_KEY, (a, t) => {
        if (a?.value === projectKey) t.store(STORE_META).delete(ACTIVE_KEY);
      });
    }, { durability: "strict" });
  } catch (e) {
    return { ok: false, message: `The project could not be deleted (${e instanceof Error ? e.message : "storage error"}). Nothing was removed.` };
  }
  return { ok: true };
}

/** Makes `projectKey` the active project. The caller has already checked that its record is readable. */
export async function setActiveKey(conn: IdbConnection, projectKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await runTransaction(conn, [STORE_META], "readwrite", (tx) => { tx.store(STORE_META).put({ key: ACTIVE_KEY, value: projectKey }); }, { durability: "strict" });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `The project could not be opened (${e instanceof Error ? e.message : "storage error"}).` };
  }
}
