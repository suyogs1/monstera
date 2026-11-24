// Browser image decoding for the atlas builder: bytes -> RGBA pixels through the platform decoder and a 2D canvas.
// Canvas pixels are not premultiplied-exact for semi-transparent edges; fully opaque and fully transparent pixels are exact.
import type { RgbaImage } from "./png";

export type DecodeImage = (bytes: Uint8Array) => Promise<RgbaImage>;

export const decodeImage: DecodeImage = async (bytes) => {
  const bitmap = await createImageBitmap(new Blob([bytes.slice()]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("the browser cannot read image pixels");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: data.width, height: data.height, data: data.data };
  } finally { bitmap.close(); }
};
