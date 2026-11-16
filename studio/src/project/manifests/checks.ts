// Checks inside one manifest that JSON Schema cannot express: unique ids, ordering, internal references and consistency.
// Cross-manifest references (kind ids against the spec, asset ids against the asset list) belong to the project-wide
// cross-reference index (task 1.4), not here.
import type { Issue, Path } from "./schema";
import { assetSeq } from "./assetIds";
import { parseStrictJson } from "./strictJson";
import type {
  AnimationsManifest, AssetsManifest, GameplayManifest, IntegrationsManifest, LevelsManifest, ProjectManifest, ProposalManifest,
} from "./types";

export type ManifestName = "project" | "assets" | "animations" | "levels" | "gameplay" | "integrations" | "proposal";

const push = (out: Issue[], path: Path, code: string, message: string) => out.push({ path, code, message });

function uniqueIds(out: Issue[], items: { id: string }[], path: Path, what: string): void {
  const seen = new Set<string>();
  items.forEach((it, i) => {
    if (seen.has(it.id)) push(out, [...path, i, "id"], "duplicate-id", `${what} id "${it.id}" is used more than once`);
    seen.add(it.id);
  });
}
function sortedBy<T>(out: Issue[], items: T[], key: (t: T) => string | number, path: Path, what: string): void {
  for (let i = 1; i < items.length; i++) {
    const a = key(items[i - 1] as T), b = key(items[i] as T);
    if (a > b) { push(out, [...path, i], "not-sorted", `${what} must be sorted; "${String(b)}" comes before "${String(a)}"`); return; }
  }
}
function sortedUnique(out: Issue[], items: string[], path: Path, what: string): void {
  for (let i = 1; i < items.length; i++) {
    if ((items[i - 1] as string) >= (items[i] as string)) { push(out, [...path, i], "not-sorted", `${what} must be sorted and without duplicates`); return; }
  }
}

function project(m: ProjectManifest): Issue[] {
  const out: Issue[] = [];
  sortedUnique(out, m.modules, ["modules"], "modules");
  if (m.derivation.levels && m.derivation.activeLevel === "") push(out, ["derivation", "activeLevel"], "required-when-derived", "an active level is required while level derivation is on");
  if (!m.derivation.levels && m.derivation.activeLevel !== "") push(out, ["derivation", "activeLevel"], "set-while-off", "activeLevel must be empty while level derivation is off");
  if (m.derivation.levels && !m.modules.includes("levels")) push(out, ["derivation", "levels"], "module-missing", "level derivation needs the levels module");
  if (m.derivation.gameplay && !m.modules.includes("gameplay")) push(out, ["derivation", "gameplay"], "module-missing", "gameplay derivation needs the gameplay module");
  const compiled = m.derivation.levels || m.derivation.gameplay;
  if (!compiled && m.derived.inputsSha256 !== "") push(out, ["derived", "inputsSha256"], "set-while-off", "inputsSha256 must be empty while no derivation is on");
  if (!compiled && m.spec.currentSha256 !== m.spec.baseSha256) push(out, ["spec", "currentSha256"], "hash-mismatch", "currentSha256 must equal baseSha256 while no derivation is on");
  return out;
}

