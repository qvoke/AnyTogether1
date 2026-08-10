import { ensureDatabaseSchema } from "../db";
import {
  applyRoomAction,
  createEmptyRoomState,
  getPositionAt,
  isClientMessage,
  isRecord,
  isRoomState,
  type MediaSource,
  type RoomAction,
  type ServerMessage,
  validateMediaUrl,
} from "../lib/protocol";
import { getUserFromToken, serializeUser } from "./auth";
import type {
  ChatMessage,
  Participant,
  PlaylistItem,
  RoomSnapshot,
  SocketAttachment,
  StoredRoom,
  SyncSocketAttachment,
  UiMedia,
  UiSocketAttachment,
  WorkerEnv,
} from "./types";

const ROOM_KEY = "room";
const SYNC_STATE_KEY = "sync-state";
const ACTION_IDS_KEY = "recent-action-ids";
const CHAT_KEY = "chat";
const PLAYLIST_KEY = "playlist";
const PARTICIPANTS_KEY = "participants";
const SYNC_EXPIRY_KEY = "sync-expiry";
const OFFLINE_DEADLINES_KEY = "offline-deadlines";
const ROOM_TTL_MS = 24 * 60 * 60 * 1_000;
const OFFLINE_DELAY_MS = 15_000;
const MAX_MESSAGE_BYTES = 8_192;
const MAX_RECENT_ACTION_IDS = 128;
const OPEN = 1;

export class RoomDurableObject implements DurableObject {
  private actionIds: string[] = [];
  private chat: ChatMessage[] = [];
  private offlineDeadlines: Record<string, number> = {};
  private participants: Participant[] = [];
  private playlist: PlaylistItem[] = [];
  private readonly ready: Promise<void>;
  private room: StoredRoom | null = null;
  private syncExpiresAtMs: number | null = null;
  private syncState = createEmptyRoomState(Date.now());

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {
    this.ready = this.restore();
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_internal/")) {
      return this.handleInternalRequest(request, url.pathname);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    const code = extractRoomCode(url);
    if (!this.room && code) {
      await this.initializeRoom({ code, title: "Room", ownerId: null });
    }
    if (!this.room) {
      return json({ error: "Room not found" }, 404);
    }

    const kind = url.pathname.endsWith("/ws") && url.pathname.startsWith("/api/rooms/") ? "sync" : "ui";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = kind === "sync"
      ? { kind: "sync" }
      : createUiAttachment();
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, [kind]);

    if (kind === "sync") {
      this.sendSyncSnapshot(server);
      this.broadcastSyncPresence();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const messageText = toMessageText(rawMessage);
    if (!messageText || byteLength(messageText) > MAX_MESSAGE_BYTES) {
      this.sendSocketError(socket, "invalid-message", "The realtime message is invalid.");
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(messageText);
    } catch {
      this.sendSocketError(socket, "invalid-json", "The realtime message is not valid JSON.");
      return;
    }

    const attachment = getAttachment(socket);
    if (attachment.kind === "sync") {
      await this.handleSyncMessage(socket, message);
      return;
    }
    await this.handleUiMessage(socket, attachment, message);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    await this.ready;
    const attachment = getAttachment(socket);
    if (attachment.kind === "sync") {
      this.broadcastSyncPresence(socket);
    } else if (attachment.joined) {
      await this.scheduleParticipantOffline(attachment);
    }
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = getAttachment(socket);
    if (attachment.kind === "sync") {
      this.broadcastSyncPresence(socket);
    } else if (attachment.joined) {
      await this.scheduleParticipantOffline(attachment);
    }
  }

  async alarm(): Promise<void> {
    await this.ready;
    const timestamp = Date.now();
    let changed = false;

    for (const [participantKey, deadline] of Object.entries(this.offlineDeadlines)) {
      if (deadline > timestamp) {
        continue;
      }
      delete this.offlineDeadlines[participantKey];
      const participant = this.participants.find((candidate) => getParticipantKey(candidate) === participantKey);
      if (participant && !this.hasConnectedUiParticipant(participant)) {
        participant.connected = false;
        participant.presenceStatus = "offline";
        participant.socketId = null;
        participant.lastSeenAt = timestamp;
        changed = true;
      }
    }

    if (this.syncExpiresAtMs !== null && this.syncExpiresAtMs <= timestamp) {
      if (this.getSockets("sync").some(isOpen)) {
        this.syncExpiresAtMs = timestamp + ROOM_TTL_MS;
      } else {
        this.syncState = createEmptyRoomState(timestamp);
        this.actionIds = [];
        this.syncExpiresAtMs = null;
        if (this.room) {
          this.room.currentMedia = null;
          this.room.lastUpdatedAt = timestamp;
        }
        await this.state.storage.delete([SYNC_STATE_KEY, ACTION_IDS_KEY, SYNC_EXPIRY_KEY]);
        changed = true;
      }
    }

    await this.persistVolatileState();
    await this.scheduleNextAlarm();
    if (changed) {
      await this.persistSummary();
      this.broadcastUiSnapshot();
      this.broadcastSyncSnapshot();
    }
  }

