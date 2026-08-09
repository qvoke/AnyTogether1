# AnyTogether

AnyTogether is a synchronized media room interface with:

- An authoritative, versioned room timeline for media, play, pause, and seek actions
- Server-time synchronization with local drift correction and automatic reconnection
- Native MP4 playback and Hls.js playback for public HLS VOD sources
- A plugin bridge that delivers metasearch results into the page

## Run locally

```bash
npm install
npm run dev
```

The server always starts at `http://localhost:3000`.

## Playback synchronization

The server owns each room timeline. Clients submit versioned actions through a
room-specific WebSocket and apply the returned snapshot against the server
clock. This prevents one browser's buffering, latency, or local playback clock
from becoming the source of truth.

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

Run the synchronization checks with:

```bash
npm run test:sync
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

Set a public CORS-enabled MP4 or HLS VOD source to also verify media loading,
play, seek, and pause across two isolated browser contexts:

```powershell
$env:E2E_MEDIA_URL = "https://cdn.example.com/video.mp4"
npm run test:e2e:watch
```

`test:e2e:watch` opens the browser so the synchronization can be observed.
Set `E2E_BASE_URL` to run the same suite against a deployed instance instead
of starting a local server.

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

The interface keeps playback diagnostics visible in the room log.
