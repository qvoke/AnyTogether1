import { ensureDatabaseSchema, listRooms } from "../db";
import { getUserFromToken, serializeUser } from "./auth";
import { isRecord } from "../lib/protocol";
import type { WorkerEnv } from "./types";

interface DirectoryAttachment {
  kind: "directory";
  nickname: string;
  token: string | null;
  userId: string | null;
}

const MAX_MESSAGE_BYTES = 8_192;
const OPEN = 1;

export class DirectoryDurableObject implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_internal/rooms-changed" && request.method === "POST") {
      await this.broadcastRooms();
      return Response.json({ ok: true });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    await ensureDatabaseSchema(this.env.DB);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: DirectoryAttachment = {
      kind: "directory",
      nickname: "Guest",
      token: null,
      userId: null,
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, ["directory"]);
    this.send(server, { type: "rooms:update", rooms: await listRooms(this.env.DB) });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      this.send(socket, { type: "directory:error", message: "The realtime message is invalid." });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.send(socket, { type: "directory:error", message: "The realtime message is not valid JSON." });
      return;
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      this.send(socket, { type: "directory:error", message: "The realtime message has an unsupported shape." });
      return;
    }

    const attachment = getAttachment(socket);
    if (value.type === "auth:identify") {
      const token = typeof value.token === "string" ? value.token.trim() : "";
      const user = await getUserFromToken(this.env.DB, token || null);
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

    if (value.type === "presence:active") {
      attachment.nickname = typeof value.nickname === "string"
        ? value.nickname.trim().slice(0, 40) || attachment.nickname
        : attachment.nickname;
      socket.serializeAttachment(attachment);
      await this.propagateSitePresence(attachment);
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
  }

  private async propagateSitePresence(attachment: DirectoryAttachment): Promise<void> {
    if (!attachment.userId) {
      return;
    }
    const result = await this.env.DB.prepare("SELECT room_code FROM user_rooms WHERE user_id = ?")
      .bind(attachment.userId).all<{ room_code: string }>();
    await Promise.all((result.results ?? []).map(({ room_code: roomCode }) => {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(roomCode));
      return stub.fetch(new Request("https://room.internal/_internal/site-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: attachment.userId, nickname: attachment.nickname }),
      }));
    }));
  }

  private async broadcastRooms(): Promise<void> {
    const payload = { type: "rooms:update", rooms: await listRooms(this.env.DB) };
    for (const socket of this.state.getWebSockets("directory")) {
      this.send(socket, payload);
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function getAttachment(socket: WebSocket): DirectoryAttachment {
  const value = socket.deserializeAttachment() as DirectoryAttachment | null;
  return value?.kind === "directory"
    ? value
    : { kind: "directory", nickname: "Guest", token: null, userId: null };
}
