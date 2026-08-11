import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getPlaybackToggleIntent,
  getRelativeSeekPosition,
  shouldDeferHlsCorrection
} from "../public/playback-policy.js";

test("relative seeks use the authoritative server-time position", () => {
  const roomState = {
    playback: {
      anchorPositionSec: 100,
      anchorServerTimeMs: 10_000,
      paused: false
    }
  };

  assert.equal(getRelativeSeekPosition(roomState, 13_000, 5, 1_000), 108);
  assert.equal(getRelativeSeekPosition(roomState, 13_000, -200, 1_000), 0);
  assert.equal(getRelativeSeekPosition(roomState, 13_000, 1_000, 200), 199.96);
});

test("the active room document contains one playable video element", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const activeHtml = html.replace(/<template\b[\s\S]*?<\/template>/gi, "");
  const players = activeHtml.match(/<video\b[^>]*\bid=["']player["'][^>]*>/gi) ?? [];

  assert.equal(players.length, 1);
});

test("a locally blocked participant activates playback without pausing the room", () => {
  const playingRoom = { media: { id: "media-1" }, playback: { paused: false } };
  const pausedRoom = { media: { id: "media-1" }, playback: { paused: true } };

  assert.equal(getPlaybackToggleIntent(playingRoom, true), "activate");
  assert.equal(getPlaybackToggleIntent(playingRoom, false), "pause");
  assert.equal(getPlaybackToggleIntent(pausedRoom, true), "play");
  assert.equal(getPlaybackToggleIntent({ media: null, playback: { paused: true } }, true), null);
});

test("HLS correction waits for stable playback after a remote seek", () => {
  const roomState = {
    media: { id: "media-1", kind: "hls" },
    playback: { paused: false },
    version: 7
  };
  const correction = { awaitingPlayback: true, version: 7 };

  assert.equal(
    shouldDeferHlsCorrection(roomState, correction, { buffering: false, seeking: false }),
    true
  );
  assert.equal(
    shouldDeferHlsCorrection(
      roomState,
      { ...correction, awaitingPlayback: false },
      { buffering: true, seeking: false }
    ),
    true
  );
  assert.equal(
    shouldDeferHlsCorrection(
      roomState,
      { ...correction, awaitingPlayback: false },
      { buffering: false, seeking: false }
    ),
    false
  );
  assert.equal(
    shouldDeferHlsCorrection(
      { ...roomState, version: 8 },
      correction,
      { buffering: true, seeking: true }
    ),
    false
  );
});
