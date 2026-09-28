import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * SITE_BASE sets the public path when the host serves the site under a subpath,
 * e.g. `SITE_BASE=/materialize-3d/ bun run build`. Unset means the site lives at `/`.
 */
export function siteBase(raw = process.env.SITE_BASE): string {
  const trimmed = raw?.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

export default defineConfig({
  base: siteBase(),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