  private async handleInternalRequest(request: Request, pathname: string): Promise<Response> {
    if (pathname === "/_internal/init" && request.method === "POST") {
      const body = await readJson(request);
      const code = String(body.code ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        return json({ error: "Invalid room code" }, 400);
      }
      await this.initializeRoom({
        code,
        title: normalizeRoomTitle(body.title) ?? "Room",
        ownerId: stringOrNull(body.ownerId),
      });
      return json({ room: this.buildSnapshot() });
    }

    if (pathname === "/_internal/snapshot" && request.method === "GET") {
      return this.room ? json({ room: this.buildSnapshot() }) : json({ error: "Room not found" }, 404);
    }

    if (pathname === "/_internal/delete" && request.method === "POST") {
      this.broadcastUi({ type: "room:deleted", roomId: this.room?.code ?? null });
      for (const socket of this.state.getWebSockets()) {
        socket.close(1000, "Room deleted");
      }
      await this.state.storage.deleteAll();
      this.room = null;
      this.chat = [];
      this.playlist = [];
      this.participants = [];
      this.actionIds = [];
      this.offlineDeadlines = {};
      this.syncExpiresAtMs = null;
      this.syncState = createEmptyRoomState(Date.now());
      return json({ ok: true });
    }

    if (pathname === "/_internal/site-presence" && request.method === "POST") {
      const body = await readJson(request);
      const userId = stringOrNull(body.userId);
      const nickname = normalizeNickname(body.nickname);
      const timestamp = Date.now();
      for (const participant of this.participants) {
        if ((userId && participant.userId === userId) || (!userId && participant.nickname === nickname)) {
          participant.connected = false;
          participant.presenceStatus = "not-in-room";
          participant.socketId = null;
          participant.lastSeenAt = timestamp;
          delete this.offlineDeadlines[getParticipantKey(participant)];
        }
      }
      await this.persistParticipants();
      await this.scheduleNextAlarm();
      this.broadcastUiSnapshot();
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleSyncMessage(socket: WebSocket, message: unknown): Promise<void> {
    if (!isClientMessage(message)) {
      this.sendSocketError(socket, "invalid-message", "The realtime message has an unsupported shape.");
      return;
    }
    if (message.type === "hello") {
      this.sendSyncSnapshot(socket);
      return;
    }
    if (message.type === "clockPing") {
      this.send(socket, { clientSendMs: message.clientSendMs, serverTimeMs: Date.now(), type: "clockPong" });
      return;
    }
    await this.acceptAction(socket, message.action);
  }

  private async acceptAction(socket: WebSocket, action: RoomAction): Promise<void> {
    if (this.actionIds.includes(action.actionId)) {
      this.sendSyncSnapshot(socket);
      return;
    }

    const serverTimeMs = Date.now();
    if (action.type === "setMedia") {
      const validated = validateMediaUrl(action.url);
      if ("error" in validated) {
        this.sendSocketError(socket, "invalid-media-url", validated.error);
        return;
      }
      const media: MediaSource = {
        id: crypto.randomUUID(),
        kind: validated.kind,
        url: validated.url,
      };
      this.syncState = applyRoomAction(this.syncState, action, serverTimeMs, media);
      if (this.room) {
        this.room.currentMedia = mergeUiMedia(this.room.currentMedia, validated.url, serverTimeMs);
      }
    } else {
      if (!this.syncState.media || action.mediaId !== this.syncState.media.id) {
        this.sendSyncSnapshot(socket);
        return;
      }
      this.syncState = applyRoomAction(this.syncState, action, serverTimeMs);
    }

    this.actionIds.push(action.actionId);
    this.actionIds = this.actionIds.slice(-MAX_RECENT_ACTION_IDS);
    this.syncExpiresAtMs = serverTimeMs + ROOM_TTL_MS;
    if (this.room) {
      this.room.lastUpdatedAt = serverTimeMs;
    }
    const syncStorage: Record<string, unknown> = {
      [SYNC_STATE_KEY]: this.syncState,
      [ACTION_IDS_KEY]: this.actionIds,
      [SYNC_EXPIRY_KEY]: this.syncExpiresAtMs,
    };
    if (this.room) {
      syncStorage[ROOM_KEY] = this.room;
    }
    await this.state.storage.put(syncStorage, { allowUnconfirmed: true });
    await this.scheduleNextAlarm(true);
    this.broadcastSyncSnapshot();
    if (action.type === "setMedia") {
      this.broadcastUiSnapshot();
      this.queueSummaryPersistence();
    }
  }

  private async handleUiMessage(
    socket: WebSocket,
    attachment: UiSocketAttachment,
    message: unknown,
  ): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      this.send(socket, { type: "room:error", roomId: this.room?.code, message: "Invalid realtime message." });
      return;
    }

    if (message.type === "auth:identify") {
      const token = stringOrNull(message.token);
      const user = await getUserFromToken(this.env.DB, token);
      if (!user) {
        attachment.token = null;
        attachment.userId = null;
        socket.serializeAttachment(attachment);
        this.send(socket, { type: "auth:rejected" });
        return;
      }
      attachment.token = token;
      attachment.userId = user.id;
      attachment.nickname = user.display_name;
      socket.serializeAttachment(attachment);
      this.send(socket, { type: "auth:accepted", user: await serializeUser(this.env.DB, user) });
      return;
    }

    if (message.type === "room:join") {
      await this.joinRoom(socket, attachment, message);
      return;
    }

    if (message.type === "presence:active") {
      await this.markParticipantNotInRoom(attachment, message.nickname);
      return;
    }

    if (message.type === "room:leave") {
      await this.leaveRoom(socket, attachment, message.keepNotInRoom === true);
      return;
    }

    if (!attachment.joined || !this.room) {
      return;
    }

    if (message.type === "room:profile") {
      await this.updateProfile(socket, attachment, message);
    } else if (message.type === "room:media-request") {
      this.forwardMediaRequest(socket, attachment, message);
    } else if (message.type === "room:participant-action") {
      await this.handleParticipantAction(socket, attachment, message);
    } else if (message.type === "room:rename") {
      await this.renameRoom(socket, attachment, message.title);
    } else if (message.type === "chat:message") {
      await this.addChatMessage(attachment, message.text);
    } else if (message.type === "playlist:add") {
      await this.addPlaylistItem(attachment, message.item);
    } else if (message.type === "playlist:suggest") {
      await this.suggestPlaylistItem(attachment, message.item);
    } else if (message.type === "playlist:activate") {
      await this.activatePlaylistItem(socket, message.playlistItemId);
    } else if (message.type === "series-context:set") {
      await this.setSeriesContext(socket, message);
    } else if (message.type === "media:set") {
      await this.setUiMedia(socket, message);
    }
  }

