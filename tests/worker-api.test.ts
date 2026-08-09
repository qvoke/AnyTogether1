import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { Miniflare } from "miniflare";

let miniflare: Miniflare;

before(async () => {
  const buildRoot = resolve(import.meta.dirname, "../.notes/build-codex/dist");
  miniflare = new Miniflare({
    modules: true,
    scriptPath: resolve(buildRoot, "anytogether1/client/index.js"),
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      ROOMS: { className: "RoomDurableObject", useSQLite: true },
      DIRECTORY: { className: "DirectoryDurableObject", useSQLite: true },
    },
    durableObjectsPersist: false,
    d1Databases: { DB: "anytogether-test" },
    d1Persist: false,
    assets: {
      directory: resolve(buildRoot, "client"),
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: true,
      },
    },
  });
  await miniflare.ready;
});

after(async () => {
  await miniflare.dispose();
});

test("registration, login, logout, and uniqueness use D1", async () => {
  const first = await register("Taylor", "taylor@example.com", "correct horse battery staple");
  assert.equal(first.response.status, 200);
  assert.equal(first.body.user.displayName, "Taylor");

  const duplicateEmail = await register("Taylor Two", "taylor@example.com", "password");
  assert.equal(duplicateEmail.response.status, 400);
  assert.equal(duplicateEmail.body.error, "Email already registered");

  const duplicateName = await register("Taylor", "other@example.com", "password");
  assert.equal(duplicateName.response.status, 400);
  assert.equal(duplicateName.body.error, "Display name already registered");

  const login = await api("/api/auth/login", {
    method: "POST",
    body: { identifier: "taylor@example.com", password: "correct horse battery staple" },
  });
  assert.equal(login.response.status, 200);
  assert.ok(login.body.token);

  const me = await api("/api/auth/me", { token: login.body.token });
  assert.equal(me.body.user.email, "taylor@example.com");
  const logout = await api("/api/auth/logout", { method: "POST", token: login.body.token });
  assert.equal(logout.body.ok, true);
  assert.equal((await api("/api/auth/me", { token: login.body.token })).response.status, 401);
});

test("catalog, membership, room state, role transfer, and deletion stay consistent", async () => {
  const owner = await register("Room Owner", "owner@example.com", "owner-password");
  const successor = await register("Room Successor", "successor@example.com", "successor-password");
  const created = await api("/api/rooms", {
    method: "POST",
    token: owner.body.token,
    body: { title: "Cloudflare Room" },
  });
  const roomCode = created.body.room.code as string;
  assert.match(roomCode, /^[A-Z0-9]{6}$/);

  const catalog = await api("/api/rooms");
  assert.ok(catalog.body.rooms.some((room: { code: string }) => room.code === roomCode));
  const ownerRooms = await api("/api/me/rooms", { token: owner.body.token });
  assert.ok(ownerRooms.body.rooms.some((room: { code: string }) => room.code === roomCode));

  const ownerUi = await connectSocket(`/ws?room=${roomCode}`);
  ownerUi.send({ type: "auth:identify", token: owner.body.token });
  await ownerUi.waitFor((message) => message.type === "auth:accepted");
  ownerUi.send({ type: "room:join", roomId: roomCode, nickname: "Room Owner", clientId: "owner-client", hasExtension: true });
  await ownerUi.waitFor((message) => message.type === "room:role" && message.role === "host");

  const successorUi = await connectSocket(`/ws?room=${roomCode}`);
  successorUi.send({ type: "auth:identify", token: successor.body.token });
  await successorUi.waitFor((message) => message.type === "auth:accepted");
  successorUi.send({ type: "room:join", roomId: roomCode, nickname: "Room Successor", clientId: "successor-client", hasExtension: true });
  await successorUi.waitFor((message) => message.type === "room:role" && message.role === "guest");

  ownerUi.send({ type: "chat:message", roomId: roomCode, text: "Hello from D1" });
  await successorUi.waitFor((message) => message.type === "chat:message" && message.message?.text === "Hello from D1");
  ownerUi.send({
    type: "playlist:add",
    roomId: roomCode,
    item: { title: "Movie", mediaUrl: "https://cdn.example.com/movie.mp4" },
  });
  await successorUi.waitFor((message) => message.type === "room:snapshot" && message.room?.playlist?.length === 1);

  ownerUi.send({
    type: "room:participant-action",
    roomId: roomCode,
    targetClientId: "successor-client",
    action: "make-creator",
  });
  await successorUi.waitFor((message) => message.type === "room:role" && message.role === "host");
  assert.equal((await api(`/api/rooms/${roomCode}`, { method: "DELETE", token: owner.body.token })).response.status, 403);
  assert.equal((await api(`/api/rooms/${roomCode}`, { method: "DELETE", token: successor.body.token })).response.status, 200);
  assert.equal((await api(`/api/rooms/${roomCode}`)).response.status, 404);

  ownerUi.close();
  successorUi.close();
});

