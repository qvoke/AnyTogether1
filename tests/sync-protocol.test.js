import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRoomAction,
  createEmptyRoomState,
  getPositionAt,
  isRoomAction,
  validateMediaUrl
} from "../lib/sync-protocol.js";

const mediaId = "b12f143f-f662-40ac-bb8a-c80600e2dafe";

test("anchors shared playback to server time", () => {
  const initialState = createEmptyRoomState(1_000);
  const mediaState = applyRoomAction(
    initialState,
    { actionId: "set-media", knownVersion: 0, mediaId: null, type: "setMedia", url: "https://cdn.example/video.mp4" },
    2_000,
    { id: mediaId, kind: "mp4", url: "https://cdn.example/video.mp4" }
  );
  const playingState = applyRoomAction(
    mediaState,
    { actionId: "play", knownVersion: 1, mediaId, type: "play" },
    3_000
  );

  assert.equal(getPositionAt(playingState, 5_250), 2.25);
  assert.equal(playingState.version, 2);
});

test("seeking preserves playback mode and advances from the new anchor", () => {
  const playingState = {
    ...createEmptyRoomState(1_000),
    media: { id: mediaId, kind: "mp4", url: "https://cdn.example/video.mp4" },
    playback: { anchorPositionSec: 4, anchorServerTimeMs: 1_000, paused: false }
  };
  const seekedState = applyRoomAction(
    playingState,
    { actionId: "seek", knownVersion: 0, mediaId, positionSec: 45, type: "seek" },
    2_000
  );

  assert.equal(seekedState.playback.paused, false);
  assert.equal(getPositionAt(seekedState, 3_500), 46.5);
});

test("accepts only public HTTPS MP4 and HLS sources", () => {
  assert.deepEqual(validateMediaUrl("https://cdn.example/video.mp4"), {
    kind: "mp4",
    url: "https://cdn.example/video.mp4"
  });
  assert.deepEqual(validateMediaUrl("https://cdn.example/master.m3u8?token=ok"), {
    kind: "hls",
    url: "https://cdn.example/master.m3u8?token=ok"
  });
  assert.ok("error" in validateMediaUrl("http://cdn.example/video.mp4"));
  assert.ok("error" in validateMediaUrl("https://127.0.0.1/video.mp4"));
  assert.ok("error" in validateMediaUrl("https://cdn.example/live.m3u"));
});

test("rejects malformed room actions", () => {
  assert.equal(
    isRoomAction({ actionId: "seek", knownVersion: 3, mediaId, positionSec: 9, type: "seek" }),
    true
  );
  assert.equal(isRoomAction({ actionId: "seek", type: "seek" }), false);
});
