import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import crypto, { pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { RoomSyncService } from "./lib/room-sync.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = 3000;

const dataDir = path.join(__dirname, "data");
const roomStorePath = path.join(dataDir, "rooms.json");
const authStorePath = path.join(dataDir, "auth.json");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

const rooms = new Map();
const roomMembers = new Map();
const socketState = new Map();
const participantOfflineTimers = new WeakMap();
const connectedSockets = new Set();
const usersById = new Map();
const sessionsByToken = new Map();
const roomSync = new RoomSyncService({
  dataDir,
  isRoomId: (roomId) => normalizeRoomCode(roomId) === roomId
});

let persistTimer = null;
let authPersistTimer = null;

function now() {
  return Date.now();
}

function normalizeRoomCode(roomCode) {
  const normalized = String(roomCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");

  return normalized || null;
}

function normalizeNickname(value) {
  const nickname = String(value || "").trim().slice(0, 40);
  return nickname || "Guest";
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase() === "host" ? "host" : "guest";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDisplayName(value) {
  const displayName = String(value || "").trim().slice(0, 60);
  return displayName || "Guest";
}

function createPasswordRecord(password, salt = null) {
  const passwordSalt = salt || crypto.randomBytes(16).toString("hex");
  const passwordHash = pbkdf2Sync(String(password || ""), passwordSalt, 120000, 64, "sha512").toString("hex");

  return { passwordSalt, passwordHash };
}

function verifyPassword(password, passwordSalt, expectedHash) {
  const actualHash = pbkdf2Sync(String(password || ""), passwordSalt, 120000, 64, "sha512");
  const expectedBuffer = Buffer.from(String(expectedHash || ""), "hex");

  if (expectedBuffer.length !== actualHash.length) {
    return false;
  }

  return timingSafeEqual(actualHash, expectedBuffer);
}

function createRoom(roomId, title = null, ownerId = null) {
  const code = normalizeRoomCode(roomId);
  const createdAt = now();
  return {
    roomId: code,
    code,
    title: title || "Room",
    ownerId: ownerId ? String(ownerId) : null,
    createdAt,
    sessionStartedAt: createdAt,
    lastUpdatedAt: createdAt,
    chat: [],
    playlist: [],
    currentMedia: null,
    currentPlayback: {
      state: "paused",
      time: 0,
      updatedAt: createdAt
    },
    participants: [],
    loadedFromDisk: false
  };
}

function getRoom(roomId) {
  const normalized = normalizeRoomCode(roomId);
  if (!normalized) return null;

  if (!rooms.has(normalized)) {
    rooms.set(normalized, createRoom(normalized));
  }

  return rooms.get(normalized);
}

function ensureRoom(roomCode, title, ownerId = null) {
  const normalizedCode = normalizeRoomCode(roomCode);
  if (!normalizedCode) return null;

  if (!rooms.has(normalizedCode)) {
    rooms.set(normalizedCode, createRoom(normalizedCode, title, ownerId));
    schedulePersist();
  }

  const room = rooms.get(normalizedCode);
  if (title && !room.title) {
    room.title = title;
    room.lastUpdatedAt = now();
    schedulePersist();
  }

  if (ownerId && !room.ownerId) {
    room.ownerId = String(ownerId);
    room.lastUpdatedAt = now();
    schedulePersist();
  }

  return room;
}

function getRoomMembers(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return new Set();

  if (!roomMembers.has(normalized)) {
    roomMembers.set(normalized, new Set());
  }

  return roomMembers.get(normalized);
}

function getSocketState(socket) {
  if (!socketState.has(socket)) {
    socketState.set(socket, {
      socketId: crypto.randomUUID(),
      nickname: "Guest",
      role: "guest",
      canManageContent: true,
      hasExtension: false,
      clientId: null,
      userId: null,
      sessionToken: null,
      rooms: new Set(),
      leftRooms: new Set(),
      keepNotInRoom: new Set(),
      presenceRooms: new Set(),
      joinedAtByRoom: {}
    });
  }

  return socketState.get(socket);
}

function sendJson(responseOrSocket, statusCodeOrPayload, payloadIfResponse = null) {
  if (typeof responseOrSocket.writeHead === "function") {
    responseOrSocket.writeHead(statusCodeOrPayload, { "Content-Type": "application/json; charset=utf-8" });
    responseOrSocket.end(JSON.stringify(payloadIfResponse));
  } else {
    if (responseOrSocket.readyState === 1) {
      responseOrSocket.send(JSON.stringify(statusCodeOrPayload));
    }
  }
}

function broadcastToUiSockets(sockets, payload) {
  const message = JSON.stringify(payload);

  for (const socket of sockets) {
    if (socket.readyState === 1) {
      socket.send(message);
    }
  }
}

function broadcastRoomSnapshot(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  broadcastToUiSockets(getRoomMembers(roomCode), {
    type: "room:snapshot",
    roomId: roomCode,
    room: buildRoomSnapshot(room)
  });
}

function broadcastRoomsList() {
  const summaries = [...rooms.values()]
    .map((room) => buildRoomSummary(room))
    .sort((left, right) => right.createdAt - left.createdAt);

  broadcastToUiSockets(connectedSockets, {
    type: "rooms:update",
    rooms: summaries
  });
}

function roomToPersistable(room) {
  return {
    code: room.code,
    title: room.title,
    ownerId: room.ownerId || null,
    createdAt: room.createdAt,
    sessionStartedAt: room.sessionStartedAt,
    chat: room.chat,
    playlist: room.playlist,
    currentMedia: room.currentMedia,
    currentPlayback: room.currentPlayback,
    participants: Array.isArray(room.participants) ? room.participants : [],
    lastUpdatedAt: room.lastUpdatedAt
  };
}

function schedulePersist() {
  if (persistTimer) return;

  persistTimer = setTimeout(async () => {
    persistTimer = null;

    try {
      const snapshot = {
        rooms: Object.fromEntries(
          [...rooms.entries()].map(([code, room]) => [code, roomToPersistable(room)])
        )
      };

      await mkdir(dataDir, { recursive: true });
      await writeFile(roomStorePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } catch (error) {
      console.error("Failed to persist room store", error);
    }
  }, 150);
}

function normalizePersistedRoom(roomData) {
  const code = normalizeRoomCode(roomData?.code);
  if (!code) return null;

  const room = createRoom(code, roomData?.title, roomData?.ownerId);
  room.createdAt = Number.isFinite(roomData?.createdAt) ? roomData.createdAt : room.createdAt;
  room.sessionStartedAt = Number.isFinite(roomData?.sessionStartedAt) ? roomData.sessionStartedAt : room.createdAt;
  room.chat = Array.isArray(roomData?.chat) ? roomData.chat : [];
  room.playlist = Array.isArray(roomData?.playlist) ? roomData.playlist : [];
  room.participants = Array.isArray(roomData?.participants)
    ? roomData.participants
        .map((participant) => normalizeParticipantRecord(participant))
        .filter(Boolean)
        .map((participant) => ({
          ...participant,
          connected: false,
          presenceStatus: "offline",
          socketId: null
        }))
    : [];
  room.loadedFromDisk = true;

  if (roomData?.currentMedia && typeof roomData.currentMedia === "object") {
    room.currentMedia = {
      mediaUrl: String(roomData.currentMedia.mediaUrl || ""),
      masterPlaylistUrl: roomData.currentMedia.masterPlaylistUrl || null,
      pageUrl: roomData.currentMedia.pageUrl || null,
      sourcePageUrl: roomData.currentMedia.sourcePageUrl || null,
      title: roomData.currentMedia.title || null,
      seriesContext: roomData.currentMedia.seriesContext || null,
      updatedAt: roomData.currentMedia.updatedAt || room.createdAt
    };
  }

  if (roomData?.currentPlayback && typeof roomData.currentPlayback === "object") {
    room.currentPlayback = {
      state: roomData.currentPlayback.state === "playing" ? "playing" : "paused",
      time: Number.isFinite(roomData.currentPlayback.time) ? roomData.currentPlayback.time : 0,
      updatedAt: roomData.currentPlayback.updatedAt || room.createdAt
    };
  }

  room.lastUpdatedAt = Number.isFinite(roomData?.lastUpdatedAt) ? roomData.lastUpdatedAt : room.createdAt;

  return room;
}

async function loadRoomsFromDisk() {
  try {
    const raw = await readFile(roomStorePath, "utf8");
    const parsed = JSON.parse(raw);
    const storedRooms = parsed?.rooms || {};

    for (const roomData of Object.values(storedRooms)) {
      const room = normalizePersistedRoom(roomData);
      if (room) {
        rooms.set(room.code, room);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function createAuthStoreSnapshot() {
  return {
    users: Object.fromEntries(
      [...usersById.entries()].map(([userId, user]) => [
        userId,
        {
          id: user.id,
          displayName: user.displayName,
          displayNameLower: user.displayNameLower,
          email: user.email,
          emailLower: user.emailLower,
          passwordSalt: user.passwordSalt,
          passwordHash: user.passwordHash,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          roomCodes: [...user.roomCodes]
        }
      ])
    ),
    sessions: Object.fromEntries(
      [...sessionsByToken.entries()].map(([token, session]) => [
        token,
        {
          token: session.token,
          userId: session.userId,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt
        }
      ])
    )
  };
}

function scheduleAuthPersist() {
  if (authPersistTimer) return;

  authPersistTimer = setTimeout(async () => {
    authPersistTimer = null;

    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(authStorePath, `${JSON.stringify(createAuthStoreSnapshot(), null, 2)}\n`, "utf8");
    } catch (error) {
      console.error("Failed to persist auth store", error);
    }
  }, 150);
}

async function loadAuthFromDisk() {
  try {
    const raw = await readFile(authStorePath, "utf8");
    const parsed = JSON.parse(raw);

    const storedUsers = parsed?.users || {};
    for (const userData of Object.values(storedUsers)) {
      const userId = String(userData?.id || crypto.randomUUID());
      const roomCodes = Array.isArray(userData?.roomCodes) ? userData.roomCodes.map(normalizeRoomCode).filter(Boolean) : [];

      usersById.set(userId, {
        id: userId,
        displayName: normalizeDisplayName(userData?.displayName || userData?.name),
        displayNameLower: normalizeDisplayName(userData?.displayName || userData?.name).toLowerCase(),
        email: String(userData?.email || ""),
        emailLower: normalizeEmail(userData?.email || userData?.emailLower),
        passwordSalt: String(userData?.passwordSalt || ""),
        passwordHash: String(userData?.passwordHash || ""),
        createdAt: Number.isFinite(userData?.createdAt) ? userData.createdAt : now(),
        lastLoginAt: Number.isFinite(userData?.lastLoginAt) ? userData.lastLoginAt : null,
        roomCodes: new Set(roomCodes)
      });
    }

    const storedSessions = parsed?.sessions || {};
    for (const sessionData of Object.values(storedSessions)) {
      const token = String(sessionData?.token || "").trim();
      const userId = String(sessionData?.userId || "").trim();
      if (!token || !usersById.has(userId)) continue;

      sessionsByToken.set(token, {
        token,
        userId,
        createdAt: Number.isFinite(sessionData?.createdAt) ? sessionData.createdAt : now(),
        lastSeenAt: Number.isFinite(sessionData?.lastSeenAt) ? sessionData.lastSeenAt : now()
      });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function getUserById(userId) {
  const normalized = String(userId || "").trim();
  if (!normalized) return null;
  return usersById.get(normalized) || null;
}

function serializeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    roomCount: user.roomCodes.size
  };
}

function updateUserDisplayName(userId, displayName) {
  const user = getUserById(userId);
  const displayNameValue = normalizeDisplayName(displayName);
  if (!user || !displayNameValue) return null;

  const existingName = [...usersById.values()].some(
    (entry) => entry.id !== user.id && entry.displayNameLower === displayNameValue.toLowerCase()
  );
  if (existingName) {
    throw new Error("Display name already registered");
  }

  user.displayName = displayNameValue;
  user.displayNameLower = displayNameValue.toLowerCase();
  user.lastLoginAt = now();
  scheduleAuthPersist();
  return user;
}

function createSession(userId) {
  const user = getUserById(userId);
  if (!user) return null;

  const token = crypto.randomUUID();
  sessionsByToken.set(token, {
    token,
    userId: user.id,
    createdAt: now(),
    lastSeenAt: now()
  });
  scheduleAuthPersist();
  return token;
}

function revokeSession(token) {
  const normalized = String(token || "").trim();
  if (!normalized) return false;
  const removed = sessionsByToken.delete(normalized);
  if (removed) {
    scheduleAuthPersist();
  }
  return removed;
}

function getSessionFromRequest(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;
  const token = bearerToken || String(req.headers["x-auth-token"] || "").trim();
  if (!token) return null;

  const session = sessionsByToken.get(token);
  if (!session) return null;

  session.lastSeenAt = now();
  return session;
}

function getUserFromRequest(req) {
  const session = getSessionFromRequest(req);
  if (!session) return null;
  const user = getUserById(session.userId);
  return user || null;
}

function createUserRecord({ displayName, email, password }) {
  const emailLower = normalizeEmail(email);
  const displayNameValue = normalizeDisplayName(displayName);
  if (!emailLower || !displayNameValue || !String(password || "").trim()) return null;

  const existingEmail = [...usersById.values()].some((user) => user.emailLower === emailLower);
  if (existingEmail) {
    throw new Error("Email already registered");
  }

  const existingName = [...usersById.values()].some((user) => user.displayNameLower === displayNameValue.toLowerCase());
  if (existingName) {
    throw new Error("Display name already registered");
  }

  const id = crypto.randomUUID();
  const { passwordSalt, passwordHash } = createPasswordRecord(password);
  const user = {
    id,
    displayName: displayNameValue,
    displayNameLower: displayNameValue.toLowerCase(),
    email: emailLower,
    emailLower,
    passwordSalt,
    passwordHash,
    createdAt: now(),
    lastLoginAt: now(),
    roomCodes: new Set()
  };

  usersById.set(id, user);
  scheduleAuthPersist();
  return user;
}

function authenticateUser(identifier, password) {
  const normalizedIdentifier = normalizeEmail(identifier) || normalizeDisplayName(identifier).toLowerCase();
  if (!normalizedIdentifier) return null;

  const user = [...usersById.values()].find((entry) => entry.emailLower === normalizedIdentifier || entry.displayNameLower === normalizedIdentifier);
  if (!user) return null;

  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return null;
  }

  user.lastLoginAt = now();
  scheduleAuthPersist();
  return user;
}

function attachRoomToUser(userId, roomCode) {
  const user = getUserById(userId);
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  if (!user || !normalizedRoomCode) return false;

  const before = user.roomCodes.size;
  user.roomCodes.add(normalizedRoomCode);
  if (user.roomCodes.size !== before) {
    scheduleAuthPersist();
  }

  return true;
}

function detachRoomFromUser(userId, roomCode) {
  const user = getUserById(userId);
  const normalizedRoomCode = normalizeRoomCode(roomCode);
  if (!user || !normalizedRoomCode) return false;

  const removed = user.roomCodes.delete(normalizedRoomCode);
  if (removed) {
    scheduleAuthPersist();
  }

  return removed;
}

function getRoomsForUser(userId) {
  const user = getUserById(userId);
  if (!user) return [];

  const existingCodes = [...user.roomCodes].filter((roomCode) => rooms.has(roomCode));
  if (existingCodes.length !== user.roomCodes.size) {
    user.roomCodes = new Set(existingCodes);
    scheduleAuthPersist();
  }

  return existingCodes
    .map((roomCode) => rooms.get(roomCode))
    .filter(Boolean)
    .map((room) => buildRoomSummary(room))
    .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt);
}

function generateRoomCode() {
  let candidate = null;

  do {
    candidate = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(candidate));

  return candidate;
}

function buildParticipantList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];

  for (const socket of getRoomMembers(roomCode)) {
    syncRoomParticipant(room, socket, { connected: true });
  }

  const participants = Array.isArray(room.participants) ? room.participants.map((participant) => normalizeParticipantRecord(participant)).filter(Boolean) : [];
  participants.sort(compareParticipantRecords);
  return participants;
}

function buildRoomSnapshot(room) {
  const participants = buildParticipantList(room.code);
  return {
    code: room.code,
    title: room.title,
    createdAt: room.createdAt,
    sessionStartedAt: room.sessionStartedAt,
    memberCount: participants.filter((participant) => participant.connected !== false).length,
    participants,
    chat: room.chat,
    playlist: room.playlist,
    currentMedia: room.currentMedia,
    currentPlayback: room.currentPlayback,
    lastUpdatedAt: room.lastUpdatedAt
  };
}

function buildRoomSummary(room) {
  const participants = buildParticipantList(room.code);
  return {
    code: room.code,
    title: room.title,
    createdAt: room.createdAt,
    sessionStartedAt: room.sessionStartedAt,
    memberCount: participants.filter((participant) => participant.connected !== false).length,
    chatCount: room.chat.length,
    playlistCount: room.playlist.length,
    currentMediaTitle: room.currentMedia?.title || room.currentMedia?.seriesContext?.title || null,
    currentMediaUrl: room.currentMedia?.mediaUrl || null,
    lastUpdatedAt: room.lastUpdatedAt
  };
}

function normalizeParticipantRecord(participant, fallback = {}) {
  if (!participant) return null;

  const joinedAt = Number.isFinite(participant.joinedAt) ? participant.joinedAt : Number.isFinite(fallback.joinedAt) ? fallback.joinedAt : now();
  const lastSeenAt = Number.isFinite(participant.lastSeenAt) ? participant.lastSeenAt : Number.isFinite(fallback.lastSeenAt) ? fallback.lastSeenAt : joinedAt;
  const presenceStatus = ["online", "offline", "not-in-room"].includes(participant.presenceStatus)
    ? participant.presenceStatus
    : participant.connected === false ? "offline" : "online";

  return {
    socketId: String(participant.socketId || fallback.socketId || "").trim() || null,
    clientId: String(participant.clientId || fallback.clientId || "").trim() || null,
    userId: String(participant.userId || fallback.userId || "").trim() || null,
    nickname: normalizeNickname(participant.nickname || fallback.nickname || "Guest"),
    role: normalizeRole(participant.role || fallback.role || "guest"),
    canManageContent: participant.canManageContent !== false,
    hasExtension: participant.hasExtension !== false,
    connected: presenceStatus === "online",
    presenceStatus,
    joinedAt,
    lastSeenAt
  };
}

function compareParticipantRecords(left, right) {
  if (String(left.role || "guest") !== String(right.role || "guest")) {
    return String(left.role || "guest") === "host" ? -1 : 1;
  }

  const presencePriority = {
    online: 0,
    "not-in-room": 1,
    offline: 2
  };
  const leftPriority = presencePriority[left.presenceStatus] ?? (left.connected ? 0 : 2);
  const rightPriority = presencePriority[right.presenceStatus] ?? (right.connected ? 0 : 2);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return (left.joinedAt || 0) - (right.joinedAt || 0);
}

function findParticipantRecord(room, state, socket = null) {
  if (!room?.participants?.length) return null;

  const clientId = state?.clientId ? String(state.clientId) : null;
  const userId = state?.userId ? String(state.userId) : null;
  const socketId = state?.socketId ? String(state.socketId) : null;
  const fallbackClientId = socket?.context?.clientId ? String(socket.context.clientId) : null;

  const matched = room.participants.find((participant) => {
    if (clientId && participant.clientId === clientId) return true;
    if (userId && participant.userId === userId) return true;
    if (socketId && participant.socketId === socketId) return true;
    if (fallbackClientId && participant.clientId === fallbackClientId) return true;
    return false;
  });
  if (matched) return matched;

  if (!userId && state?.nickname) {
    return room.participants.find((participant) =>
      !participant.userId && participant.nickname === state.nickname
    ) || null;
  }

  return null;
}

function syncRoomParticipant(room, socket, { connected = true } = {}) {
  if (!room || !socket) return null;

  const state = getSocketState(socket);
  const existing = findParticipantRecord(room, state, socket);
  const nextRecord = normalizeParticipantRecord(
    {
      socketId: state.socketId,
      clientId: state.clientId,
      userId: state.userId,
      nickname: state.nickname,
      role: state.role,
      canManageContent: state.canManageContent,
      hasExtension: state.hasExtension,
      connected,
      presenceStatus: connected ? "online" : "offline",
      joinedAt: existing?.joinedAt,
      lastSeenAt: now()
    },
    existing || {}
  );

  room.participants = Array.isArray(room.participants)
    ? room.participants.filter((participant) => {
        if (!participant) return false;
        if (nextRecord.clientId && participant.clientId === nextRecord.clientId) return false;
        if (nextRecord.userId && participant.userId === nextRecord.userId) return false;
        if (!nextRecord.userId && !participant.userId && participant.nickname === nextRecord.nickname) return false;
        if (!nextRecord.clientId && !nextRecord.userId && nextRecord.socketId && participant.socketId === nextRecord.socketId) return false;
        return true;
      })
    : [];

  room.participants.push(nextRecord);
  room.participants.sort(compareParticipantRecords);
  schedulePersist();
  return nextRecord;
}

function markRoomParticipantDisconnected(room, socket) {
  const state = getSocketState(socket);
  const record = findParticipantRecord(room, state, socket);
  if (!record) return;

  record.connected = false;
  record.presenceStatus = "offline";
  record.socketId = null;
  record.lastSeenAt = now();
  schedulePersist();
}

function markRoomParticipantNotInRoom(room, socket) {
  const state = getSocketState(socket);
  const record = findParticipantRecord(room, state, socket);
  if (!record) return;

  record.connected = false;
  record.presenceStatus = "not-in-room";
  record.socketId = null;
  record.lastSeenAt = now();
  schedulePersist();
}

function scheduleParticipantOffline(room, record) {
  if (!room || !record) return;
  clearTimeout(participantOfflineTimers.get(record));
  const timer = setTimeout(() => {
    record.connected = false;
    record.presenceStatus = "offline";
    participantOfflineTimers.delete(record);
    record.lastSeenAt = now();
    schedulePersist();
    if (!deleteRoomIfOrphaned(room.code)) {
      broadcastRoomSnapshot(room.code);
      broadcastRoomsList();
    }
  }, 15000);
  participantOfflineTimers.set(record, timer);
}

function confirmSitePresence(state) {
  for (const room of rooms.values()) {
    const record = room.participants?.find((participant) =>
      state.userId
        ? participant.userId === state.userId
        : !participant.userId && participant.nickname === state.nickname
    );
    if (!record) continue;

    clearTimeout(participantOfflineTimers.get(record));
    participantOfflineTimers.delete(record);
    record.connected = false;
    record.presenceStatus = "not-in-room";
    record.lastSeenAt = now();
    state.presenceRooms.add(room.code);
    broadcastRoomSnapshot(room.code);
  }
  schedulePersist();
}

function removeRoomParticipant(room, socket) {
  if (!room || !Array.isArray(room.participants)) return;

  const state = getSocketState(socket);
  const clientId = state.clientId ? String(state.clientId) : null;
  const userId = state.userId ? String(state.userId) : null;
  const socketId = state.socketId ? String(state.socketId) : null;

  room.participants = room.participants.filter((participant) => {
    if (!participant) return false;
    if (clientId && participant.clientId === clientId) return false;
    if (!clientId && userId && participant.userId === userId) return false;
    if (!clientId && !userId && socketId && participant.socketId === socketId) return false;
    return true;
  });
  schedulePersist();
}

function deleteRoomIfOrphaned(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return false;

  const room = rooms.get(normalized);
  if (!room) return false;

  return false;
}

function assignNextHost(roomCode, excludedSocket = null) {
  const members = [...getRoomMembers(roomCode)].filter((socket) => socket !== excludedSocket);
  if (!members.length) return null;

  const nextHost = members[0];
  const state = getSocketState(nextHost);
  state.role = "host";
  const room = rooms.get(roomCode);
  if (room) {
    room.ownerId = state.userId ? String(state.userId) : null;
    room.lastUpdatedAt = now();
  }

  if (nextHost.readyState === 1) {
    nextHost.send(
      JSON.stringify({
        type: "room:role",
        roomId: roomCode,
        role: "host"
      })
    );
  }

  return nextHost;
}

function markRoomUpdated(roomCode, persist = true) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.lastUpdatedAt = now();

  if (persist) {
    schedulePersist();
  }
}

function normalizeRoomTitle(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ").slice(0, 60);
  return title || null;
}

function joinRoom(roomCode, socket, { nickname, clientId, canManageContent, hasExtension }) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return;

  const room = ensureRoom(normalized);
  const state = getSocketState(socket);

  state.clientId = clientId || state.clientId;
  state.nickname = nickname ? normalizeNickname(nickname) : state.nickname;
  state.hasExtension = hasExtension !== false;

  const existingParticipant = findParticipantRecord(room, state, socket);
  const isOwner = Boolean(state.userId && room.ownerId && String(room.ownerId) === String(state.userId));
  const firstMember = !room.loadedFromDisk && getRoomMembers(normalized).size === 0 && (!Array.isArray(room.participants) || room.participants.length === 0);
  const isReturningAnonymousOwner = String(existingParticipant?.role || "guest") === "host";
  state.role = isOwner || firstMember || isReturningAnonymousOwner ? "host" : "guest";
  state.canManageContent = canManageContent !== false && state.hasExtension !== false;

  getRoomMembers(normalized).add(socket);
  state.rooms.add(normalized);
  state.leftRooms.delete(normalized);
  state.joinedAtByRoom[normalized] = now();
  syncRoomParticipant(room, socket, { connected: true });
  schedulePersist();

  sendJson(socket, {
    type: "room:snapshot",
    roomId: normalized,
    room: buildRoomSnapshot(room)
  });

  sendJson(socket, {
    type: "room:role",
    roomId: normalized,
    role: state.role
  });

  broadcastRoomSnapshot(normalized);
  broadcastRoomsList();
}

function leaveRoomFromUI(roomCode, socket, { keepNotInRoom = false } = {}) {
  const normalized = normalizeRoomCode(roomCode);
  if (!normalized) return;

  const room = rooms.get(normalized);
  const state = getSocketState(socket);
  const userId = state.userId;

  getRoomMembers(normalized).delete(socket);
  state.rooms.delete(normalized);
  state.leftRooms.add(normalized);
  if (keepNotInRoom) {
    state.keepNotInRoom.add(normalized);
  } else {
    state.keepNotInRoom.delete(normalized);
  }
  delete state.joinedAtByRoom[normalized];

  if (room) {
    if (keepNotInRoom) {
      markRoomParticipantNotInRoom(room, socket);
    } else {
      removeRoomParticipant(room, socket);
    }
  }

  if (userId) {
    detachRoomFromUser(userId, normalized);
  }

  schedulePersist();

  if (state.role === "host") {
    state.role = "guest";
    assignNextHost(normalized, socket);
  }

  if (deleteRoomIfOrphaned(normalized)) {
    return;
  }

  broadcastRoomSnapshot(normalized);
  broadcastRoomsList();
}

function leaveAllRooms(socket) {
  const state = getSocketState(socket);
  for (const roomCode of state.rooms) {
    leaveRoomFromUI(roomCode, socket);
  }
}

function detachSocketFromRooms(socket) {
  const state = getSocketState(socket);

  for (const roomCode of new Set([...state.rooms, ...state.leftRooms, ...state.presenceRooms])) {
    const normalized = normalizeRoomCode(roomCode);
    const room = rooms.get(normalized);
    getRoomMembers(normalized).delete(socket);
    delete state.joinedAtByRoom[normalized];
    if (room) {
      if (state.presenceRooms.has(normalized) || !state.keepNotInRoom.has(normalized)) {
        markRoomParticipantDisconnected(room, socket);
      } else {
        const record = findParticipantRecord(room, state, socket);
        scheduleParticipantOffline(room, record);
      }
      schedulePersist();
      if (!deleteRoomIfOrphaned(normalized)) {
        broadcastRoomSnapshot(normalized);
        broadcastRoomsList();
      }
    }
  }

  state.rooms.clear();
  state.leftRooms.clear();
  state.keepNotInRoom.clear();
  state.presenceRooms.clear();
}

async function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

async function handleApiRequest(request, response, url) {
  const method = request.method;
  const pathPart = url.pathname;

  if (method === "POST" && (pathPart === "/api/auth/register" || pathPart === "/api/auth/signup")) {
    const { displayName, email, password } = await readBody(request);
    try {
      const user = createUserRecord({ displayName, email, password });
      if (!user) {
        sendJson(response, 400, { error: "Failed to create user account" });
        return true;
      }
      const token = createSession(user.id);
      sendJson(response, 200, { token, user: serializeUser(user) });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (method === "POST" && pathPart === "/api/auth/login") {
    const { identifier, password } = await readBody(request);
    const user = authenticateUser(identifier, password);
    if (!user) {
      sendJson(response, 401, { error: "Invalid username or password" });
      return true;
    }
    const token = createSession(user.id);
    sendJson(response, 200, { token, user: serializeUser(user) });
    return true;
  }

  if (method === "POST" && pathPart === "/api/auth/logout") {
    const session = getSessionFromRequest(request);
    if (session) {
      revokeSession(session.token);
    }
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (method === "GET" && pathPart === "/api/auth/me") {
    const user = getUserFromRequest(request);
    if (!user) {
      sendJson(response, 401, { error: "Authentication required" });
      return true;
    }
    sendJson(response, 200, { user: serializeUser(user) });
    return true;
  }

  if (method === "GET" && pathPart === "/api/me/rooms") {
    const user = getUserFromRequest(request);
    if (!user) {
      sendJson(response, 401, { error: "Authentication required" });
      return true;
    }
    const userRooms = getRoomsForUser(user.id);
    sendJson(response, 200, { rooms: userRooms, user: serializeUser(user) });
    return true;
  }

  if (method === "GET" && pathPart === "/api/rooms") {
    const summaries = [...rooms.values()]
      .map((room) => buildRoomSummary(room))
      .sort((left, right) => right.createdAt - left.createdAt);
    sendJson(response, 200, { rooms: summaries });
    return true;
  }

  if (method === "POST" && pathPart === "/api/rooms") {
    const user = getUserFromRequest(request);
    const { title } = await readBody(request);

    const roomCode = generateRoomCode();
    const ownerId = user ? user.id : null;
    const room = ensureRoom(roomCode, title, ownerId);

    if (user) {
      attachRoomToUser(user.id, roomCode);
    }

    broadcastRoomsList();
    sendJson(response, 200, { room: buildRoomSummary(room) });
    return true;
  }

  if (method === "GET" && pathPart.startsWith("/api/rooms/")) {
    const roomCode = normalizeRoomCode(pathPart.split("/").pop());
    const room = rooms.get(roomCode);
    if (!room) {
      sendJson(response, 404, { error: "Room not found" });
      return true;
    }
    sendJson(response, 200, { room: buildRoomSnapshot(room) });
    return true;
  }

  if (method === "DELETE" && pathPart.startsWith("/api/rooms/")) {
    const roomCode = normalizeRoomCode(pathPart.split("/").pop());
    const room = rooms.get(roomCode);
    if (!room) {
      sendJson(response, 404, { error: "Room not found" });
      return true;
    }

    const user = getUserFromRequest(request);
    if (room.ownerId && (!user || String(room.ownerId) !== String(user.id))) {
      sendJson(response, 403, { error: "Forbidden: You are not the owner of this room" });
      return true;
    }

    rooms.delete(roomCode);
    roomSync.delete(roomCode);
    if (user) {
      detachRoomFromUser(user.id, roomCode);
    }

    broadcastToUiSockets(getRoomMembers(roomCode), {
      type: "room:deleted",
      roomId: roomCode
    });

    getRoomMembers(roomCode).forEach((socket) => {
      const state = getSocketState(socket);
      state.rooms.delete(roomCode);
    });
    roomMembers.delete(roomCode);

    broadcastRoomsList();
    schedulePersist();
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

function getRequestPath(request) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  return path.normalize(path.join(publicDir, pathname));
}

async function serveStatic(request, response) {
  try {
    const filePath = getRequestPath(request);
    if (!filePath.startsWith(publicDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes.get(ext) || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    const handled = await handleApiRequest(request, response, url);
    if (!handled) {
      sendJson(response, 404, { error: "Not found" });
    }
    return;
  }

  void serveStatic(request, response);
});

const wss = new WebSocketServer({ noServer: true });
const syncWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const syncRoomMatch = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
  if (syncRoomMatch) {
    const roomId = normalizeRoomCode(syncRoomMatch[1]);
    if (!roomId || roomId !== syncRoomMatch[1]) {
      socket.destroy();
      return;
    }
    syncWss.handleUpgrade(request, socket, head, (ws) => {
      syncWss.emit("connection", ws, roomId);
    });
    return;
  }

  if (url.pathname !== "/ws" || url.search) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

syncWss.on("connection", (socket, roomId) => {
  roomSync.connect(roomId, socket);
});

wss.on("connection", (socket, request) => {
    connectedSockets.add(socket);

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      const state = getSocketState(socket);

      if (message.type === "auth:identify") {
        const token = String(message.token || "").trim();
        if (!token) {
          state.userId = null;
          state.sessionToken = null;
          sendJson(socket, { type: "auth:rejected" });
          return;
        }

        const session = sessionsByToken.get(token);
        if (!session) {
          state.userId = null;
          state.sessionToken = null;
          sendJson(socket, { type: "auth:rejected" });
          return;
        }

        const user = getUserById(session.userId);
        if (!user) {
          state.userId = null;
          state.sessionToken = null;
          sendJson(socket, { type: "auth:rejected" });
          return;
        }

        state.userId = user.id;
        state.sessionToken = token;
        state.nickname = user.displayName;

        sendJson(socket, {
          type: "auth:accepted",
          user: serializeUser(user)
        });

        for (const roomId of state.rooms) {
          attachRoomToUser(user.id, roomId);
          const room = rooms.get(roomId);
          if (room) {
            syncRoomParticipant(room, socket, { connected: true });
          }
        }
        for (const roomId of state.rooms) {
          broadcastRoomSnapshot(roomId);
        }
        broadcastRoomsList();
        return;
      }

      if (message.type === "room:join") {
        const roomId = normalizeRoomCode(message.roomId);
        if (!roomId) return;
        if (state.userId) {
          attachRoomToUser(state.userId, roomId);
        }
        joinRoom(roomId, socket, {
          nickname: message.nickname,
          clientId: message.clientId,
          canManageContent: message.canManageContent,
          hasExtension: message.hasExtension
        });
        return;
      }

      if (message.type === "presence:active") {
        if (message.nickname) {
          state.nickname = normalizeNickname(message.nickname);
        }
        if (!state.userId && message.userId) {
          state.userId = String(message.userId).trim() || null;
        }
        confirmSitePresence(state);
        return;
      }

      if (message.type === "room:leave") {
        const roomId = normalizeRoomCode(message.roomId);
        if (!roomId) return;
        leaveRoomFromUI(roomId, socket, { keepNotInRoom: message.keepNotInRoom === true });
        return;
      }

      if (message.type === "room:profile") {
        const roomId = normalizeRoomCode(message.roomId);
        if (!roomId) return;

        const previousNickname = state.nickname;
        const nextNickname = message.nickname ? normalizeNickname(message.nickname) : state.nickname;
        state.canManageContent = message.canManageContent !== false;
        state.hasExtension = message.hasExtension !== false;
        state.clientId = message.clientId || state.clientId;

        if (state.userId && nextNickname) {
          try {
            updateUserDisplayName(state.userId, nextNickname);
          } catch (error) {
            state.nickname = previousNickname;
            sendJson(socket, {
              type: "room:profile-rejected",
              roomId,
              reason: error.message || "Unable to update display name"
            });
            return;
          }
        }

        state.nickname = nextNickname;

        if (state.rooms.size === 0) {
          confirmSitePresence(state);
        }

        for (const joinedRoomId of state.rooms) {
          const room = rooms.get(joinedRoomId);
          if (room) {
            syncRoomParticipant(room, socket, { connected: true });
          }
          broadcastRoomSnapshot(joinedRoomId);
        }
        broadcastRoomsList();
        return;
      }

      if (message.type === "room:media-request") {
        const roomId = normalizeRoomCode(message.roomId);
        const room = rooms.get(roomId);
        if (!room) return;

        const candidates = [...getRoomMembers(roomId)]
          .filter((candidate) => candidate !== socket && getSocketState(candidate).hasExtension === true)
          .sort((left, right) => Number(getSocketState(right).role === "host") - Number(getSocketState(left).role === "host"));
        const recipient = candidates[0];
        if (!recipient) {
          sendJson(socket, {
            type: "room:error",
            roomId,
            message: "No participant can resolve this media request."
          });
          return;
        }

        sendJson(recipient, {
          type: "media-request",
          roomId,
          requestedSeasonId: message.requestedSeasonId || null,
          requestedEpisodeId: message.requestedEpisodeId || null,
          requestedQualityLabel: message.requestedQualityLabel || null,
          requestedTranslatorId: message.requestedTranslatorId || null,
          requestedBy: getSocketState(socket).clientId
        });
        return;
      }

      if (message.type === "room:participant-action") {
        const roomId = normalizeRoomCode(message.roomId);
        const targetClientId = String(message.targetClientId || "").trim();
        const action = String(message.action || "").trim();
        if (!roomId || !targetClientId || !action) return;

        const room = rooms.get(roomId);
        if (!room) return;

        if (state.role !== "host" && (!room.ownerId || String(room.ownerId) !== String(state.userId))) {
          sendJson(socket, {
            type: "room:participant-action-rejected",
            roomId,
            reason: "Only the creator can manage participants"
          });
          return;
        }

        const targetSocket = [...getRoomMembers(roomId)].find((candidate) => getSocketState(candidate).clientId === targetClientId);
        if (!targetSocket) return;

        const targetState = getSocketState(targetSocket);

        if (action === "kick") {
          leaveRoomFromUI(roomId, targetSocket);
          return;
        }

        if (action === "toggle-content") {
          if (targetState.hasExtension === false) {
            sendJson(socket, {
              type: "room:participant-action-rejected",
              roomId,
              action,
              reason: "Participant requires the extension"
            });
            return;
          }

          targetState.canManageContent = !targetState.canManageContent;
          syncRoomParticipant(room, targetSocket, { connected: true });
          broadcastRoomSnapshot(roomId);
          broadcastRoomsList();
          return;
        }

        if (action === "make-creator") {
          for (const member of getRoomMembers(roomId)) {
            const memberState = getSocketState(member);
            memberState.role = "guest";
          }

          targetState.role = "host";
          if (targetState.userId) {
            room.ownerId = targetState.userId;
            attachRoomToUser(targetState.userId, roomId);
          } else {
            room.ownerId = null;
          }

          syncRoomParticipant(room, targetSocket, { connected: true });

          if (socket.readyState === 1) {
            socket.send(
              JSON.stringify({
                type: "room:role",
                roomId,
                role: "guest"
              })
            );
          }

          if (targetSocket.readyState === 1) {
            targetSocket.send(
              JSON.stringify({
                type: "room:role",
                roomId,
                role: "host"
              })
            );
          }

          broadcastRoomSnapshot(roomId);
          broadcastRoomsList();
          return;
        }
      }

      if (message.type === "room:rename") {
        const roomId = normalizeRoomCode(message.roomId);
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        if (state.role !== "host" && String(room.ownerId || "") !== String(state.userId || "")) {
          sendJson(socket, {
            type: "room:rename-rejected",
            roomId,
            reason: "Only the creator can rename a room"
          });
          return;
        }

        const nextTitle = normalizeRoomTitle(message.title);
        if (!nextTitle) return;

        room.title = nextTitle;
        markRoomUpdated(roomId);
        broadcastRoomSnapshot(roomId);
        broadcastRoomsList();
        return;
      }

      if (message.type === "chat:message") {
        const roomId = normalizeRoomCode(message.roomId);
        const room = rooms.get(roomId);
        if (!room) return;

        const chatMessage = {
          id: crypto.randomUUID(),
          sentAt: now(),
          author: {
            nickname: state.nickname,
            role: state.role,
            clientId: state.clientId,
            userId: state.userId
          },
          text: String(message.text || "").trim()
        };

        room.chat.push(chatMessage);
        markRoomUpdated(roomId);

        broadcastToUiSockets(getRoomMembers(roomId), {
          type: "chat:message",
          roomId,
          message: chatMessage
        });
        broadcastRoomSnapshot(roomId);
        return;
      }

      if (message.type === "playlist:add") {
        const roomId = normalizeRoomCode(message.roomId);
        const room = rooms.get(roomId);
        if (!room || !message.item) return;

        const playlistItem = {
          id: crypto.randomUUID(),
          addedAt: now(),
          addedBy: {
            nickname: state.nickname,
            role: state.role,
            clientId: state.clientId
          },
          title: String(message.item.title || "Playlist item"),
          mediaUrl: String(message.item.mediaUrl || ""),
          pageUrl: message.item.pageUrl || null,
          seriesContext: message.item.seriesContext || null
        };

        room.playlist.push(playlistItem);
        markRoomUpdated(roomId);
        broadcastRoomSnapshot(roomId);
        return;
      }

      if (message.type === "playlist:suggest") {
        const roomId = normalizeRoomCode(message.roomId);
        const room = rooms.get(roomId);
        if (!room || !message.item) return;

        const chatMessage = {
          id: crypto.randomUUID(),
          sentAt: now(),
          author: {
            nickname: "System",
            role: "system",
            clientId: "system"
          },
          text: `${state.nickname} suggested watching: "${message.item.title || message.item.mediaUrl}"`
        };

        room.chat.push(chatMessage);
        markRoomUpdated(roomId);

        broadcastToUiSockets(getRoomMembers(roomId), {
          type: "chat:message",
          roomId,
          message: chatMessage
        });
        broadcastRoomSnapshot(roomId);
        return;
      }

      if (message.type === "playlist:activate") {
        const roomId = normalizeRoomCode(message.roomId);
        const room = rooms.get(roomId);
        if (!room) return;

        const item = room.playlist.find((i) => i.id === message.playlistItemId);
        if (!item) return;
        const syncResult = roomSync.setMedia(roomId, item.mediaUrl);
        if ("error" in syncResult) {
          sendJson(socket, {
            type: "room:error",
            roomId,
            message: syncResult.error
          });
          return;
        }

        room.currentMedia = {
          mediaUrl: item.mediaUrl,
          pageUrl: item.pageUrl || null,
          title: item.title,
          seriesContext: item.seriesContext || null,
          updatedAt: now()
        };

        room.currentPlayback = {
          state: "paused",
          time: 0,
          updatedAt: now()
        };

        markRoomUpdated(roomId);
        broadcastRoomSnapshot(roomId);
        broadcastRoomsList();
        return;
      }

      if (message.type === "series-context:set") {
        const roomId = normalizeRoomCode(message.roomId);
        const room = rooms.get(roomId);
        if (!room || !message.seriesContext) return;

        room.currentMedia = {
          mediaUrl: room.currentMedia?.mediaUrl || "",
          masterPlaylistUrl: room.currentMedia?.masterPlaylistUrl || null,
          pageUrl: message.pageUrl || room.currentMedia?.pageUrl || null,
          sourcePageUrl: message.sourcePageUrl || room.currentMedia?.sourcePageUrl || null,
          title: message.title || message.seriesContext.title || room.currentMedia?.title || null,
          seriesContext: message.seriesContext,
          updatedAt: now()
        };

        markRoomUpdated(roomId);
        const contextReceivedAt = now();
        sendJson(socket, {
          type: "series-context:ack",
          roomId,
          contextEventId: message.contextEventId || null,
          receivedAt: contextReceivedAt
        });
        broadcastToUiSockets(getRoomMembers(roomId), {
          type: "series-context:set",
          contextEventId: message.contextEventId || null,
          receivedAt: contextReceivedAt,
          roomId,
          pageUrl: room.currentMedia.pageUrl,
          sourcePageUrl: room.currentMedia.sourcePageUrl,
          title: room.currentMedia.title,
          seriesContext: room.currentMedia.seriesContext,
          originId: message.originId || null
        });
        return;
      }

      if (message.type === "media:set") {
        const roomId = normalizeRoomCode(message.roomId);
        const room = rooms.get(roomId);
        if (!room) return;
        const nextSeriesContext = message.seriesContext || room.currentMedia?.seriesContext || null;
        const mediaUrl = message.masterPlaylistUrl || message.mediaUrl;
        const syncResult = roomSync.setMedia(roomId, mediaUrl);
        if ("error" in syncResult) {
          sendJson(socket, {
            type: "room:error",
            roomId,
            message: syncResult.error
          });
          return;
        }

        room.currentMedia = {
          mediaUrl: String(message.mediaUrl || ""),
          masterPlaylistUrl: message.masterPlaylistUrl || null,
          pageUrl: message.pageUrl || null,
          sourcePageUrl: message.sourcePageUrl || null,
          title: message.title || null,
          seriesContext: nextSeriesContext,
          updatedAt: now()
        };

        room.currentPlayback = {
          state: "paused",
          time: 0,
          updatedAt: now()
        };

        markRoomUpdated(roomId);
        broadcastToUiSockets(getRoomMembers(roomId), {
          type: "media:set",
          roomId,
          mediaUrl: room.currentMedia.mediaUrl,
          masterPlaylistUrl: room.currentMedia.masterPlaylistUrl,
          pageUrl: room.currentMedia.pageUrl,
          sourcePageUrl: room.currentMedia.sourcePageUrl,
          title: room.currentMedia.title,
          seriesContext: room.currentMedia.seriesContext,
          originId: message.originId || null
        });
        broadcastRoomSnapshot(roomId);
        broadcastRoomsList();
        return;
      }
    });

    socket.on("close", () => {
      detachSocketFromRooms(socket);
      connectedSockets.delete(socket);
      socketState.delete(socket);
      broadcastRoomsList();
    });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the process that is bound to it and try again.`);
    process.exitCode = 1;
    return;
  }

  throw error;
});

async function startServer() {
  await roomSync.restore();
  await loadRoomsFromDisk();
  await loadAuthFromDisk();
  restoreSynchronizedMedia();

  server.listen(port, () => {
    console.log(`AnyTogether is running at http://localhost:${port}`);
  });
}

function restoreSynchronizedMedia() {
  for (const room of rooms.values()) {
    if (roomSync.getState(room.code)) {
      continue;
    }
    const mediaUrl = room.currentMedia?.masterPlaylistUrl || room.currentMedia?.mediaUrl;
    if (mediaUrl) {
      roomSync.setMedia(room.code, mediaUrl);
    }
  }
}

void startServer();
