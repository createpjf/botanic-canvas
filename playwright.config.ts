import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-webkit', testIgnore: /paste-media\.spec\.ts/u, use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'VITE_PERSISTENCE_MODE=local npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173/#/projects',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