  private async joinRoom(
    socket: WebSocket,
    attachment: UiSocketAttachment,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (!this.room) {
      return;
    }
    attachment.clientId = stringOrNull(message.clientId) ?? attachment.clientId;
    attachment.nickname = message.nickname ? normalizeNickname(message.nickname) : attachment.nickname;
    attachment.hasExtension = message.hasExtension !== false;
    attachment.canManageContent = message.canManageContent !== false && attachment.hasExtension;
    const existing = this.findParticipant(attachment);
    const firstParticipant = this.participants.length === 0;
    const isOwner = Boolean(attachment.userId && this.room.ownerId === attachment.userId);
    attachment.role = isOwner || firstParticipant || existing?.role === "host" ? "host" : "guest";
    attachment.joined = true;
    socket.serializeAttachment(attachment);
    this.upsertParticipant(attachment, true);
    if (attachment.userId) {
      await this.env.DB.prepare("INSERT OR IGNORE INTO user_rooms (user_id, room_code, joined_at_ms) VALUES (?, ?, ?)")
        .bind(attachment.userId, this.room.code, Date.now()).run();
    }
    await this.persistParticipants();
    await this.persistSummary();
    this.send(socket, { type: "room:snapshot", roomId: this.room.code, room: this.buildSnapshot() });
    this.send(socket, { type: "room:role", roomId: this.room.code, role: attachment.role });
    this.broadcastUiSnapshot();
  }

  private async leaveRoom(socket: WebSocket, attachment: UiSocketAttachment, keepNotInRoom: boolean): Promise<void> {
    const participant = this.findParticipant(attachment);
    if (participant) {
      if (keepNotInRoom) {
        participant.connected = false;
        participant.presenceStatus = "not-in-room";
        participant.socketId = null;
        participant.lastSeenAt = Date.now();
      } else {
        this.participants = this.participants.filter((candidate) => candidate !== participant);
      }
    }
    if (attachment.userId && this.room) {
      await this.env.DB.prepare("DELETE FROM user_rooms WHERE user_id = ? AND room_code = ?")
        .bind(attachment.userId, this.room.code).run();
    }
    const wasHost = attachment.role === "host";
    attachment.joined = false;
    attachment.role = "guest";
    socket.serializeAttachment(attachment);
    if (wasHost) {
      await this.assignNextHost();
    }
    await this.persistParticipants();
    await this.persistSummary();
    this.broadcastUiSnapshot();
  }

  private async updateProfile(
    socket: WebSocket,
    attachment: UiSocketAttachment,
    message: Record<string, unknown>,
  ): Promise<void> {
    const nextNickname = normalizeNickname(message.nickname ?? attachment.nickname);
    if (attachment.userId) {
      const duplicate = await this.env.DB.prepare("SELECT id FROM users WHERE display_name_lower = ? AND id <> ?")
        .bind(nextNickname.toLowerCase(), attachment.userId).first();
      if (duplicate) {
        this.send(socket, { type: "room:profile-rejected", roomId: this.room?.code, reason: "Display name already registered" });
        return;
      }
      try {
        await this.env.DB.prepare("UPDATE users SET display_name = ?, display_name_lower = ?, last_login_at_ms = ? WHERE id = ?")
          .bind(nextNickname, nextNickname.toLowerCase(), Date.now(), attachment.userId).run();
      } catch {
        this.send(socket, { type: "room:profile-rejected", roomId: this.room?.code, reason: "Display name already registered" });
        return;
      }
    }
    attachment.nickname = nextNickname;
    attachment.clientId = stringOrNull(message.clientId) ?? attachment.clientId;
    attachment.hasExtension = message.hasExtension !== false;
    attachment.canManageContent = message.canManageContent !== false && attachment.hasExtension;
    socket.serializeAttachment(attachment);
    this.upsertParticipant(attachment, true);
    await this.persistParticipants();
    this.broadcastUiSnapshot();
  }

