import type { RoomState } from "../lib/protocol";

export interface WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  DIRECTORY: DurableObjectNamespace;
  ROOMS: DurableObjectNamespace;
}

export interface StoredRoom {
  code: string;
  createdAt: number;
  currentMedia: UiMedia | null;
  lastUpdatedAt: number;
  ownerId: string | null;
  sessionStartedAt: number;
  title: string;
}

export interface UiMedia {
  masterPlaylistUrl?: string | null;
  mediaUrl: string;
  pageUrl?: string | null;
  seriesContext?: Record<string, unknown> | null;
  sourcePageUrl?: string | null;
  title?: string | null;
  updatedAt: number;
}

export interface ChatMessage {
  author: {
    clientId: string | null;
    nickname: string;
    role: string;
    userId?: string | null;
  };
  id: string;
  sentAt: number;
  text: string;
}

export interface PlaylistItem {
  addedAt: number;
  addedBy: {
    clientId: string | null;
    nickname: string;
    role: string;
  };
  id: string;
  mediaUrl: string;
  pageUrl: string | null;
  seriesContext: Record<string, unknown> | null;
  title: string;
}

export type PresenceStatus = "not-in-room" | "offline" | "online";

export interface Participant {
  canManageContent: boolean;
  clientId: string | null;
  connected: boolean;
  hasExtension: boolean;
  joinedAt: number;
  lastSeenAt: number;
  nickname: string;
  presenceStatus: PresenceStatus;
  role: "guest" | "host";
  socketId: string | null;
  userId: string | null;
}

export interface RoomSnapshot {
  chat: ChatMessage[];
  code: string;
  createdAt: number;
  currentMedia: UiMedia | null;
  currentPlayback: {
    state: "paused" | "playing";
    time: number;
    updatedAt: number;
    version: number;
  };
  lastUpdatedAt: number;
  memberCount: number;
  participants: Participant[];
  playlist: PlaylistItem[];
  sessionStartedAt: number;
  title: string;
}

export interface SyncSocketAttachment {
  kind: "sync";
}

export interface UiSocketAttachment {
  canManageContent: boolean;
  clientId: string | null;
  hasExtension: boolean;
  joined: boolean;
  kind: "ui";
  nickname: string;
  role: "guest" | "host";
  socketId: string;
  token: string | null;
  userId: string | null;
}

export type SocketAttachment = SyncSocketAttachment | UiSocketAttachment;

export interface RoomPersistedState {
  actionIds: string[];
  chat: ChatMessage[];
  offlineDeadlines: Record<string, number>;
  participants: Participant[];
  playlist: PlaylistItem[];
  room: StoredRoom | null;
  syncExpiresAtMs: number | null;
  syncState: RoomState;
}
