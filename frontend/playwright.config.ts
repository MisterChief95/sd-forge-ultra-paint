import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://localhost:5173/ultra_paint/app/",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173/ultra_paint/app/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
