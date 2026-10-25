import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 40_000,
  expect: { timeout: 8000 },
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'msedge', viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], channel: 'msedge', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node dist-server/server/index.js',
    url: 'http://127.0.0.1:3001/api/sale',
    reuseExistingServer: false,
    env: {
      DB_PATH: resolve(`data/e2e-${process.pid}.sqlite`),
      SALE_DELAY_MS: '0', SALE_DURATION_MS: '600000', RESERVATION_TTL_MS: '10000', PORT: '3001',
    },
  },
});
