import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRoomAction,
  createEmptyRoomState,
  getPositionAt,
  isRoomAction,
  normalizeRoomId,
  validateMediaUrl,
} from "../lib/protocol";

const mediaId = "a55c9baa-165d-4894-b238-29f043aaf38a";

test("anchors playback to authoritative server time", () => {
  const initial = createEmptyRoomState(1_000);
  const withMedia = applyRoomAction(
    initial,
    { actionId: "set", knownVersion: 0, mediaId: null, type: "setMedia", url: "https://cdn.example/video.mp4" },
    2_000,
    { id: mediaId, kind: "mp4", url: "https://cdn.example/video.mp4" },
  );
  const playing = applyRoomAction(
    withMedia,
    { actionId: "play", knownVersion: 1, mediaId, type: "play" },
    3_000,
  );

  assert.equal(getPositionAt(playing, 5_250), 2.25);
  assert.equal(playing.version, 2);
});

test("pausing preserves the actor-calculated position", () => {
  const playing = {
    ...createEmptyRoomState(1_000),
    media: { id: mediaId, kind: "mp4" as const, url: "https://cdn.example/video.mp4" },
    playback: { anchorPositionSec: 10, anchorServerTimeMs: 1_000, paused: false },
  };
  const paused = applyRoomAction(
    playing,
    { actionId: "pause", knownVersion: 0, mediaId, type: "pause" },
    4_000,
  );

  assert.equal(paused.playback.paused, true);
  assert.equal(paused.playback.anchorPositionSec, 13);
  assert.equal(getPositionAt(paused, 8_000), 13);
});

test("a playing seek retains playback and advances from its anchor", () => {
  const playing = {
    ...createEmptyRoomState(1_000),
    media: { id: mediaId, kind: "mp4" as const, url: "https://cdn.example/video.mp4" },
    playback: { anchorPositionSec: 4, anchorServerTimeMs: 1_000, paused: false },
  };
  const seeked = applyRoomAction(
    playing,
    { actionId: "seek", knownVersion: 0, mediaId, positionSec: 45, type: "seek" },
    2_000,
  );

  assert.equal(seeked.playback.paused, false);
  assert.equal(getPositionAt(seeked, 3_500), 46.5);
});

test("only public HTTPS MP4 and HLS URLs are accepted", () => {
  assert.deepEqual(validateMediaUrl("https://cdn.example/video.mp4"), {
    kind: "mp4",
    url: "https://cdn.example/video.mp4",
  });
  assert.deepEqual(validateMediaUrl("https://cdn.example/master.m3u8?token=ok"), {
    kind: "hls",
    url: "https://cdn.example/master.m3u8?token=ok",
  });
  assert.deepEqual(validateMediaUrl("http://cdn.example/video.mp4"), { error: "Use a public HTTPS URL without embedded credentials." });
  assert.deepEqual(validateMediaUrl("https://127.0.0.1/video.mp4"), { error: "Local and IP-based media hosts are not allowed." });
  assert.deepEqual(validateMediaUrl("https://cdn.example/live.m3u"), { error: "The URL must end with .mp4 or .m3u8." });
});

test("malformed actions and non-six-character room IDs are rejected", () => {
  assert.equal(isRoomAction({ actionId: "x", knownVersion: 3, mediaId, positionSec: 9, type: "seek" }), true);
  assert.equal(isRoomAction({ actionId: "x", type: "seek" }), false);
  assert.equal(normalizeRoomId(" a1b2c3 "), "A1B2C3");
  assert.equal(normalizeRoomId("A1B2C"), null);
  assert.equal(normalizeRoomId("A1B2-3"), null);
});
