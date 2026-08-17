import {
  getPlaybackToggleIntent,
  getRelativeSeekPosition
} from "./playback-policy.js";

const elements = {
  activeRoom: document.getElementById("activeRoom"),
  connectionState: document.getElementById("connectionState"),
  currentMediaLabel: document.getElementById("currentMediaLabel"),
  mediaUrl: document.getElementById("mediaUrl"),
  playbackState: document.getElementById("playbackState"),
  player: document.querySelector("[data-current-room-shell] #player") || document.getElementById("video"),
  revisionLabel: document.getElementById("revisionLabel")
};

const CLOCK_PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 1_200;
const PERIODIC_SYNC_INTERVAL_MS = 3_000;
const HARD_SYNC_THRESHOLD_SEC = 0.15;
const SOFT_SYNC_THRESHOLD_SEC = 0.04;
const PLAYBACK_TELEMETRY_INTERVAL_MS = 500;
const Hls = window.Hls;
const DIAGNOSTIC_STORAGE_KEY = "anytogether:sync-diagnostics";
const MAX_DIAGNOSTIC_ENTRIES = 300;

const state = {
  clientId: getClientId(),
  clockOffsetMs: 0,
  connection: null,
  connectionGeneration: 0,
  hls: null,
  hlsBuffering: false,
  lastHlsRecoveryAt: 0,
  hlsNetworkRecoveryAttempts: 0,
  hlsNetworkRecoveryTimer: null,
  lastSyncErrorMs: 0,
  lastTelemetryAt: 0,
  lastTelemetrySignature: null,
  playbackBlocked: false,
  reconnectTimer: null,
  remotePlayUntil: 0,
  pendingSeek: null,
  resetRateTimer: null,
  roundTripMs: null,
  roomId: null,
  roomState: null,
  sourceId: null,
  playbackEvents: []
};

function getClientId() {
  const storageKey = "anytogether:sync-client-id";
  try {
    if (typeof window.__anyTogetherClientId === "string" && window.__anyTogetherClientId) {
      return window.__anyTogetherClientId;
    }
    const existing = sessionStorage.getItem(storageKey);
    if (existing) {
      window.__anyTogetherClientId = existing;
      return existing;
    }
    const clientId = crypto.randomUUID();
    sessionStorage.setItem(storageKey, clientId);
    window.__anyTogetherClientId = clientId;
    return clientId;
  } catch {
    const clientId = crypto.randomUUID();
    window.__anyTogetherClientId = clientId;
    return clientId;
  }
}

function logSyncEvent(title, detail = "") {
  window.dispatchEvent(new CustomEvent("anytogether:sync-log", { detail: { title, detail } }));
  console.info(`[Sync] ${title}`, detail);
  storeDiagnostic({ type: "event", title, detail });
}

function storeDiagnostic(entry) {
  try {
    const stored = JSON.parse(localStorage.getItem(DIAGNOSTIC_STORAGE_KEY) || "[]");
    const diagnostics = (Array.isArray(stored) ? stored : []).map(redactDiagnostic);
    diagnostics.push(redactDiagnostic({ at: Date.now(), ...entry }));
    localStorage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(diagnostics.slice(-MAX_DIAGNOSTIC_ENTRIES)));
  } catch {}
}

function redactDiagnostic(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") {
      return item;
    }
    return item.replace(/https?:\/\/[^\s"']+/gi, sanitizeDiagnosticUrl);
  }));
}

function sanitizeDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}/[redacted-path]`;
  } catch {
    return "[redacted-url]";
  }
}

function recordPlaybackEvent(type, player) {
  state.playbackEvents.push({
    type,
    at: Date.now(),
    currentTime: player.currentTime,
    readyState: player.readyState,
    paused: player.paused,
    muted: player.muted,
    volume: player.volume
  });
  if (state.playbackEvents.length > 500) {
    state.playbackEvents.splice(0, state.playbackEvents.length - 500);
  }
}

function setConnectionState(label) {
  if (elements.connectionState) {
    elements.connectionState.textContent = label;
  }
}

function setPlaybackState() {
  if (!elements.player || !elements.playbackState) {
    return;
  }
  const paused = state.roomState?.media
    ? state.roomState.playback.paused
    : elements.player.paused;
  elements.playbackState.textContent = paused ? "Paused" : "Playing";
}

function setPlaybackBlocked(blocked) {
  if (state.playbackBlocked === blocked) {
    return;
  }
  state.playbackBlocked = blocked;
  window.dispatchEvent(new CustomEvent("anytogether:playback-activation", {
    detail: { needed: blocked }
  }));
}

function estimateServerNow() {
  return Date.now() + state.clockOffsetMs;
}

function getPositionAt(roomState, serverTimeMs) {
  if (roomState.playback.paused) {
    return roomState.playback.anchorPositionSec;
  }
  return Math.max(
    0,
    roomState.playback.anchorPositionSec + (serverTimeMs - roomState.playback.anchorServerTimeMs) / 1_000
  );
}

function clampPosition(position, duration) {
  if (!Number.isFinite(duration)) {
    return Math.max(0, position);
  }
  return Math.max(0, Math.min(position, Math.max(0, duration - 0.04)));
}

function getCurrentSyncErrorSec() {
  const player = elements.player;
  const roomState = state.roomState;
  if (!player || !roomState?.media || player.readyState < HTMLMediaElement.HAVE_METADATA) {
    return 0;
  }
  const expectedPosition = clampPosition(getPositionAt(roomState, estimateServerNow()), player.duration);
  return expectedPosition - player.currentTime;
}

function getPlaybackSyncInfo() {
  const player = elements.player;
  const roomState = state.roomState;
  const errorMs = Math.round(Math.abs(getCurrentSyncErrorSec()) * 1_000);
  state.lastSyncErrorMs = errorMs;
  const buffering = Boolean(
    player &&
    roomState?.media &&
    (player.seeking || (
      !roomState.playback.paused && player.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
    ))
  );
  return {
    active: Boolean(roomState?.media),
    authoritativePaused: roomState?.playback?.paused ?? true,
    buffering,
    offsetMs: errorMs,
    playbackState: buffering ? "loading" : player?.paused ? "paused" : "playing",
    version: roomState?.version ?? null
  };
}

function emitPlaybackTelemetry(force = false) {
  if (!state.roomId) {
    return;
  }
  const syncInfo = getPlaybackSyncInfo();
  const signature = [
    syncInfo.buffering,
    Math.round(syncInfo.offsetMs / 10),
    syncInfo.playbackState,
    syncInfo.version
  ].join(":");
  const now = Date.now();
  if (!force && signature === state.lastTelemetrySignature && now - state.lastTelemetryAt < PLAYBACK_TELEMETRY_INTERVAL_MS) {
    return;
  }
  state.lastTelemetryAt = now;
  state.lastTelemetrySignature = signature;
  window.dispatchEvent(new CustomEvent("anytogether:playback-telemetry", {
    detail: {
      ...syncInfo,
      clientId: state.clientId,
      roomId: state.roomId
    }
  }));
}

function isSocketOpen() {
  return state.connection?.readyState === WebSocket.OPEN;
}

function createSocketUrl(roomId) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/rooms/${encodeURIComponent(roomId)}/ws`;
}

function closeConnection() {
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.connection) {
    state.connection.close(1_000, "Changing room");
    state.connection = null;
  }
}

function connectRoom(roomId) {
  const nextRoomId = String(roomId || "").trim();
  if (!nextRoomId) {
    closeConnection();
    state.roomId = null;
    state.roomState = null;
    unloadSource();
    return false;
  }

  if (state.roomId === nextRoomId && (isSocketOpen() || state.connection?.readyState === WebSocket.CONNECTING)) {
    return true;
  }

  closeConnection();
  state.roomId = nextRoomId;
  state.roomState = null;
  state.sourceId = null;
  const generation = ++state.connectionGeneration;
  openConnection(generation);
  return true;
}

