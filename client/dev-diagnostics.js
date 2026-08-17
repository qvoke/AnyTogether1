const REPORT_STORAGE_KEY = "anytogether:manual-diagnostics";
const SAMPLE_INTERVAL_MS = 1_000;
const MAX_ITEMS = 1_000;
const REPORT_VERSION = 7;
const OMITTED_DIAGNOSTIC_TYPES = new Set(["clock", "delivery", "sync"]);
const SAMPLE_FIELDS = [
  "elapsedMs",
  "version",
  "roomPositionMs",
  "localPositionMs",
  "syncErrorMs",
  "readyState",
  "networkState",
  "flags",
  "currentLevel",
  "loadLevel",
  "nextLoadLevel",
  "bandwidthKbps",
  "roundTripMs",
  "clockOffsetMs",
  "playbackRatePermille"
];
const SAMPLE_FLAGS = {
  authoritativePaused: 1,
  localPaused: 2,
  seeking: 4,
  hlsBuffering: 8
};
const PLAYBACK_EVENT_FIELDS = ["elapsedMs", "type", "positionMs", "readyState", "flags"];
const PLAYBACK_EVENT_FLAGS = { paused: 1, muted: 2 };
const BUFFER_CHANGE_FIELDS = ["elapsedMs", "rangesMs"];

