import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../e2e.config.json", import.meta.url), "utf8"));

async function createRoom(request) {
  const response = await request.post("/api/rooms", { data: { title: "E2E synchronization room" } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).room.code;
}

async function openRoom(browser, roomId) {
  const context = await browser.newContext();
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
  await expect.poll(() => page.locator("#player").evaluate((video) => video.readyState >= 1), {
    timeout: 30_000
  }).toBe(true);
}

async function waitForPlayback(pageA, pageB, expectedPosition = undefined) {
  await expect.poll(async () => {
    const samples = await Promise.all([pageA, pageB].map((page) => page.locator("#player").evaluate((video) => ({
      currentTime: video.currentTime,
      paused: video.paused,
      readyState: video.readyState
    }))));
    if (samples.some((sample) => sample.readyState < 1 || sample.paused)) {
      return false;
    }
    if (Math.abs(samples[0].currentTime - samples[1].currentTime) >= 0.75) {
      return false;
    }
    if (expectedPosition === undefined) {
      return samples.every((sample) => sample.currentTime > 0.25);
    }
    return samples.every((sample) => Math.abs(sample.currentTime - expectedPosition) < 1.5);
  }, { intervals: [100, 250, 500, 1_000], timeout: 30_000 }).toBe(true);
}

async function togglePlayback(page) {
  await page.locator("#player").click();
}

test("two isolated browser contexts join the same synchronized room", async ({ browser, request }) => {
  const roomId = await createRoom(request);
  const first = await openRoom(browser, roomId);
  const second = await openRoom(browser, roomId);

  await expect.poll(async () => (await pipelineState(first.page))?.version).toBe(0);
  await expect.poll(async () => (await pipelineState(second.page))?.version).toBe(0);

  await first.context.close();
  await second.context.close();
});

test("media, play, seek, and pause propagate between browser contexts", async ({ browser, request }, testInfo) => {
  test.setTimeout(120_000);
  const mediaUrl = process.env.E2E_MEDIA_URL || config.mediaUrl;
  test.skip(!mediaUrl, "Set E2E_MEDIA_URL or tests/e2e.config.json mediaUrl to a public CORS-enabled MP4 or HLS VOD URL.");

  const roomId = await createRoom(request);
  const first = await openRoom(browser, roomId);
  const second = await openRoom(browser, roomId);

  await loadMediaFromBridge(first.page, roomId, mediaUrl);
  await Promise.all([waitForMedia(first.page, mediaUrl), waitForMedia(second.page, mediaUrl)]);
  await Promise.all([
    expect.poll(async () => (await pipelineState(first.page))?.ready).toBe(true),
    expect.poll(async () => (await pipelineState(second.page))?.ready).toBe(true)
  ]);

  await togglePlayback(first.page);
  await waitForPlayback(first.page, second.page);

  const duration = await first.page.locator("#player").evaluate((video) => video.duration);
  const targetPosition = Math.max(
    0.5,
    Math.min(config.seekPositionsSec[0] || 5, Number.isFinite(duration) ? duration - 0.1 : config.seekPositionsSec[0] || 5)
  );
  const versionBeforeSeek = (await pipelineState(first.page)).version;
  await first.page.locator("#player").evaluate((video, position) => {
    video.currentTime = position;
  }, targetPosition);
  await expect.poll(async () => (await pipelineState(second.page))?.version).toBeGreaterThan(versionBeforeSeek);
  await waitForPlayback(first.page, second.page, targetPosition);

  await togglePlayback(first.page);
  await expect.poll(async () => (await pipelineState(first.page))?.paused).toBe(true);
  await expect.poll(async () => (await pipelineState(second.page))?.paused).toBe(true);

  const holdMs = Number(process.env.E2E_HOLD_MS || config.holdMs || 0);
  if (holdMs > 0) {
    await first.page.waitForTimeout(holdMs);
  }

  await testInfo.attach("e2e-sync-summary", {
    body: Buffer.from(JSON.stringify({ mediaUrl: "[redacted]", roomId, targetPosition }, null, 2)),
    contentType: "application/json"
  });

  await first.context.close();
  await second.context.close();
});