function openConnection(generation) {
  if (!state.roomId || generation !== state.connectionGeneration) {
    return;
  }

  const socket = new WebSocket(createSocketUrl(state.roomId));
  state.connection = socket;
  setConnectionState(state.roomState ? "Reconnecting" : "Connecting");

  socket.addEventListener("open", () => {
    if (generation !== state.connectionGeneration || state.connection !== socket) {
      return;
    }
    setConnectionState("Connected");
    socket.send(JSON.stringify({ type: "hello" }));
    socket.send(JSON.stringify({ clientSendMs: Date.now(), type: "clockPing" }));
    logSyncEvent("Synchronized room connected", { roomId: state.roomId });
  });

  socket.addEventListener("message", (event) => {
    if (generation !== state.connectionGeneration || state.connection !== socket) {
      return;
    }
    try {
      processServerMessage(JSON.parse(String(event.data)));
    } catch {
      logSyncEvent("Unreadable synchronized room message", "", true);
    }
  });

  socket.addEventListener("error", () => {
    if (generation === state.connectionGeneration) {
      setConnectionState("Offline");
    }
  });

  socket.addEventListener("close", () => {
    if (generation !== state.connectionGeneration || state.connection !== socket) {
      return;
    }
    state.connection = null;
    setConnectionState("Reconnecting");
    state.reconnectTimer = window.setTimeout(() => openConnection(generation), RECONNECT_DELAY_MS);
  });
}

function processServerMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "snapshot") {
    applySnapshot(message.state, message.serverTimeMs);
    return;
  }

  if (message.type === "clockPong") {
    const receivedAt = Date.now();
    const roundTripMs = Math.max(0, receivedAt - message.clientSendMs);
    const estimatedOffset = message.serverTimeMs - (message.clientSendMs + receivedAt) / 2;
    if (!Number.isFinite(state.roundTripMs) || roundTripMs <= state.roundTripMs) {
      state.clockOffsetMs = estimatedOffset;
      state.roundTripMs = roundTripMs;
      storeDiagnostic({ type: "clock", roundTripMs, clockOffsetMs: estimatedOffset });
    }
    return;
  }

  if (message.type === "error") {
    logSyncEvent("Synchronized room error", message.message || message.code || "Unknown error");
    return;
  }

  if (message.type === "presence") {
    window.postMessage({
      type: "anytogether:sync-presence",
      roomId: state.roomId,
      count: message.count
    }, "*");
  }
}

function applySnapshot(nextState, serverTimeMs) {
  if (!isRoomState(nextState)) {
    logSyncEvent("Invalid synchronized room snapshot");
    return;
  }
  if (state.roomState && nextState.version < state.roomState.version) {
    return;
  }

  const previousSourceId = state.roomState?.media?.id || null;
  storeDiagnostic({
    type: "delivery",
    deliveryMs: Math.max(0, Date.now() - (serverTimeMs - state.clockOffsetMs)),
    version: nextState.version
  });
  state.roomState = nextState;
  if (state.pendingSeek && nextState.version > state.pendingSeek.baseVersion) {
    const confirmedPosition = nextState.playback.anchorPositionSec;
    if (Math.abs(confirmedPosition - state.pendingSeek.positionSec) < 0.5) {
      state.pendingSeek = null;
    }
  }
  if (elements.revisionLabel) {
    elements.revisionLabel.textContent = String(nextState.version);
  }
  if (elements.currentMediaLabel) {
    elements.currentMediaLabel.textContent = nextState.media?.url || "No media";
  }

  if (nextState.media?.id !== previousSourceId) {
    loadSource(nextState.media);
  }

  window.setTimeout(() => synchronizePlayer("room-update"), 0);
}

function isRoomState(value) {
  return Boolean(
    value &&
    typeof value.version === "number" &&
    value.playback &&
    typeof value.playback.anchorPositionSec === "number" &&
    typeof value.playback.anchorServerTimeMs === "number" &&
    typeof value.playback.paused === "boolean" &&
    (value.media === null || (typeof value.media?.id === "string" && typeof value.media?.url === "string"))
  );
}

function sendAction(pendingAction) {
  const roomState = state.roomState;
  if (!isSocketOpen() || !roomState) {
    logSyncEvent("Synchronized room is reconnecting", "The command was not sent.");
    return false;
  }

  const action = {
    ...pendingAction,
    actionId: crypto.randomUUID(),
    knownVersion: roomState.version,
    mediaId: roomState.media?.id ?? null
  };
  state.connection.send(JSON.stringify({ action, type: "action" }));
  storeDiagnostic({ type: "action-sent", actionType: action.type, knownVersion: action.knownVersion });
  return true;
}

