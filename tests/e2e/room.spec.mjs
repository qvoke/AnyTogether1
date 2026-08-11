import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const config = JSON.parse(readFileSync(new URL("../e2e.config.json", import.meta.url), "utf8"));

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
  await page.goto(`/?room=${encodeURIComponent(roomId)}`);
  await expect.poll(() => page.evaluate(() => window.__getPlaybackPipelineState?.().connected === true)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__getPlaybackPipelineState?.().roomId)).toBe(roomId);
  return { context, page };
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
  return Promise.all(pages.map((page) => page.locator("#player").evaluate((video) => ({
    currentTime: video.currentTime,
    paused: video.paused,
    ended: video.ended,
    readyState: video.readyState
  }))));
}

async function waitForPlayback(pageA, pageB, expectedPosition = undefined, syncLog = null, persistSyncLog = null, operationStartedAt = Date.now()) {
  let finalSamples = [];
  let loadingWaitMs = null;
  const synchronizationStartedAt = Date.now();
  const convergenceTimeoutMs = 30_000;
  try {
    await expect.poll(async () => {
      const samples = await playbackSamples([pageA, pageB]);
      finalSamples = samples;
      if (loadingWaitMs === null && samples.every((sample) => sample.readyState >= 3)) {
        loadingWaitMs = Date.now() - operationStartedAt;
      }
      if (samples.some((sample) => sample.readyState < 1)) {
        return false;
      }
      if (Math.abs(samples[0].currentTime - samples[1].currentTime) >= 0.75) {
        return false;
      }
      if (expectedPosition === undefined) {
        return true;
      }
      const authoritative = await pipelineState(pageA);
      const expectedPositionAtSample = authoritative?.positionSec;
      return Number.isFinite(expectedPositionAtSample) &&
        samples.every((sample) => Math.abs(sample.currentTime - expectedPositionAtSample) < 1.5);
    }, { intervals: [100, 250, 500, 1_000], timeout: convergenceTimeoutMs }).toBe(true);
  } catch (error) {
    if (syncLog) {
      syncLog.push({
        targetPosition: expectedPosition ?? null,
        loadingWaitMs,
        convergenceWaitMs: Date.now() - synchronizationStartedAt,
        settledAfterMs: 0,
        totalWaitMs: Date.now() - synchronizationStartedAt,
        samples: finalSamples.map(({ currentTime, readyState }) => ({ currentTime, readyState })),
        deltaMs: finalSamples.length === 2
          ? Math.round(Math.abs(finalSamples[0].currentTime - finalSamples[1].currentTime) * 1_000)
          : null,
        progressDeltaSec: [],
        hangDetected: false,
        convergenceTimedOut: true,
        timeoutMs: convergenceTimeoutMs
      });
      if (persistSyncLog) {
        await persistSyncLog();
      }
    }
    throw new Error(`Playback convergence exceeded ${convergenceTimeoutMs} ms`, { cause: error });
  }

  const settleMs = Math.max(0, Number(config.playbackSettleMs) || 0);
  const settleStartSamples = await playbackSamples([pageA, pageB]);
  const settleStartedAt = Date.now();
  while (Date.now() - settleStartedAt < settleMs) {
    const samples = await playbackSamples([pageA, pageB]);
    if (loadingWaitMs === null && samples.every((sample) => sample.readyState >= 3)) {
      loadingWaitMs = Date.now() - operationStartedAt;
    }
    const remainingSettleMs = settleMs - (Date.now() - settleStartedAt);
    if (remainingSettleMs > 0) {
      await pageA.waitForTimeout(Math.min(100, remainingSettleMs));
    }
  }
  const settleEndSamples = await playbackSamples([pageA, pageB]);
  const progressDeltaSec = settleEndSamples.map((sample, index) => (
    sample.currentTime - settleStartSamples[index].currentTime
  ));

  if (syncLog) {
    syncLog.push({
      targetPosition: expectedPosition ?? null,
      loadingWaitMs,
      convergenceWaitMs: Date.now() - synchronizationStartedAt - settleMs,
      settledAfterMs: settleMs,
      totalWaitMs: Date.now() - synchronizationStartedAt,
      samples: finalSamples.map(({ currentTime, readyState }) => ({ currentTime, readyState })),
      deltaMs: Math.round(Math.abs(finalSamples[0].currentTime - finalSamples[1].currentTime) * 1_000),
      progressDeltaSec,
      hangDetected: false
    });
    if (persistSyncLog) {
      await persistSyncLog();
    }
  }
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

  await first.context.close();
  await second.context.close();
});

