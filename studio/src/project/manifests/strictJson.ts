// Strict JSON reader for Studio-owned files. Mirrors the engine's strictness (duplicate keys, BOM, invalid UTF-8 are errors)
// and adds what Studio manifests need: no floats, no prototype-pollution keys, bounded depth and size.
// It parses data; it knows nothing about any schema.
export interface JsonIssue { code: string; message: string; offset: number }
export type JsonResult = { ok: true; value: unknown } | { ok: false; issue: JsonIssue };

export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_DEPTH = 32;
/** UTF-8 byte length of a JavaScript string (lone surrogates count as U+FFFD, three bytes, as TextEncoder does). Stops early past `limit`. */
export function utf8Length(s: string, limit = Infinity): number {
  let n = 0;
  for (let i = 0; i < s.length && n <= limit; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class Fail extends Error {
  constructor(readonly code: string, message: string, readonly offset: number) { super(message); }
}

/** Decodes UTF-8 and refuses a byte order mark and invalid sequences. */
export function decodeUtf8Strict(bytes: Uint8Array): { ok: true; text: string } | { ok: false; issue: JsonIssue } {
  if (bytes.length > MAX_JSON_BYTES) return { ok: false, issue: { code: "too-large", message: `file is larger than ${MAX_JSON_BYTES} bytes`, offset: 0 } };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { ok: false, issue: { code: "bom", message: "a byte order mark is not allowed", offset: 0 } };
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { ok: false, issue: { code: "invalid-utf8", message: "the file is not valid UTF-8", offset: 0 } };
  }
}

export function parseStrictJson(text: string): JsonResult {
  if (text.length > MAX_JSON_BYTES || utf8Length(text, MAX_JSON_BYTES) > MAX_JSON_BYTES) return { ok: false, issue: { code: "too-large", message: `text is larger than ${MAX_JSON_BYTES} bytes in UTF-8`, offset: 0 } };
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, issue: { code: "bom", message: "a byte order mark is not allowed", offset: 0 } };
  let i = 0;
  const ws = () => { while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++; };
  const fail = (code: string, message: string): never => { throw new Fail(code, message, i); };
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail("too-deep", `nesting is deeper than ${MAX_DEPTH}`);
    ws();
    const c = text[i];
    if (c === "{") return object(depth);
    if (c === "[") return array(depth);
    if (c === '"') return string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return number();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    return fail("syntax", "unexpected character");
  };
  const object = (depth: number): unknown => {
    i++;
    const out: Record<string, unknown> = {};
    ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail("syntax", "expected a string key");
      const key = string();
      if (FORBIDDEN_KEYS.has(key)) fail("forbidden-key", `the key "${key}" is not allowed`);
      if (Object.prototype.hasOwnProperty.call(out, key)) fail("duplicate-key", `duplicate key "${key}"`);
      ws();
      if (text[i] !== ":") fail("syntax", "expected ':'");
      i++;
      out[key] = value(depth + 1);
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      fail("syntax", "expected ',' or '}'");
    }
  };
  const array = (depth: number): unknown => {
    i++;
    const out: unknown[] = [];
    ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value(depth + 1));
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      fail("syntax", "expected ',' or ']'");
    }
  };
  const string = (): string => {
    i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) fail("syntax", "unterminated string");
      if (c === '"') { i++; return out; }
      if (c !== undefined && c < " ") fail("syntax", "control character in string");
      if (c === "\\") {
        const e = text[i + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e !== undefined && simple[e] !== undefined) { out += simple[e]; i += 2; continue; }
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("syntax", "bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
        }
        fail("syntax", "bad escape");
      }
      out += c; i++;
    }
  };
  const number = (): number => {
    const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 40));
    if (!m) return fail("syntax", "bad number");
    if (m[1] !== undefined || m[2] !== undefined) fail("float", "Studio manifests hold integers only; decimals and exponents are not allowed");
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) fail("integer-range", "integer is outside the safe range");
    i += m[0].length;
    return n === 0 ? 0 : n;
  };
  try {
    const v = value(0);
    ws();
    if (i < text.length) fail("syntax", "unexpected text after the document");
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, issue: { code: e.code, message: e.message, offset: e.offset } };
    throw e;
  }
}
