import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Static output only. base "./" keeps the build host-agnostic (Vercel or any static server).
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
