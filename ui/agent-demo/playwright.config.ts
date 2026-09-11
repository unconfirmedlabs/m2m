import { defineConfig } from 'playwright/test';
import { existsSync } from 'node:fs';

const cachedChromium = '/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    ...(existsSync(cachedChromium) ? { launchOptions: { executablePath: cachedChromium } } : {}),
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    port: 4173,
    reuseExistingServer: false,
  },
});
