import type { Json } from "../schema/schema";

export type Path = (string | number)[];

/** "game.runtime.kinds[].glyph": array indices become []. Matches SchemaModel and COVERAGE keys. */
export function toPattern(path: Path): string {
  let out = "";
  for (const step of path) {
    if (typeof step === "number") out += "[]";
    else out += out ? `.${step}` : step;
  }
  return out;
}

/** Engine issue path form: "$.game.runtime.kinds[1].id". */
export function toIssuePath(path: Path): string {
  let out = "$";
  for (const step of path) out += typeof step === "number" ? `[${step}]` : `.${step}`;
  return out;
}

/** Inverse of toIssuePath. Returns undefined for anything that is not a plain "$.a.b[0].c" path. */
export function parseIssuePath(text: string): Path | undefined {
  if (!text.startsWith("$")) return undefined;
  const path: Path = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/y;
  re.lastIndex = 1;
  while (re.lastIndex < text.length) {
    const m = re.exec(text);
    if (!m) return undefined;
    path.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return path;
}

export const samePath = (a: Path, b: Path): boolean => a.length === b.length && a.every((s, i) => s === b[i]);
export const startsWith = (path: Path, prefix: Path): boolean => prefix.length <= path.length && prefix.every((s, i) => s === path[i]);

export function getAt(doc: Json | undefined, path: Path): Json | undefined {
  let cur: Json | undefined = doc;
  for (const step of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[step as number] : (cur as Record<string, Json>)[step as string];
  }
  return cur;
}

/** Immutable set: returns a new document sharing every untouched branch. */
export function setAt(doc: Json, path: Path, value: Json): Json {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(doc)) {
    const copy = doc.slice();
    copy[head as number] = setAt(copy[head as number] as Json, rest, value);
    return copy;
  }
  const obj = doc as Record<string, Json>;
  return { ...obj, [head as string]: setAt(obj[head as string] as Json, rest, value) };
}

export function insertAt(doc: Json, arrayPath: Path, item: Json): Json {
  const arr = getAt(doc, arrayPath);
  if (!Array.isArray(arr)) throw new Error(`${toIssuePath(arrayPath)} is not an array`);
  return setAt(doc, arrayPath, [...arr, item]);
}

export function removeIndex(doc: Json, arrayPath: Path, index: number): Json {
  const arr = getAt(doc, arrayPath);
  if (!Array.isArray(arr)) throw new Error(`${toIssuePath(arrayPath)} is not an array`);
  return setAt(doc, arrayPath, arr.filter((_, i) => i !== index));
}
