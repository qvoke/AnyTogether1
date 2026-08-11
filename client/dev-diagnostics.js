const REPORT_STORAGE_KEY = "anytogether:manual-diagnostics";
const SAMPLE_INTERVAL_MS = 1_000;
const MAX_ITEMS = 1_000;
const REPORT_VERSION = 2;
const OMITTED_DIAGNOSTIC_TYPES = new Set(["clock", "delivery", "sync"]);

if (import.meta.env.DEV) {
  let report = loadReport() || createReport();
  let diagnosticKeys = createItemKeys(report.diagnostics);
  let playbackEventKeys = createItemKeys(report.playbackEvents);
  let bufferedRangesKey = findLastBufferedRangesKey();
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
      context: {
        roomId: null,
        media: null
      },
      lifecycle: [],
      messages: [],
      samples: [],
      diagnostics: [],
      playbackEvents: [],
      errors: []
    };
  }

  function loadReport() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(REPORT_STORAGE_KEY) || "null");
      if (stored?.version !== REPORT_VERSION || !Array.isArray(stored.samples)) {
        return null;
      }
      return stored;
    } catch {
      return null;
    }
  }

  function findLastBufferedRangesKey() {
    for (let index = report.samples.length - 1; index >= 0; index -= 1) {
      const ranges = report.samples[index].bufferedRanges;
      if (ranges) {
        return JSON.stringify(ranges);
      }
    }
    return "";
  }

  function itemKey(item) {
    return JSON.stringify([
      item?.at,
      item?.type,
      item?.title,
      item?.reason,
      item?.version,
      item?.currentTime,
      item?.details,
      item?.fatal
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

  function mergeUnique(target, items, keys, predicate) {
    const startedAtMs = Date.parse(report.startedAt);
    for (const item of Array.isArray(items) ? items : []) {
      if (!Number.isFinite(item?.at) || item.at < startedAtMs || !predicate(item)) {
        continue;
      }
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
      report.samples.splice(0, Math.ceil(report.samples.length / 2));
      report.diagnostics.splice(0, Math.ceil(report.diagnostics.length / 2));
      report.playbackEvents.splice(0, Math.ceil(report.playbackEvents.length / 2));
      try {
        sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(report));
      } catch {}
    }
  }

  function finiteRounded(value, digits = 3) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
  }

  function collectSample(reason = "interval") {
    const pipeline = window.__getPlaybackPipelineState?.() ?? null;
    const interfaceState = window.__getInterfaceMediaState?.() ?? null;
    if (pipeline) {
      const ranges = (pipeline.bufferedRanges || []).map((range) => ({
        start: finiteRounded(range.start),
        end: finiteRounded(range.end)
      }));
      const nextBufferedRangesKey = JSON.stringify(ranges);
      const sample = {
        at: Date.now(),
        reason,
        version: pipeline.version,
        roomPositionSec: finiteRounded(pipeline.positionSec),
        localPositionSec: finiteRounded(pipeline.localPositionSec),
        syncErrorMs: pipeline.syncErrorMs,
        readyState: pipeline.readyState,
        networkState: pipeline.networkState,
        authoritativePaused: pipeline.paused,
        localPaused: pipeline.localPaused,
        seeking: pipeline.seeking,
        hlsBuffering: pipeline.hlsBuffering,
        correctionVersion: pipeline.hlsCorrection?.version ?? null,
        awaitingPlayback: pipeline.hlsCorrection?.awaitingPlayback ?? false,
        currentLevel: pipeline.hlsCurrentLevel,
        loadLevel: pipeline.hlsLoadLevel,
        nextLoadLevel: pipeline.hlsNextLoadLevel,
        bandwidthEstimate: pipeline.hlsBandwidthEstimate,
        roundTripMs: pipeline.roundTripMs,
        clockOffsetMs: pipeline.clockOffsetMs
      };
      if (nextBufferedRangesKey !== bufferedRangesKey) {
        sample.bufferedRanges = ranges;
        bufferedRangesKey = nextBufferedRangesKey;
      }
      append(report.samples, sample);
      report.context.roomId = pipeline.roomId || report.context.roomId;
    }
    if (interfaceState) {
      report.context.media = redact(interfaceState);
    }
    mergeUnique(
      report.diagnostics,
      window.__getSyncDiagnostics?.(),
      diagnosticKeys,
      (item) => !OMITTED_DIAGNOSTIC_TYPES.has(item.type)
    );
    mergeUnique(report.playbackEvents, window.__getPlaybackEvents?.(), playbackEventKeys, () => true);
    persistReport();
    updateStatus();
  }

  function resetReport(reason) {
    report = createReport();
    diagnosticKeys = new Set();
    playbackEventKeys = new Set();
    bufferedRangesKey = "";
    append(report.lifecycle, { at: new Date().toISOString(), type: reason });
    collectSample("reset");
  }

  function reportFilename() {
    const roomId = window.__getPlaybackPipelineState?.()?.roomId || "no-room";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `anytogether-log-${roomId}-${timestamp}.json`;
  }

  function downloadReport() {
    collectSample("download");
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
    statusElement.textContent = `${elapsedSec}s · ${report.diagnostics.length} events · ${report.playbackEvents.length} media`;
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
  window.addEventListener("pagehide", () => collectSample("pagehide"));
  const diagnosticsApi = {
    download: downloadReport,
    getReport: () => redact(report),
    reset: () => resetReport("api-reset"),
    snapshot: () => collectSample("manual")
  };
  Object.defineProperty(diagnosticsApi, "runId", { get: () => report.runId });
  window.__anyTogetherDiagnostics = diagnosticsApi;
  installToolbar();
  collectSample("start");
  window.setInterval(() => collectSample("interval"), SAMPLE_INTERVAL_MS);
}
