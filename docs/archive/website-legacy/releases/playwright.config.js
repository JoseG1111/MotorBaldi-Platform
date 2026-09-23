import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: '**/*.spec.js',
  timeout: 45000,
  expect: { timeout: 6000 },
  fullyParallel: true,
  workers: 3,
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.QA_REPORT || "docs/qa/results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command: "node scripts/serve.mjs dist",
    port: 5174,
    env: { PORT: "5174" },
    reuseExistingServer: false,
  },
});
