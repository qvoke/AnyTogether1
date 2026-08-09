import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const playwrightCli = path.join(projectDirectory, "node_modules", "@playwright", "test", "cli.js");
const notificationScript = path.join(scriptDirectory, "notify-chat.ahk");
const reportPath = path.resolve(projectDirectory, ".notes", "build-codex", "e2e-report.json");
const testArguments = [playwrightCli, "test", ...process.argv.slice(2)];

function runTests() {
  return new Promise((resolve) => {
    const testProcess = spawn(process.execPath, testArguments, {
      cwd: projectDirectory,
      env: process.env,
      stdio: "inherit"
    });

    testProcess.once("error", (error) => {
      console.error(`Unable to start Playwright: ${error.message}`);
      resolve(1);
    });
    testProcess.once("close", (code, signal) => {
      resolve(typeof code === "number" ? code : signal ? 1 : 1);
    });
  });
}

function notifyChat(exitCode) {
  return new Promise((resolve) => {
    if (!existsSync(notificationScript)) {
      console.warn(`Notification script not found: ${notificationScript}`);
      resolve();
      return;
    }

    const runId = process.env.E2E_RUN_ID || `e2e-${Date.now()}`;
    const autoHotkeyExecutable = process.env.AUTOHOTKEY_EXE || "AutoHotkey64.exe";
    const notifier = spawn(autoHotkeyExecutable, [notificationScript, runId, reportPath, String(exitCode)], {
      cwd: projectDirectory,
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
    notifier.unref();
    resolve();
  });
}

const exitCode = await runTests();
await notifyChat(exitCode);
process.exitCode = exitCode;
