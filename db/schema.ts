import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    displayNameLower: text("display_name_lower").notNull(),
    email: text("email").notNull(),
    emailLower: text("email_lower").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    lastLoginAtMs: integer("last_login_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("users_display_name_lower_unique").on(table.displayNameLower),
    uniqueIndex("users_email_lower_unique").on(table.emailLower),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAtMs: integer("created_at_ms").notNull(),
    lastSeenAtMs: integer("last_seen_at_ms").notNull(),
  },
  (table) => [index("sessions_user_id_index").on(table.userId)],
);

export const rooms = sqliteTable(
  "rooms",
  {
    code: text("code").primaryKey(),
    title: text("title").notNull(),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdAtMs: integer("created_at_ms").notNull(),
    sessionStartedAtMs: integer("session_started_at_ms").notNull(),
    lastUpdatedAtMs: integer("last_updated_at_ms").notNull(),
    memberCount: integer("member_count").notNull().default(0),
    chatCount: integer("chat_count").notNull().default(0),
    playlistCount: integer("playlist_count").notNull().default(0),
    currentMediaTitle: text("current_media_title"),
    currentMediaUrl: text("current_media_url"),
  },
  (table) => [index("rooms_last_updated_index").on(table.lastUpdatedAtMs)],
);

export const userRooms = sqliteTable(
  "user_rooms",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roomCode: text("room_code").notNull().references(() => rooms.code, { onDelete: "cascade" }),
    joinedAtMs: integer("joined_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roomCode] }),
    index("user_rooms_room_code_index").on(table.roomCode),
  ],
);
