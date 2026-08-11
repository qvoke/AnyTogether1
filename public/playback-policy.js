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

export function isPositionBuffered(buffered, positionSec) {
  for (let index = 0; index < buffered.length; index += 1) {
    if (positionSec >= buffered.start(index) - 0.04 && positionSec <= buffered.end(index) - 0.04) {
      return true;
    }
  }
  return false;
}

export function shouldDeferHlsCorrection(roomState, player, remoteSeek, expectedPosition) {
  return Boolean(
    roomState.media?.kind === "hls" &&
    !roomState.playback.paused &&
    remoteSeek?.version === roomState.version &&
    !isPositionBuffered(player.buffered, expectedPosition)
  );
}
