import { defineConfig, devices } from "@playwright/test";

const externalBaseUrl = process.env.E2E_BASE_URL;
const localPort = Number(process.env.E2E_PORT || 3100);
const localBaseUrl = `http://127.0.0.1:${localPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  outputDir: ".notes/build-codex/e2e-results",
  reporter: [
    ["list"],
    ["json", { outputFile: ".notes/build-codex/e2e-report.json" }]
  ],
  timeout: 45_000,
  use: {
    baseURL: externalBaseUrl || localBaseUrl,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "npm run dev",
        env: {
          ...process.env,
          ANYTOGETHER_DATA_DIR: ".notes/build-codex/e2e-data",
          PORT: String(localPort)
        },
        reuseExistingServer: true,
        timeout: 120_000,
        url: `${localBaseUrl}/`
      }
});