const AUDIO_CATEGORIES = new Set(["music", "sfx"]);
function assets(m: AssetsManifest): Issue[] {
  const out: Issue[] = [];
  uniqueIds(out, m.assets, ["assets"], "asset");
  sortedBy(out, m.assets, (a) => a.id, ["assets"], "assets");
  // Allocation rule (assetIds.ts): generated ids are asset-<seq>; nextSeq is the next unused number. History of deleted ids is not stored, so only collisions with ids that exist can be detected.
  m.assets.forEach((a, i) => {
    const seq = assetSeq(a.id);
    if (seq !== null && m.nextSeq <= seq) push(out, ["nextSeq"], "seq-too-low", `nextSeq ${m.nextSeq} would reuse or collide with the generated id "${a.id}" (assets[${i}]); it must exceed ${seq}`);
  });
  const total = m.assets.reduce((n, a) => n + a.bytes, 0);
  if (total > 64 * 1024 * 1024) push(out, ["assets"], "project-too-large", "assets exceed 64 MiB in total");
  m.assets.forEach((a, i) => {
    const at = (f: string): Path => ["assets", i, f];
    if (a.kind === "image") {
      if (!a.mime.startsWith("image/")) push(out, at("mime"), "kind-mime", "an image needs an image/* type");
      if (a.width < 1 || a.height < 1) push(out, at("width"), "dimensions", "an image needs width and height of at least 1");
      if (a.durationMs !== 0) push(out, at("durationMs"), "dimensions", "an image has no duration");
      if (AUDIO_CATEGORIES.has(a.category)) push(out, at("category"), "kind-category", "an image cannot be music or sfx");
    } else {
      if (!a.mime.startsWith("audio/")) push(out, at("mime"), "kind-mime", "audio needs an audio/* type");
      if (a.width !== 0 || a.height !== 0) push(out, at("width"), "dimensions", "audio has no pixel size");
      if (a.durationMs < 1) push(out, at("durationMs"), "dimensions", "audio needs a duration of at least 1 ms");
      if (!AUDIO_CATEGORIES.has(a.category)) push(out, at("category"), "kind-category", "audio must be music or sfx");
    }
    sortedUnique(out, a.kindRefs, [...at("kindRefs")], "kindRefs");
    const p = a.provenance;
    p.license.split(" ").forEach((tok, k) => { if (k % 2 === 0 && (tok === "AND" || tok === "OR" || tok === "WITH")) push(out, [...at("provenance"), "license"], "license", `"${tok}" is an operator and cannot be used as an identifier`); });
    if (p.license.includes("proprietary-owned") && p.license !== "proprietary-owned") push(out, [...at("provenance"), "license"], "license", "proprietary-owned cannot be combined with other license identifiers")
    if (p.origin === "ai-generated" && (p.tool === "" || p.model === "")) push(out, [...at("provenance"), "tool"], "provenance", "AI-generated assets must record the tool and the model");
    if (p.origin !== "ai-generated" && (p.promptSha256 !== "")) push(out, [...at("provenance"), "promptSha256"], "provenance", "a prompt hash applies only to AI-generated assets");
  });
  const files = new Set<string>();
  m.assets.forEach((a, i) => { const k = `${a.id}/${a.file}`; if (files.has(k)) push(out, ["assets", i, "file"], "duplicate-file", "duplicate asset file"); files.add(k); });
  return out;
}

function animations(m: AnimationsManifest): Issue[] {
  const out: Issue[] = [];
  uniqueIds(out, m.sheets, ["sheets"], "sheet");
  uniqueIds(out, m.animations, ["animations"], "animation");
  sortedBy(out, m.sheets, (s) => s.id, ["sheets"], "sheets");
  sortedBy(out, m.animations, (a) => a.id, ["animations"], "animations");
  const sheets = new Map(m.sheets.map((s) => [s.id, s]));
  m.sheets.forEach((s, i) => uniqueIds(out, s.frames, ["sheets", i, "frames"], "frame"));
  m.animations.forEach((a, i) => {
    const sheet = sheets.get(a.sheetId);
    if (!sheet) { push(out, ["animations", i, "sheetId"], "unknown-sheet", `sheet "${a.sheetId}" does not exist`); return; }
    const ids = new Set(sheet.frames.map((f) => f.id));
    if (a.sequence.length === 0) push(out, ["animations", i, "sequence"], "empty-sequence", "an animation needs at least one frame");
    a.sequence.forEach((s, j) => { if (!ids.has(s.frameId)) push(out, ["animations", i, "sequence", j, "frameId"], "unknown-frame", `frame "${s.frameId}" is not in sheet "${sheet.id}"`); });
  });
  return out;
}

