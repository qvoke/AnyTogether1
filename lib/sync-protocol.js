const MAX_MEDIA_URL_LENGTH = 2_048;

export function createEmptyRoomState(serverTimeMs) {
  return {
    media: null,
    playback: {
      anchorPositionSec: 0,
      anchorServerTimeMs: serverTimeMs,
      paused: true
    },
    updatedAtMs: serverTimeMs,
    version: 0
  };
}

export function getPositionAt(state, serverTimeMs) {
  if (state.playback.paused) {
    return state.playback.anchorPositionSec;
  }

  return Math.max(
    0,
    state.playback.anchorPositionSec + (serverTimeMs - state.playback.anchorServerTimeMs) / 1_000
  );
}

export function validateMediaUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > MAX_MEDIA_URL_LENGTH) {
    return { error: "Enter a video URL up to 2048 characters." };
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "Enter a valid HTTPS URL." };
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return { error: "Use a public HTTPS URL without embedded credentials." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isLocalHost(hostname) || isIpLiteral(hostname) || isPrivateIpv4(hostname)) {
    return { error: "Local and IP-based media hosts are not allowed." };
  }

  const pathname = parsed.pathname.toLowerCase();
  if (pathname.endsWith(".mp4")) {
    return { kind: "mp4", url: parsed.toString() };
  }
  if (pathname.endsWith(".m3u8")) {
    return { kind: "hls", url: parsed.toString() };
  }

  return { error: "The URL must end with .mp4 or .m3u8." };
}

export function isClientMessage(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "hello") {
    return true;
  }
  if (value.type === "clockPing") {
    return typeof value.clientSendMs === "number" && Number.isFinite(value.clientSendMs);
  }
  return value.type === "action" && isRoomAction(value.action);
}

export function isRoomAction(value) {
  if (!isRecord(value) || !isActionBase(value)) {
    return false;
  }

  if (value.type === "setMedia") {
    return typeof value.url === "string";
  }
  if (value.type === "seek") {
    return typeof value.positionSec === "number" && Number.isFinite(value.positionSec);
  }
  return value.type === "play" || value.type === "pause";
}

export function isRoomState(value) {
  if (!isRecord(value) || typeof value.version !== "number" || !isRecord(value.playback)) {
    return false;
  }

  const { playback } = value;
  if (
    typeof playback.anchorPositionSec !== "number" ||
    typeof playback.anchorServerTimeMs !== "number" ||
    typeof playback.paused !== "boolean" ||
    typeof value.updatedAtMs !== "number"
  ) {
    return false;
  }

  if (value.media === null) {
    return true;
  }

  return (
    isRecord(value.media) &&
    typeof value.media.id === "string" &&
    typeof value.media.url === "string" &&
    (value.media.kind === "mp4" || value.media.kind === "hls")
  );
}

export function applyRoomAction(state, action, serverTimeMs, media = undefined) {
  const position = getPositionAt(state, serverTimeMs);
  const nextPlayback = {
    anchorPositionSec: position,
    anchorServerTimeMs: serverTimeMs,
    paused: state.playback.paused
  };

  if (action.type === "setMedia" && media) {
    return {
      media,
      playback: {
        anchorPositionSec: 0,
        anchorServerTimeMs: serverTimeMs,
        paused: true
      },
      updatedAtMs: serverTimeMs,
      version: state.version + 1
    };
  }

  if (action.type === "play") {
    nextPlayback.paused = false;
  } else if (action.type === "pause") {
    nextPlayback.paused = true;
  } else if (action.type === "seek") {
    nextPlayback.anchorPositionSec = Math.max(0, action.positionSec);
  }

  return {
    ...state,
    playback: nextPlayback,
    updatedAtMs: serverTimeMs,
    version: state.version + 1
  };
}

function isActionBase(value) {
  return (
    typeof value.actionId === "string" &&
    value.actionId.length > 0 &&
    value.actionId.length <= 128 &&
    typeof value.knownVersion === "number" &&
    Number.isInteger(value.knownVersion) &&
    (typeof value.mediaId === "string" || value.mediaId === null)
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isIpLiteral(hostname) {
  return hostname.startsWith("[") || /^[0-9.]+$/.test(hostname);
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }

  const values = octets.map(Number);
  if (values.some((value) => value > 255)) {
    return false;
  }

  return (
    values[0] === 10 ||
    values[0] === 127 ||
    values[0] === 0 ||
    (values[0] === 169 && values[1] === 254) ||
    (values[0] === 172 && values[1] >= 16 && values[1] <= 31) ||
    (values[0] === 192 && values[1] === 168)
  );
}
