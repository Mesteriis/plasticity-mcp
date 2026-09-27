import { defineConfig, devices } from "playwright/test";
import { resolve } from "node:path";

const e2eProjectsRoot = resolve("test-results/workbench-data");

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4317", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "tablet", use: { ...devices["Desktop Chrome HiDPI"], viewport: { width: 1024, height: 1366 }, hasTouch: true } },
  ],
  webServer: {
    command: "npm --prefix .. run start:workbench",
    url: "http://127.0.0.1:4317/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { WORKBENCH_PROJECTS_ROOT: e2eProjectsRoot },
  },
});
