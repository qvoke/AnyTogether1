import { ensureDatabaseSchema, getRoomSummary, listRooms, type UserRow } from "../db";
import { isRoomId, normalizeRoomId } from "../lib/protocol";
import {
  createPasswordRecord,
  getBearerToken,
  getUserById,
  getUserFromToken,
  normalizeDisplayName,
  normalizeEmail,
  serializeUser,
  verifyPassword,
} from "./auth";
import { DirectoryDurableObject } from "./directory";
import { RoomDurableObject } from "./room";
import type { WorkerEnv } from "./types";

export { DirectoryDurableObject, RoomDurableObject };

const worker: ExportedHandler<WorkerEnv> = {
  async fetch(request, env): Promise<Response> {
    await ensureDatabaseSchema(env.DB);
    const url = new URL(request.url);
    const syncRoomId = getSyncRoomId(url.pathname);
    if (syncRoomId) {
      if (!await getRoomSummary(env.DB, syncRoomId)) {
        return json({ error: "Room not found" }, 404);
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade.", { status: 426 });
      }
      return getRoomStub(env, syncRoomId).fetch(request);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade.", { status: 426 });
      }
      const roomId = normalizeRoomId(url.searchParams.get("room"));
      if (url.searchParams.has("room") && !roomId) {
        return json({ error: "Invalid room code" }, 400);
      }
      if (roomId) {
        if (!await getRoomSummary(env.DB, roomId)) {
          return json({ error: "Room not found" }, 404);
        }
        return getRoomStub(env, roomId).fetch(request);
      }
      return env.DIRECTORY.get(env.DIRECTORY.idFromName("global")).fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, url);
    }

    const assetUrl = url.pathname === "/" ? new URL("/index.html", url) : url;
    return env.ASSETS.fetch(new Request(assetUrl, request));
  },
};

export default worker;