test("media, play, seek, and pause propagate between browser contexts", async ({ browser, request }, testInfo) => {
  test.setTimeout(180_000);
  const mediaUrl = process.env.E2E_MEDIA_URL || config.mediaUrl;
  test.skip(!mediaUrl, "Set E2E_MEDIA_URL or tests/e2e.config.json mediaUrl to a public CORS-enabled MP4 or HLS VOD URL.");
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
  await Promise.all([
    expect.poll(async () => (await pipelineState(first.page))?.ready).toBe(true),
    expect.poll(async () => (await pipelineState(second.page))?.ready).toBe(true)
  ]);

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
  const blockedPosition = await second.page.locator("#player").evaluate((video) => video.currentTime);
  await second.page.waitForTimeout(3_200);
  const blockedPositionAfterReconciliation = await second.page.locator("#player").evaluate((video) => video.currentTime);
  expect(Math.abs(blockedPositionAfterReconciliation - blockedPosition)).toBeLessThan(0.25);
  await togglePlayback(second.page);
  await expect.poll(async () => (await pipelineState(second.page))?.activationNeeded).toBe(false);
  await expect.poll(() => second.page.locator("#player").evaluate((video) => video.paused)).toBe(false);
  expect((await pipelineState(second.page)).version).toBe(blockedVersion);
  await waitForPlayback(first.page, second.page, undefined, syncLog, persistSyncLog, playStartedAt);

  const random = createRandom(config.randomSeed);
  const seekCount = Math.max(0, Math.floor(Number(config.seekCount) || config.seekPositionsSec?.length || 0));
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
    if (index === 0) {
      const progressBar = sourcePage.locator(".progress-bar");
      const progressBox = await progressBar.boundingBox();
      expect(progressBox).not.toBeNull();
      const startX = progressBox.x + progressBox.width * 0.1;
      const targetX = progressBox.x + progressBox.width * Math.min(1, targetPosition / duration);
      const centerY = progressBox.y + progressBox.height / 2;
      await sourcePage.mouse.move(startX, centerY);
      await sourcePage.mouse.down();
      await sourcePage.mouse.move(targetX, centerY, { steps: 12 });
      await sourcePage.mouse.up();
    } else {
      const seekSent = await sourcePage.evaluate((position) => (
        window.anyTogetherSyncBridge?.seek(position) === true
      ), targetPosition);
      expect(seekSent).toBe(true);
    }
    await expect.poll(
      async () => (await pipelineState(first.page))?.version,
      { timeout: 15_000 }
    ).toBeGreaterThan(versionBeforeSeek);
    const versionAfterSeek = (await pipelineState(first.page)).version;
    if (index === 0) {
      expect(versionAfterSeek).toBe(versionBeforeSeek + 1);
    }
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

  const versionBeforeResume = (await pipelineState(first.page)).version;
  expect(await first.page.evaluate(() => window.anyTogetherSyncBridge?.play())).toBe(true);
  await expect.poll(
    async () => (await pipelineState(first.page))?.version,
    { timeout: 15_000 }
  ).toBeGreaterThan(versionBeforeResume);
  const versionAfterResume = (await pipelineState(first.page)).version;
  await expect.poll(async () => (await pipelineState(second.page))?.version).toBe(versionAfterResume);
  await waitForPlayback(first.page, second.page);

  const holdMs = Number(process.env.E2E_HOLD_MS || config.holdMs || 0);
  if (holdMs > 0) {
    await first.page.waitForTimeout(holdMs);
  }

  await testInfo.attach("e2e-sync-summary", {
    body: Buffer.from(JSON.stringify({
      config: { ...config, mediaUrl: config.mediaUrl ? "[redacted]" : "" },
      roomId,
      seekCount,
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

  await first.context.close();
  await second.context.close();
});