function synchronizePlayer(reason) {
  const player = elements.player;
  const roomState = state.roomState;
  if (!player || !roomState?.media || player.readyState < HTMLMediaElement.HAVE_METADATA) {
    return;
  }

  if (roomState.media.kind === "hls" && !roomState.playback.paused) {
    if (player.seeking || state.hlsBuffering) {
      requestAuthoritativePlayback(player);
      setPlaybackState();
      return;
    }
    if (reason === "seeked") {
      requestAuthoritativePlayback(player);
      setPlaybackState();
      return;
    }
  }

  const expectedPosition = clampPosition(getPositionAt(roomState, estimateServerNow()), player.duration);
  const error = expectedPosition - player.currentTime;
  const absoluteError = Math.abs(error);
  state.lastSyncErrorMs = Math.round(absoluteError * 1_000);
  storeDiagnostic({ type: "sync", reason, errorMs: state.lastSyncErrorMs, version: roomState.version });

  if (roomState.playback.paused) {
    if (!player.paused) {
      player.pause();
    }
    if (absoluteError > SOFT_SYNC_THRESHOLD_SEC) {
      player.currentTime = expectedPosition;
    }
    player.playbackRate = 1;
  } else {
    if (absoluteError > HARD_SYNC_THRESHOLD_SEC || player.paused) {
      player.currentTime = expectedPosition;
    } else if (absoluteError > SOFT_SYNC_THRESHOLD_SEC) {
      player.playbackRate = error > 0 ? 1.04 : 0.96;
      resetPlaybackRate(player);
    }
    requestAuthoritativePlayback(player);
  }

  if (reason === "room-update") {
    logSyncEvent("Room timeline applied", { version: roomState.version, errorMs: state.lastSyncErrorMs });
  }
  setPlaybackState();
}

function resetPlaybackRate(player) {
  if (state.resetRateTimer !== null) {
    window.clearTimeout(state.resetRateTimer);
  }
  state.resetRateTimer = window.setTimeout(() => {
    player.playbackRate = 1;
    state.resetRateTimer = null;
  }, 1_600);
}

function requestAuthoritativePlayback(player) {
  if (
    state.playbackBlocked ||
    !player.paused ||
    player.ended
  ) {
    return;
  }
  state.remotePlayUntil = performance.now() + 10_000;
  void player.play().catch((error) => {
    if (error?.name === "AbortError") {
      return;
    }
    setPlaybackBlocked(true);
    state.remotePlayUntil = 0;
    logSyncEvent("Playback needs local activation", "Click the player once to allow audio playback.");
  });
}

function unloadSource() {
  const player = elements.player;
  if (state.hlsNetworkRecoveryTimer !== null) {
    window.clearTimeout(state.hlsNetworkRecoveryTimer);
    state.hlsNetworkRecoveryTimer = null;
  }
  if (state.resetRateTimer !== null) {
    window.clearTimeout(state.resetRateTimer);
    state.resetRateTimer = null;
  }
  if (player) {
    player.playbackRate = 1;
  }
  state.hls?.destroy();
  state.hls = null;
  state.hlsBuffering = false;
  state.lastHlsRecoveryAt = 0;
  state.sourceId = null;
  if (!player) {
    return;
  }
  player.pause();
  player.removeAttribute("src");
  player.load();
}

function loadSource(media) {
  const player = elements.player;
  if (!player) {
    return;
  }

  const previousSourceId = state.sourceId;
  unloadSource();
  if (!media) {
    state.hlsNetworkRecoveryAttempts = 0;
    return;
  }

  if (previousSourceId !== media.id) {
    state.hlsNetworkRecoveryAttempts = 0;
  }
  state.sourceId = media.id;
  setPlaybackBlocked(false);
  if (elements.mediaUrl) {
    elements.mediaUrl.value = media.url;
  }
  player.style.display = "";
  document.querySelector(".player-idle-state")?.classList.add("hidden");

  if (media.kind === "mp4") {
    player.src = media.url;
    player.load();
    return;
  }

  if (Hls.isSupported()) {
    const hls = new Hls({
      backBufferLength: 30,
      lowLatencyMode: false
    });
    state.hls = hls;
    hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
      if (data.details.live) {
        hls.destroy();
        state.hls = null;
        logSyncEvent("Unsupported HLS source", "Live HLS is not supported in synchronized rooms.");
      }
    });
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => handleHlsFragmentLoaded(hls, data));
    hls.on(Hls.Events.ERROR, (_event, data) => handleHlsError(hls, data));
    hls.loadSource(media.url);
    hls.attachMedia(player);
    return;
  }

  if (player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = media.url;
    player.load();
    return;
  }

  logSyncEvent("Unsupported HLS source", "This browser cannot play HLS video.");
}

