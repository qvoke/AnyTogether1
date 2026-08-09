import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const notificationScript = path.join(scriptDirectory, "notify-chat.ahk");
const reportPath = path.resolve(projectDirectory, ".notes", "build-codex", "e2e-report.json");

export default class E2ENotifyReporter {
  onEnd(result) {
    if (!existsSync(notificationScript)) {
      return;
    }

    const runId = process.env.E2E_RUN_ID || `e2e-${Date.now()}`;
    const exitCode = result.status === "passed" ? "0" : "1";
    const autoHotkeyExecutable = process.env.AUTOHOTKEY_EXE || "AutoHotkey64.exe";
    const notifier = spawn(autoHotkeyExecutable, [notificationScript, runId, reportPath, exitCode], {
      cwd: projectDirectory,
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
    notifier.unref();
  }
}
