import { ensureDatabaseSchema, type UserRow } from "../db";

export interface PublicUser {
  createdAt: number;
  displayName: string;
  email: string;
  id: string;
  lastLoginAt: number;
  roomCount: number;
}

const encoder = new TextEncoder();

export function normalizeDisplayName(value: unknown): string {
  return String(value ?? "").trim().slice(0, 60) || "Guest";
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export async function createPasswordRecord(password: unknown): Promise<{ passwordHash: string; passwordSalt: string }> {
  const passwordSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return {
    passwordSalt,
    passwordHash: await derivePasswordHash(password, passwordSalt),
  };
}

export async function verifyPassword(password: unknown, salt: string, expectedHash: string): Promise<boolean> {
  const actual = hexToBytes(await derivePasswordHash(password, salt));
  const expected = hexToBytes(expectedHash);
  if (actual.length !== expected.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}

export async function getUserById(database: D1Database, id: string): Promise<UserRow | null> {
  await ensureDatabaseSchema(database);
  return database.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function getUserFromToken(database: D1Database, token: string | null): Promise<UserRow | null> {
  if (!token) {
    return null;
  }
  await ensureDatabaseSchema(database);
  const now = Date.now();
  const row = await database.prepare(`SELECT users.* FROM users
    INNER JOIN sessions ON sessions.user_id = users.id WHERE sessions.token = ?`).bind(token).first<UserRow>();
  if (row) {
    await database.prepare("UPDATE sessions SET last_seen_at_ms = ? WHERE token = ?").bind(now, token).run();
  }
  return row;
}

export async function serializeUser(database: D1Database, user: UserRow): Promise<PublicUser> {
  const count = await database.prepare("SELECT COUNT(*) AS count FROM user_rooms WHERE user_id = ?")
    .bind(user.id).first<{ count: number }>();
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email,
    createdAt: user.created_at_ms,
    lastLoginAt: user.last_login_at_ms,
    roomCount: Number(count?.count ?? 0),
  };
}

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim() || null;
  }
  return request.headers.get("X-Auth-Token")?.trim() || null;
}

async function derivePasswordHash(password: unknown, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(password ?? "")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-512", salt: encoder.encode(salt), iterations: 120_000 },
    key,
    512,
  );
  return bytesToHex(new Uint8Array(bits));
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  const result = new Uint8Array(Math.floor(value.length / 2));
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}
