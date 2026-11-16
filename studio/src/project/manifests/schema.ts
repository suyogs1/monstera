// Runtime validator for Studio-owned manifest schemas. It follows the engine's discipline: every property is required,
// additionalProperties is false, and a keyword it does not implement fails when the schema is loaded.
// It validates Studio sidecar manifests only. The canonical v4 spec is validated by the engine, never here.
export type Path = (string | number)[];
export interface Issue { path: Path; code: string; message: string }

const KEYWORDS = new Set([
  "$schema", "title", "description", "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
  "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "$ref", "$defs",
]);
const TYPES = new Set(["object", "array", "string", "integer", "boolean"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Node {
  type?: string; properties?: Record<string, Node>; order: string[]; items?: Node; minItems?: number; maxItems?: number;
  enum?: Json[]; const?: Json; hasConst: boolean; pattern?: RegExp; minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
}
export interface CompiledSchema { title: string; root: Node }

export class SchemaLoadError extends Error {}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
/** Own-property test. `in` also finds inherited names such as toString and hasOwnProperty, which must never count as declared. */
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function compileSchema(schema: unknown): CompiledSchema {
  if (!isObj(schema)) throw new SchemaLoadError("schema must be an object");
  const defs = isObj(schema["$defs"]) ? (schema["$defs"] as Raw) : {};
  const cache = new Map<string, Node>();
  const build = (raw: unknown, where: string, resolving: string[]): Node => {
    if (!isObj(raw)) throw new SchemaLoadError(`${where}: schema must be an object`);
    for (const k of Object.keys(raw)) if (!KEYWORDS.has(k)) throw new SchemaLoadError(`${where}: unsupported keyword "${k}"`);
    if (raw["$ref"] !== undefined) {
      const ref = raw["$ref"];
      const m = typeof ref === "string" ? /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(ref) : null;
      if (!m || !m[1]) throw new SchemaLoadError(`${where}: unsupported $ref`);
      const name = m[1];
      if (!own(defs, name)) throw new SchemaLoadError(`${where}: unknown definition "${name}"`);
      if (resolving.includes(name)) throw new SchemaLoadError(`${where}: recursive definition "${name}"`);
      const hit = cache.get(name);
      if (hit) return hit;
      const node = build(defs[name], `$defs/${name}`, [...resolving, name]);
      cache.set(name, node);
      return node;
    }
    const node: Node = { order: [], hasConst: own(raw, "const") };
    if (own(raw, "const")) node.const = raw["const"] as Json;
    if (raw["type"] !== undefined) {
      if (typeof raw["type"] !== "string" || !TYPES.has(raw["type"])) throw new SchemaLoadError(`${where}: unsupported type`);
      node.type = raw["type"];
    }
    if (!node.type && !node.hasConst && raw["enum"] === undefined) throw new SchemaLoadError(`${where}: needs a type, const or enum`);
    if (node.type === "object") {
      const props = raw["properties"];
      if (!isObj(props)) throw new SchemaLoadError(`${where}: object needs properties`);
      if (raw["additionalProperties"] !== false) throw new SchemaLoadError(`${where}: additionalProperties must be false`);
      const required = raw["required"];
      const names = Object.keys(props);
      if (!Array.isArray(required) || required.length !== names.length || !names.every((n) => required.includes(n))) {
        throw new SchemaLoadError(`${where}: every property must be required, and nothing else`);
      }
      node.properties = {};
      for (const n of names) node.properties[n] = build(props[n], `${where}.${n}`, resolving);
      node.order = names;
    } else if (raw["properties"] !== undefined || raw["required"] !== undefined || raw["additionalProperties"] !== undefined) {
      throw new SchemaLoadError(`${where}: object keywords on a non-object`);
    }
    if (node.type === "array") {
      if (raw["items"] === undefined) throw new SchemaLoadError(`${where}: array needs items`);
      node.items = build(raw["items"], `${where}[]`, resolving);
      if (typeof raw["maxItems"] !== "number") throw new SchemaLoadError(`${where}: array needs maxItems`);
    }
    for (const k of ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"] as const) {
      if (raw[k] === undefined) continue;
      if (typeof raw[k] !== "number" || !Number.isInteger(raw[k])) throw new SchemaLoadError(`${where}: ${k} must be an integer`);
      node[k] = raw[k] as number;
    }
    if (raw["enum"] !== undefined) {
      if (!Array.isArray(raw["enum"]) || raw["enum"].length === 0) throw new SchemaLoadError(`${where}: enum must be a non-empty array`);
      node.enum = raw["enum"] as Json[];
    }
    if (raw["pattern"] !== undefined) {
      if (typeof raw["pattern"] !== "string") throw new SchemaLoadError(`${where}: pattern must be a string`);
      node.pattern = new RegExp(raw["pattern"]);
    }
    return node;
  };
  const root = build(schema, "$", []);
  if (root.type !== "object") throw new SchemaLoadError("$: root must be an object schema");
  return { title: typeof schema["title"] === "string" ? schema["title"] : "", root };
}

const same = (a: unknown, b: unknown) => a === b;

export function validate(value: unknown, schema: CompiledSchema): Issue[] {
  const issues: Issue[] = [];
  const walk = (v: unknown, n: Node, path: Path): void => {
    const add = (code: string, message: string) => issues.push({ path: [...path], code, message });
    if (n.hasConst && !same(v, n.const)) { add("const", `must be ${JSON.stringify(n.const)}`); return; }
    if (n.enum && !n.enum.some((e) => same(e, v))) { add("enum", `must be one of ${n.enum.map((e) => JSON.stringify(e)).join(", ")}`); return; }
    switch (n.type) {
      case undefined: return;
      case "boolean": if (typeof v !== "boolean") add("type", "must be a boolean"); return;
      case "integer":
        if (typeof v !== "number" || !Number.isSafeInteger(v)) { add("type", "must be an integer"); return; }
        if (n.minimum !== undefined && v < n.minimum) add("minimum", `must be at least ${n.minimum}`);
        if (n.maximum !== undefined && v > n.maximum) add("maximum", `must be at most ${n.maximum}`);
        return;
      case "string":
        if (typeof v !== "string") { add("type", "must be a string"); return; }
        if (n.minLength !== undefined && v.length < n.minLength) add("minLength", `must have at least ${n.minLength} characters`);
        if (n.maxLength !== undefined && v.length > n.maxLength) add("maxLength", `must have at most ${n.maxLength} characters`);
        if (n.pattern && !n.pattern.test(v)) add("pattern", `does not match ${n.pattern.source}`);
        return;
      case "array":
        if (!Array.isArray(v)) { add("type", "must be an array"); return; }
        if (n.minItems !== undefined && v.length < n.minItems) add("minItems", `must have at least ${n.minItems} items`);
        if (n.maxItems !== undefined && v.length > n.maxItems) add("maxItems", `must have at most ${n.maxItems} items`);
        if (n.items) v.slice(0, (n.maxItems ?? v.length) + 1).forEach((x, i) => walk(x, n.items as Node, [...path, i]));
        return;
      case "object": {
        if (!isObj(v)) { add("type", "must be an object"); return; }
        const props = n.properties ?? {};
        for (const k of Object.keys(v)) if (!own(props, k)) issues.push({ path: [...path, k], code: "additional", message: `unknown property "${k}"` });
        for (const k of n.order) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) issues.push({ path: [...path, k], code: "required", message: `missing property "${k}"` });
          else walk(v[k], props[k] as Node, [...path, k]);
        }
        return;
      }
    }
  };
  walk(value, schema.root, []);
  return issues;
}

/** Re-orders object keys into schema order so serialization is canonical. Assumes the value validated. */
export function inSchemaOrder(value: unknown, schema: CompiledSchema): unknown {
  const go = (v: unknown, n: Node): unknown => {
    if (n.type === "array" && Array.isArray(v) && n.items) return v.map((x) => go(x, n.items as Node));
    if (n.type === "object" && isObj(v) && n.properties) {
      const out: Raw = {};
      for (const k of n.order) out[k] = go(v[k], n.properties[k] as Node);
      return out;
    }
    return v;
  };
  return go(value, schema.root);
}
