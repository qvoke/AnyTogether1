import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveConfiguredSourceMedia } from "./source-media.mjs";

const fileConfig = JSON.parse(readFileSync(new URL("../e2e.config.json", import.meta.url), "utf8"));
const config = {
  ...fileConfig,
  playbackSettleMs: getRunNumber("E2E_PLAYBACK_SETTLE_MS", fileConfig.playbackSettleMs, 0),
  seekCount: getRunNumber("E2E_SEEK_COUNT", fileConfig.seekCount, 0)
};
const maxClientDeltaMs = 750;
let resolvedSourceMedia = null;
test.describe.configure({ mode: "serial" });

function getRunNumber(name, fallback, minimum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.floor(value));
}

function sitesRequestHeaders() {
  const token = process.env.E2E_SITES_BYPASS_TOKEN;
  return token ? { "OAI-Sites-Authorization": `Bearer ${token}` } : {};
}

function createRandom(seed) {
  let value = (Number(seed) || 0) >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 4_294_967_296;
  };
}

async function createRoom(request) {
  const response = await request.post("/api/rooms", {
    data: { title: "E2E synchronization room" },
    headers: sitesRequestHeaders()
  });
  if (!response.ok()) {
    throw new Error(`Unable to create an E2E room at ${response.url()}: HTTP ${response.status()} ${await response.text()}`);
  }

  const payload = await response.json();
  expect(payload.room?.code).toEqual(expect.any(String));
  return payload.room.code;
}

async function openRoom(browser, roomId) {
  const context = await browser.newContext({ extraHTTPHeaders: sitesRequestHeaders() });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push({ type: "pageerror", message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push({ type: "console", message: message.text() });
    }
  });
  await page.goto(`/?room=${encodeURIComponent(roomId)}`);
  await expect.poll(() => page.evaluate(() => window.__getPlaybackPipelineState?.().connected === true)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__getPlaybackPipelineState?.().roomId)).toBe(roomId);
  return { browserErrors, context, page };
}

async function loadMediaFromBridge(page, roomId, mediaUrl) {
  await page.evaluate(({ nextRoomId, nextMediaUrl }) => {
    window.postMessage({
      type: "WT_MEDIA_FOUND",
      payload: {
        mediaUrl: nextMediaUrl,
        pageUrl: nextMediaUrl,
        roomId: nextRoomId,
        title: "E2E media"
      }
    }, "*");
  }, { nextMediaUrl: mediaUrl, nextRoomId: roomId });
}

async function pipelineState(page) {
  return page.evaluate(() => window.__getPlaybackPipelineState?.());
}

async function waitForMedia(page, mediaUrl) {
  await expect.poll(async () => {
    const state = await pipelineState(page);
    return state?.version === 1 && state.mediaUrl === mediaUrl;
  }, { timeout: 30_000 }).toBe(true);
}

async function playbackSamples(pages) {
  return Promise.all(pages.map((page) => page.locator("#player").evaluate((video) => {
    if (!video.__e2eFrameCallbackStarted) {
      video.__e2eFrameCallbackStarted = true;
      video.__e2ePresentedFrames = 0;
      const recordPresentedFrame = () => {
        video.__e2ePresentedFrames = (video.__e2ePresentedFrames || 0) + 1;
        video.requestVideoFrameCallback(recordPresentedFrame);
      };
      video.requestVideoFrameCallback(recordPresentedFrame);
    }
    const quality = video.getVideoPlaybackQuality();
    return {
      currentTime: video.currentTime,
      decodedFrames: quality.totalVideoFrames,
      droppedFrames: quality.droppedVideoFrames,
      paused: video.paused,
      presentedFrames: video.__e2ePresentedFrames || 0,
      readyState: video.readyState,
      seeking: video.seeking
    };
  })));
}

function isPlaybackReady(sample) {
  return sample.readyState >= 3 && !sample.paused && !sample.seeking;
}