async function handleApiRequest(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const method = request.method;
  const pathname = url.pathname;

  if (method === "POST" && (pathname === "/api/auth/register" || pathname === "/api/auth/signup")) {
    const body = await readJson(request);
    const displayName = normalizeDisplayName(body.displayName);
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? "");
    if (!email || !String(body.displayName ?? "").trim() || !password.trim()) {
      return json({ error: "Failed to create user account" }, 400);
    }
    const duplicate = await env.DB.prepare("SELECT email_lower, display_name_lower FROM users WHERE email_lower = ? OR display_name_lower = ?")
      .bind(email, displayName.toLowerCase()).first<{ display_name_lower: string; email_lower: string }>();
    if (duplicate?.email_lower === email) {
      return json({ error: "Email already registered" }, 400);
    }
    if (duplicate) {
      return json({ error: "Display name already registered" }, 400);
    }
    const timestamp = Date.now();
    const id = crypto.randomUUID();
    const { passwordHash, passwordSalt } = await createPasswordRecord(password);
    try {
      await env.DB.prepare(`INSERT INTO users (
        id, display_name, display_name_lower, email, email_lower,
        password_salt, password_hash, created_at_ms, last_login_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, displayName, displayName.toLowerCase(), email, email, passwordSalt, passwordHash, timestamp, timestamp).run();
    } catch (error) {
      return json({ error: mapUniqueError(error) }, 400);
    }
    const user = await getUserById(env.DB, id);
    if (!user) {
      return json({ error: "Failed to create user account" }, 500);
    }
    const token = await createSession(env.DB, id);
    return json({ token, user: await serializeUser(env.DB, user) });
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(request);
    const identifier = normalizeEmail(body.identifier);
    const user = await env.DB.prepare("SELECT * FROM users WHERE email_lower = ? OR display_name_lower = ?")
      .bind(identifier, identifier).first<UserRow>();
    if (!user || !await verifyPassword(body.password, user.password_salt, user.password_hash)) {
      return json({ error: "Invalid username or password" }, 401);
    }
    const timestamp = Date.now();
    await env.DB.prepare("UPDATE users SET last_login_at_ms = ? WHERE id = ?").bind(timestamp, user.id).run();
    user.last_login_at_ms = timestamp;
    const token = await createSession(env.DB, user.id);
    return json({ token, user: await serializeUser(env.DB, user) });
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const token = getBearerToken(request);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    }
    return json({ ok: true });
  }

  if (method === "GET" && pathname === "/api/auth/me") {
    const user = await authenticateRequest(request, env.DB);
    return user
      ? json({ user: await serializeUser(env.DB, user) })
      : json({ error: "Authentication required" }, 401);
  }

  if (method === "GET" && pathname === "/api/me/rooms") {
    const user = await authenticateRequest(request, env.DB);
    return user
      ? json({ rooms: await listRooms(env.DB, user.id), user: await serializeUser(env.DB, user) })
      : json({ error: "Authentication required" }, 401);
  }

  if (method === "GET" && pathname === "/api/rooms") {
    return json({ rooms: await listRooms(env.DB) });
  }

  if (method === "POST" && pathname === "/api/rooms") {
    const body = await readJson(request);
    const user = await authenticateRequest(request, env.DB);
    const code = await generateRoomCode(env.DB);
    const title = normalizeRoomTitle(body.title) ?? "Room";
    const stub = getRoomStub(env, code);
    const initialized = await stub.fetch(new Request("https://room.internal/_internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, title, ownerId: user?.id ?? null }),
    }));
    if (!initialized.ok) {
      return initialized;
    }
    if (user) {
      await env.DB.prepare("INSERT OR IGNORE INTO user_rooms (user_id, room_code, joined_at_ms) VALUES (?, ?, ?)")
        .bind(user.id, code, Date.now()).run();
    }
    const room = await getRoomSummary(env.DB, code);
    return json({ room });
  }

  const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
  if (roomMatch) {
    const code = normalizeRoomId(roomMatch[1]);
    if (!code) {
      return json({ error: "Room not found" }, 404);
    }
    const summary = await getRoomSummary(env.DB, code);
    if (!summary) {
      return json({ error: "Room not found" }, 404);
    }
    if (method === "GET") {
      return getRoomStub(env, code).fetch(new Request("https://room.internal/_internal/snapshot"));
    }
    if (method === "DELETE") {
      const user = await authenticateRequest(request, env.DB);
      if (summary.ownerId && summary.ownerId !== user?.id) {
        return json({ error: "Forbidden: You are not the owner of this room" }, 403);
      }
      await getRoomStub(env, code).fetch(new Request("https://room.internal/_internal/delete", { method: "POST" }));
      await env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
      await notifyDirectory(env);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, 404);
}

function getSyncRoomId(pathname: string): string | null {
  const match = /^\/api\/rooms\/([^/]+)\/ws$/.exec(pathname);
  return match && isRoomId(match[1]) ? match[1] : null;
}

function getRoomStub(env: WorkerEnv, code: string): DurableObjectStub {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function authenticateRequest(request: Request, database: D1Database): Promise<UserRow | null> {
  return getUserFromToken(database, getBearerToken(request));
}

async function createSession(database: D1Database, userId: string): Promise<string> {
  const token = crypto.randomUUID();
  const timestamp = Date.now();
  await database.prepare("INSERT INTO sessions (token, user_id, created_at_ms, last_seen_at_ms) VALUES (?, ?, ?, ?)")
    .bind(token, userId, timestamp, timestamp).run();
  return token;
}

async function generateRoomCode(database: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    const code = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    if (!await getRoomSummary(database, code)) {
      return code;
    }
  }
  throw new Error("Unable to allocate a room code");
}

function normalizeRoomTitle(value: unknown): string | null {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || null;
}

async function notifyDirectory(env: WorkerEnv): Promise<void> {
  await env.DIRECTORY.get(env.DIRECTORY.idFromName("global"))
    .fetch(new Request("https://directory.internal/_internal/rooms-changed", { method: "POST" }));
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapUniqueError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("email") ? "Email already registered" : "Display name already registered";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
