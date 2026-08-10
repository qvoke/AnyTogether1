import assert from "node:assert/strict";
import test from "node:test";
import { RoomDurableObject } from "../worker/room";

class MemoryStorage {
  alarm: number | Date | null = null;
  values = new Map<string, unknown>();

  async delete(key: string | string[]) {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.values.delete(item);
    }
    return true;
  }

  async deleteAlarm() {
    this.alarm = null;
  }

  async deleteAll() {
    this.values.clear();
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T) {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, structuredClone(value));
      return;
    }

    for (const [key, item] of Object.entries(keyOrEntries)) {
      this.values.set(key, structuredClone(item));
    }
  }

  async setAlarm(value: number | Date) {
    this.alarm = value;
  }
}

class TestSocket {
  attachment: unknown = { kind: "sync" };
  messages: Record<string, unknown>[] = [];
  readyState = 1;

  close() {
    this.readyState = 3;
  }

  deserializeAttachment() {
    return structuredClone(this.attachment);
  }

  send(value: string) {
    this.messages.push(JSON.parse(value));
  }

  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
}

function createRoom(storage = new MemoryStorage(), socketEntries: Array<{ socket: TestSocket; tags: string[] }> = []) {
  const state = {
    acceptWebSocket(socket: TestSocket, tags: string[]) {
      socketEntries.push({ socket, tags });
    },
    getWebSockets(tag?: string) {
      return socketEntries.filter((entry) => !tag || entry.tags.includes(tag)).map((entry) => entry.socket);
    },
    waitUntil(promise: Promise<unknown>) {
      void promise;
    },
    storage,
  };
  return {
    room: new RoomDurableObject(state as unknown as DurableObjectState, {} as never),
    storage,
  };
}

function action(type: string, overrides: Record<string, unknown> = {}) {
  return {
    actionId: crypto.randomUUID(),
    knownVersion: 0,
    mediaId: null,
    type,
    ...overrides,
  };
}

function latestSnapshot(socket: TestSocket) {
  return socket.messages.filter((message) => message.type === "snapshot").at(-1) as {
    state: { media: { id: string; kind: string } | null; playback: { anchorPositionSec: number; paused: boolean }; version: number };
  };
}

test("rejects invalid messages, stale media, and duplicate actions", async () => {
  const first = new TestSocket();
  const second = new TestSocket();
  const setup = createRoom(undefined, [
    { socket: first, tags: ["sync"] },
    { socket: second, tags: ["sync"] },
  ]);
  const setMedia = action("setMedia", { url: "https://cdn.example.com/movie.m3u8" });

  await setup.room.webSocketMessage(first as unknown as WebSocket, "{");
  assert.equal(first.messages.at(-1)?.type, "error");

  await setup.room.webSocketMessage(first as unknown as WebSocket, JSON.stringify({ type: "action", action: setMedia }));
  const firstMediaState = latestSnapshot(second).state;
  assert.equal(firstMediaState.version, 1);
  assert.equal(firstMediaState.media?.kind, "hls");

  const play = action("play", { mediaId: firstMediaState.media?.id, knownVersion: 999 });
  await setup.room.webSocketMessage(first as unknown as WebSocket, JSON.stringify({ type: "action", action: play }));
  assert.equal(latestSnapshot(second).state.playback.paused, false);

  await setup.room.webSocketMessage(first as unknown as WebSocket, JSON.stringify({
    type: "action",
    action: action("seek", { mediaId: "stale-media", positionSec: 120 }),
  }));
  assert.equal(latestSnapshot(first).state.version, 2);

  await setup.room.webSocketMessage(first as unknown as WebSocket, JSON.stringify({ type: "action", action: play }));
  assert.equal(latestSnapshot(first).state.version, 2);
});

test("a repeated URL creates a fresh media ID and version", async () => {
  const socket = new TestSocket();
  const setup = createRoom(undefined, [{ socket, tags: ["sync"] }]);
  const url = "https://cdn.example.com/movie.mp4";

  await setup.room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "action", action: action("setMedia", { url }) }));
  const first = latestSnapshot(socket).state;
  await setup.room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "action", action: action("setMedia", { url }) }));
  const second = latestSnapshot(socket).state;

  assert.equal(second.version, 2);
  assert.notEqual(second.media?.id, first.media?.id);
  assert.equal(second.playback.paused, true);
  assert.equal(second.playback.anchorPositionSec, 0);
});

test("restores hibernated state and clears only expired playback", async () => {
  const storage = new MemoryStorage();
  const socket = new TestSocket();
  const first = createRoom(storage, [{ socket, tags: ["sync"] }]);
  await first.room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
    type: "action",
    action: action("setMedia", { url: "https://cdn.example.com/movie.mp4" }),
  }));

  const restoredSocket = new TestSocket();
  const restored = createRoom(storage, [{ socket: restoredSocket, tags: ["sync"] }]);
  await restored.room.webSocketMessage(restoredSocket as unknown as WebSocket, JSON.stringify({ type: "hello" }));
  assert.equal(latestSnapshot(restoredSocket).state.version, 1);

  restoredSocket.readyState = 3;
  storage.values.set("chat", [{ id: "retained-chat" }]);
  storage.values.set("playlist", [{ id: "retained-playlist" }]);
  storage.values.set("sync-expiry", Date.now() - 1);
  const expired = createRoom(storage, []);
  await expired.room.alarm();
  const verificationSocket = new TestSocket();
  const verification = createRoom(storage, [{ socket: verificationSocket, tags: ["sync"] }]);
  await verification.room.webSocketMessage(verificationSocket as unknown as WebSocket, JSON.stringify({ type: "hello" }));
  assert.equal(latestSnapshot(verificationSocket).state.version, 0);
  assert.equal(latestSnapshot(verificationSocket).state.media, null);
  assert.deepEqual(storage.values.get("chat"), [{ id: "retained-chat" }]);
  assert.deepEqual(storage.values.get("playlist"), [{ id: "retained-playlist" }]);
});

test("an open sync socket extends an expired timeline alarm", async () => {
  const storage = new MemoryStorage();
  storage.values.set("sync-expiry", Date.now() - 1);
  const socket = new TestSocket();
  const setup = createRoom(storage, [{ socket, tags: ["sync"] }]);
  await setup.room.alarm();
  assert.ok(Number(storage.values.get("sync-expiry")) > Date.now());
});

test("serializes concurrent actions into one version sequence", async () => {
  const socket = new TestSocket();
  const setup = createRoom(undefined, [{ socket, tags: ["sync"] }]);
  await setup.room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
    type: "action",
    action: action("setMedia", { url: "https://cdn.example.com/movie.mp4" }),
  }));
  const mediaId = latestSnapshot(socket).state.media?.id;
  await Promise.all([
    setup.room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "action", action: action("seek", { mediaId, positionSec: 30 }) })),
    setup.room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "action", action: action("seek", { mediaId, positionSec: 60 }) })),
  ]);
  assert.equal(latestSnapshot(socket).state.version, 3);
  assert.ok([30, 60].includes(latestSnapshot(socket).state.playback.anchorPositionSec));
});