function getHlsFragmentDiagnostic(fragment) {
  return fragment
    ? {
        duration: fragment.duration,
        level: fragment.level,
        sequenceNumber: fragment.sn,
        start: fragment.start,
        url: fragment.url
      }
    : null;
}

function handleHlsFragmentLoaded(hls, data) {
  if (hls !== state.hls) {
    return;
  }
  state.hlsNetworkRecoveryAttempts = 0;
  const stats = data.stats || data.frag?.stats;
  const loading = stats?.loading;
  const loadMs = Number.isFinite(loading?.end) && Number.isFinite(loading?.start)
    ? Math.max(0, loading.end - loading.start)
    : null;
  storeDiagnostic({
    type: "hls-fragment-loaded",
    fragment: getHlsFragmentDiagnostic(data.frag),
    loadedBytes: stats?.loaded ?? null,
    loadMs
  });
}

function handleHlsError(hls, data) {
  const fragment = data.frag;
  storeDiagnostic({
    type: "hls-error",
    details: data.details,
    fatal: data.fatal,
    errorType: data.type,
    fragment: getHlsFragmentDiagnostic(fragment),
    hlsState: {
      autoLevelEnabled: hls.autoLevelEnabled,
      bandwidthEstimate: hls.bandwidthEstimate,
      currentLevel: hls.currentLevel,
      loadLevel: hls.loadLevel,
      nextLoadLevel: hls.nextLoadLevel
    },
    recovery: data.errorAction
      ? {
          action: data.errorAction.action,
          flags: data.errorAction.flags,
          nextAutoLevel: data.errorAction.nextAutoLevel,
          resolved: data.errorAction.resolved,
          retryCount: data.errorAction.retryCount
        }
      : null,
    response: data.response
      ? { code: data.response.code, text: data.response.text, url: data.response.url }
      : null,
    stats: data.stats
      ? {
          aborted: data.stats.aborted,
          bandwidthEstimate: data.stats.bwEstimate,
          loaded: data.stats.loaded,
          retry: data.stats.retry,
          total: data.stats.total
        }
      : null,
    url: data.url || null
  });
  if (data.details === "bufferSeekOverHole" || data.details === "bufferNudgeOnStall") {
    hls.startLoad();
    logSyncEvent("HLS is correcting a buffer gap after the seek.");
    return;
  }
  if (
    !data.fatal &&
    data.type === Hls.ErrorTypes.NETWORK_ERROR &&
    ["fragLoadError", "fragLoadTimeOut"].includes(data.details) &&
    (data.response?.code ?? 0) >= 400 &&
    (data.errorAction?.retryCount ?? data.stats?.retry ?? 0) >= 1
  ) {
    scheduleHlsNetworkRecovery(hls);
    return;
  }
  if (!data.fatal) {
    return;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    const now = Date.now();
    if (now - state.lastHlsRecoveryAt >= 5_000) {
      state.lastHlsRecoveryAt = now;
      hls.recoverMediaError();
      logSyncEvent("Recovering HLS decoder at the shared position.");
    } else {
      const player = elements.player;
      const targetPosition = player?.currentTime;
      hls.stopLoad();
      hls.detachMedia();
      hls.attachMedia(player);
      hls.startLoad(Number.isFinite(targetPosition) ? targetPosition : -1);
      logSyncEvent("Restarting HLS decoder at the current position.");
    }
    return;
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    logSyncEvent("HLS segment loading failed after retries. The source may have expired.");
    return;
  }
  logSyncEvent("HLS playback error", data.details || "Unknown HLS error");
}