function summarizePlaybackWindows(entries) {
  const windows = entries.filter((entry) => Array.isArray(entry.presentedFps));
  const arrayValues = (key) => windows.flatMap((entry) => (
    Array.isArray(entry[key]) ? entry[key].filter((value) => typeof value === "number") : []
  ));
  const numberValue = (entry, key) => (typeof entry[key] === "number" ? entry[key] : 0);
  const round = (value) => Math.round(value * 10) / 10;
  const minimum = (values) => (values.length > 0 ? round(Math.min(...values)) : null);
  const maximum = (values) => (values.length > 0 ? Math.max(...values) : null);

  return {
    windows: windows.length,
    slowWindows: windows.filter((entry) => numberValue(entry, "slowFrameSampleCount") > 0).length,
    slowFrameSamples: windows.reduce((total, entry) => total + numberValue(entry, "slowFrameSampleCount"), 0),
    unreadyWindows: windows.filter((entry) => numberValue(entry, "unreadySampleCount") > 0).length,
    cadenceResets: windows.reduce((total, entry) => total + numberValue(entry, "cadenceResetCount"), 0),
    minimumSampledFps: minimum(arrayValues("minimumSampledFps")),
    minimumFinalFps: minimum(arrayValues("presentedFps")),
    maximumClientDeltaMs: maximum(windows.map((entry) => numberValue(entry, "deltaMs"))),
    maximumSettleMs: maximum(windows.map((entry) => numberValue(entry, "settledAfterMs")))
  };
}

async function playbackFailureDiagnostics(pages) {
  return Promise.all(pages.map((page) => page.evaluate(() => {
    const pipeline = window.__getPlaybackPipelineState?.() || null;
    if (pipeline) {
      delete pipeline.mediaUrl;
    }
    return {
      pipeline,
      diagnostics: (window.__getSyncDiagnostics?.() || []).slice(-100)
    };
  })));
}

