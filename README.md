# AnyTogether

AnyTogether is a synchronized media room interface with:

- An authoritative, versioned room timeline for media, play, pause, and seek actions
- Server-time synchronization with local drift correction and automatic reconnection
- Native MP4 playback and Hls.js playback for public HLS VOD sources
- Cloudflare Workers, D1, and hibernatable Durable Object WebSockets
- Accounts, room ownership, participant roles, chat, playlists, and room directory updates
- A plugin bridge that delivers metasearch results into the page

## Run locally

```bash
npm install
npm run dev
```

Vite starts the Cloudflare development runtime at `http://localhost:5173`.

Local D1 and Durable Object state is stored under `.notes/build-codex`. The
previous JSON files under `data` are not imported, changed, or removed.

## Playback synchronization

Each room's Durable Object owns its timeline. Clients submit versioned actions
through a room-specific WebSocket and apply the returned snapshot against the
server clock. This prevents one browser's buffering, latency, or local playback
clock from becoming the source of truth.

```json
{
  "type": "action",
  "action": {
    "type": "seek",
    "actionId": "2d42e7c1-4f3c-4f91-b6a7-1d0b9b2d7a26",
    "knownVersion": 7,
    "mediaId": "b12f143f-f662-40ac-bb8a-c80600e2dafe",
    "positionSec": 42.5
  }
}
```

```json
{
  "type": "snapshot",
  "serverTimeMs": 1765658385000,
  "state": {
    "version": 8,
    "media": {
      "id": "b12f143f-f662-40ac-bb8a-c80600e2dafe",
      "kind": "hls",
      "url": "https://example.com/stream.m3u8"
    },
    "playback": {
      "anchorPositionSec": 42.5,
      "anchorServerTimeMs": 1765658385000,
      "paused": false
    }
  }
}
```

Only public HTTPS MP4 and HLS VOD URLs are accepted. Video remains on its
original host; the room sends only a URL and small synchronization messages.

Run the protocol, Worker, Durable Object, D1, API, build, lint, and parser checks
with:

```bash
npm test
npm run lint
```

## Browser end-to-end checks

Install the local Chromium binary once:

```bash
npm run test:e2e:install
```

Run the room connection smoke test:

```bash
npm run test:e2e
```

The tracked E2E configuration never contains a signed media URL. Provide a
temporary public CORS-enabled MP4 or HLS VOD URL through `E2E_MEDIA_URL` for
the complete media, reconnect, play, 20-seek, pause, and resume scenario.

The remaining E2E command settings mirror the seektest configuration:
`run` enables the scenario, `participants` selects the supported participant
count, `seekMode` chooses `manual` or deterministic `random` positions,
`seekCount` sets the number of seeks, `seekPositionsSec` supplies manual
positions, `randomSeed` controls random replayability, `playbackSettleMs`
waits after clocks converge, and `holdMs` keeps the final playback running.

```powershell
npm run test:e2e:watch
```

`test:e2e:watch` opens the browser so the synchronization can be observed.
Set `E2E_BASE_URL` to run the same suite against a deployed instance instead
of starting a local server. By default the suite starts its own server on port
3100. Set `E2E_REUSE_SERVER=1` only to deliberately reuse a server already
running on that port. `E2E_MEDIA_URL` remains available as a one-time media
source override. Remove `E2E_BASE_URL` from the shell environment to return to
the local server:

```powershell
Remove-Item Env:E2E_BASE_URL -ErrorAction SilentlyContinue
```

After either E2E command finishes, it invokes `scripts/notify-chat.ahk` with
the run identifier, result status, and report path. Set `AUTOHOTKEY_EXE` when
AutoHotkey is not available as `AutoHotkey64.exe` on `PATH`.

The generated sync log records `progressDeltaSec` for both videos and marks
each checkpoint with `hangDetected` when a playing video fails to advance
during the settle window.

## Cloudflare data model

D1 stores users, sessions, room membership, ownership, and the room directory.
The room Durable Object stores room metadata, participants, chat, playlist,
media metadata, recent action IDs, and the authoritative playback timeline.
The directory Durable Object serves lobby realtime updates, while room pages
use `/ws?room=ABC123` and playback synchronization uses
`/api/rooms/ABC123/ws`.

Versioned D1 migrations are in `drizzle`. Static files are served through the
`ASSETS` binding, and only `/api/*` plus `/ws` run Worker-first. R2 is not used.

## Site and extension bridge

The page sends a search request with `window.postMessage`:

```js
window.postMessage(
  {
    source: "anytogether-web",
    type: "anytogether-plugin:search-request",
    requestId: crypto.randomUUID(),
    room: "lobby",
    role: "host",
    query: "vimeo space station"
  },
  "*"
);
```

A companion extension can reply back to the page with:

```js
window.postMessage(
  {
    source: "anytogether-plugin",
    type: "anytogether-plugin:search-result",
    requestId,
    title: "Sample stream",
    originUrl: "https://example.com/page",
    mediaUrl: "https://example.com/stream.m3u8"
  },
  "*"
);
```

## Network request matcher example

Use a simple pattern when inspecting request URLs for direct stream manifests:

```js
const streamPattern = /\.(?:m3u8|mp4)(?:\?|$)/i;
```

The interface keeps playback diagnostics visible in the room log. Up to 300
redacted diagnostic records are retained in local storage and up to 500 media
events remain available through the test bridge.
