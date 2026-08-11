const REPORT_STORAGE_KEY = "anytogether:manual-diagnostics";
const SNAPSHOT_INTERVAL_MS = 1_000;
const MAX_ITEMS = 1_000;
const REPORT_VERSION = 1;

if (import.meta.env.DEV) {
  let report = loadReport() || createReport();
  let syncDiagnosticKeys = createItemKeys(report.syncDiagnostics);
  let playbackEventKeys = createItemKeys(report.playbackEvents);
  let statusElement = null;

  function redactUrl(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
    } catch {
      return String(value).replace(/[?].*$/, "?[redacted]");
    }
  }

  function redact(value, key = "") {
    if (typeof value === "string") {
      return /url|uri|href|source|playlist|media/i.test(key) ? redactUrl(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => redact(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
    }
    return value;
  }

  function createReport() {
    return {
      version: REPORT_VERSION,
      runId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      page: {
        href: redactUrl(window.location.href),
        origin: window.location.origin,
        userAgent: navigator.userAgent
      },
      lifecycle: [],
      messages: [],
      snapshots: [],
      syncDiagnostics: [],
      playbackEvents: [],
      errors: []
    };
  }

  function loadReport() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(REPORT_STORAGE_KEY) || "null");
      if (stored?.version !== REPORT_VERSION || !Array.isArray(stored.snapshots)) {
        return null;
      }
      return stored;
    } catch {
      return null;
    }
  }

  function itemKey(item) {
    return JSON.stringify([
      item?.at,
      item?.type,
      item?.title,
      item?.reason,
      item?.version,
      item?.currentTime
    ]);
  }

  function createItemKeys(items) {
    return new Set((Array.isArray(items) ? items : []).map(itemKey));
  }

  function append(target, value) {
    target.push(redact(value));
    if (target.length > MAX_ITEMS) {
      target.splice(0, target.length - MAX_ITEMS);
    }
  }

  function mergeUnique(target, items, keys) {
    for (const item of Array.isArray(items) ? items : []) {
      const key = itemKey(item);
      if (keys.has(key)) {
        continue;
      }
      keys.add(key);
      append(target, item);
    }
  }

  function persistReport() {
    try {
      sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(report));
    } catch {
      report.snapshots.splice(0, Math.ceil(report.snapshots.length / 2));
      report.syncDiagnostics.splice(0, Math.ceil(report.syncDiagnostics.length / 2));
      report.playbackEvents.splice(0, Math.ceil(report.playbackEvents.length / 2));
      try {
        sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(report));
      } catch {}
    }
  }

  function collectSnapshot(reason = "interval") {
    const pipeline = window.__getPlaybackPipelineState?.() ?? null;
    const interfaceState = window.__getInterfaceMediaState?.() ?? null;
    append(report.snapshots, {
      at: new Date().toISOString(),
      reason,
      pipeline,
      interfaceState
    });
    mergeUnique(report.syncDiagnostics, window.__getSyncDiagnostics?.(), syncDiagnosticKeys);
    mergeUnique(report.playbackEvents, window.__getPlaybackEvents?.(), playbackEventKeys);
    persistReport();
    updateStatus();
  }

  function resetReport(reason) {
    report = createReport();
    syncDiagnosticKeys = new Set();
    playbackEventKeys = new Set();
    append(report.lifecycle, { at: new Date().toISOString(), type: reason });
    collectSnapshot("reset");
  }

  function reportFilename() {
    const roomId = window.__getPlaybackPipelineState?.()?.roomId || "no-room";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `anytogether-log-${roomId}-${timestamp}.json`;
  }

  function downloadReport() {
    collectSnapshot("download");
    const payload = JSON.stringify({ ...report, downloadedAt: new Date().toISOString() }, null, 2);
    const url = URL.createObjectURL(new Blob([`${payload}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reportFilename();
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    resetReport("download-complete");
  }

  function updateStatus() {
    if (!statusElement) {
      return;
    }
    const elapsedSec = Math.max(0, Math.round((Date.now() - Date.parse(report.startedAt)) / 1_000));
    statusElement.textContent = `${elapsedSec}s · ${report.syncDiagnostics.length} sync · ${report.playbackEvents.length} media`;
  }

  function createButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "border:1px solid #475569;border-radius:6px;padding:5px 8px;background:#1e293b;color:#f8fafc;font:12px/1.2 system-ui;cursor:pointer";
    button.addEventListener("click", action);
    return button;
  }

  function installToolbar() {
    const toolbar = document.createElement("aside");
    toolbar.setAttribute("aria-label", "Development diagnostics");
    toolbar.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:2147483647;display:flex;align-items:center;gap:6px;padding:7px;border:1px solid #334155;border-radius:9px;background:rgba(15,23,42,.94);box-shadow:0 6px 24px rgba(0,0,0,.35);color:#cbd5e1";
    statusElement = document.createElement("span");
    statusElement.style.cssText = "padding:0 4px;font:11px/1.2 system-ui;white-space:nowrap";
    toolbar.append(
      statusElement,
      createButton("Download + new log", downloadReport),
      createButton("New log", () => resetReport("manual-reset"))
    );
    document.body.appendChild(toolbar);
    updateStatus();
  }

  function collectMessage(event) {
    const data = event.data;
    if (!data?.type || !data.type.startsWith("WT_")) {
      return;
    }
    append(report.messages, {
      at: new Date().toISOString(),
      type: data.type,
      payload: data.payload ?? data
    });
  }

  function collectError(event) {
    append(report.errors, {
      at: new Date().toISOString(),
      type: "error",
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno
    });
    persistReport();
  }

  function collectRejection(event) {
    append(report.errors, {
      at: new Date().toISOString(),
      type: "unhandledrejection",
      reason: String(event.reason)
    });
    persistReport();
  }

  append(report.lifecycle, {
    at: new Date().toISOString(),
    type: "page-load",
    href: redactUrl(window.location.href)
  });
  window.addEventListener("message", collectMessage);
  window.addEventListener("error", collectError);
  window.addEventListener("unhandledrejection", collectRejection);
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      downloadReport();
    }
  });
  window.addEventListener("pagehide", () => collectSnapshot("pagehide"));
  const diagnosticsApi = {
    download: downloadReport,
    getReport: () => redact(report),
    reset: () => resetReport("api-reset"),
    snapshot: () => collectSnapshot("manual")
  };
  Object.defineProperty(diagnosticsApi, "runId", { get: () => report.runId });
  window.__anyTogetherDiagnostics = diagnosticsApi;
  installToolbar();
  collectSnapshot("start");
  window.setInterval(() => collectSnapshot("interval"), SNAPSHOT_INTERVAL_MS);
}