async function waitForPlayback(pageA, pageB, expectedPosition = undefined, syncLog = null, persistSyncLog = null, operationStartedAt = Date.now()) {
  let readySamples = [];
  let loadingWaitMs = null;
  const synchronizationStartedAt = Date.now();
  const followsTargetTimeline = (sample, sampledAt) => {
    if (expectedPosition === undefined) {
      return true;
    }
    const positionAtOperationStart = expectedPosition + Math.max(0, sampledAt - operationStartedAt) / 1_000;
    const positionAtSynchronizationStart = expectedPosition + Math.max(0, sampledAt - synchronizationStartedAt) / 1_000;
    const lowerBound = Math.min(positionAtOperationStart, positionAtSynchronizationStart) - 1.5;
    const upperBound = Math.max(positionAtOperationStart, positionAtSynchronizationStart) + 1.5;
    return sample.currentTime >= lowerBound && sample.currentTime <= upperBound;
  };
  try {
    await expect.poll(
      async () => {
        const samples = await playbackSamples([pageA, pageB]);
        readySamples = samples;
        if (loadingWaitMs === null && samples.every(isPlaybackReady)) {
          loadingWaitMs = Date.now() - operationStartedAt;
        }
        if (!samples.every(isPlaybackReady)) {
          return false;
        }
        if (Math.abs(samples[0].currentTime - samples[1].currentTime) * 1_000 >= maxClientDeltaMs) {
          return false;
        }
        const sampledAt = Date.now();
        return samples.every((sample) => followsTargetTimeline(sample, sampledAt));
      },
      { timeout: 30_000, intervals: [100, 250, 500, 1_000] }
    ).toBe(true);
  } catch (error) {
    if (syncLog) {
      syncLog.push({
        targetPosition: expectedPosition ?? null,
        phase: "playback-readiness-timeout",
        loadingWaitMs,
        totalWaitMs: Date.now() - synchronizationStartedAt,
        samples: readySamples,
        deltaMs: readySamples.length === 2
          ? Math.round(Math.abs(readySamples[0].currentTime - readySamples[1].currentTime) * 1_000)
          : null
      });
      if (persistSyncLog) {
        await persistSyncLog();
      }
    }
    throw error;
  }
  const convergenceWaitMs = Date.now() - synchronizationStartedAt;
  const settleMs = Math.max(0, Number(config.playbackSettleMs) || 0);
  const progressStartSamples = readySamples;
  const settleStartedAt = Date.now();
  let cadenceStartedAt = settleStartedAt;
  let cadenceStartSamples = readySamples;
  let frameSampleStartedAt = settleStartedAt;
  let frameSampleStartSamples = readySamples;
  let finalSamples = readySamples;
  let progressDeltaSec = finalSamples.map(() => 0);
  let presentedFrameDelta = finalSamples.map(() => 0);
  let droppedFrameDelta = finalSamples.map(() => 0);
  let presentedFps = finalSamples.map(() => 0);
  let slowFrameSampleCount = 0;
  let unreadySampleCount = 0;
  let cadenceResetCount = 0;
  let minimumSampledFps = finalSamples.map(() => null);
  const minimumProgressSec = settleMs > 0 ? Math.min(0.75, settleMs / 2_000) : 0;
  const cadenceObservationMs = Math.max(2_000, settleMs);
  const minimumPresentedFps = 20;
  const cadenceExpectation = expect.poll(
    async () => {
      finalSamples = await playbackSamples([pageA, pageB]);
      const observationMs = Date.now() - cadenceStartedAt;
      const frameSampleMs = Date.now() - frameSampleStartedAt;
      progressDeltaSec = finalSamples.map((sample, index) => (
        sample.currentTime - progressStartSamples[index].currentTime
      ));
      presentedFrameDelta = finalSamples.map((sample, index) => (
        sample.presentedFrames - cadenceStartSamples[index].presentedFrames
      ));
      droppedFrameDelta = finalSamples.map((sample, index) => (
        sample.droppedFrames - cadenceStartSamples[index].droppedFrames
      ));
      presentedFps = presentedFrameDelta.map((frames) => (
        observationMs > 0 ? frames / (observationMs / 1_000) : 0
      ));
      const resetCadenceWindow = () => {
        cadenceStartedAt = Date.now();
        cadenceStartSamples = finalSamples;
        frameSampleStartedAt = cadenceStartedAt;
        frameSampleStartSamples = finalSamples;
        cadenceResetCount += 1;
      };
      if (!finalSamples.every(isPlaybackReady)) {
        unreadySampleCount += 1;
        resetCadenceWindow();
        return false;
      }
      if (Math.abs(finalSamples[0].currentTime - finalSamples[1].currentTime) * 1_000 >= maxClientDeltaMs) {
        resetCadenceWindow();
        return false;
      }
      const sampledAt = Date.now();
      if (!finalSamples.every((sample) => followsTargetTimeline(sample, sampledAt))) {
        resetCadenceWindow();
        return false;
      }
      if (frameSampleMs >= 400) {
        const sampledFps = finalSamples.map((sample, index) => (
          (sample.presentedFrames - frameSampleStartSamples[index].presentedFrames) / (frameSampleMs / 1_000)
        ));
        minimumSampledFps = sampledFps.map((fps, index) => (
          minimumSampledFps[index] === null ? fps : Math.min(minimumSampledFps[index], fps)
        ));
        frameSampleStartedAt = Date.now();
        frameSampleStartSamples = finalSamples;
        if (!sampledFps.every((fps) => fps >= minimumPresentedFps)) {
          slowFrameSampleCount += 1;
          resetCadenceWindow();
          return false;
        }
      }
      if (observationMs < cadenceObservationMs) {
        return false;
      }
      const hasHealthyFrameCadence = presentedFps.every((fps) => fps >= minimumPresentedFps);
      if (!hasHealthyFrameCadence) {
        slowFrameSampleCount += 1;
        resetCadenceWindow();
        return false;
      }
      return progressDeltaSec.every((progress) => progress >= minimumProgressSec);
    },
    { timeout: 30_000, intervals: [100, 250, 500, 1_000] }
  );
  try {
    await cadenceExpectation.toBe(true);
  } catch (error) {
    if (syncLog) {
      syncLog.push({
        targetPosition: expectedPosition ?? null,
        phase: "frame-cadence-timeout",
        loadingWaitMs,
        convergenceWaitMs,
        settledAfterMs: Date.now() - settleStartedAt,
        totalWaitMs: Date.now() - synchronizationStartedAt,
        samples: finalSamples,
        deltaMs: finalSamples.length === 2
          ? Math.round(Math.abs(finalSamples[0].currentTime - finalSamples[1].currentTime) * 1_000)
          : null,
        progressDeltaSec,
        presentedFrameDelta,
        droppedFrameDelta,
        presentedFps,
        minimumSampledFps,
        slowFrameSampleCount,
        unreadySampleCount,
        cadenceResetCount
      });
      if (persistSyncLog) {
        await persistSyncLog();
      }
    }
    throw error;
  }
  const clientDeltaMs = Math.round(Math.abs(finalSamples[0].currentTime - finalSamples[1].currentTime) * 1_000);
  if (syncLog) {
    syncLog.push({
      targetPosition: expectedPosition ?? null,
      loadingWaitMs,
      convergenceWaitMs,
      settledAfterMs: Date.now() - settleStartedAt,
      totalWaitMs: Date.now() - synchronizationStartedAt,
      samples: finalSamples,
      deltaMs: clientDeltaMs,
      progressDeltaSec,
      presentedFrameDelta,
      droppedFrameDelta,
      presentedFps,
      minimumSampledFps,
      slowFrameSampleCount,
      unreadySampleCount,
      cadenceResetCount
    });
    if (persistSyncLog) {
      await persistSyncLog();
    }
  }
  expect(finalSamples.every(isPlaybackReady)).toBe(true);
  expect(clientDeltaMs).toBeLessThan(maxClientDeltaMs);
  expect(progressDeltaSec.every((progress) => progress >= minimumProgressSec)).toBe(true);
  expect(presentedFps.every((fps) => fps >= minimumPresentedFps)).toBe(true);
  expect(finalSamples.every((sample) => followsTargetTimeline(sample, Date.now()))).toBe(true);
}

