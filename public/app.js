const elements = {
  activeRoom: document.getElementById("activeRoom"),
  connectionState: document.getElementById("connectionState"),
  currentMediaLabel: document.getElementById("currentMediaLabel"),
  mediaUrl: document.getElementById("mediaUrl"),
  playbackState: document.getElementById("playbackState"),
  player: document.getElementById("player") || document.getElementById("video"),
  revisionLabel: document.getElementById("revisionLabel")
};

const CLOCK_PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 1_200;
const PERIODIC_SYNC_INTERVAL_MS = 3_000;
const HARD_SYNC_THRESHOLD_SEC = 0.15;
const SOFT_SYNC_THRESHOLD_SEC = 0.04;

const state = {
  clientId: getClientId(),
  clockOffsetMs: 0,
  connection: null,
  connectionGeneration: 0,
  hls: null,
  lastSyncErrorMs: 0,
  playbackBlocked: false,
  reconnectTimer: null,
  remotePlayUntil: 0,
  remoteSeek: null,
  resetRateTimer: null,
  roomId: null,
  roomState: null,
  sourceId: null,
  isApplyingRemoteEvent: false
};

function getClientId() {
  const storageKey = "anytogether:sync-client-id";
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) {
      return existing;
    }
    const clientId = crypto.randomUUID();
    sessionStorage.setItem(storageKey, clientId);
    return clientId;
  } catch {
    return crypto.randomUUID();
  }
}

function logSyncEvent(title, detail = "") {
  window.dispatchEvent(new CustomEvent("anytogether:sync-log", { detail: { title, detail } }));
  console.info(`[Sync] ${title}`, detail);
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
  elements.playbackState.textContent = elements.player.paused ? "Paused" : "Playing";
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
  return Math.max(0, Math.min(position, Math.max(0, duration - 0.01)));
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
  state.roomState = nextState;
  if (elements.revisionLabel) {
    elements.revisionLabel.textContent = String(nextState.version);
  }
  if (elements.currentMediaLabel) {
    elements.currentMediaLabel.textContent = nextState.media?.url || "No media";
  }

  if (nextState.media?.id !== previousSourceId) {
    loadSource(nextState.media);
  }

  window.setTimeout(() => synchronizePlayer("room-update", serverTimeMs), 0);
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

  if (roomState.playback.paused) {
    if (!player.paused) {
      withRemoteControl(() => player.pause());
    }
    if (absoluteError > SOFT_SYNC_THRESHOLD_SEC) {
      withRemoteControl(() => setRemotePosition(player, expectedPosition));
    }
    player.playbackRate = 1;
  } else {
    if (absoluteError > HARD_SYNC_THRESHOLD_SEC || player.paused) {
      withRemoteControl(() => setRemotePosition(player, expectedPosition));
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
  if (state.playbackBlocked || !player.paused || player.ended) {
    return;
  }
  state.remotePlayUntil = performance.now() + 10_000;
  void player.play().catch(() => {
    state.playbackBlocked = true;
    state.remotePlayUntil = 0;
    logSyncEvent("Playback needs local activation", "Click the player once to allow audio playback.");
  });
}

function withRemoteControl(callback) {
  state.isApplyingRemoteEvent = true;
  try {
    callback();
  } finally {
    state.isApplyingRemoteEvent = false;
  }
}

function setRemotePosition(player, positionSec) {
  state.remoteSeek = {
    expiresAt: performance.now() + 10_000,
    positionSec
  };
  player.currentTime = positionSec;
}

function shouldPublishLocalEvent() {
  return !state.isApplyingRemoteEvent && Boolean(state.roomState?.media);
}

function unloadSource() {
  const player = elements.player;
  state.hls?.destroy();
  state.hls = null;
  state.sourceId = null;
  if (!player) {
    return;
  }
  withRemoteControl(() => {
    player.pause();
    player.removeAttribute("src");
    player.load();
  });
}

function loadSource(media) {
  const player = elements.player;
  if (!player) {
    return;
  }

  unloadSource();
  if (!media) {
    return;
  }

  state.sourceId = media.id;
  state.playbackBlocked = false;
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

  if (window.Hls?.isSupported()) {
    const hls = new window.Hls({ backBufferLength: 30, lowLatencyMode: false });
    state.hls = hls;
    hls.on(window.Hls.Events.LEVEL_LOADED, (_event, data) => {
      if (data.details.live) {
        hls.destroy();
        state.hls = null;
        logSyncEvent("Unsupported HLS source", "Live HLS is not supported in synchronized rooms.");
      }
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => handleHlsError(hls, data));
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

function handleHlsError(hls, data) {
  if (!data.fatal) {
    return;
  }
  if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
    hls.recoverMediaError();
    logSyncEvent("Recovering HLS decoder");
    return;
  }
  if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
    logSyncEvent("HLS source could not load", "The source may have expired or blocked CORS.");
    return;
  }
  logSyncEvent("HLS playback error", data.details || "Unknown HLS error");
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
  player.addEventListener("canplay", () => synchronizePlayer("canplay"));
  player.addEventListener("seeked", () => {
    const remoteSeek = state.remoteSeek;
    const completedRemoteSeek = Boolean(
      remoteSeek &&
      performance.now() <= remoteSeek.expiresAt &&
      Math.abs(player.currentTime - remoteSeek.positionSec) < 0.5
    );
    if (completedRemoteSeek || (remoteSeek && performance.now() > remoteSeek.expiresAt)) {
      state.remoteSeek = null;
    }
    if (!completedRemoteSeek && shouldPublishLocalEvent()) {
      sendAction({ positionSec: Math.max(0, player.currentTime), type: "seek" });
    }
    synchronizePlayer("seeked");
  });
  player.addEventListener("play", () => {
    const completedRemotePlay = performance.now() <= state.remotePlayUntil;
    if (completedRemotePlay) {
      state.remotePlayUntil = 0;
    }
    if (!completedRemotePlay && shouldPublishLocalEvent()) {
      sendAction({ type: "play" });
    }
    setPlaybackState();
  });
  player.addEventListener("pause", () => {
    if (shouldPublishLocalEvent()) {
      sendAction({ type: "pause" });
    }
    setPlaybackState();
  });
  player.addEventListener("error", () => {
    const message = player.error?.message || "The media element could not load this source.";
    logSyncEvent("Media playback error", message);
  });
  player.addEventListener("pointerdown", () => {
    state.playbackBlocked = false;
  });
}

function requestAutoplay() {
  state.playbackBlocked = false;
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
  return { active: true, buffering: elements.player?.readyState < HTMLMediaElement.HAVE_FUTURE_DATA, offsetMs: state.lastSyncErrorMs };
};
window.__getPlaybackPipelineState = () => ({
  connected: isSocketOpen(),
  hlsActive: Boolean(state.hls),
  mediaUrl: state.roomState?.media?.url || "",
  paused: state.roomState?.playback?.paused ?? true,
  ready: Boolean(elements.player && elements.player.readyState >= HTMLMediaElement.HAVE_METADATA),
  roomId: state.roomId,
  version: state.roomState?.version ?? null
});

bindPlayerEvents();
window.setInterval(() => {
  if (isSocketOpen()) {
    state.connection.send(JSON.stringify({ clientSendMs: Date.now(), type: "clockPing" }));
  }
}, CLOCK_PING_INTERVAL_MS);
window.setInterval(() => synchronizePlayer("periodic"), PERIODIC_SYNC_INTERVAL_MS);
