import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { SITE_URL, THEME_KEY } from "./src/site.ts";

/**
 * SITE_BASE sets the public path when the host serves the site under a subpath,
 * e.g. `SITE_BASE=/materialize-3d/ bun run build`. Unset means the site lives at `/`.
 */
export function siteBase(raw = process.env.SITE_BASE): string {
  const trimmed = raw?.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

/** The app's own brand mark, font, and icons. The site uses the files the app ships, not copies. */
const appAssets = path.resolve(import.meta.dirname, "../src/assets");

/**
 * Writes the site's address and the theme key from src/site.ts into each page, robots.txt, and sitemap.xml, and
 * points each page's favicon at the app's assets. The dev server serves files outside the site under /@fs.
 */
function siteFacts(): Plugin {
  const prePaint = `try { if (localStorage.getItem(${JSON.stringify(THEME_KEY)}) === "dark") document.documentElement.dataset.theme = "dark"; } catch {}`;
  const pages = ["", "privacy"].map((page) => `  <url>\n    <loc>${SITE_URL}${page}</loc>\n  </url>\n`).join("");
  const files: Record<string, string> = {
    "robots.txt": `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`,
    "sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages}</urlset>\n`,
  };
  return {
    name: "site-facts",
    transformIndexHtml: {
      order: "pre",
      handler: (html, { server }) => ({
        html: html
          .replaceAll("%SITE_URL%", SITE_URL)
          .replaceAll("%APP_ASSETS%", server ? `/@fs${appAssets}` : path.relative(import.meta.dirname, appAssets)),
        tags: [{ tag: "script", children: prePaint, injectTo: "head" }],
      }),
    },
    configureServer(server) {
      for (const [fileName, source] of Object.entries(files)) {
        server.middlewares.use(`${server.config.base}${fileName}`, (_request, response) => {
          response.setHeader("Content-Type", fileName.endsWith(".xml") ? "application/xml" : "text/plain");
          response.end(source);
        });
      }
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(files)) this.emitFile({ type: "asset", fileName, source });
    },
  };
}

export default defineConfig({
  base: siteBase(),
  plugins: [react(), siteFacts()],
  resolve: { alias: { "@app": appAssets } },
  server: { fs: { allow: [import.meta.dirname, appAssets] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // privacy.html builds to dist/privacy.html, which the host serves at /privacy.
    rolldownOptions: { input: { index: "index.html", privacy: "privacy.html" } },
  },
});
