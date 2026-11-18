// Byte fixtures for asset tests (task 2.2). Imported by tests only. Each builder yields the smallest file the Task 2.1 sniffer accepts.
export const txt = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
export const u8 = (a: number[]): Uint8Array => Uint8Array.from(a);
export const png = (w: number, h: number): Uint8Array => u8([
  0x89, ...txt("PNG\r\n\x1a\n"),
  ...be32(13), ...txt("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ...be32(1), ...txt("IDAT"), 0, 0, 0, 0, 0,
  ...be32(0), ...txt("IEND"), 0, 0, 0, 0,
]);
export const jpeg = (w: number, h: number): Uint8Array => u8([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0,
  0xff, 0xda, 0, 2, 0xff, 0xd9,
]);
/** 8-bit mono WAV at 8000 Hz holding `dataBytes` bytes of samples: `dataBytes / 8` milliseconds long. */
export const wav = (dataBytes = 800): Uint8Array => {
  const body = [...txt("WAVE"), ...txt("fmt "), ...le32(16), ...le16(1), ...le16(1), ...le32(8000), ...le32(8000), ...le16(1), ...le16(8), ...txt("data"), ...le32(dataBytes), ...new Array<number>(dataBytes).fill(128)];
  return u8([...txt("RIFF"), ...le32(body.length), ...body]);
};
export const ogg = (): Uint8Array => u8([...txt("OggS"), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 30, 1, ...txt("vorbis"), ...new Array<number>(23).fill(0)]);
export const mp3 = (): Uint8Array => u8([0xff, 0xfb, 0x90, 0x00, ...new Array<number>(60).fill(0)]);
export const svg = (): Uint8Array => u8(txt('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
