import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getBufferedHlsAlignmentPosition,
  getHlsAlignmentAllowanceSec,
  getPlaybackToggleIntent,
  getRelativeSeekPosition,
  shouldDeferHlsCorrection,
  shouldQueueHlsCorrection,
  shouldRunSettledHlsAlignment,
  shouldScheduleSettledHlsAlignment,
  shouldStartHlsPrimaryCorrection
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

test("HLS alignment predicts a bounded buffered seek latency", () => {
  assert.equal(getHlsAlignmentAllowanceSec({ primaryLatencyMs: 1_600 }), 0.8);
  assert.equal(getHlsAlignmentAllowanceSec({ primaryLatencyMs: 600 }), 0.3);
  assert.equal(getHlsAlignmentAllowanceSec({ historicAlignmentLatencyMs: 250, primaryLatencyMs: 1_600 }), 0.25);
  assert.equal(getHlsAlignmentAllowanceSec({ alignmentAttempts: 1, historicAlignmentLatencyMs: 600 }), 0.3);
  assert.equal(getHlsAlignmentAllowanceSec(null), 0.2);
});

test("HLS alignment stays inside the available buffered range", () => {
  const bufferedRanges = [{ start: 340, end: 350 }];

  assert.equal(getBufferedHlsAlignmentPosition(349.8, 350.2, bufferedRanges), null);
  assert.equal(getBufferedHlsAlignmentPosition(348, 348.3, bufferedRanges), 348.3);
  assert.equal(getBufferedHlsAlignmentPosition(349.8, 349.95, bufferedRanges), null);
  assert.equal(getBufferedHlsAlignmentPosition(350, 350.2, bufferedRanges), null);
  assert.equal(getBufferedHlsAlignmentPosition(330, 330.2, bufferedRanges), null);
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

test("a newer HLS seek is queued while the previous correction is unstable", () => {
  const roomState = {
    media: { id: "media-1", kind: "hls" },
    playback: { paused: false },
    version: 8
  };
  const previousCorrection = { awaitingPlayback: true, version: 7 };

  assert.equal(
    shouldQueueHlsCorrection(roomState, previousCorrection, { buffering: true, seeking: true }),
    true
  );
  assert.equal(
    shouldQueueHlsCorrection(
      roomState,
      { ...previousCorrection, awaitingPlayback: false },
      { buffering: false, seeking: false }
    ),
    false
  );
  assert.equal(
    shouldQueueHlsCorrection(
      { ...roomState, playback: { paused: true } },
      previousCorrection,
      { buffering: true, seeking: true }
    ),
    false
  );
  assert.equal(
    shouldQueueHlsCorrection(
      { ...roomState, media: { id: "media-1", kind: "mp4" } },
      previousCorrection,
      { buffering: true, seeking: true }
    ),
    false
  );
});

test("a settled HLS version allows bounded alignment without repeating its primary seek", () => {
  const roomState = {
    media: { id: "media-1", kind: "hls" },
    playback: { paused: false },
    version: 7
  };
  const correction = {
    alignmentReady: true,
    alignmentAttempts: 0,
    awaitingPlayback: false,
    phase: "settled",
    version: 7
  };
  const stablePlayer = { buffering: false, seeking: false };

  assert.equal(shouldStartHlsPrimaryCorrection(roomState, correction), false);
  assert.equal(shouldRunSettledHlsAlignment(roomState, correction, stablePlayer, 0.28), true);
  assert.equal(shouldRunSettledHlsAlignment(roomState, correction, stablePlayer, 0.15), false);
  assert.equal(
    shouldRunSettledHlsAlignment(
      roomState,
      { ...correction, alignmentReady: false },
      stablePlayer,
      0.28
    ),
    false
  );
  assert.equal(
    shouldRunSettledHlsAlignment(
      roomState,
      { ...correction, alignmentAttempts: 2 },
      stablePlayer,
      0.28
    ),
    false
  );
  assert.equal(
    shouldRunSettledHlsAlignment(
      roomState,
      { ...correction, alignmentAttempts: 1 },
      stablePlayer,
      0.28
    ),
    true
  );
  assert.equal(
    shouldRunSettledHlsAlignment(roomState, correction, { buffering: true, seeking: false }, 0.28),
    false
  );
  assert.equal(shouldStartHlsPrimaryCorrection({ ...roomState, version: 8 }, correction), true);
});

test("settled HLS playback rearms alignment only for persistent uncorrected drift", () => {
  const roomState = {
    media: { id: "media-1", kind: "hls" },
    playback: { paused: false },
    version: 7
  };
  const correction = {
    alignmentReady: false,
    alignmentReadinessPending: false,
    alignmentAttempts: 1,
    awaitingPlayback: false,
    pendingAlignment: false,
    phase: "settled",
    version: 7
  };

  assert.equal(shouldScheduleSettledHlsAlignment(roomState, correction, 0.28), true);
  assert.equal(shouldScheduleSettledHlsAlignment(roomState, correction, 0.15), false);
  assert.equal(
    shouldScheduleSettledHlsAlignment(roomState, { ...correction, alignmentReadinessPending: true }, 0.28),
    false
  );
  assert.equal(
    shouldScheduleSettledHlsAlignment(roomState, { ...correction, alignmentReady: true }, 0.28),
    false
  );
  assert.equal(
    shouldScheduleSettledHlsAlignment(roomState, { ...correction, alignmentAttempts: 2 }, 0.28),
    false
  );
});
