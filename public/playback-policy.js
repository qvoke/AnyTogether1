export function getRelativeSeekPosition(roomState, serverTimeMs, deltaSec, duration) {
  const position = roomState.playback.paused
    ? roomState.playback.anchorPositionSec
    : Math.max(
      0,
      roomState.playback.anchorPositionSec +
        (serverTimeMs - roomState.playback.anchorServerTimeMs) / 1_000
    );
  const target = Math.max(0, position + deltaSec);
  if (!Number.isFinite(duration)) {
    return target;
  }
  return Math.min(target, Math.max(0, duration - 0.04));
}

export function getPlaybackToggleIntent(roomState, localPaused) {
  if (!roomState?.media) {
    return null;
  }
  if (!roomState.playback.paused && localPaused) {
    return "activate";
  }
  return roomState.playback.paused ? "play" : "pause";
}

export function getHlsSyncPlaybackRate(errorSec) {
  const absoluteError = Math.abs(errorSec);
  if (!Number.isFinite(absoluteError) || absoluteError <= 0.04) {
    return 1;
  }
  const adjustment = absoluteError >= 1 ? 1 : absoluteError >= 0.5 ? 0.5 : absoluteError >= 0.2 ? 0.3 : 0.15;
  return errorSec > 0 ? 1 + adjustment : Math.max(0.5, 1 - adjustment);
}

export function shouldDeferHlsCorrection(roomState, correction, playerState) {
  return Boolean(
    roomState.media?.kind === "hls" &&
    !roomState.playback.paused &&
    correction?.version === roomState.version &&
    (correction.awaitingPlayback || playerState.buffering || playerState.seeking)
  );
}

export function shouldQueueHlsCorrection(roomState, correction, playerState) {
  return Boolean(
    roomState.media?.kind === "hls" &&
    !roomState.playback.paused &&
    correction?.version !== roomState.version &&
    (correction?.awaitingPlayback || playerState.buffering || playerState.seeking)
  );
}
