// Browser-side probes for asset import (design section 8: decode in createImageBitmap with try/catch; assets only ever reach
// the page as blob: URLs, never autoplay). Each probe exists only where the browser API does, so a missing API means that check
// is unavailable (OGG and MP3 are then refused by planImport), never silently passed. Not unit-testable without a browser; the
// plan logic that uses them is tested with injected stand-ins.
import type { ImportDeps } from "./import";
const AUDIO_PROBE_TIMEOUT_MS = 5000;
export function browserProbes(): ImportDeps {
  const out: { -readonly [K in keyof ImportDeps]: ImportDeps[K] } = {};
  if (typeof createImageBitmap === "function") {
    out.decodeImage = async (bytes, mime) => {
      try {
        const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
      } catch {
        return null;
      }
    };
  }
  if (typeof Audio === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    out.probeAudioMs = (bytes, mime) => new Promise<number | null>((resolve) => {
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
      const el = new Audio();
      let done = false;
      const finish = (v: number | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeAttribute("src");
        URL.revokeObjectURL(url);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), AUDIO_PROBE_TIMEOUT_MS);
      el.preload = "metadata";
      el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null);
      el.onerror = () => finish(null);
      el.src = url;
    });
  }
  return out;
}