function scheduleHlsNetworkRecovery(hls) {
  const media = state.roomState?.media;
  if (
    hls !== state.hls ||
    !media ||
    media.kind !== "hls" ||
    state.hlsNetworkRecoveryAttempts >= 3 ||
    state.hlsNetworkRecoveryTimer !== null
  ) {
    return;
  }

  state.hlsNetworkRecoveryAttempts += 1;
  hls.stopLoad();
  logSyncEvent("Restarting HLS after a segment request failure.", {
    attempt: state.hlsNetworkRecoveryAttempts,
    mediaId: media.id
  });
  state.hlsNetworkRecoveryTimer = window.setTimeout(() => {
    state.hlsNetworkRecoveryTimer = null;
    if (state.hls !== hls || state.roomState?.media?.id !== media.id) {
      return;
    }
    loadSource(media);
  }, 250);
}

function loadInterfaceMedia(url, forceReload = false) {
  const sourceUrl = String(url || "").trim();
  if (!sourceUrl) {
    return false;
  }

  const media = state.roomState?.media;
  if (media?.url === sourceUrl) {
    if (forceReload) {
      loadSource(media);
    }
    return true;
  }

  return Boolean(state.roomId);
}

function bindPlayerEvents() {
  const player = elements.player;
  if (!player) {
    return;
  }

  player.addEventListener("loadedmetadata", () => {
    if (state.roomState?.media?.kind === "hls" && !Number.isFinite(player.duration)) {
      player.pause();
      logSyncEvent("Unsupported HLS source", "Live HLS is not supported in synchronized rooms.");
      return;
    }
    synchronizePlayer("metadata");
  });
  player.addEventListener("canplay", () => {
    state.hlsBuffering = false;
    synchronizePlayer("canplay");
  });
  player.addEventListener("waiting", () => {
    state.hlsBuffering = state.roomState?.media?.kind === "hls";
    recordPlaybackEvent("waiting", player);
    logSyncEvent("Buffering media at the shared position.");
    emitPlaybackTelemetry(true);
  });
  player.addEventListener("playing", () => {
    state.hlsBuffering = false;
    setPlaybackBlocked(false);
    state.remotePlayUntil = 0;
    recordPlaybackEvent("playing", player);
    logSyncEvent("Playing in sync.");
    emitPlaybackTelemetry(true);
  });
  player.addEventListener("seeking", () => {
    recordPlaybackEvent("seeking", player);
  });
  player.addEventListener("seeked", () => {
    if (player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      state.hlsBuffering = false;
    }
    recordPlaybackEvent("seeked", player);
    synchronizePlayer("seeked");
  });
  player.addEventListener("play", () => {
    if (performance.now() <= state.remotePlayUntil) {
      state.remotePlayUntil = 0;
    }
    setPlaybackState();
  });
  player.addEventListener("pause", () => {
    setPlaybackState();
  });
  player.addEventListener("error", () => {
    const details = {
      code: player.error?.code ?? null,
      message: player.error?.message || null,
      currentTime: player.currentTime,
      readyState: player.readyState,
      networkState: player.networkState
    };
    console.warn("[Sync] Media playback error", details);
    if (state.roomState?.media?.kind === "hls" && state.hls && player.error?.code === 3) {
      handleHlsError(state.hls, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: "mediaError" });
      return;
    }
    logSyncEvent("Media playback error", details);
  });
}

function requestAutoplay() {
  setPlaybackBlocked(false);
  synchronizePlayer("requested-autoplay");
}

function sendMediaRequest(params) {
  window.dispatchEvent(new CustomEvent("anytogether:outbound-media-request", { detail: params || {} }));
}

