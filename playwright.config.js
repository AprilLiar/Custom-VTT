import { defineConfig, devices } from '@playwright/test';

// Mobile readiness (Change 002) §15.2: device matrix covering mobile
// Chromium, mobile WebKit (real iOS Safari uses WebKit, not Chromium — a
// Chromium-only pass would miss WebKit-specific layout/touch bugs), a
// tablet breakpoint, a landscape orientation, and the 320px minimum-width
// fallback from §14.3. Chromium-based projects pin executablePath to the
// browser this sandbox has pre-installed (see CLAUDE.md's environment
// notes) rather than the revision @playwright/test would otherwise try to
// download; WebKit has no pre-installed binary here and only runs in an
// environment with `npx playwright install webkit` — its project is still
// defined for CI/full-install environments.
const CHROMIUM_PATH = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './e2e-mobile',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'], launchOptions: { executablePath: CHROMIUM_PATH } },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'tablet',
      use: { ...devices['Galaxy Tab S4'], launchOptions: { executablePath: CHROMIUM_PATH } },
    },
    {
      name: 'mobile-landscape',
      use: { ...devices['Pixel 7 landscape'], launchOptions: { executablePath: CHROMIUM_PATH } },
    },
    {
      name: '320-fallback',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 320, height: 568 },
        launchOptions: { executablePath: CHROMIUM_PATH },
      },
    },
  ],
});
