// Reads the engine's own JSON Schemas (spec/schema/*.schema.json, as loaded into the worker) to describe fields:
// labels, descriptions, constraints and whether a number is a Q16.16 quantity. It does not validate documents;
// the engine does (R1.2). Constraints shown in the UI are hints that come from here.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export interface FieldInfo {
  /** Path pattern, array indices written as [] (e.g. game.runtime.kinds[].glyph). */
  pattern: string;
  type: string | undefined;
  title: string | undefined;
  description: string | undefined;
  enum: Json[] | undefined;
  const: Json | undefined;
  minimum: number | undefined;
  maximum: number | undefined;
  exclusiveMinimum: number | undefined;
  minLength: number | undefined;
  maxLength: number | undefined;
  regex: string | undefined;
  /** Names of the $defs this field passed through, innermost first (e.g. ["fixed"]). */
  defs: string[];
  /** q16: raw Q16.16 integer shown in game units. Derived from the schema type name, never from a hand-kept list. */
  unit: "q16" | undefined;
}

const SCHEMA_FILES = ["monstera.spec.schema.json", "project.schema.json", "game.schema.json"] as const;
const Q16_DEFS = new Set(["fixed", "size"]);

export class SchemaModel {
  private readonly files = new Map<string, Obj>();

  constructor(texts: Record<string, string>) {
    for (const name of SCHEMA_FILES) {
      const text = texts[name];
      if (text === undefined) throw new Error(`schema file ${name} was not provided by the engine`);
      this.files.set(name, JSON.parse(text) as Obj);
    }
  }

  private root(): { node: Obj; file: string } {
    return { node: this.files.get("monstera.spec.schema.json") as Obj, file: "monstera.spec.schema.json" };
  }

  /** Follows $ref chains. Sibling keywords next to a $ref override the target (draft 2020-12). */
  private resolve(node: Obj, file: string, defs: string[] = []): { node: Obj; file: string; defs: string[] } {
    const ref = node["$ref"];
    if (typeof ref !== "string") return { node, file, defs };
    let targetFile = file;
    let pointer = ref;
    if (!ref.startsWith("#")) { targetFile = ref; pointer = "#"; }
    let target = this.files.get(targetFile);
    if (!target) throw new Error(`unresolved $ref ${ref} in ${file}`);
    let name: string | undefined;
    if (pointer.startsWith("#/")) {
      for (const part of pointer.slice(2).split("/")) {
        target = (target as Obj)[part] as Obj;
        if (!target) throw new Error(`unresolved $ref ${ref} in ${file}`);
      }
      name = pointer.split("/").pop();
    }
    const { $ref: _ref, ...siblings } = node;
    void _ref;
    return this.resolve({ ...target, ...siblings }, targetFile, name ? [...defs, name] : defs);
  }

  private describe(pattern: string, node: Obj, defs: string[]): FieldInfo {
    const num = (k: string) => (typeof node[k] === "number" ? (node[k] as number) : undefined);
    const str = (k: string) => (typeof node[k] === "string" ? (node[k] as string) : undefined);
    return {
      pattern, type: str("type"), title: str("title"), description: str("description"),
      enum: Array.isArray(node["enum"]) ? (node["enum"] as Json[]) : undefined,
      const: node["const"],
      minimum: num("minimum"), maximum: num("maximum"), exclusiveMinimum: num("exclusiveMinimum"),
      minLength: num("minLength"), maxLength: num("maxLength"), regex: str("pattern"),
      defs, unit: defs.some((d) => Q16_DEFS.has(d)) ? "q16" : undefined,
    };
  }

  private walk(pattern: string, steps: string[], from: { node: Obj; file: string }, defs: string[]): FieldInfo | undefined {
    const r = this.resolve(from.node, from.file, defs);
    const [head, ...rest] = steps;
    if (head === undefined) return this.describe(pattern, r.node, r.defs);
    if (head === "[]") {
      const items = r.node["items"];
      return items && typeof items === "object" && !Array.isArray(items)
        ? this.walk(pattern, rest, { node: items as Obj, file: r.file }, []) : undefined;
    }
    const props = r.node["properties"] as Obj | undefined;
    const child = props?.[head];
    return child && typeof child === "object" && !Array.isArray(child)
      ? this.walk(pattern, rest, { node: child as Obj, file: r.file }, []) : undefined;
  }

  /** Field description for a path pattern such as "game.runtime.kinds[].glyph"; undefined if the schema has no such leaf. */
  field(pattern: string): FieldInfo | undefined {
    return this.walk(pattern, splitPattern(pattern), this.root(), []);
  }

  /** Every leaf path pattern of the schema (a leaf is anything that is neither an object with properties nor an array of objects). */
  leaves(): string[] {
    const out: string[] = [];
    const visit = (pattern: string, node: Obj, file: string): void => {
      const r = this.resolve(node, file);
      const props = r.node["properties"] as Obj | undefined;
      const items = r.node["items"] as Obj | undefined;
      if (r.node["type"] === "object" && props) {
        for (const key of Object.keys(props)) visit(pattern ? `${pattern}.${key}` : key, props[key] as Obj, r.file);
      } else if (r.node["type"] === "array" && items) {
        const item = this.resolve(items, r.file);
        if (item.node["type"] === "object" && item.node["properties"]) visit(`${pattern}[]`, items, r.file);
        else out.push(`${pattern}[]`);
      } else out.push(pattern);
    };
    visit("", this.root().node, this.root().file);
    return out.sort();
  }
}

export function splitPattern(pattern: string): string[] {
  const steps: string[] = [];
  for (const part of pattern.split(".")) {
    const m = /^([^[\]]*)((?:\[\])*)$/.exec(part);
    if (!m) throw new Error(`bad path pattern ${pattern}`);
    if (m[1]) steps.push(m[1]);
    for (let i = 0; i < (m[2] ?? "").length / 2; i++) steps.push("[]");
  }
  return steps;
}