  private forwardMediaRequest(
    sender: WebSocket,
    attachment: UiSocketAttachment,
    message: Record<string, unknown>,
  ): void {
    const recipient = this.getSockets("ui")
      .filter((socket) => socket !== sender)
      .map((socket) => ({ socket, attachment: getAttachment(socket) }))
      .filter((entry): entry is { attachment: UiSocketAttachment; socket: WebSocket } =>
        entry.attachment.kind === "ui" && entry.attachment.joined && entry.attachment.hasExtension)
      .sort((left, right) => Number(right.attachment.role === "host") - Number(left.attachment.role === "host"))[0];
    if (!recipient) {
      this.send(sender, { type: "room:error", roomId: this.room?.code, message: "No participant can resolve this media request." });
      return;
    }
    this.send(recipient.socket, {
      type: "media-request",
      roomId: this.room?.code,
      requestedSeasonId: message.requestedSeasonId ?? null,
      requestedEpisodeId: message.requestedEpisodeId ?? null,
      requestedQualityLabel: message.requestedQualityLabel ?? null,
      requestedTranslatorId: message.requestedTranslatorId ?? null,
      requestedBy: attachment.clientId,
    });
  }

  private async handleParticipantAction(
    socket: WebSocket,
    attachment: UiSocketAttachment,
    message: Record<string, unknown>,
  ): Promise<void> {
    const isOwner = Boolean(this.room?.ownerId && this.room.ownerId === attachment.userId);
    if (!this.room || (attachment.role !== "host" && !isOwner)) {
      this.send(socket, { type: "room:participant-action-rejected", roomId: this.room?.code, reason: "Only the creator can manage participants" });
      return;
    }
    const targetClientId = stringOrNull(message.targetClientId);
    const action = String(message.action ?? "");
    if (!targetClientId) {
      return;
    }
    const targetSocket = this.getSockets("ui").find((candidate) => {
      const target = getAttachment(candidate);
      return target.kind === "ui" && target.clientId === targetClientId;
    });
    if (!targetSocket) {
      return;
    }
    const target = getAttachment(targetSocket) as UiSocketAttachment;
    if (action === "kick") {
      await this.leaveRoom(targetSocket, target, false);
      this.send(targetSocket, { type: "room:kicked", roomId: this.room.code });
    } else if (action === "toggle-content") {
      if (!target.hasExtension) {
        this.send(socket, { type: "room:participant-action-rejected", roomId: this.room.code, action, reason: "Participant requires the extension" });
        return;
      }
      target.canManageContent = !target.canManageContent;
      targetSocket.serializeAttachment(target);
      this.upsertParticipant(target, true);
    } else if (action === "make-creator") {
      for (const candidate of this.getSockets("ui")) {
        const candidateAttachment = getAttachment(candidate);
        if (candidateAttachment.kind !== "ui" || !candidateAttachment.joined) {
          continue;
        }
        candidateAttachment.role = candidate === targetSocket ? "host" : "guest";
        candidate.serializeAttachment(candidateAttachment);
        this.upsertParticipant(candidateAttachment, true);
        this.send(candidate, { type: "room:role", roomId: this.room.code, role: candidateAttachment.role });
      }
      this.room.ownerId = target.userId;
      if (target.userId) {
        await this.env.DB.prepare("INSERT OR IGNORE INTO user_rooms (user_id, room_code, joined_at_ms) VALUES (?, ?, ?)")
          .bind(target.userId, this.room.code, Date.now()).run();
      }
      await this.state.storage.put(ROOM_KEY, this.room);
    }
    await this.persistParticipants();
    await this.persistSummary();
    this.broadcastUiSnapshot();
  }

  private async renameRoom(socket: WebSocket, attachment: UiSocketAttachment, title: unknown): Promise<void> {
    const isOwner = Boolean(this.room?.ownerId && this.room.ownerId === attachment.userId);
    if (!this.room || (attachment.role !== "host" && !isOwner)) {
      this.send(socket, { type: "room:rename-rejected", roomId: this.room?.code, reason: "Only the creator can rename a room" });
      return;
    }
    const normalized = normalizeRoomTitle(title);
    if (!normalized) {
      return;
    }
    this.room.title = normalized;
    this.room.lastUpdatedAt = Date.now();
    await this.state.storage.put(ROOM_KEY, this.room);
    await this.persistSummary();
    this.broadcastUiSnapshot();
  }

