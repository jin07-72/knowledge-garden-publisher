import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    pool: "forks",
    setupFiles: ["@testing-library/jest-dom/vitest"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "tests/e2e/**"],
  },
})
