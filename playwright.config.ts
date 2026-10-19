import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: '.private/playwright',
  reporter: 'list',
  workers: process.env.XHALF_DAT ? 1 : undefined,
  use: {
    baseURL: 'http://127.0.0.1:4173/xhalf-hle/',
    trace: 'off',
    launchOptions: {
      executablePath: process.env.XHALF_BROWSER_EXECUTABLE,
      args: process.env.XHALF_BROWSER_NO_TRAP
        ? ['--js-flags=--no-wasm-trap-handler']
        : [],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'npm run preview -- --port 4173',
      url: 'http://127.0.0.1:4173/xhalf-hle/',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev -- --port 5173',
      url: 'http://127.0.0.1:5173/xhalf-hle/',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
