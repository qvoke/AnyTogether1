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
