import { defineConfig, devices } from "@playwright/test";

// Tests run against the production build served under a subpath, which also proves
// SITE_BASE works: every asset and link must resolve below /materialize-3d/.
const base = "/materialize-3d/";
const port = 4173;

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}${base}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `bun run build && bunx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    env: { SITE_BASE: base },
    url: `http://127.0.0.1:${port}${base}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
