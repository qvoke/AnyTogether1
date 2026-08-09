export interface UserRow {
  created_at_ms: number;
  display_name: string;
  display_name_lower: string;
  email: string;
  email_lower: string;
  id: string;
  last_login_at_ms: number;
  password_hash: string;
  password_salt: string;
}

export interface RoomSummary {
  chatCount: number;
  code: string;
  createdAt: number;
  currentMediaTitle: string | null;
  currentMediaUrl: string | null;
  lastUpdatedAt: number;
  memberCount: number;
  ownerId: string | null;
  playlistCount: number;
  sessionStartedAt: number;
  title: string;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    display_name_lower TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    email_lower TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    last_login_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at_ms INTEGER NOT NULL,
    session_started_at_ms INTEGER NOT NULL,
    last_updated_at_ms INTEGER NOT NULL,
    member_count INTEGER DEFAULT 0 NOT NULL,
    chat_count INTEGER DEFAULT 0 NOT NULL,
    playlist_count INTEGER DEFAULT 0 NOT NULL,
    current_media_title TEXT,
    current_media_url TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS user_rooms (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    joined_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_code)
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_user_id_index ON sessions(user_id)",
  "CREATE INDEX IF NOT EXISTS rooms_last_updated_index ON rooms(last_updated_at_ms)",
  "CREATE INDEX IF NOT EXISTS user_rooms_room_code_index ON user_rooms(room_code)",
];

const initializedDatabases = new WeakSet<object>();

export async function ensureDatabaseSchema(database: D1Database): Promise<void> {
  if (initializedDatabases.has(database)) {
    return;
  }

  await database.batch(SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)));
  initializedDatabases.add(database);
}

export function mapRoomSummary(row: Record<string, unknown>): RoomSummary {
  return {
    code: String(row.code),
    title: String(row.title),
    ownerId: row.owner_id ? String(row.owner_id) : null,
    createdAt: Number(row.created_at_ms),
    sessionStartedAt: Number(row.session_started_at_ms),
    lastUpdatedAt: Number(row.last_updated_at_ms),
    memberCount: Number(row.member_count),
    chatCount: Number(row.chat_count),
    playlistCount: Number(row.playlist_count),
    currentMediaTitle: row.current_media_title ? String(row.current_media_title) : null,
    currentMediaUrl: row.current_media_url ? String(row.current_media_url) : null,
  };
}

export async function listRooms(database: D1Database, userId?: string): Promise<RoomSummary[]> {
  const statement = userId
    ? database.prepare(`SELECT rooms.* FROM rooms
        INNER JOIN user_rooms ON user_rooms.room_code = rooms.code
        WHERE user_rooms.user_id = ? ORDER BY rooms.last_updated_at_ms DESC`).bind(userId)
    : database.prepare("SELECT * FROM rooms ORDER BY last_updated_at_ms DESC");
  const result = await statement.all<Record<string, unknown>>();
  return (result.results ?? []).map(mapRoomSummary);
}

export async function getRoomSummary(database: D1Database, code: string): Promise<RoomSummary | null> {
  const row = await database.prepare("SELECT * FROM rooms WHERE code = ?").bind(code).first<Record<string, unknown>>();
  return row ? mapRoomSummary(row) : null;
}