test("sync sockets expose seektest messages and reject malformed input", async () => {
  const created = await api("/api/rooms", { method: "POST", body: { title: "Protocol Room" } });
  const roomCode = created.body.room.code as string;
  const first = await connectSocket(`/api/rooms/${roomCode}/ws`);
  const ui = await connectSocket(`/ws?room=${roomCode}`);
  const second = await connectSocket(`/api/rooms/${roomCode}/ws`);

  const initial = await first.waitFor((message) => message.type === "snapshot");
  assert.equal(initial.state.version, 0);
  assert.equal(initial.state.media, null);
  assert.equal((await first.waitFor((message) => message.type === "presence" && message.count === 2)).count, 2);

  first.sendRaw("{");
  assert.equal((await first.waitFor((message) => message.type === "error")).code, "invalid-json");
  const actionId = crypto.randomUUID();
  first.send({
    type: "action",
    action: {
      type: "setMedia",
      actionId,
      knownVersion: 0,
      mediaId: null,
      url: "https://cdn.example.com/media.mp4",
    },
  });
  const mediaSnapshot = await second.waitFor((message) => message.type === "snapshot" && message.state.version === 1);
  const firstMediaId = mediaSnapshot.state.media.id;

  first.send({
    type: "action",
    action: {
      type: "setMedia",
      actionId: crypto.randomUUID(),
      knownVersion: 0,
      mediaId: firstMediaId,
      url: "https://cdn.example.com/media.mp4",
    },
  });
  const repeated = await second.waitFor((message) => message.type === "snapshot" && message.state.version === 2);
  assert.notEqual(repeated.state.media.id, firstMediaId);
  assert.equal(repeated.state.playback.paused, true);

  first.close();
  second.close();
  ui.close();
});

async function register(displayName: string, email: string, password: string) {
  return api("/api/auth/register", { method: "POST", body: { displayName, email, password } });
}

async function api(
  path: string,
  options: { body?: unknown; method?: string; token?: string } = {},
): Promise<{ body: any; response: Response }> {
  const headers = new Headers();
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  const response = await miniflare.dispatchFetch(`https://example.com${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response: response as unknown as Response, body: await response.json() };
}

async function connectSocket(path: string): Promise<SocketCollector> {
  const response = await miniflare.dispatchFetch(`https://example.com${path}`, {
    headers: { Upgrade: "websocket" },
  });
  assert.equal(response.status, 101);
  const webSocket = response.webSocket;
  assert.ok(webSocket);
  webSocket.accept();
  return new SocketCollector(webSocket as unknown as WebSocket);
}

class SocketCollector {
  private readonly messages: any[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.messages.push(JSON.parse(String(event.data)));
      for (const waiter of this.waiters) {
        waiter();
      }
    });
  }

  close() {
    this.socket.close(1000, "Test complete");
  }

  send(value: unknown) {
    this.sendRaw(JSON.stringify(value));
  }

  sendRaw(value: string) {
    this.socket.send(value);
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 5_000): Promise<any> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.waiters.delete(onMessage);
          resolve();
        }, 25);
        const onMessage = () => {
          clearTimeout(timeout);
          this.waiters.delete(onMessage);
          resolve();
        };
        this.waiters.add(onMessage);
      });
    }
    assert.fail(`Timed out waiting for a WebSocket message. Received: ${JSON.stringify(this.messages)}`);
  }
}
