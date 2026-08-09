import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyRoomAction,
  createEmptyRoomState,
  isClientMessage,
  isRoomState,
  validateMediaUrl
} from "./sync-protocol.js";

const MAX_MESSAGE_BYTES = 8_192;
const MAX_RECENT_ACTION_IDS = 128;
const ROOM_TTL_MS = 24 * 60 * 60 * 1_000;

export class RoomSyncService {
  constructor({ dataDir, isRoomId }) {
    this.storePath = path.join(dataDir, "sync-rooms.json");
    this.isRoomId = isRoomId;
    this.rooms = new Map();
    this.clients = new Map();
    this.persistTimer = null;
  }

  async restore() {
    try {
      const raw = await readFile(this.storePath, "utf8");
      const stored = JSON.parse(raw);
      for (const [roomId, record] of Object.entries(stored?.rooms || {})) {
        if (!this.isRoomId(roomId) || !isRoomState(record?.state)) {
          continue;
        }
        const expiresAtMs = Number(record.expiresAtMs);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
          continue;
        }
        this.rooms.set(roomId, {
          expiresAtMs,
          recentActionIds: Array.isArray(record.recentActionIds)
            ? record.recentActionIds.filter((id) => typeof id === "string").slice(-MAX_RECENT_ACTION_IDS)
            : [],
          state: record.state
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  connect(roomId, socket) {
    const room = this.getRoom(roomId);
    const clients = this.getClients(roomId);
    clients.add(socket);
    this.sendSnapshot(socket, room.state);
    this.broadcastPresence(roomId);

    socket.on("message", (raw) => this.handleMessage(roomId, socket, raw));
    socket.on("close", () => {
      clients.delete(socket);
      if (clients.size === 0) {
        this.clients.delete(roomId);
      }
      this.broadcastPresence(roomId);
    });
    socket.on("error", () => socket.close());
  }

  setMedia(roomId, url) {
    if (!this.isRoomId(roomId)) {
      return { error: "Unknown room." };
    }

    const source = validateMediaUrl(url);
    if ("error" in source) {
      return source;
    }

    const room = this.getRoom(roomId);
    room.state = applyRoomAction(
      room.state,
      { actionId: crypto.randomUUID(), knownVersion: room.state.version, mediaId: null, type: "setMedia", url: source.url },
      Date.now(),
      { id: crypto.randomUUID(), kind: source.kind, url: source.url }
    );
    room.expiresAtMs = Date.now() + ROOM_TTL_MS;
    this.schedulePersist();
    this.broadcastSnapshot(roomId);
    return { state: room.state };
  }

  delete(roomId) {
    this.rooms.delete(roomId);
    this.schedulePersist();
  }

  getState(roomId) {
    return this.rooms.get(roomId)?.state || null;
  }

  getRoom(roomId) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        expiresAtMs: Date.now() + ROOM_TTL_MS,
        recentActionIds: [],
        state: createEmptyRoomState(Date.now())
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  getClients(roomId) {
    if (!this.clients.has(roomId)) {
      this.clients.set(roomId, new Set());
    }
    return this.clients.get(roomId);
  }

  handleMessage(roomId, socket, raw) {
    const messageText = toMessageText(raw);
    if (!messageText || messageText.length > MAX_MESSAGE_BYTES) {
      this.sendError(socket, "invalid-message", "The realtime message is invalid.");
      return;
    }

    let message;
    try {
      message = JSON.parse(messageText);
    } catch {
      this.sendError(socket, "invalid-json", "The realtime message is not valid JSON.");
      return;
    }

    if (!isClientMessage(message)) {
      this.sendError(socket, "invalid-message", "The realtime message has an unsupported shape.");
      return;
    }

    const room = this.getRoom(roomId);
    if (message.type === "hello") {
      this.sendSnapshot(socket, room.state);
      return;
    }
    if (message.type === "clockPing") {
      this.send(socket, { clientSendMs: message.clientSendMs, serverTimeMs: Date.now(), type: "clockPong" });
      return;
    }

    this.acceptAction(roomId, socket, message.action);
  }

  acceptAction(roomId, socket, action) {
    const room = this.getRoom(roomId);
    if (room.recentActionIds.includes(action.actionId)) {
      this.sendSnapshot(socket, room.state);
      return;
    }

    const serverTimeMs = Date.now();
    let nextState;
    if (action.type === "setMedia") {
      const source = validateMediaUrl(action.url);
      if ("error" in source) {
        this.sendError(socket, "invalid-media-url", source.error);
        return;
      }
      nextState = applyRoomAction(
        room.state,
        action,
        serverTimeMs,
        { id: crypto.randomUUID(), kind: source.kind, url: source.url }
      );
    } else {
      if (!room.state.media || action.mediaId !== room.state.media.id) {
        this.sendSnapshot(socket, room.state);
        return;
      }
      nextState = applyRoomAction(room.state, action, serverTimeMs);
    }

    room.state = nextState;
    room.expiresAtMs = serverTimeMs + ROOM_TTL_MS;
    room.recentActionIds.push(action.actionId);
    if (room.recentActionIds.length > MAX_RECENT_ACTION_IDS) {
      room.recentActionIds.splice(0, room.recentActionIds.length - MAX_RECENT_ACTION_IDS);
    }
    this.schedulePersist();
    this.broadcastSnapshot(roomId);
  }

  broadcastSnapshot(roomId) {
    const state = this.getRoom(roomId).state;
    for (const socket of this.getClients(roomId)) {
      this.sendSnapshot(socket, state);
    }
  }

  broadcastPresence(roomId) {
    const sockets = this.getClients(roomId);
    const message = { count: [...sockets].filter(isOpen).length, serverTimeMs: Date.now(), type: "presence" };
    for (const socket of sockets) {
      this.send(socket, message);
    }
  }

  sendSnapshot(socket, state) {
    this.send(socket, { serverTimeMs: Date.now(), state, type: "snapshot" });
  }

  sendError(socket, code, message) {
    this.send(socket, { code, message, type: "error" });
  }

  send(socket, message) {
    if (isOpen(socket)) {
      socket.send(JSON.stringify(message));
    }
  }

  schedulePersist() {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(async () => {
      this.persistTimer = null;
      const snapshot = {
        rooms: Object.fromEntries(
          [...this.rooms.entries()]
            .filter(([, room]) => room.expiresAtMs > Date.now())
            .map(([roomId, room]) => [roomId, room])
        )
      };

      try {
        await mkdir(path.dirname(this.storePath), { recursive: true });
        await writeFile(this.storePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      } catch (error) {
        console.error("Failed to persist synchronized room state", error);
      }
    }, 150);
  }
}

function isOpen(socket) {
  return socket.readyState === 1;
}

function toMessageText(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.byteLength > MAX_MESSAGE_BYTES) {
    return null;
  }
  return buffer.toString("utf8");
}
