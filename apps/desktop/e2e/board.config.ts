import { defineConfig } from "@playwright/test";

const baseURL = `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`;

export default defineConfig({
  testDir: ".",
  testMatch: "board.spec.ts",
  outputDir: "../test-results/board",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: { baseURL },
  webServer: {
    command: "pnpm --filter @rakazo/web dev",
    cwd: "../../..",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
