export type MediaKind = "mp4" | "hls";

export interface MediaSource {
  id: string;
  kind: MediaKind;
  url: string;
}

export interface PlaybackAnchor {
  anchorPositionSec: number;
  anchorServerTimeMs: number;
  paused: boolean;
}

export interface RoomState {
  media: MediaSource | null;
  playback: PlaybackAnchor;
  updatedAtMs: number;
  version: number;
}

interface ActionBase {
  actionId: string;
  knownVersion: number;
  mediaId: string | null;
}

export interface SetMediaAction extends ActionBase {
  type: "setMedia";
  url: string;
}

export interface PlayAction extends ActionBase {
  type: "play";
}

export interface PauseAction extends ActionBase {
  type: "pause";
}

export interface SeekAction extends ActionBase {
  positionSec: number;
  type: "seek";
}

export type RoomAction = SetMediaAction | PlayAction | PauseAction | SeekAction;

export type ClientMessage =
  | { type: "hello" }
  | { clientSendMs: number; type: "clockPing" }
  | { action: RoomAction; type: "action" };

export type ServerMessage =
  | { serverTimeMs: number; state: RoomState; type: "snapshot" }
  | { count: number; serverTimeMs: number; type: "presence" }
  | { clientSendMs: number; serverTimeMs: number; type: "clockPong" }
  | { code: string; message: string; type: "error" };

export const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;
const MAX_MEDIA_URL_LENGTH = 2_048;

export function createEmptyRoomState(serverTimeMs: number): RoomState {
  return {
    media: null,
    playback: {
      anchorPositionSec: 0,
      anchorServerTimeMs: serverTimeMs,
      paused: true,
    },
    updatedAtMs: serverTimeMs,
    version: 0,
  };
}

export function getPositionAt(state: RoomState, serverTimeMs: number): number {
  if (state.playback.paused) {
    return state.playback.anchorPositionSec;
  }

  return Math.max(
    0,
    state.playback.anchorPositionSec +
      (serverTimeMs - state.playback.anchorServerTimeMs) / 1_000,
  );
}

export function isRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

export function normalizeRoomId(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return isRoomId(normalized) ? normalized : null;
}

export function validateMediaUrl(
  value: string,
): { kind: MediaKind; url: string } | { error: string } {
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_MEDIA_URL_LENGTH) {
    return { error: "Enter a video URL up to 2048 characters." };
  }

  let parsed: URL;
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

export function isRoomAction(value: unknown): value is RoomAction {
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

export function isClientMessage(value: unknown): value is ClientMessage {
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

export function isRoomState(value: unknown): value is RoomState {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !isRecord(value.playback)
  ) {
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

export function applyRoomAction(
  state: RoomState,
  action: RoomAction,
  serverTimeMs: number,
  media?: MediaSource,
): RoomState {
  const position = getPositionAt(state, serverTimeMs);
  const nextPlayback: PlaybackAnchor = {
    anchorPositionSec: position,
    anchorServerTimeMs: serverTimeMs,
    paused: state.playback.paused,
  };

  if (action.type === "setMedia" && media) {
    return {
      media,
      playback: {
        anchorPositionSec: 0,
        anchorServerTimeMs: serverTimeMs,
        paused: true,
      },
      updatedAtMs: serverTimeMs,
      version: state.version + 1,
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
    version: state.version + 1,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isActionBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.actionId === "string" &&
    value.actionId.length > 0 &&
    value.actionId.length <= 128 &&
    typeof value.knownVersion === "number" &&
    Number.isInteger(value.knownVersion) &&
    (typeof value.mediaId === "string" || value.mediaId === null)
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^[0-9.]+$/.test(hostname);
}

function isPrivateIpv4(hostname: string): boolean {
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
