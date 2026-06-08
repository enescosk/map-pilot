import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/__tests__/**/*.test.{js,ts}", "src/__tests__/**/*.test.ts"],
    environmentMatchGlobs: [
      ["src/__tests__/**", "jsdom"],
      ["server/__tests__/**", "node"],
    ],
  },
});
