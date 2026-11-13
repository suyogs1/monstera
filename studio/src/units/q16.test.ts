import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "./q16";

const raw = (s: string) => {
  const r = parseUnits(s);
  if (!r.ok) throw new Error(r.reason);
  return r.raw;
};

describe("formatUnits", () => {
  it("shows exact decimals", () => {
    expect(formatUnits(0)).toBe("0");
    expect(formatUnits(65536)).toBe("1");
    expect(formatUnits(5242880)).toBe("80");
    expect(formatUnits(98304)).toBe("1.5");
    expect(formatUnits(-98304)).toBe("-1.5");
    expect(formatUnits(1)).toBe("0.0000152587890625"); // the smallest step, all 16 digits
    expect(formatUnits(-1)).toBe("-0.0000152587890625");
    expect(formatUnits(32768)).toBe("0.5");
  });
  it("handles the int32 extremes", () => {
    expect(formatUnits(2147483647)).toBe("32767.9999847412109375");
    expect(formatUnits(-2147483648)).toBe("-32768");
  });
});

describe("parseUnits", () => {
  it("converts to raw integers", () => {
    expect(raw("80")).toBe(5242880);
    expect(raw("1.5")).toBe(98304);
    expect(raw("-1.5")).toBe(-98304);
    expect(raw(".5")).toBe(32768);
    expect(raw("+2")).toBe(131072);
    expect(raw("  3  ")).toBe(196608);
    expect(raw("0")).toBe(0);
    expect(raw("-0")).toBe(0);
  });
  it("rounds to the nearest raw value, ties away from zero", () => {
    // half a raw step is 0.00000762939453125
    expect(raw("0.00000762939453125")).toBe(1); // exact tie -> away from zero
    expect(raw("-0.00000762939453125")).toBe(-1);
    expect(raw("0.0000076293945312")).toBe(0); // just below the tie
    expect(raw("0.0000076293945313")).toBe(1);
    expect(raw("0.1")).toBe(6554); // 6553.6 rounds up
    expect(raw("0.2")).toBe(13107); // 13107.2 rounds down
    expect(raw("1.00001")).toBe(65537); // 65536.65536 -> 65537
  });
  it("rejects what is not a plain decimal", () => {
    for (const bad of ["", ".", "-", "abc", "1e3", "1,5", "0x10", "1.2.3", "--1", "Infinity", "NaN"]) {
      expect(parseUnits(bad).ok, bad).toBe(false);
    }
  });
  it("reports values beyond the safe integer range instead of losing digits", () => {
    expect(parseUnits("999999999999999999999").ok).toBe(false);
  });
});

describe("round trip", () => {
  it("parse(format(raw)) === raw for edge values and a dense sweep", () => {
    const samples = [0, 1, -1, 2, 32767, 32768, 32769, 65535, 65536, 65537, 2147483647, -2147483648, -2147483647, 5242880, 123207680];
    for (let i = 0; i < 70000; i += 7) samples.push(i, 0 - i);
    for (let i = 0; i < 4000; i++) samples.push((i * 2654435761) % 4294967296 - 2147483648); // spread over int32
    for (const r of samples) expect(raw(formatUnits(r)), String(r)).toBe(r);
  });
  it("every raw value in 0..65536 round-trips (one full unit)", () => {
    for (let r = -65536; r <= 65536; r++) if (raw(formatUnits(r)) !== r) throw new Error(`round trip failed for ${r}`);
  });
});
