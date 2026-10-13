import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // SwiftShader WebGL is CPU-heavy; parallel workers starve each other.
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    browserName: 'chromium',
    launchOptions: {
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  // Reuses a running `npx vite --port 5180` (which the tools need too); make
  // sure it serves this checkout.
  webServer: {
    command: 'pnpm vite --port 5180',
    port: 5180,
    reuseExistingServer: true,
  },
});
