import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/__tests__/**/*.test.{js,ts}", "src/__tests__/**/*.test.ts"],
  },
});
