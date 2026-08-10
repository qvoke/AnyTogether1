const REPORT_ENDPOINT = "/__anytogether/diagnostics";
const REPORT_INTERVAL_MS = 5_000;
const MAX_ITEMS = 1_000;

if (import.meta.env.DEV) {
  const runId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const report = {
    runId,
    startedAt: new Date().toISOString(),
    page: {
      href: redactUrl(window.location.href),
      origin: window.location.origin,
      userAgent: navigator.userAgent
    },
    messages: [],
    snapshots: [],
    errors: [],
    batches: 0,
    lastSentAt: null
  };

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
      return /url|uri|source|playlist|media/i.test(key) ? redactUrl(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => redact(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
    }
    return value;
  }

  function push(target, value) {
    target.push({ at: new Date().toISOString(), value: redact(value) });
    if (target.length > MAX_ITEMS) {
      target.splice(0, target.length - MAX_ITEMS);
    }
  }

  function snapshot() {
    const pipeline = window.__getPlaybackPipelineState?.();
    if (!pipeline) {
      return;
    }
    push(report.snapshots, {
      pipeline,
      syncDiagnostics: window.__getSyncDiagnostics?.()?.slice(-20) ?? [],
      playbackEvents: window.__getPlaybackEvents?.()?.slice(-20) ?? [],
      interfaceState: window.__getInterfaceMediaState?.() ?? null
    });
  }

  function collectMessage(event) {
    const data = event.data;
    if (!data?.type || !data.type.startsWith("WT_")) {
      return;
    }
    push(report.messages, { type: data.type, payload: data.payload ?? data });
  }

  function collectError(event) {
    push(report.errors, {
      type: "error",
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno
    });
  }

  function collectRejection(event) {
    push(report.errors, { type: "unhandledrejection", reason: String(event.reason) });
  }

  async function sendReport(reason) {
    snapshot();
    report.lastSentAt = new Date().toISOString();
    report.batches += 1;
    const payload = JSON.stringify({ ...report, reason });
    try {
      await fetch(REPORT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: reason === "pagehide"
      });
    } catch {
      if (reason === "pagehide") {
        navigator.sendBeacon?.(REPORT_ENDPOINT, new Blob([payload], { type: "application/json" }));
      }
    }
  }

  window.addEventListener("message", collectMessage);
  window.addEventListener("error", collectError);
  window.addEventListener("unhandledrejection", collectRejection);
  const timer = window.setInterval(() => void sendReport("interval"), REPORT_INTERVAL_MS);
  window.addEventListener("pagehide", () => {
    window.clearInterval(timer);
    void sendReport("pagehide");
  }, { once: true });

  window.__anyTogetherDiagnostics = {
    runId,
    flush: () => sendReport("manual")
  };
  void sendReport("start");
}