  private async addChatMessage(attachment: UiSocketAttachment, text: unknown): Promise<void> {
    if (!this.room) {
      return;
    }
    const normalized = String(text ?? "").trim().slice(0, 4_000);
    if (!normalized) {
      return;
    }
    const chatMessage: ChatMessage = {
      id: crypto.randomUUID(),
      sentAt: Date.now(),
      author: {
        nickname: attachment.nickname,
        role: attachment.role,
        clientId: attachment.clientId,
        userId: attachment.userId,
      },
      text: normalized,
    };
    this.chat.push(chatMessage);
    this.room.lastUpdatedAt = Date.now();
    await Promise.all([this.state.storage.put(CHAT_KEY, this.chat), this.state.storage.put(ROOM_KEY, this.room)]);
    await this.persistSummary();
    this.broadcastUi({ type: "chat:message", roomId: this.room.code, message: chatMessage });
    this.broadcastUiSnapshot();
  }

  private async addPlaylistItem(attachment: UiSocketAttachment, value: unknown): Promise<void> {
    if (!this.room || !isRecord(value)) {
      return;
    }
    const item: PlaylistItem = {
      id: crypto.randomUUID(),
      addedAt: Date.now(),
      addedBy: { nickname: attachment.nickname, role: attachment.role, clientId: attachment.clientId },
      title: String(value.title ?? "Playlist item").slice(0, 300),
      mediaUrl: String(value.mediaUrl ?? ""),
      pageUrl: stringOrNull(value.pageUrl),
      seriesContext: isRecord(value.seriesContext) ? value.seriesContext : null,
    };
    this.playlist.push(item);
    this.room.lastUpdatedAt = Date.now();
    await Promise.all([this.state.storage.put(PLAYLIST_KEY, this.playlist), this.state.storage.put(ROOM_KEY, this.room)]);
    await this.persistSummary();
    this.broadcastUiSnapshot();
  }

  private async suggestPlaylistItem(attachment: UiSocketAttachment, value: unknown): Promise<void> {
    if (!isRecord(value)) {
      return;
    }
    await this.addChatMessage({ ...attachment, nickname: "System", role: "guest" },
      `${attachment.nickname} suggested watching: "${String(value.title ?? value.mediaUrl ?? "")}"`);
  }

  private async activatePlaylistItem(socket: WebSocket, itemId: unknown): Promise<void> {
    const item = this.playlist.find((candidate) => candidate.id === itemId);
    if (!item) {
      return;
    }
    await this.applyMediaFromUi(socket, item.mediaUrl, {
      mediaUrl: item.mediaUrl,
      pageUrl: item.pageUrl,
      title: item.title,
      seriesContext: item.seriesContext,
    });
  }

  private async setSeriesContext(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
    if (!this.room || !isRecord(message.seriesContext)) {
      return;
    }
    const timestamp = Date.now();
    this.room.currentMedia = {
      mediaUrl: this.room.currentMedia?.mediaUrl ?? "",
      masterPlaylistUrl: this.room.currentMedia?.masterPlaylistUrl ?? null,
      pageUrl: stringOrNull(message.pageUrl) ?? this.room.currentMedia?.pageUrl ?? null,
      sourcePageUrl: stringOrNull(message.sourcePageUrl) ?? this.room.currentMedia?.sourcePageUrl ?? null,
      title: stringOrNull(message.title) ?? stringOrNull(message.seriesContext.title) ?? this.room.currentMedia?.title ?? null,
      seriesContext: message.seriesContext,
      updatedAt: timestamp,
    };
    this.room.lastUpdatedAt = timestamp;
    await this.state.storage.put(ROOM_KEY, this.room);
    await this.persistSummary();
    this.send(socket, { type: "series-context:ack", roomId: this.room.code, contextEventId: message.contextEventId ?? null, receivedAt: timestamp });
    this.broadcastUi({
      type: "series-context:set",
      roomId: this.room.code,
      contextEventId: message.contextEventId ?? null,
      receivedAt: timestamp,
      pageUrl: this.room.currentMedia.pageUrl,
      sourcePageUrl: this.room.currentMedia.sourcePageUrl,
      title: this.room.currentMedia.title,
      seriesContext: this.room.currentMedia.seriesContext,
      originId: message.originId ?? null,
    });
  }

  private async setUiMedia(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
    const syncUrl = String(message.masterPlaylistUrl ?? message.mediaUrl ?? "");
    await this.applyMediaFromUi(socket, syncUrl, {
      mediaUrl: String(message.mediaUrl ?? ""),
      masterPlaylistUrl: stringOrNull(message.masterPlaylistUrl),
      pageUrl: stringOrNull(message.pageUrl),
      sourcePageUrl: stringOrNull(message.sourcePageUrl),
      title: stringOrNull(message.title),
      seriesContext: isRecord(message.seriesContext) ? message.seriesContext : this.room?.currentMedia?.seriesContext ?? null,
    }, message.originId);
  }