async function togglePlayback(page) {
  await page.locator("#player").click();
}

test("two isolated browser contexts join the same synchronized room", async ({ browser, request }) => {
  test.skip(config.run !== true || Number(config.participants) !== 2, "The E2E command config disables the two-participant scenario.");
  const roomId = await createRoom(request);
  const first = await openRoom(browser, roomId);
  const second = await openRoom(browser, roomId);

  await expect.poll(async () => (await pipelineState(first.page))?.version).toBe(0);
  await expect.poll(async () => (await pipelineState(second.page))?.version).toBe(0);

  await Promise.all([first.context.close(), second.context.close()]);
});

test("HDRezka parser resolves a current HLS playlist", async ({ browserName }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(!config.sourcePageUrl, "Set tests/e2e.config.json sourcePageUrl to exercise the source parser.");

  expect(browserName).toBe("chromium");
  resolvedSourceMedia = await resolveConfiguredSourceMedia(config.sourcePageUrl, {
    qualityLabel: config.sourceQualityLabel
  });
  expect(resolvedSourceMedia.summary.mediaHost).toEqual(expect.any(String));
  expect(resolvedSourceMedia.summary.episodeCount).toBeGreaterThan(0);
  expect(resolvedSourceMedia.summary.qualityCount).toBeGreaterThan(0);
  if (config.sourceQualityLabel) {
    expect(resolvedSourceMedia.summary.selectedQuality).toBe(config.sourceQualityLabel);
  }
  await testInfo.attach("source-parser-summary", {
    body: Buffer.from(JSON.stringify(resolvedSourceMedia.summary, null, 2)),
    contentType: "application/json"
  });
});