if (import.meta.env.DEV) {
  let report = loadReport() || createReport();
  let diagnosticKeys = createItemKeys(report.diagnostics);
  let playbackEventKeys = createItemKeys(report.playbackEvents);
  let bufferedRangesKey = findLastBufferedRangesKey();
  let statusElement = null;

  function redactUrl(value) {
    try {
      const url = new URL(value);
      return `${url.origin}/[redacted-path]`;
    } catch {
      return "[redacted-url]";
    }
  }

  function redact(value, key = "") {
    if (typeof value === "string") {
      if (/url|uri|href|source|playlist|media/i.test(key) || /^https?:\/\//i.test(value)) {
        return redactUrl(value);
      }
      return value.replace(/https?:\/\/[^\s"']+/gi, (url) => redactUrl(url));
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
        userAgent: navigator.userAgent
      },
      context: { roomId: null, media: null },
      sampleFields: SAMPLE_FIELDS,
      sampleFlags: SAMPLE_FLAGS,
      samples: [],
      bufferChangeFields: BUFFER_CHANGE_FIELDS,
      bufferChanges: [],
      playbackEventFields: PLAYBACK_EVENT_FIELDS,
      playbackEventFlags: PLAYBACK_EVENT_FLAGS,
      playbackEvents: [],
      diagnostics: [],
      lifecycle: [],
      messages: [],
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
    const lastChange = report.bufferChanges.at(-1);
    return lastChange ? JSON.stringify(lastChange[1]) : "";
  }

  function elapsedMs(at = Date.now()) {
    return Math.max(0, Math.round(Number(at) - Date.parse(report.startedAt)));
  }

  function positionMs(value) {
    return Number.isFinite(value) ? Math.round(value * 1_000) : null;
  }

  function integer(value, scale = 1) {
    return Number.isFinite(value) ? Math.round(value / scale) : null;
  }

  function itemKey(item) {
    return JSON.stringify(item);
  }

  function createItemKeys(items) {
    return new Set((Array.isArray(items) ? items : []).map(itemKey));
  }

  function append(target, value) {
    target.push(value);
    if (target.length > MAX_ITEMS) {
      target.splice(0, target.length - MAX_ITEMS);
    }
  }

  function fragmentIdentity(fragment) {
    if (!fragment) {
      return null;
    }
    let host = null;
    try {
      const url = new URL(fragment.url);
      host = url.host;
    } catch {}
    return [
      host,
      fragment.level ?? null,
      fragment.sequenceNumber ?? null,
      positionMs(fragment.start),
      positionMs(fragment.duration)
    ];
  }

  function compactDiagnostic(item) {
    const time = elapsedMs(item.at);
    if (item.type === "action-sent") {
      return { t: time, type: "action", action: item.actionType, version: item.knownVersion };
    }
    if (item.type === "hls-error") {
      return {
        t: time,
        type: "hls-error",
        detail: item.details,
        fatal: item.fatal,
        category: item.errorType,
        status: item.response?.code ?? null,
        fragment: fragmentIdentity(item.fragment),
        retry: item.recovery
          ? [item.recovery.retryCount ?? null, item.recovery.action ?? null, item.recovery.flags ?? null]
          : null,
        hls: item.hlsState
          ? [
              item.hlsState.currentLevel ?? null,
              item.hlsState.loadLevel ?? null,
              item.hlsState.nextLoadLevel ?? null,
              integer(item.hlsState.bandwidthEstimate, 1_000)
            ]
          : null
      };
    }
    if (item.type === "hls-fragment-loaded") {
      return {
        t: time,
        type: "hls-loaded",
        fragment: fragmentIdentity(item.fragment),
        loadedBytes: integer(item.loadedBytes),
        loadMs: integer(item.loadMs)
      };
    }
    if (item.type === "event" && /activation|error|failed|recover|restart|unsupported/i.test(item.title || "")) {
      return { t: time, type: "event", title: item.title, detail: redact(item.detail) };
    }
    return null;
  }

  function mergeDiagnostics(items) {
    const startedAtMs = Date.parse(report.startedAt);
    for (const item of Array.isArray(items) ? items : []) {
      if (!Number.isFinite(item?.at) || item.at < startedAtMs || OMITTED_DIAGNOSTIC_TYPES.has(item.type)) {
        continue;
      }
      const compact = compactDiagnostic(item);
      if (!compact) {
        continue;
      }
      const key = itemKey(compact);
      if (diagnosticKeys.has(key)) {
        continue;
      }
      diagnosticKeys.add(key);
      append(report.diagnostics, compact);
    }
  }

  function mergePlaybackEvents(items) {
    const startedAtMs = Date.parse(report.startedAt);
    for (const item of Array.isArray(items) ? items : []) {
      if (!Number.isFinite(item?.at) || item.at < startedAtMs) {
        continue;
      }
      const flags = (item.paused ? PLAYBACK_EVENT_FLAGS.paused : 0) |
        (item.muted ? PLAYBACK_EVENT_FLAGS.muted : 0);
      const compact = [
        elapsedMs(item.at),
        item.type,
        positionMs(item.currentTime),
        item.readyState,
        flags
      ];
      const key = itemKey(compact);
      if (playbackEventKeys.has(key)) {
        continue;
      }
      playbackEventKeys.add(key);
      append(report.playbackEvents, compact);
    }
  }

  function persistReport() {
    try {
      sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(report));
    } catch {
      report.samples.splice(0, Math.ceil(report.samples.length / 2));
      report.bufferChanges.splice(0, Math.ceil(report.bufferChanges.length / 2));
      report.diagnostics.splice(0, Math.ceil(report.diagnostics.length / 2));
      report.playbackEvents.splice(0, Math.ceil(report.playbackEvents.length / 2));
      try {
        sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(report));
      } catch {}
    }
  }

  function sampleFlags(pipeline) {
    return (pipeline.paused ? SAMPLE_FLAGS.authoritativePaused : 0) |
      (pipeline.localPaused ? SAMPLE_FLAGS.localPaused : 0) |
      (pipeline.seeking ? SAMPLE_FLAGS.seeking : 0) |
      (pipeline.hlsBuffering ? SAMPLE_FLAGS.hlsBuffering : 0);
  }

  function collectSample() {
    const pipeline = window.__getPlaybackPipelineState?.() ?? null;
    const interfaceState = window.__getInterfaceMediaState?.() ?? null;
    if (pipeline) {
      const time = elapsedMs();
      append(report.samples, [
        time,
        pipeline.version,
        positionMs(pipeline.positionSec),
        positionMs(pipeline.localPositionSec),
        integer(pipeline.syncErrorMs),
        pipeline.readyState,
        pipeline.networkState,
        sampleFlags(pipeline),
        pipeline.hlsCurrentLevel,
        pipeline.hlsLoadLevel,
        pipeline.hlsNextLoadLevel,
        integer(pipeline.hlsBandwidthEstimate, 1_000),
        integer(pipeline.roundTripMs),
        integer(pipeline.clockOffsetMs),
        integer(pipeline.localPlaybackRate, 0.001)
      ]);
      const ranges = (pipeline.bufferedRanges || []).flatMap((range) => [
        positionMs(range.start),
        positionMs(range.end)
      ]);
      const nextBufferedRangesKey = JSON.stringify(ranges);
      if (nextBufferedRangesKey !== bufferedRangesKey) {
        append(report.bufferChanges, [time, ranges]);
        bufferedRangesKey = nextBufferedRangesKey;
      }
      report.context.roomId = pipeline.roomId || report.context.roomId;
    }
    if (interfaceState) {
      report.context.media = redact(interfaceState);
    }
    mergeDiagnostics(window.__getSyncDiagnostics?.());
    mergePlaybackEvents(window.__getPlaybackEvents?.());
    persistReport();
    updateStatus();
  }

  function resetReport(reason) {
    report = createReport();
    diagnosticKeys = new Set();
    playbackEventKeys = new Set();
    bufferedRangesKey = "";
    append(report.lifecycle, [0, reason]);
    collectSample();
  }

  function reportFilename() {
    const roomId = window.__getPlaybackPipelineState?.()?.roomId || "no-room";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `anytogether-log-${roomId}-${timestamp}.json`;
  }

  function downloadReport() {
    collectSample();
    const payload = JSON.stringify({ ...report, downloadedAt: new Date().toISOString() });
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
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
    const elapsedSec = Math.floor(elapsedMs() / 1_000);
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
    append(report.messages, [elapsedMs(), data.type, redact(data.payload ?? data)]);
  }

  function collectError(event) {
    append(report.errors, [elapsedMs(), "error", event.message, event.lineno, event.colno]);
    persistReport();
  }

  function collectRejection(event) {
    append(report.errors, [elapsedMs(), "unhandledrejection", String(event.reason)]);
    persistReport();
  }

  append(report.lifecycle, [elapsedMs(), "page-load"]);
  window.addEventListener("message", collectMessage);
  window.addEventListener("error", collectError);
  window.addEventListener("unhandledrejection", collectRejection);
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      downloadReport();
    }
  });
  window.addEventListener("pagehide", collectSample);
  const diagnosticsApi = {
    download: downloadReport,
    getReport: () => report,
    reset: () => resetReport("api-reset"),
    snapshot: collectSample
  };
  Object.defineProperty(diagnosticsApi, "runId", { get: () => report.runId });
  window.__anyTogetherDiagnostics = diagnosticsApi;
  installToolbar();
  collectSample();
  window.setInterval(collectSample, SAMPLE_INTERVAL_MS);
}