  private async applyMediaFromUi(
    socket: WebSocket,
    syncUrl: string,
    metadata: Omit<UiMedia, "updatedAt">,
    originId: unknown = null,
  ): Promise<void> {
    if (!this.room) {
      return;
    }
    const validated = validateMediaUrl(syncUrl);
    if ("error" in validated) {
      this.send(socket, { type: "room:error", roomId: this.room.code, message: validated.error });
      return;
    }
    const timestamp = Date.now();
    const action: RoomAction = {
      type: "setMedia",
      actionId: crypto.randomUUID(),
      knownVersion: this.syncState.version,
      mediaId: this.syncState.media?.id ?? null,
      url: validated.url,
    };
    const media: MediaSource = { id: crypto.randomUUID(), kind: validated.kind, url: validated.url };
    this.syncState = applyRoomAction(this.syncState, action, timestamp, media);
    this.actionIds.push(action.actionId);
    this.actionIds = this.actionIds.slice(-MAX_RECENT_ACTION_IDS);
    this.syncExpiresAtMs = timestamp + ROOM_TTL_MS;
    this.room.currentMedia = { ...metadata, updatedAt: timestamp };
    this.room.lastUpdatedAt = timestamp;
    await Promise.all([
      this.state.storage.put(SYNC_STATE_KEY, this.syncState),
      this.state.storage.put(ACTION_IDS_KEY, this.actionIds),
      this.state.storage.put(SYNC_EXPIRY_KEY, this.syncExpiresAtMs),
      this.state.storage.put(ROOM_KEY, this.room),
    ]);
    await this.scheduleNextAlarm();
    this.broadcastSyncSnapshot();
    this.broadcastUi({
      type: "media:set",
      roomId: this.room.code,
      mediaUrl: this.room.currentMedia.mediaUrl,
      masterPlaylistUrl: this.room.currentMedia.masterPlaylistUrl ?? null,
      pageUrl: this.room.currentMedia.pageUrl ?? null,
      sourcePageUrl: this.room.currentMedia.sourcePageUrl ?? null,
      title: this.room.currentMedia.title ?? null,
      seriesContext: this.room.currentMedia.seriesContext ?? null,
      originId,
    });
    this.broadcastUiSnapshot();
    this.queueSummaryPersistence();
  }

  private async initializeRoom(input: { code: string; ownerId: string | null; title: string }): Promise<void> {
    if (this.room) {
      return;
    }
    const timestamp = Date.now();
    this.room = {
      code: input.code,
      title: input.title,
      ownerId: input.ownerId,
      createdAt: timestamp,
      sessionStartedAt: timestamp,
      lastUpdatedAt: timestamp,
      currentMedia: null,
    };
    this.syncState = createEmptyRoomState(timestamp);
    await Promise.all([
      this.state.storage.put(ROOM_KEY, this.room),
      this.state.storage.put(SYNC_STATE_KEY, this.syncState),
    ]);
    await this.persistSummary();
  }

