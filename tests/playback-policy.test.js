import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getPlaybackToggleIntent,
  getRelativeSeekPosition,
  isPositionBuffered,
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

test("HLS correction waits until the advancing room position is buffered", () => {
  const roomState = {
    media: { id: "media-1", kind: "hls" },
    playback: { paused: false },
    version: 7
  };
  const ranges = [[457, 463]];
  const buffered = {
    length: ranges.length,
    start: (index) => ranges[index][0],
    end: (index) => ranges[index][1]
  };
  const player = { buffered };
  const remoteSeek = { positionSec: 457, version: 7 };

  assert.equal(isPositionBuffered(buffered, 460), true);
  assert.equal(isPositionBuffered(buffered, 466), false);
  assert.equal(shouldDeferHlsCorrection(roomState, player, remoteSeek, 466), true);
  assert.equal(shouldDeferHlsCorrection(roomState, player, remoteSeek, 460), false);
  assert.equal(
    shouldDeferHlsCorrection({ ...roomState, version: 8 }, player, remoteSeek, 466),
    false
  );
});
