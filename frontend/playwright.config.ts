import { defineConfig } from "@playwright/test";

// e2e gets its own dev server with the API proxy aimed at a dead origin, so a
// running Forge is never touched (autosave uploads and settings writes would
// otherwise land in the real backend). Tests stub the routes they need.
const PORT = 5179;

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: `http://localhost:${PORT}/ultra_paint/app/`,
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    env: { ULTRA_PAINT_BACKEND: "http://127.0.0.1:9" },
    url: `http://localhost:${PORT}/ultra_paint/app/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
