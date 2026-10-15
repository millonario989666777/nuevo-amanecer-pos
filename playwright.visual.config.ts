import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4183',
    serviceWorkers: 'block',
    timezoneId: 'America/Lima',
    locale: 'es-PE',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npx --yes http-server POS -p 4183 -c-1 --silent',
    url: 'http://127.0.0.1:4183/index.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
