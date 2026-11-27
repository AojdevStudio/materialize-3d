import { defineConfig } from '@playwright/test'

// The phone and tablet layout tests run against the production mobile window build, as the iOS app loads it, with
// Rust and the paired computer faked inside the page. jsdom has no layout, so these are the tests that see the screen.
// Port 4174 keeps clear of the landing site's 4173, so both can run on one host.
const port = 4174

export default defineConfig({
  testDir: 'src/mobile',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    channel: 'chrome',
    launchOptions: { chromiumSandbox: true },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  },
  webServer: {
    command: `bun run build:mobile && bunx vite preview --config vite.mobile.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
