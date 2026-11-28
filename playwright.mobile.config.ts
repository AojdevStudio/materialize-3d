import { defineConfig } from '@playwright/test'
import { createServer } from 'node:net'

// The phone and tablet layout tests run against the production mobile window build, as the iOS app loads it, with
// Rust and the paired computer faked inside the page. jsdom has no layout, so these are the tests that see the screen.
// The preview takes a port the system says is free, so runs in other worktrees on one host never collide. Workers load
// this file again, and they inherit the environment, so they read the same port.
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('No port was given.'))))
    })
  })
process.env.M3D_MOBILE_PORT ??= String(await freePort())
const port = Number(process.env.M3D_MOBILE_PORT)

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
