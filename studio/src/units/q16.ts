// Q16.16 display conversion. The spec stores raw integers (1 unit = 65536); this module only changes how a raw
// integer is shown and how typed text is turned back into one. It is display glue, not engine arithmetic.
//
// Exactness: raw / 65536 always has a finite decimal expansion (at most 16 fractional digits), so
// formatUnits is exact and parseUnits(formatUnits(raw)) === raw for every integer. Typed text with more digits
// than that is rounded to the nearest raw value, ties away from zero (documented in the UI hint).

export const ONE = 65536;
const FRACTION_DIGITS = 16;
const POW10_16 = 10n ** 16n;

/** Exact decimal text of a raw integer in game units, e.g. 5242880 -> "80", 98304 -> "1.5". */
export function formatUnits(raw: number): string {
  if (!Number.isSafeInteger(raw)) throw new RangeError(`raw value ${raw} is not a safe integer`);
  const negative = raw < 0;
  const a = BigInt(negative ? -raw : raw);
  const whole = a / BigInt(ONE);
  const rem = a % BigInt(ONE);
  let text = whole.toString();
  if (rem !== 0n) {
    const frac = ((rem * POW10_16) / BigInt(ONE)).toString().padStart(FRACTION_DIGITS, "0").replace(/0+$/, "");
    text += "." + frac;
  }
  return negative && a !== 0n ? "-" + text : text;
}

export type ParseResult = { ok: true; raw: number } | { ok: false; reason: string };

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Decimal text in game units -> raw integer, nearest value, ties away from zero. Exponent notation is rejected. */
export function parseUnits(input: string): ParseResult {
  const text = input.trim();
  const m = DECIMAL.exec(text);
  if (!m || ((m[2] ?? "") === "" && (m[3] ?? "") === "")) return { ok: false, reason: "not a number" };
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  const scale = 10n ** BigInt(frac.length);
  const numerator = BigInt(whole + frac) * BigInt(ONE);
  let q = numerator / scale;
  if ((numerator % scale) * 2n >= scale) q += 1n; // magnitude rounding: ties go away from zero
  const raw = sign * q;
  if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < -BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "too large" };
  return { ok: true, raw: Number(raw) };
}