  private async restore(): Promise<void> {
    const [room, syncState, actionIds, chat, playlist, participants, syncExpiry, offlineDeadlines] = await Promise.all([
      this.state.storage.get<StoredRoom>(ROOM_KEY),
      this.state.storage.get<unknown>(SYNC_STATE_KEY),
      this.state.storage.get<string[]>(ACTION_IDS_KEY),
      this.state.storage.get<ChatMessage[]>(CHAT_KEY),
      this.state.storage.get<PlaylistItem[]>(PLAYLIST_KEY),
      this.state.storage.get<Participant[]>(PARTICIPANTS_KEY),
      this.state.storage.get<number>(SYNC_EXPIRY_KEY),
      this.state.storage.get<Record<string, number>>(OFFLINE_DEADLINES_KEY),
    ]);
    this.room = room ?? null;
    if (isRoomState(syncState)) {
      this.syncState = syncState;
    }
    this.actionIds = Array.isArray(actionIds) ? actionIds.filter((id) => typeof id === "string").slice(-MAX_RECENT_ACTION_IDS) : [];
    this.chat = Array.isArray(chat) ? chat : [];
    this.playlist = Array.isArray(playlist) ? playlist : [];
    this.participants = Array.isArray(participants) ? participants : [];
    this.syncExpiresAtMs = typeof syncExpiry === "number" && Number.isFinite(syncExpiry) ? syncExpiry : null;
    this.offlineDeadlines = isRecord(offlineDeadlines)
      ? Object.fromEntries(Object.entries(offlineDeadlines).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
      : {};
  }

  private buildSnapshot(): RoomSnapshot {
    if (!this.room) {
      throw new Error("Room state is unavailable");
    }
    const timestamp = Date.now();
    const participants = [...this.participants].sort(compareParticipants);
    return {
      code: this.room.code,
      title: this.room.title,
      createdAt: this.room.createdAt,
      sessionStartedAt: this.room.sessionStartedAt,
      memberCount: participants.filter((participant) => participant.connected).length,
      participants,
      chat: this.chat,
      playlist: this.playlist,
      currentMedia: this.room.currentMedia,
      currentPlayback: {
        state: this.syncState.playback.paused ? "paused" : "playing",
        time: getPositionAt(this.syncState, timestamp),
        updatedAt: this.syncState.updatedAtMs,
        version: this.syncState.version,
      },
      lastUpdatedAt: this.room.lastUpdatedAt,
    };
  }

  private upsertParticipant(attachment: UiSocketAttachment, connected: boolean): Participant {
    const existing = this.findParticipant(attachment);
    const timestamp = Date.now();
    const participant: Participant = {
      socketId: attachment.socketId,
      clientId: attachment.clientId,
      userId: attachment.userId,
      nickname: attachment.nickname,
      role: attachment.role,
      canManageContent: attachment.canManageContent,
      hasExtension: attachment.hasExtension,
      connected,
      presenceStatus: connected ? "online" : "offline",
      joinedAt: existing?.joinedAt ?? timestamp,
      lastSeenAt: timestamp,
    };
    if (existing) {
      Object.assign(existing, participant);
      delete this.offlineDeadlines[getParticipantKey(existing)];
      return existing;
    }
    this.participants.push(participant);
    return participant;
  }

  private findParticipant(attachment: UiSocketAttachment): Participant | undefined {
    return this.participants.find((participant) =>
      Boolean(attachment.clientId && participant.clientId === attachment.clientId) ||
      Boolean(attachment.userId && participant.userId === attachment.userId) ||
      participant.socketId === attachment.socketId ||
      (!attachment.userId && !participant.userId && participant.nickname === attachment.nickname));
  }

  private async markParticipantNotInRoom(attachment: UiSocketAttachment, nickname: unknown): Promise<void> {
    attachment.nickname = nickname ? normalizeNickname(nickname) : attachment.nickname;
    const participant = this.findParticipant(attachment);
    if (!participant) {
      return;
    }
    participant.connected = false;
    participant.presenceStatus = "not-in-room";
    participant.socketId = null;
    participant.lastSeenAt = Date.now();
    delete this.offlineDeadlines[getParticipantKey(participant)];
    await this.persistParticipants();
    await this.scheduleNextAlarm();
    this.broadcastUiSnapshot();
  }

  private async scheduleParticipantOffline(attachment: UiSocketAttachment): Promise<void> {
    const participant = this.findParticipant(attachment);
    if (!participant) {
      return;
    }
    this.offlineDeadlines[getParticipantKey(participant)] = Date.now() + OFFLINE_DELAY_MS;
    await this.state.storage.put(OFFLINE_DEADLINES_KEY, this.offlineDeadlines);
    await this.scheduleNextAlarm();
  }

  private async assignNextHost(): Promise<void> {
    const nextSocket = this.getSockets("ui").find((socket) => {
      const attachment = getAttachment(socket);
      return attachment.kind === "ui" && attachment.joined;
    });
    if (!nextSocket || !this.room) {
      return;
    }
    const attachment = getAttachment(nextSocket) as UiSocketAttachment;
    attachment.role = "host";
    nextSocket.serializeAttachment(attachment);
    this.upsertParticipant(attachment, true);
    this.room.ownerId = attachment.userId;
    await this.state.storage.put(ROOM_KEY, this.room);
    this.send(nextSocket, { type: "room:role", roomId: this.room.code, role: "host" });
  }

  private hasConnectedUiParticipant(participant: Participant): boolean {
    return this.getSockets("ui").some((socket) => {
      const attachment = getAttachment(socket);
      return attachment.kind === "ui" && attachment.joined && (
        Boolean(participant.clientId && attachment.clientId === participant.clientId) ||
        Boolean(participant.userId && attachment.userId === participant.userId) ||
        participant.socketId === attachment.socketId
      );
    });
  }

  private async persistParticipants(): Promise<void> {
    await Promise.all([
      this.state.storage.put(PARTICIPANTS_KEY, this.participants),
      this.state.storage.put(OFFLINE_DEADLINES_KEY, this.offlineDeadlines),
    ]);
  }

  private async persistVolatileState(): Promise<void> {
    await Promise.all([
      this.state.storage.put(PARTICIPANTS_KEY, this.participants),
      this.state.storage.put(OFFLINE_DEADLINES_KEY, this.offlineDeadlines),
      this.syncExpiresAtMs === null
        ? this.state.storage.delete(SYNC_EXPIRY_KEY)
        : this.state.storage.put(SYNC_EXPIRY_KEY, this.syncExpiresAtMs),
      this.room ? this.state.storage.put(ROOM_KEY, this.room) : Promise.resolve(),
    ]);
  }

  private async persistSummary(): Promise<void> {
    if (!this.room) {
      return;
    }
    await ensureDatabaseSchema(this.env.DB);
    const snapshot = this.buildSnapshot();
    await this.env.DB.prepare(`INSERT INTO rooms (
      code, title, owner_id, created_at_ms, session_started_at_ms, last_updated_at_ms,
      member_count, chat_count, playlist_count, current_media_title, current_media_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      title = excluded.title,
      owner_id = excluded.owner_id,
      last_updated_at_ms = excluded.last_updated_at_ms,
      member_count = excluded.member_count,
      chat_count = excluded.chat_count,
      playlist_count = excluded.playlist_count,
      current_media_title = excluded.current_media_title,
      current_media_url = excluded.current_media_url`)
      .bind(
        snapshot.code,
        snapshot.title,
        this.room.ownerId,
        snapshot.createdAt,
        snapshot.sessionStartedAt,
        snapshot.lastUpdatedAt,
        snapshot.memberCount,
        snapshot.chat.length,
        snapshot.playlist.length,
        snapshot.currentMedia?.title ?? snapshot.currentMedia?.seriesContext?.title ?? null,
        snapshot.currentMedia?.mediaUrl ?? null,
      ).run();
    await this.notifyDirectory();
  }

  private async notifyDirectory(): Promise<void> {
    const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
    await stub.fetch(new Request("https://directory.internal/_internal/rooms-changed", { method: "POST" }));
  }

  private queueSummaryPersistence(): void {
    this.state.waitUntil(this.persistSummary().catch((error: unknown) => {
      console.error("Failed to persist the room directory summary", error);
    }));
  }

  private async scheduleNextAlarm(allowUnconfirmed = false): Promise<void> {
    const options = allowUnconfirmed ? { allowUnconfirmed: true } : undefined;
    const deadlines = Object.values(this.offlineDeadlines);
    if (this.syncExpiresAtMs !== null) {
      deadlines.push(this.syncExpiresAtMs);
    }
    if (deadlines.length > 0) {
      await this.state.storage.setAlarm(Math.min(...deadlines), options);
    } else {
      await this.state.storage.deleteAlarm(options);
    }
  }

  private broadcastSyncSnapshot(): void {
    for (const socket of this.getSockets("sync")) {
      this.sendSyncSnapshot(socket);
    }
  }

  private broadcastSyncPresence(excluded?: WebSocket): void {
    const sockets = this.getSockets("sync").filter((socket) => socket !== excluded && isOpen(socket));
    const message: ServerMessage = { type: "presence", count: sockets.length, serverTimeMs: Date.now() };
    for (const socket of sockets) {
      this.send(socket, message);
    }
  }

  private sendSyncSnapshot(socket: WebSocket): void {
    this.send(socket, { type: "snapshot", state: this.syncState, serverTimeMs: Date.now() });
  }

  private sendSocketError(socket: WebSocket, code: string, message: string): void {
    const attachment = getAttachment(socket);
    if (attachment.kind === "sync") {
      this.send(socket, { type: "error", code, message });
    } else {
      this.send(socket, { type: "room:error", roomId: this.room?.code ?? null, message });
    }
  }

  private broadcastUiSnapshot(): void {
    if (!this.room) {
      return;
    }
    this.broadcastUi({ type: "room:snapshot", roomId: this.room.code, room: this.buildSnapshot() });
  }

  private broadcastUi(payload: unknown): void {
    for (const socket of this.getSockets("ui")) {
      const attachment = getAttachment(socket);
      if (attachment.kind === "ui" && attachment.joined) {
        this.send(socket, payload);
      }
    }
  }

  private getSockets(kind: "sync" | "ui"): WebSocket[] {
    return this.state.getWebSockets(kind).filter(isOpen);
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (isOpen(socket)) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function createUiAttachment(): UiSocketAttachment {
  return {
    kind: "ui",
    socketId: crypto.randomUUID(),
    nickname: "Guest",
    role: "guest",
    canManageContent: true,
    hasExtension: false,
    clientId: null,
    userId: null,
    token: null,
    joined: false,
  };
}

function getAttachment(socket: WebSocket): SocketAttachment {
  const attachment = socket.deserializeAttachment() as SocketAttachment | null;
  return attachment?.kind === "ui" || attachment?.kind === "sync" ? attachment : { kind: "sync" };
}

function extractRoomCode(url: URL): string | null {
  const roomQuery = url.searchParams.get("room")?.toUpperCase();
  const pathMatch = /^\/api\/rooms\/([A-Z0-9]{6})\/ws$/.exec(url.pathname);
  const code = roomQuery ?? pathMatch?.[1] ?? null;
  return code && /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

function normalizeNickname(value: unknown): string {
  return String(value ?? "").trim().slice(0, 40) || "Guest";
}

function normalizeRoomTitle(value: unknown): string | null {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || null;
}

function stringOrNull(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function getParticipantKey(participant: Participant): string {
  return participant.userId ? `user:${participant.userId}`
    : participant.clientId ? `client:${participant.clientId}`
      : `socket:${participant.socketId ?? participant.nickname}`;
}

function compareParticipants(left: Participant, right: Participant): number {
  if (left.role !== right.role) {
    return left.role === "host" ? -1 : 1;
  }
  const priority = { online: 0, "not-in-room": 1, offline: 2 };
  const presenceDifference = priority[left.presenceStatus] - priority[right.presenceStatus];
  return presenceDifference || left.joinedAt - right.joinedAt;
}

function mergeUiMedia(current: UiMedia | null, url: string, timestamp: number): UiMedia {
  return {
    mediaUrl: url,
    masterPlaylistUrl: url.endsWith(".m3u8") ? url : null,
    pageUrl: current?.pageUrl ?? null,
    sourcePageUrl: current?.sourcePageUrl ?? null,
    title: current?.title ?? null,
    seriesContext: current?.seriesContext ?? null,
    updatedAt: timestamp,
  };
}

function isOpen(socket: WebSocket): boolean {
  return socket.readyState === OPEN;
}

function toMessageText(value: string | ArrayBuffer): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value.byteLength > MAX_MESSAGE_BYTES) {
    return null;
  }
  return new TextDecoder().decode(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
