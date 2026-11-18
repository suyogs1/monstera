// Task 2.1 acceptance: a fixture for each allowed type, SVG, polyglot, truncated, oversized, wrong extension. All fail closed.
import { describe, expect, it } from "vitest";
import { checkAddLimits, checkDimensions, MAX_ASSETS, MAX_FILE_BYTES, MAX_IMAGE_SIDE, MAX_PROJECT_BYTES } from "./limits";
import { sniffAsset, vetAsset } from "./sniff";

const txt = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u8 = (a: number[]): Uint8Array => Uint8Array.from(a);

const png = (w: number, h: number): number[] => [
  0x89, ...txt("PNG\r\n\x1a\n"),
  ...be32(13), ...txt("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ...be32(1), ...txt("IDAT"), 0, 0, 0, 0, 0,
  ...be32(0), ...txt("IEND"), 0, 0, 0, 0,
];
const jpeg = (w: number, h: number): number[] => [
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 2, 0xff, 0xd9,
];
const gif = (w: number, h: number): number[] => [
  ...txt("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0,
  0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2, 0,
  0x3b,
];
const webpL = (w: number, h: number): number[] => {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  const body = [...txt("WEBP"), ...txt("VP8L"), ...le32(10), 0x2f, ...le32(bits), 0, 0, 0, 0, 0];
  return [...txt("RIFF"), ...le32(body.length), ...body];
};
const wav = (): number[] => {
  const body = [...txt("WAVE"), ...txt("fmt "), ...le32(16), ...le16(1), ...le16(1), ...le32(8000), ...le32(8000), ...le16(1), ...le16(8), ...txt("data"), ...le32(2), 128, 128];
  return [...txt("RIFF"), ...le32(body.length), ...body];
};
const ogg = (): number[] => [...txt("OggS"), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 30, 1, ...txt("vorbis"), ...new Array(23).fill(0)];
const mp3 = (): number[] => [0xff, 0xfb, 0x90, 0x00, ...new Array(60).fill(0)];

describe("sniffAsset: every allowed type is decided from bytes", () => {
  it("png", () => expect(sniffAsset(u8(png(32, 16)))).toMatchObject({ ok: true, type: "png", kind: "image", mime: "image/png", width: 32, height: 16 }));
  it("jpeg", () => expect(sniffAsset(u8(jpeg(40, 20)))).toMatchObject({ ok: true, type: "jpeg", mime: "image/jpeg", width: 40, height: 20 }));
  it("gif", () => expect(sniffAsset(u8(gif(8, 9)))).toMatchObject({ ok: true, type: "gif", width: 8, height: 9 }));
  it("webp", () => expect(sniffAsset(u8(webpL(64, 48)))).toMatchObject({ ok: true, type: "webp", width: 64, height: 48 }));
  it("wav", () => expect(sniffAsset(u8(wav()))).toMatchObject({ ok: true, type: "wav", kind: "audio", mime: "audio/wav" }));
  it("ogg", () => expect(sniffAsset(u8(ogg()))).toMatchObject({ ok: true, type: "ogg", kind: "audio" }));
  it("mp3", () => expect(sniffAsset(u8(mp3()))).toMatchObject({ ok: true, type: "mp3", mime: "audio/mpeg" }));
  it("mp3 behind an ID3 tag", () => expect(sniffAsset(u8([...txt("ID3"), 4, 0, 0, 0, 0, 0, 2, 0, 0, ...mp3()]))).toMatchObject({ ok: true, type: "mp3" }));
});

describe("sniffAsset: refusals", () => {
  const svg = u8(txt('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  it("refuses SVG and HTML", () => {
    expect(sniffAsset(svg).ok).toBe(false);
    expect(sniffAsset(u8(txt("<!doctype html><script>1</script>"))).ok).toBe(false);
    expect(sniffAsset(u8(txt('<?xml version="1.0"?><svg/>'))).ok).toBe(false);
  });
  it("refuses empty and unknown content", () => {
    expect(sniffAsset(new Uint8Array(0)).ok).toBe(false);
    expect(sniffAsset(u8([1, 2, 3, 4, 5, 6, 7, 8])).ok).toBe(false);
  });
  it("refuses polyglots: data appended after the image or audio structure", () => {
    const tail = txt("<script>alert(1)</script>");
    for (const f of [png(4, 4), jpeg(4, 4), gif(4, 4), webpL(4, 4), wav()]) expect(sniffAsset(u8([...f, ...tail])).ok).toBe(false);
    expect(sniffAsset(u8([...ogg(), ...tail])).ok).toBe(false);
  });
  it("refuses a RIFF whose declared size is wrong, and text smuggled in a PNG header position", () => {
    const w = webpL(4, 4);
    w[4] = (w[4] ?? 0) + 1;
    expect(sniffAsset(u8(w)).ok).toBe(false);
    expect(sniffAsset(u8([...txt("<svg>"), ...png(4, 4)])).ok).toBe(false);
  });
  it("refuses every truncation of every fixture", () => {
    for (const f of [png(4, 4), jpeg(4, 4), gif(4, 4), webpL(4, 4), wav(), ogg()]) {
      for (let n = 0; n < f.length; n++) expect(sniffAsset(u8(f.slice(0, n))).ok, `length ${n} of ${f.length}`).toBe(false);
    }
    expect(sniffAsset(u8([0xff, 0xfb, 0x90])).ok).toBe(false);
  });
  it("refuses a file over 5 MiB, even with valid magic bytes", () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(png(4, 4));
    expect(sniffAsset(big).ok).toBe(false);
  });
  it("refuses images over 4096 px per side and zero-sized images, from the header", () => {
    expect(sniffAsset(u8(png(MAX_IMAGE_SIDE + 1, 8))).ok).toBe(false);
    expect(sniffAsset(u8(png(8, MAX_IMAGE_SIDE + 1))).ok).toBe(false);
    expect(sniffAsset(u8(png(0, 8))).ok).toBe(false);
    expect(sniffAsset(u8(jpeg(5000, 8))).ok).toBe(false);
    expect(sniffAsset(u8(gif(8, 5000))).ok).toBe(false);
    expect(sniffAsset(u8(webpL(8192, 8))).ok).toBe(false);
    expect(sniffAsset(u8(png(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))).ok).toBe(true);
  });
  it("ignores the file name: wrong extension changes nothing, SVG named .png is still refused", () => {
    // sniffAsset takes bytes only; the same bytes give the same decision whatever they are called.
    expect(sniffAsset(u8(png(4, 4)))).toMatchObject({ ok: true, type: "png" });
    expect(sniffAsset(svg).ok).toBe(false);
  });
  it("never throws on random bytes", () => {
    let s = 12345;
    for (let i = 0; i < 300; i++) {
      const b = new Uint8Array(1 + (i % 90));
      for (let j = 0; j < b.length; j++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        b[j] = s >>> 24;
      }
      if (i % 3 === 0) b.set(png(4, 4).slice(0, Math.min(b.length, 12)));
      expect(() => sniffAsset(b)).not.toThrow();
    }
  });
});

describe("limits", () => {
  it("enforces count, per-file and per-project totals", () => {
    expect(checkAddLimits({ count: 0, totalBytes: 0 }, 1).ok).toBe(true);
    expect(checkAddLimits({ count: 0, totalBytes: 0 }, MAX_FILE_BYTES).ok).toBe(true);
    expect(checkAddLimits({ count: 0, totalBytes: 0 }, MAX_FILE_BYTES + 1).ok).toBe(false);
    expect(checkAddLimits({ count: MAX_ASSETS - 1, totalBytes: 0 }, 1).ok).toBe(true);
    expect(checkAddLimits({ count: MAX_ASSETS, totalBytes: 0 }, 1).ok).toBe(false);
    expect(checkAddLimits({ count: 1, totalBytes: MAX_PROJECT_BYTES - 10 }, 10).ok).toBe(true);
    expect(checkAddLimits({ count: 1, totalBytes: MAX_PROJECT_BYTES - 10 }, 11).ok).toBe(false);
  });
  it("fails closed on invalid numbers", () => {
    expect(checkAddLimits({ count: 0, totalBytes: 0 }, 0).ok).toBe(false);
    expect(checkAddLimits({ count: 0, totalBytes: 0 }, Number.NaN).ok).toBe(false);
    expect(checkAddLimits({ count: -1, totalBytes: 0 }, 5).ok).toBe(false);
    expect(checkDimensions(1.5, 2).ok).toBe(false);
    expect(checkDimensions(Number.NaN, 2).ok).toBe(false);
  });
  it("vetAsset refuses a valid image when the project is full, and accepts it otherwise", () => {
    const b = u8(png(4, 4));
    expect(vetAsset(b, { count: MAX_ASSETS, totalBytes: 0 }).ok).toBe(false);
    expect(vetAsset(b, { count: 0, totalBytes: MAX_PROJECT_BYTES }).ok).toBe(false);
    expect(vetAsset(b, { count: 0, totalBytes: 0 }).ok).toBe(true);
  });
});
