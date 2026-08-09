# Changelog

## 0.53.0 - 2026-08-09

### Added

- Cloudflare Worker routing with D1, static assets, and SQLite-backed Durable Objects.
- Hibernatable room and directory WebSockets with isolated `sync`, `ui`, and `directory` tags.
- Versioned D1 schema and migrations for users, sessions, room membership, ownership, and directory summaries.
- Durable Object coverage for room synchronization, hibernation restoration, UI state, and alarms.

### Changed

- Replaced the Node.js server, process-local maps, and JSON persistence with Cloudflare services.
- Matched seektest playback anchors, action deduplication, stale-media handling, clock sampling, drift correction, HLS recovery, reconnect behavior, and diagnostics.
- Routed player controls and keyboard shortcuts through explicit play, pause, and seek commands.
- Updated Hls.js to the npm-provided 1.6.17 build.

### Removed

- Removed the unused Node.js and `ws` room runtime.
- Removed the signed E2E media URL from tracked configuration.
