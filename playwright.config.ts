// Minimal Playwright config for perf baseline runs.
// Run with: npx playwright test
// Prereqs: dev server (npm run dev) + backend (npm run server) running.

import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  reporter: [["list"]],
});
