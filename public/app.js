import {
  getBufferedHlsAlignmentPosition,
  getHlsAlignmentAllowanceSec,
  getPlaybackToggleIntent,
  getRelativeSeekPosition,
  shouldDeferHlsCorrection,
  shouldQueueHlsCorrection,
  shouldRunSettledHlsAlignment,
  shouldScheduleSettledHlsAlignment,
  shouldStartHlsPrimaryCorrection
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
const HLS_ALIGNMENT_THRESHOLD_SEC = HARD_SYNC_THRESHOLD_SEC;
const HLS_MIN_ALIGNMENT_ALLOWANCE_SEC = 0.2;
const HLS_MAX_INITIAL_ALIGNMENT_ALLOWANCE_SEC = 0.8;
const HLS_MAX_REPEAT_ALIGNMENT_ALLOWANCE_SEC = 0.3;
const HLS_MAX_TRACKED_ALIGNMENT_LATENCY_MS = 800;
const HLS_MAX_ALIGNMENT_ATTEMPTS = 2;
const HLS_ALIGNMENT_STABILITY_DELAY_MS = 250;
const HLS_DRIFT_ALIGNMENT_THRESHOLD_SEC = 0.2;
const HLS_DRIFT_STABILITY_DELAY_MS = PERIODIC_SYNC_INTERVAL_MS;
const HLS_IMMEDIATE_REPEAT_PRIMARY_LATENCY_LIMIT_MS = 2_000;
const HLS_STALLED_SEEK_RETRY_DELAY_MS = 4_000;
const PLAYBACK_TELEMETRY_INTERVAL_MS = 500;
const HLS_NETWORK_RECOVERY_DELAY_MS = 250;
const HLS_NETWORK_RECOVERY_LIMIT = 3;
const HLS_FRAGMENT_FIRST_BYTE_TIMEOUT_MS = 4_000;
const Hls = window.Hls;
const DIAGNOSTIC_STORAGE_KEY = "anytogether:sync-diagnostics";
const MAX_DIAGNOSTIC_ENTRIES = 300;

const state = {
  clientId: getClientId(),
  clockOffsetMs: 0,
  connection: null,
  connectionGeneration: 0,
  deferredHlsCorrection: null,
  hls: null,
  hlsAlignmentLatencyMs: null,
  hlsBuffering: false,
  hlsCommitLatencyMs: null,
  hlsCorrection: null,
  hlsPlayRequestAtMs: null,
  hlsRecoveryTimer: null,
  lastHlsRecoveryAt: 0,
  lastHlsLoadVersion: null,
  lastHlsNetworkRecovery: null,
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
    (state.hlsBuffering || state.hlsCorrection?.awaitingPlayback ||
      state.hlsCorrection?.pendingAlignment || player.seeking || (
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

function synchronizePlayer(reason, serverTimeMs = estimateServerNow()) {
  const player = elements.player;
  const roomState = state.roomState;
  if (!player || !roomState?.media || player.readyState < HTMLMediaElement.HAVE_METADATA) {
    return;
  }
  const expectedPosition = clampPosition(getPositionAt(roomState, serverTimeMs), player.duration);
  const error = expectedPosition - player.currentTime;
  const absoluteError = Math.abs(error);
  state.lastSyncErrorMs = Math.round(absoluteError * 1_000);
  storeDiagnostic({ type: "sync", reason, errorMs: state.lastSyncErrorMs, version: roomState.version });

  if (roomState.playback.paused) {
    if (!player.paused) {
      player.pause();
    }
    if (absoluteError > SOFT_SYNC_THRESHOLD_SEC) {
      const correctionPosition = setRemotePosition(player, expectedPosition, roomState);
      startHlsLoadForState(roomState, correctionPosition);
    }
    resetHlsPlaybackRate(player);
  } else {
    if (state.playbackBlocked) {
      resetHlsPlaybackRate(player);
      setPlaybackState();
      return;
    }
    const hasSettledCurrentHlsCorrection = roomState.media.kind === "hls" &&
      state.hlsCorrection?.version === roomState.version &&
      state.hlsCorrection.phase === "settled";
    if (
      hasSettledCurrentHlsCorrection &&
      (state.hlsCorrection.alignmentAttempts >= HLS_MAX_ALIGNMENT_ATTEMPTS ||
        absoluteError <= HLS_ALIGNMENT_THRESHOLD_SEC)
    ) {
      state.hlsCorrection.pendingAlignment = false;
      state.hlsCorrection.alignmentReady = false;
    }
    if (shouldScheduleSettledHlsAlignment(
      roomState,
      state.hlsCorrection,
      absoluteError,
      HLS_DRIFT_ALIGNMENT_THRESHOLD_SEC,
      HLS_MAX_ALIGNMENT_ATTEMPTS
    )) {
      scheduleHlsAlignment(state.hlsCorrection, false);
    }
    const withinHlsSettlementGrace = hasSettledCurrentHlsCorrection &&
      !state.hlsCorrection.pendingAlignment &&
      state.hlsCorrection.alignmentReady !== true &&
      state.hlsCorrection.alignmentAttempts > 0 &&
      performance.now() - state.hlsCorrection.settledAtMs < PERIODIC_SYNC_INTERVAL_MS;
    const correctionThresholdSec = hasSettledCurrentHlsCorrection
      ? HLS_ALIGNMENT_THRESHOLD_SEC
      : HARD_SYNC_THRESHOLD_SEC;
    const requiresPositionCorrection = !withinHlsSettlementGrace && absoluteError > correctionThresholdSec;
    const playerState = {
      buffering: state.hlsBuffering,
      seeking: player.seeking
    };
    if (
      requiresPositionCorrection &&
      shouldQueueHlsCorrection(roomState, state.hlsCorrection, playerState)
    ) {
      if (state.deferredHlsCorrection?.version !== roomState.version) {
        storeDiagnostic({
          type: "hls-correction-queued",
          errorMs: state.lastSyncErrorMs,
          reason,
          version: roomState.version
        });
      }
      state.deferredHlsCorrection = { version: roomState.version };
      player.playbackRate = 1;
      requestAuthoritativePlayback(player);
      setPlaybackState();
      return;
    }
    const hasPendingHlsStart = roomState.media.kind === "hls" &&
      state.hlsCorrection?.version === roomState.version &&
      state.hlsCorrection.awaitingPlayback;
    if (hasPendingHlsStart) {
      advanceHlsPlaybackStart(player);
      player.playbackRate = 1;
      requestAuthoritativePlayback(player);
      setPlaybackState();
      return;
    }
    if (
      requiresPositionCorrection &&
      shouldDeferHlsCorrection(roomState, state.hlsCorrection, playerState)
    ) {
      player.playbackRate = 1;
      storeDiagnostic({
        type: "hls-correction-deferred",
        errorMs: state.lastSyncErrorMs,
        reason,
        version: roomState.version
      });
      requestAuthoritativePlayback(player);
      setPlaybackState();
      return;
    }
    if (requiresPositionCorrection) {
      if (roomState.media.kind === "hls") {
        const alignmentStarted = shouldRunSettledHlsAlignment(
          roomState,
          state.hlsCorrection,
          playerState,
          absoluteError,
          HLS_ALIGNMENT_THRESHOLD_SEC,
          HLS_MAX_ALIGNMENT_ATTEMPTS
        ) && startHlsAlignment(
          player,
          roomState,
          state.hlsCorrection,
          expectedPosition,
          error,
          false
        );
        if (!alignmentStarted && shouldStartHlsPrimaryCorrection(roomState, state.hlsCorrection)) {
          const correctionPosition = setRemotePosition(player, expectedPosition, roomState);
          startHlsLoadForState(roomState, correctionPosition);
        }
      } else {
        const correctionPosition = setRemotePosition(player, expectedPosition, roomState);
        startHlsLoadForState(roomState, correctionPosition);
      }
    } else if (roomState.media.kind === "hls") {
      player.playbackRate = 1;
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

function startHlsLoadForState(roomState, positionSec) {
  if (roomState.media?.kind !== "hls" || !state.hls || state.lastHlsLoadVersion === roomState.version) {
    return;
  }
  state.lastHlsLoadVersion = roomState.version;
  state.hls.startLoad(positionSec);
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

function markHlsCorrectionReady(player, playbackStarted = false) {
  const correction = state.hlsCorrection;
  if (!correction?.awaitingPlayback) {
    return;
  }
  advanceHlsPlaybackStart(player, playbackStarted);
  if (
    correction === state.hlsCorrection &&
    correction.awaitingPlayback &&
    correction.playbackStarted &&
    !correction.stabilityCheckPending
  ) {
    correction.stabilityCheckPending = true;
    window.setTimeout(() => {
      correction.stabilityCheckPending = false;
      if (correction === state.hlsCorrection && correction.awaitingPlayback) {
        markHlsCorrectionReady(player);
      }
    }, 50);
  }
}

function advanceHlsPlaybackStart(player, playbackStarted = false) {
  const correction = state.hlsCorrection;
  const roomState = state.roomState;
  if (correction && playbackStarted) {
    correction.playbackStarted = true;
  }
  if (correction?.awaitingPlayback && correction.version !== roomState?.version) {
    if (player.seeking) {
      return;
    }
    correction.awaitingPlayback = false;
    correction.phase = "superseded";
    state.hlsBuffering = false;
    synchronizePlayer("queued-hls-correction");
    return;
  }
  if (
    !correction?.awaitingPlayback ||
    roomState.media?.kind !== "hls" ||
    roomState.playback.paused ||
    player.readyState < HTMLMediaElement.HAVE_METADATA
  ) {
    return;
  }

  if (player.seeking) {
    retryBufferedHlsSeek(player, roomState, correction);
    return;
  }

  if (
    !["aligning", "committed"].includes(correction.phase) ||
    !correction.playbackStarted ||
    player.paused
  ) {
    return;
  }

  const completedAlignment = correction.phase === "aligning";
  const commitLatencyMs = Math.max(0, performance.now() - correction.commitStartedAtMs);
  if (completedAlignment) {
    updateHlsAlignmentLatency(commitLatencyMs);
    correction.lastAlignmentLatencyMs = commitLatencyMs;
  } else {
    updateHlsCommitLatency(commitLatencyMs);
  }
  state.hlsPlayRequestAtMs = null;
  const settleLatencyMs = Math.max(0, performance.now() - correction.startedAtMs);
  correction.awaitingPlayback = false;
  correction.phase = "settled";
  correction.settledAtMs = performance.now();
  correction.commitLatencyMs = Math.round(commitLatencyMs);
  correction.settleLatencyMs = Math.round(settleLatencyMs);
  correction.startErrorMs = Math.round(Math.abs(getCurrentSyncErrorSec()) * 1_000);
  const startErrorSec = correction.startErrorMs / 1_000;
  correction.pendingAlignment = correction.alignmentAttempts < HLS_MAX_ALIGNMENT_ATTEMPTS && (
    (!completedAlignment && startErrorSec > HLS_ALIGNMENT_THRESHOLD_SEC) ||
    (completedAlignment &&
      startErrorSec > HLS_DRIFT_ALIGNMENT_THRESHOLD_SEC &&
      state.hlsCommitLatencyMs <= HLS_IMMEDIATE_REPEAT_PRIMARY_LATENCY_LIMIT_MS)
  );
  state.hlsBuffering = false;
  player.playbackRate = 1;
  storeDiagnostic({
    type: "hls-seek-settled",
    alignmentMs: Math.round((correction.alignmentAllowanceSec ?? 0) * 1_000),
    errorMs: correction.startErrorMs,
    commitLatencyMs: correction.commitLatencyMs,
    leadMs: correction.leadMs,
    settleLatencyMs: correction.settleLatencyMs,
    version: correction.version
  });

  if (state.deferredHlsCorrection?.version === roomState.version) {
    synchronizePlayer("queued-hls-correction");
    return;
  }
  requestAuthoritativePlayback(player);
  if (correction.pendingAlignment) {
    scheduleHlsAlignment(correction);
  }
}

function retryBufferedHlsSeek(player, roomState, correction) {
  if (
    correction.phase !== "committed" ||
    correction.retryAttempts >= 1 ||
    performance.now() - correction.startedAtMs < HLS_STALLED_SEEK_RETRY_DELAY_MS
  ) {
    return;
  }
  const expectedPosition = clampPosition(getPositionAt(roomState, estimateServerNow()), player.duration);
  const retryPosition = getBufferedHlsAlignmentPosition(
    expectedPosition,
    expectedPosition,
    getBufferedRanges(player)
  );
  if (retryPosition === null) {
    return;
  }

  correction.retryAttempts += 1;
  correction.commitTargetSec = retryPosition;
  recordPlaybackEvent("sync-retry-seek", player);
  player.currentTime = retryPosition;
  state.hls?.startLoad(retryPosition);
}

function scheduleHlsAlignment(correction, requirePendingAlignment = true) {
  if (correction.alignmentReadinessPending) {
    return;
  }
  correction.alignmentReadinessPending = true;
  const markReady = () => {
    correction.alignmentReadinessPending = false;
    if (
      correction !== state.hlsCorrection ||
      correction.phase !== "settled" ||
      (requirePendingAlignment && !correction.pendingAlignment) ||
      correction.alignmentAttempts >= HLS_MAX_ALIGNMENT_ATTEMPTS
    ) {
      return;
    }
    if (Math.abs(getCurrentSyncErrorSec()) <= HLS_ALIGNMENT_THRESHOLD_SEC) {
      correction.pendingAlignment = false;
      correction.alignmentReady = false;
      return;
    }
    correction.alignmentReady = true;
    synchronizePlayer("hls-alignment-ready");
  };
  window.setTimeout(
    markReady,
    requirePendingAlignment ? HLS_ALIGNMENT_STABILITY_DELAY_MS : HLS_DRIFT_STABILITY_DELAY_MS
  );
}

function startHlsAlignment(
  player,
  roomState,
  correction,
  expectedPosition,
  signedErrorSec,
  markBuffering
) {
  if (
    correction !== state.hlsCorrection ||
    correction?.version !== roomState?.version ||
    correction.alignmentAttempts >= HLS_MAX_ALIGNMENT_ATTEMPTS ||
    Math.abs(signedErrorSec) <= HLS_ALIGNMENT_THRESHOLD_SEC
  ) {
    return false;
  }

  const wasSettled = correction.phase === "settled";
  const alignmentAllowanceSec = getHlsAlignmentAllowanceSec(
    {
      alignmentAttempts: correction.alignmentAttempts,
      historicAlignmentLatencyMs: state.hlsAlignmentLatencyMs,
      primaryLatencyMs: state.hlsCommitLatencyMs
    },
    HLS_MIN_ALIGNMENT_ALLOWANCE_SEC,
    HLS_MAX_INITIAL_ALIGNMENT_ALLOWANCE_SEC,
    HLS_MAX_REPEAT_ALIGNMENT_ALLOWANCE_SEC
  );
  const desiredAlignmentPosition = clampPosition(expectedPosition + alignmentAllowanceSec, player.duration);
  const alignmentPosition = getBufferedHlsAlignmentPosition(
    expectedPosition,
    desiredAlignmentPosition,
    getBufferedRanges(player)
  );
  if (alignmentPosition === null) {
    return false;
  }

  const startedAtMs = performance.now();
  correction.alignmentAttempts += 1;
  correction.alignmentReady = false;
  correction.alignmentAllowanceSec = alignmentPosition - expectedPosition;
  correction.awaitingPlayback = true;
  correction.pendingAlignment = false;
  correction.commitStartedAtMs = startedAtMs;
  correction.commitTargetSec = alignmentPosition;
  correction.phase = "aligning";
  correction.playbackStarted = !player.paused;
  if (wasSettled) {
    correction.startedAtMs = startedAtMs;
  }
  if (markBuffering) {
    state.hlsBuffering = true;
  }
  recordPlaybackEvent("sync-align-seek", player);
  player.currentTime = alignmentPosition;
  requestAuthoritativePlayback(player);
  return true;
}

function updateHlsCommitLatency(commitLatencyMs) {
  state.hlsCommitLatencyMs = commitLatencyMs;
}

function updateHlsAlignmentLatency(alignmentLatencyMs) {
  if (
    !Number.isFinite(alignmentLatencyMs) ||
    alignmentLatencyMs > HLS_MAX_TRACKED_ALIGNMENT_LATENCY_MS
  ) {
    return;
  }
  state.hlsAlignmentLatencyMs = Number.isFinite(state.hlsAlignmentLatencyMs)
    ? state.hlsAlignmentLatencyMs * 0.7 + alignmentLatencyMs * 0.3
    : alignmentLatencyMs;
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
  if (state.roomState?.media?.kind === "hls" && player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    state.hlsPlayRequestAtMs = performance.now();
  }
  void player.play().catch((error) => {
    if (error?.name === "AbortError") {
      return;
    }
    setPlaybackBlocked(true);
    state.remotePlayUntil = 0;
    logSyncEvent("Playback needs local activation", "Click the player once to allow audio playback.");
  });
}

function setRemotePosition(player, positionSec, roomState) {
  state.deferredHlsCorrection = null;
  state.hlsPlayRequestAtMs = null;
  resetHlsPlaybackRate(player);
  const isAdvancingHls = roomState.media?.kind === "hls" && !roomState.playback.paused;
  const correctionPosition = clampPosition(positionSec, player.duration);
  const startedAtMs = isAdvancingHls ? performance.now() : null;
  state.hlsCorrection = roomState.media?.kind === "hls"
    ? {
        awaitingPlayback: isAdvancingHls,
        alignmentAttempts: 0,
        commitStartedAtMs: startedAtMs,
        commitTargetSec: correctionPosition,
        leadMs: 0,
        phase: isAdvancingHls ? "committed" : "settled",
        playbackStarted: isAdvancingHls && !player.paused,
        retryAttempts: 0,
        settleLatencyMs: null,
        startAllowanceSec: 0,
        startedAtMs,
        version: roomState.version
      }
    : null;
  state.hlsBuffering = isAdvancingHls;
  recordPlaybackEvent("sync-seek", player);
  player.currentTime = correctionPosition;
  return correctionPosition;
}

function getBufferedRanges(player) {
  return Array.from({ length: player.buffered.length }, (_item, index) => ({
    end: player.buffered.end(index),
    start: player.buffered.start(index)
  }));
}

function resetHlsPlaybackRate(player = elements.player) {
  if (player) {
    player.playbackRate = 1;
  }
}

function unloadSource(options = {}) {
  const player = elements.player;
  if (!options.preserveNetworkRecovery) {
    state.lastHlsNetworkRecovery = null;
  }
  if (state.hlsRecoveryTimer !== null) {
    window.clearTimeout(state.hlsRecoveryTimer);
    state.hlsRecoveryTimer = null;
  }
  resetHlsPlaybackRate(player);
  state.hls?.destroy();
  state.deferredHlsCorrection = null;
  state.hls = null;
  state.hlsAlignmentLatencyMs = null;
  state.hlsBuffering = false;
  state.hlsCorrection = null;
  state.hlsPlayRequestAtMs = null;
  if (!options.preserveNetworkRecovery) {
    state.hlsCommitLatencyMs = null;
  }
  state.lastHlsRecoveryAt = 0;
  state.lastHlsLoadVersion = null;
  state.sourceId = null;
  if (!player) {
    return;
  }
  player.pause();
  player.removeAttribute("src");
  player.load();
}

function loadSource(media, options = {}) {
  const player = elements.player;
  if (!player) {
    return;
  }

  unloadSource(options);
  if (!media) {
    return;
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
      fragLoadPolicy: {
        default: {
          ...Hls.DefaultConfig.fragLoadPolicy.default,
          maxTimeToFirstByteMs: HLS_FRAGMENT_FIRST_BYTE_TIMEOUT_MS
        }
      },
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
    hls.on(Hls.Events.FRAG_BUFFERED, () => handleHlsFragmentBuffered(hls, player));
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
  state.lastHlsNetworkRecovery = null;
  if (state.hlsRecoveryTimer !== null) {
    window.clearTimeout(state.hlsRecoveryTimer);
    state.hlsRecoveryTimer = null;
  }
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

function handleHlsFragmentBuffered(hls, player) {
  if (hls !== state.hls) {
    return;
  }
  markHlsCorrectionReady(player);
  if (
    state.hlsCorrection?.phase === "settled" &&
    state.hlsCorrection.version === state.roomState?.version &&
    !state.roomState.playback.paused
  ) {
    synchronizePlayer("hls-fragment-buffered");
  }
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
  if (shouldRecoverHlsNetworkEarly(data)) {
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
    scheduleHlsNetworkRecovery(hls);
    return;
  }
  logSyncEvent("HLS playback error", data.details || "Unknown HLS error");
}

function scheduleHlsNetworkRecovery(hls) {
  const roomState = state.roomState;
  if (hls !== state.hls || !roomState?.media || roomState.media.kind !== "hls") {
    return;
  }
  const previousRecovery = state.lastHlsNetworkRecovery;
  const attempts = previousRecovery?.mediaId === roomState.media.id &&
    previousRecovery?.version === roomState.version
    ? previousRecovery.attempts
    : 0;
  if (attempts >= HLS_NETWORK_RECOVERY_LIMIT) {
    logSyncEvent("HLS segment loading failed after pipeline recovery.");
    return;
  }
  const recovery = {
    attempts: attempts + 1,
    mediaId: roomState.media.id,
    version: roomState.version
  };
  state.lastHlsNetworkRecovery = recovery;
  if (state.hlsRecoveryTimer !== null) {
    return;
  }
  hls.stopLoad();
  logSyncEvent("Restarting the HLS pipeline after a network failure.");
  state.hlsRecoveryTimer = window.setTimeout(() => {
    state.hlsRecoveryTimer = null;
    const latestState = state.roomState;
    if (state.hls !== hls || latestState?.media?.id !== recovery.mediaId) {
      return;
    }
    loadSource(latestState.media, { preserveNetworkRecovery: true });
  }, HLS_NETWORK_RECOVERY_DELAY_MS);
}

function shouldRecoverHlsNetworkEarly(data) {
  const retryCount = data.errorAction?.retryCount ?? data.stats?.retry ?? 0;
  const responseCode = data.response?.code ?? 0;
  if (data.type !== Hls.ErrorTypes.NETWORK_ERROR || data.fatal) {
    return false;
  }
  if (data.details === "fragLoadTimeOut") {
    return true;
  }
  return data.details === "fragLoadError" && retryCount >= 1 && responseCode >= 400;
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

  player.addEventListener("loadedmetadata", () => synchronizePlayer("metadata"));
  player.addEventListener("canplay", () => {
    if (!player.seeking) {
      state.hlsBuffering = false;
      markHlsCorrectionReady(player);
    }
    synchronizePlayer("canplay");
  });
  player.addEventListener("waiting", () => {
    state.hlsBuffering = state.roomState?.media?.kind === "hls";
    state.remotePlayUntil = performance.now() + 60_000;
    recordPlaybackEvent("waiting", player);
    logSyncEvent("Buffering media at the shared position.");
    emitPlaybackTelemetry(true);
  });
  player.addEventListener("playing", () => {
    state.hlsBuffering = false;
    const hadPendingHlsCommit = state.hlsCorrection?.awaitingPlayback === true &&
      ["aligning", "committed"].includes(state.hlsCorrection.phase);
    markHlsCorrectionReady(player, true);
    if (!hadPendingHlsCommit && Number.isFinite(state.hlsPlayRequestAtMs)) {
      updateHlsCommitLatency(Math.max(0, performance.now() - state.hlsPlayRequestAtMs));
      state.hlsPlayRequestAtMs = null;
    }
    setPlaybackBlocked(false);
    state.remotePlayUntil = 0;
    recordPlaybackEvent("playing", player);
    logSyncEvent("Playing in sync.");
    if (state.roomState?.media?.kind === "hls") {
      window.setTimeout(() => synchronizePlayer("hls-playing"), 0);
    }
    emitPlaybackTelemetry(true);
  });
  player.addEventListener("seeking", () => {
    recordPlaybackEvent("seeking", player);
  });
  player.addEventListener("seeked", () => {
    if (player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      state.hlsBuffering = false;
      markHlsCorrectionReady(player);
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
    const correctionIsLoading = state.hlsCorrection?.awaitingPlayback === true;
    const localPaused = elements.player?.paused !== false && !correctionIsLoading;
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
  hlsAlignmentLatencyMs: state.hlsAlignmentLatencyMs,
  hlsBandwidthEstimate: state.hls?.bandwidthEstimate ?? null,
  hlsBuffering: state.hlsBuffering,
  hlsCommitLatencyMs: state.hlsCommitLatencyMs,
  hlsCorrection: state.hlsCorrection ? { ...state.hlsCorrection } : null,
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
