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

export function getHlsAlignmentAllowanceSec(
  correction,
  minimumAllowanceSec = 0.2,
  maximumInitialAllowanceSec = 0.8,
  maximumRepeatAllowanceSec = 0.3
) {
  const alignmentAttempts = Number(correction?.alignmentAttempts) || 0;
  const historicAllowanceSec = Number.isFinite(correction?.historicAlignmentLatencyMs)
    ? correction.historicAlignmentLatencyMs / 1_000
    : null;
  const primaryAllowanceSec = Number.isFinite(correction?.primaryLatencyMs)
    ? correction.primaryLatencyMs / 2_000
    : minimumAllowanceSec;
  const predictedAllowanceSec = Math.max(
    minimumAllowanceSec,
    historicAllowanceSec ?? primaryAllowanceSec
  );
  return alignmentAttempts > 0
    ? Math.min(maximumRepeatAllowanceSec, predictedAllowanceSec)
    : Math.min(maximumInitialAllowanceSec, predictedAllowanceSec);
}

export function getBufferedHlsAlignmentPosition(
  expectedPositionSec,
  desiredPositionSec,
  bufferedRanges,
  minimumForwardBufferSec = 0.1
) {
  if (
    !Number.isFinite(expectedPositionSec) ||
    !Number.isFinite(desiredPositionSec) ||
    !Array.isArray(bufferedRanges)
  ) {
    return null;
  }
  const matchingRange = bufferedRanges.find((range) => (
    Number.isFinite(range?.start) &&
    Number.isFinite(range?.end) &&
    expectedPositionSec >= range.start - 0.05 &&
    desiredPositionSec >= range.start - 0.05 &&
    desiredPositionSec <= range.end - minimumForwardBufferSec
  ));
  return matchingRange ? Math.max(expectedPositionSec, desiredPositionSec) : null;
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

export function shouldStartHlsPrimaryCorrection(roomState, correction) {
  return Boolean(
    roomState.media?.kind === "hls" &&
    !roomState.playback.paused &&
    correction?.version !== roomState.version
  );
}

export function shouldScheduleSettledHlsAlignment(
  roomState,
  correction,
  absoluteErrorSec,
  thresholdSec = 0.15,
  maximumAlignmentAttempts = 2
) {
  return Boolean(
    roomState.media?.kind === "hls" &&
    !roomState.playback.paused &&
    correction?.version === roomState.version &&
    correction.phase === "settled" &&
    !correction.awaitingPlayback &&
    !correction.pendingAlignment &&
    !correction.alignmentReadinessPending &&
    correction.alignmentReady !== true &&
    correction.alignmentAttempts < maximumAlignmentAttempts &&
    Number.isFinite(absoluteErrorSec) &&
    absoluteErrorSec > thresholdSec
  );
}

export function shouldRunSettledHlsAlignment(
  roomState,
  correction,
  playerState,
  absoluteErrorSec,
  thresholdSec = 0.15,
  maximumAlignmentAttempts = 2
) {
  return Boolean(
    roomState.media?.kind === "hls" &&
    !roomState.playback.paused &&
    correction?.version === roomState.version &&
    correction.phase === "settled" &&
    !correction.awaitingPlayback &&
    correction.alignmentReady === true &&
    correction.alignmentAttempts < maximumAlignmentAttempts &&
    !playerState.buffering &&
    !playerState.seeking &&
    Number.isFinite(absoluteErrorSec) &&
    absoluteErrorSec > thresholdSec
  );
}