window.anyTogetherSyncBridge = {
  connectRoom(roomId) {
    return connectRoom(roomId);
  },
  loadMedia(url, forceReload = false) {
    return loadInterfaceMedia(url, forceReload);
  },
  play() {
    setPlaybackBlocked(false);
    return sendAction({ type: "play" });
  },
  pause() {
    return sendAction({ type: "pause" });
  },
  toggle() {
    const localPaused = elements.player?.paused !== false;
    const intent = getPlaybackToggleIntent(state.roomState, localPaused);
    if (!intent) {
      return false;
    }
    if (intent === "activate") {
      requestAutoplay();
      return true;
    }
    setPlaybackBlocked(false);
    return sendAction({ type: intent });
  },
  seekBy(deltaSec) {
    if (!state.roomState?.media) {
      return false;
    }
    const delta = Number(deltaSec);
    if (!Number.isFinite(delta)) {
      return false;
    }
    const position = getRelativeSeekPosition(
      state.roomState,
      estimateServerNow(),
      delta,
      elements.player?.duration
    );
    state.pendingSeek = {
      baseVersion: state.roomState.version,
      positionSec: position
    };
    return sendAction({ positionSec: position, type: "seek" });
  },
  seek(positionSec) {
    const position = Number(positionSec);
    if (!Number.isFinite(position) || position < 0) {
      return false;
    }
    if (!state.roomState) {
      return false;
    }
    state.pendingSeek = {
      baseVersion: state.roomState.version,
      positionSec: position
    };
    return sendAction({ positionSec: position, type: "seek" });
  }
};

window.__anyTogetherRequestAutoplay = requestAutoplay;
window.__sendMediaRequest = sendMediaRequest;
window.__sendQualityRequest = (qualityLabel) => sendMediaRequest({ requestedQualityLabel: qualityLabel });
window.__sendTranslationRequest = (translatorId) => sendMediaRequest({ requestedTranslatorId: Number(translatorId) });
window.__getPlaybackSyncInfo = (participantClientId = state.clientId) => {
  if (participantClientId !== state.clientId) {
    return null;
  }
  return getPlaybackSyncInfo();
};
window.__getPlaybackPipelineState = () => ({
  activationNeeded: state.playbackBlocked,
  bufferedRanges: elements.player
    ? Array.from({ length: elements.player.buffered.length }, (_item, index) => ({
        end: elements.player.buffered.end(index),
        start: elements.player.buffered.start(index)
      }))
    : [],
  connected: isSocketOpen(),
  hlsActive: Boolean(state.hls),
  hlsBandwidthEstimate: state.hls?.bandwidthEstimate ?? null,
  hlsBuffering: state.hlsBuffering,
  hlsCurrentLevel: state.hls?.currentLevel ?? null,
  hlsLoadLevel: state.hls?.loadLevel ?? null,
  hlsNextLoadLevel: state.hls?.nextLoadLevel ?? null,
  localPositionSec: elements.player?.currentTime ?? null,
  localPaused: elements.player?.paused ?? true,
  localPlaybackRate: elements.player?.playbackRate ?? 1,
  mediaUrl: state.roomState?.media?.url || "",
  networkState: elements.player?.networkState ?? null,
  paused: state.roomState?.playback?.paused ?? true,
  positionSec: state.roomState ? getPositionAt(state.roomState, estimateServerNow()) : null,
  ready: Boolean(elements.player && elements.player.readyState >= HTMLMediaElement.HAVE_METADATA),
  readyState: elements.player?.readyState ?? null,
  roomId: state.roomId,
  roundTripMs: state.roundTripMs,
  seeking: elements.player?.seeking ?? false,
  syncErrorMs: Math.round(Math.abs(getCurrentSyncErrorSec()) * 1_000),
  clockOffsetMs: state.clockOffsetMs,
  version: state.roomState?.version ?? null
});
window.__getPlaybackEvents = () => state.playbackEvents.slice();
window.__disconnectPlaybackSocket = () => {
  if (!state.connection) {
    return false;
  }
  state.connection.close(4_000, "E2E reconnect check");
  return true;
};
window.__getSyncDiagnostics = () => {
  try {
    const entries = JSON.parse(localStorage.getItem(DIAGNOSTIC_STORAGE_KEY) || "[]");
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
};

bindPlayerEvents();
window.setInterval(() => {
  if (isSocketOpen()) {
    state.connection.send(JSON.stringify({ clientSendMs: Date.now(), type: "clockPing" }));
  }
}, CLOCK_PING_INTERVAL_MS);
window.setInterval(() => synchronizePlayer("periodic"), PERIODIC_SYNC_INTERVAL_MS);
window.setInterval(() => emitPlaybackTelemetry(), PLAYBACK_TELEMETRY_INTERVAL_MS);
