import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cachedChromium = join(
  homedir(),
  ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
);
const chromiumPath =
  process.env.MOTORBALDI_CHROMIUM_PATH ||
  (existsSync(cachedChromium) ? cachedChromium : undefined);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/browser",
  use: {
    browserName: "chromium",
    launchOptions: {
      executablePath: chromiumPath,
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm exec tsx scripts/ui/serve.ts",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec tsx scripts/ui/serve-integration.ts",
      url: "http://127.0.0.1:4183",
      reuseExistingServer: false,
      timeout: 180000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
    },
  ],
});