test("media, play, seek, and pause propagate between browser contexts", async ({ browser, request }, testInfo) => {
  test.setTimeout(900_000);
  const mediaUrl = process.env.E2E_MEDIA_URL || resolvedSourceMedia?.mediaUrl || config.mediaUrl;
  test.skip(!mediaUrl, "Configure sourcePageUrl, E2E_MEDIA_URL, or mediaUrl with a playable source.");
  test.skip(config.run !== true || Number(config.participants) !== 2, "The E2E command config disables the two-participant scenario.");
  test.skip(config.seekMode === "manual" && !config.seekPositionsSec?.length, "Manual seek mode requires at least one position.");

  const roomId = await createRoom(request);
  const first = await openRoom(browser, roomId);
  const second = await openRoom(browser, roomId);
  const syncLog = [];
  const syncLogPath = new URL("../../.notes/build-codex/latest-sync-log.json", import.meta.url);
  const persistSyncLog = async () => {
    await mkdir(new URL("../../.notes/build-codex/", import.meta.url), { recursive: true });
    await writeFile(syncLogPath, `${JSON.stringify({
      config: { ...config, mediaUrl: config.mediaUrl ? "[redacted]" : "" },
      roomId,
      entries: syncLog
    }, null, 2)}\n`, "utf8");
  };

  await loadMediaFromBridge(first.page, roomId, mediaUrl);
  await Promise.all([waitForMedia(first.page, mediaUrl), waitForMedia(second.page, mediaUrl)]);
  const versionBeforeReconnect = (await pipelineState(second.page)).version;
  expect(await second.page.evaluate(() => window.__disconnectPlaybackSocket?.())).toBe(true);
  await expect.poll(() => second.page.evaluate(() => window.__getPlaybackPipelineState?.().connected)).toBe(false);
  await expect.poll(() => second.page.evaluate(() => window.__getPlaybackPipelineState?.().connected), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await pipelineState(second.page))?.version).toBe(versionBeforeReconnect);
  try {
    await Promise.all([
      expect.poll(async () => (await pipelineState(first.page))?.ready).toBe(true),
      expect.poll(async () => (await pipelineState(second.page))?.ready).toBe(true)
    ]);
  } catch (error) {
    syncLog.push({
      phase: "media-ready",
      browserErrors: [first.browserErrors, second.browserErrors],
      failureDiagnostics: await playbackFailureDiagnostics([first.page, second.page])
    });
    await persistSyncLog();
    throw error;
  }

  await second.page.locator("#player").evaluate((video) => {
    const play = video.play.bind(video);
    let rejectOnce = true;
    video.play = () => {
      if (rejectOnce) {
        rejectOnce = false;
        return Promise.reject(new DOMException("Playback requires local activation", "NotAllowedError"));
      }
      return play();
    };
  });

  const playStartedAt = Date.now();
  await togglePlayback(first.page);
  await expect.poll(async () => (await pipelineState(second.page))?.activationNeeded).toBe(true);
  const blockedVersion = (await pipelineState(second.page)).version;
  await second.page.waitForTimeout(3_200);
  await expect.poll(() => second.page.locator("#player").evaluate((video) => video.paused)).toBe(true);
  await expect.poll(async () => (await pipelineState(second.page))?.paused).toBe(false);
  await togglePlayback(second.page);
  await expect.poll(async () => (await pipelineState(second.page))?.activationNeeded).toBe(false);
  try {
    await expect.poll(() => second.page.locator("#player").evaluate((video) => video.paused)).toBe(false);
  } catch (error) {
    syncLog.push({
      phase: "local-activation",
      failureDiagnostics: await playbackFailureDiagnostics([first.page, second.page])
    });
    await persistSyncLog();
    throw error;
  }
  expect((await pipelineState(second.page)).version).toBe(blockedVersion);
  await waitForPlayback(first.page, second.page, undefined, syncLog, persistSyncLog, playStartedAt);

  const random = createRandom(config.randomSeed);
  const seekCount = Math.max(0, Math.floor(Number(config.seekCount) || 0));
  for (let index = 0; index < seekCount; index += 1) {
    const sourcePage = index % 2 === 0 ? first.page : second.page;
    const mediaSample = await sourcePage.locator("#player").evaluate((video) => ({
      currentTime: video.currentTime,
      duration: video.duration
    }));
    const duration = mediaSample.duration;
    const maxPosition = Number.isFinite(duration) ? Math.max(0.5, duration - 0.1) : Number.MAX_SAFE_INTEGER;
    const requestedPosition = config.seekMode === "random"
      ? random() * maxPosition
      : config.seekPositionsSec[index % config.seekPositionsSec.length];
    let targetPosition = Math.max(0.5, Math.floor(Math.min(requestedPosition, maxPosition) * 100) / 100);
    if (Math.abs(targetPosition - mediaSample.currentTime) < 0.75) {
      targetPosition = targetPosition + 1 < maxPosition ? targetPosition + 1 : Math.max(0.5, targetPosition - 1);
    }

    const versionBeforeSeek = (await pipelineState(first.page)).version;
    const seekStartedAt = Date.now();
    const seekSent = await sourcePage.evaluate((position) => (
      window.anyTogetherSyncBridge?.seek(position) === true
    ), targetPosition);
    expect(seekSent).toBe(true);
    await expect.poll(
      async () => (await pipelineState(first.page))?.version,
      { timeout: 15_000 }
    ).toBeGreaterThan(versionBeforeSeek);
    const versionAfterSeek = (await pipelineState(first.page)).version;
    expect(versionAfterSeek).toBe(versionBeforeSeek + 1);
    await expect.poll(
      async () => (await pipelineState(second.page))?.version,
      { timeout: 15_000 }
    ).toBe(versionAfterSeek);
    await waitForPlayback(first.page, second.page, targetPosition, syncLog, persistSyncLog, seekStartedAt);
  }

  const versionBeforePause = (await pipelineState(first.page)).version;
  expect(await first.page.evaluate(() => window.anyTogetherSyncBridge?.pause())).toBe(true);
  await expect.poll(
    async () => (await pipelineState(first.page))?.version,
    { timeout: 15_000 }
  ).toBeGreaterThan(versionBeforePause);
  const versionAfterPause = (await pipelineState(first.page)).version;
  await expect.poll(async () => (await pipelineState(second.page))?.version).toBe(versionAfterPause);
  await expect.poll(async () => (await pipelineState(first.page))?.paused).toBe(true);
  await expect.poll(async () => (await pipelineState(second.page))?.paused).toBe(true);
  await expect.poll(
    async () => (await playbackSamples([first.page, second.page])).every((sample) => sample.paused),
    { timeout: 15_000 }
  ).toBe(true);

  const versionBeforeResume = (await pipelineState(first.page)).version;
  expect(await first.page.evaluate(() => window.anyTogetherSyncBridge?.play())).toBe(true);
  await expect.poll(
    async () => (await pipelineState(first.page))?.version,
    { timeout: 15_000 }
  ).toBeGreaterThan(versionBeforeResume);
  const versionAfterResume = (await pipelineState(first.page)).version;
  await expect.poll(async () => (await pipelineState(second.page))?.version).toBe(versionAfterResume);
  await waitForPlayback(first.page, second.page, undefined, syncLog, persistSyncLog);

  const holdMs = Number(process.env.E2E_HOLD_MS || config.holdMs || 0);
  if (holdMs > 0) {
    await first.page.waitForTimeout(holdMs);
  }

  const diagnosticReportBytes = await Promise.all([first.page, second.page].map((page) => (
    page.evaluate(() => {
      window.__anyTogetherDiagnostics?.snapshot();
      const report = window.__anyTogetherDiagnostics?.getReport() || {};
      return new TextEncoder().encode(JSON.stringify(report)).byteLength;
    })
  )));
  expect(Math.max(...diagnosticReportBytes)).toBeLessThan(50 * 1_024);
  const playbackSummary = summarizePlaybackWindows(syncLog);
  console.log(`Playback cadence summary: ${JSON.stringify(playbackSummary)}`);

  await testInfo.attach("e2e-sync-summary", {
    body: Buffer.from(JSON.stringify({
      config: { ...config, mediaUrl: config.mediaUrl ? "[redacted]" : "" },
      roomId,
      seekCount,
      diagnosticReportBytes,
      playbackSummary,
      entries: syncLog
    }, null, 2)),
    contentType: "application/json"
  });

  await testInfo.attach("e2e-sync-log", {
    body: Buffer.from(JSON.stringify({
      config: { ...config, mediaUrl: config.mediaUrl ? "[redacted]" : "" },
      roomId,
      entries: syncLog
    }, null, 2)),
    contentType: "application/json"
  });

  await Promise.all([first.context.close(), second.context.close()]);
});