function levels(m: LevelsManifest): Issue[] {
  const out: Issue[] = [];
  uniqueIds(out, m.levels, ["levels"], "level");
  sortedBy(out, m.levels, (l) => l.order, ["levels"], "levels (by order)");
  const orders = new Set<number>();
  m.levels.forEach((l, i) => {
    if (orders.has(l.order)) push(out, ["levels", i, "order"], "duplicate-order", `order ${l.order} is used more than once`);
    orders.add(l.order);
    const base: Path = ["levels", i];
    uniqueIds(out, l.placements, [...base, "placements"], "placement");
    uniqueIds(out, l.waves, [...base, "waves"], "wave");
    uniqueIds(out, l.difficulty, [...base, "difficulty"], "difficulty step");
    const streams = new Set<string>();
    const useStream = (s: string, path: Path) => { if (streams.has(s)) push(out, path, "duplicate-stream", `stream "${s}" is used more than once in this level`); streams.add(s); };
    l.waves.forEach((w, j) => {
      useStream(w.stream, [...base, "waves", j, "stream"]);
      if (w.xMin > w.xMax) push(out, [...base, "waves", j, "xMax"], "range", "xMax must not be below xMin");
      if (w.yMin > w.yMax) push(out, [...base, "waves", j, "yMax"], "range", "yMax must not be below yMin");
    });
    const waves = new Map(l.waves.map((w) => [w.id, w]));
    l.difficulty.forEach((d, j) => {
      useStream(d.stream, [...base, "difficulty", j, "stream"]);
      const w = waves.get(d.waveId);
      if (!w) push(out, [...base, "difficulty", j, "waveId"], "unknown-wave", `wave "${d.waveId}" does not exist in this level`);
      else if (d.atTick <= w.startTick) push(out, [...base, "difficulty", j, "atTick"], "before-wave", "a difficulty step must start after its wave starts");
    });
    if (l.waves.length + l.difficulty.length > 64) push(out, [...base, "waves"], "too-many-spawners", "a level compiles to at most 64 spawners");
  });
  return out;
}

function gameplay(m: GameplayManifest): Issue[] {
  const out: Issue[] = [];
  uniqueIds(out, m.collectibles, ["collectibles"], "collectible");
  uniqueIds(out, m.enemies, ["enemies"], "enemy");
  const pairs = new Map<string, string>();
  const claim = (a: string, b: string, path: Path) => {
    const k = `${a}|${b}`;
    if (pairs.has(k)) push(out, path, "duplicate-pair", `the pair ${a} and ${b} is already handled by "${pairs.get(k)}"`);
    pairs.set(k, path.join("."));
  };
  m.collectibles.forEach((c, i) => claim(c.collectorKind, c.kind, ["collectibles", i, "kind"]));
  m.enemies.forEach((e, i) => claim(e.targetKind, e.kind, ["enemies", i, "kind"]));
  return out;
}

function integrations(m: IntegrationsManifest): Issue[] {
  const out: Issue[] = [];
  uniqueIds(out, m.monetization.placements, ["monetization", "placements"], "placement");
  sortedBy(out, m.monetization.placements, (p) => p.id, ["monetization", "placements"], "placements");
  sortedUnique(out, m.backend.configFiles, ["backend", "configFiles"], "configFiles");
  m.monetization.placements.forEach((p, i) => {
    const at = (f: string): Path => ["monetization", "placements", i, f];
    if (p.type === "rewarded") {
      if (p.rewardKind === "" || p.rewardAmount < 1) push(out, at("rewardKind"), "reward", "a rewarded placement needs a reward kind and an amount of at least 1");
    } else if (p.rewardKind !== "" || p.rewardAmount !== 0) push(out, at("rewardKind"), "reward", "only a rewarded placement has a reward");
  });
  return out;
}

function proposal(m: ProposalManifest): Issue[] {
  const out: Issue[] = [];
  m.ops.forEach((o, i) => {
    if (o.op === "remove" && o.value !== "") push(out, ["ops", i, "value"], "value", "a remove operation has no value");
    if (o.op !== "remove") {
      if (o.value === "") push(out, ["ops", i, "value"], "value", "add and set need a value");
      else {
        const r = parseStrictJson(o.value);
        if (!r.ok) push(out, ["ops", i, "value"], "value", `the value must be strict JSON (${r.issue.code}: ${r.issue.message})`);
      }
    }
    if (/(^|\/)(__proto__|constructor|prototype)(\/|$)/.test(o.path)) push(out, ["ops", i, "path"], "forbidden-key", "the path names a forbidden key");
  });
  return out;
}

export function checkManifest(name: ManifestName, value: unknown): Issue[] {
  switch (name) {
    case "project": return project(value as ProjectManifest);
    case "assets": return assets(value as AssetsManifest);
    case "animations": return animations(value as AnimationsManifest);
    case "levels": return levels(value as LevelsManifest);
    case "gameplay": return gameplay(value as GameplayManifest);
    case "integrations": return integrations(value as IntegrationsManifest);
    case "proposal": return proposal(value as ProposalManifest);
  }
}
