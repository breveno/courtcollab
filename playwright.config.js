// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',

  // Run tests sequentially — payment flows share server state and Stripe mocks
  fullyParallel: false,
  workers: 1,

  timeout: 30_000,           // per-test timeout
  retries: process.env.CI ? 2 : 0,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    baseURL: 'http://localhost:3457',
    headless: true,
    screenshot: 'only-on-failure',
    video:      'retain-on-failure',
    trace:      'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Spin up the static file server automatically before running tests.
  // serve.py uses PORT env var (default 3456) and serves the project root.
  webServer: {
    command: 'PORT=3457 python3 serve.py',
    url:     'http://localhost:3457',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
