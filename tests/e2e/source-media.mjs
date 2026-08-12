import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  buildDirectStreamResolution,
  createDirectResolverRequest,
  findDirectResolverConfig
} from "../../extension/src/direct-resolver.js";
import { extractSeriesContextInPage } from "../../extension/src/extraction-engine.js";
import { selectParserConfig } from "../../extension/src/parser-configs.js";

const parserConfigs = JSON.parse(readFileSync(
  new URL("../../extension/src/parser-configs/index.json", import.meta.url),
  "utf8"
));

function targetEpisodeFromContext(seriesContext) {
  const episodes = Array.isArray(seriesContext?.episodes) ? seriesContext.episodes : [];
  const fallbackEpisode = episodes[Number(seriesContext?.currentEpisodeIndex) || 0] || null;
  const targetEpisode = {
    seasonId: seriesContext?.currentSeasonId ?? fallbackEpisode?.seasonId,
    episodeId: seriesContext?.currentEpisodeId ?? fallbackEpisode?.episodeId
  };
  if (!Number.isFinite(Number(targetEpisode.seasonId)) || !Number.isFinite(Number(targetEpisode.episodeId))) {
    throw new Error("The source parser did not identify a playable episode.");
  }
  return targetEpisode;
}

async function fetchDirectResolverData(page, request) {
  const result = await page.evaluate(async (resolverRequest) => {
    try {
      const response = await fetch(resolverRequest.url, {
        method: resolverRequest.method,
        headers: resolverRequest.headers,
        credentials: resolverRequest.credentials,
        body: new URLSearchParams(resolverRequest.bodyValues)
      });
      if (!response.ok) {
        return { error: `HTTP ${response.status}` };
      }
      const responseText = await response.text();
      try {
        return { data: JSON.parse(responseText) };
      } catch {
        return { error: "The response was not valid JSON" };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, request);
  if (result.error) {
    throw new Error(`The source stream resolver failed: ${result.error}`);
  }
  return result.data;
}

function validateHlsUrl(mediaUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(mediaUrl);
  } catch {
    throw new Error("The source parser returned an invalid media URL.");
  }
  if (parsedUrl.protocol !== "https:" || !parsedUrl.pathname.toLowerCase().endsWith(".m3u8")) {
    throw new Error("The source parser did not return an HTTPS HLS playlist.");
  }
  return parsedUrl;
}

async function validateHlsPlaylist(page, mediaUrl) {
  const result = await page.evaluate(async (url) => {
    const abortController = new AbortController();
    const timeout = window.setTimeout(() => abortController.abort(), 10_000);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        signal: abortController.signal
      });
      if (!response.ok) {
        return { error: `HTTP ${response.status}` };
      }
      const playlist = await response.text();
      return /^#EXTM3U(?:\r?\n|$)/.test(playlist)
        ? { ok: true }
        : { error: "The response was not an HLS playlist" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      window.clearTimeout(timeout);
    }
  }, mediaUrl);
  if (!result.ok) {
    throw new Error(`The resolved HLS playlist could not be downloaded: ${result.error}`);
  }
}

export async function resolveConfiguredSourceMedia(sourcePageUrl, options = {}) {
  const parsedSourceUrl = new URL(sourcePageUrl);
  const profile = selectParserConfig(parserConfigs, parsedSourceUrl.href);
  if (!profile) {
    throw new Error(`No parser profile matches ${parsedSourceUrl.hostname}.`);
  }

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ locale: "uk-UA" });
    const page = await context.newPage();
    const response = await page.goto(parsedSourceUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    });
    if (!response?.ok()) {
      throw new Error(`The source page returned HTTP ${response?.status() ?? "unknown"}.`);
    }

    try {
      await page.waitForFunction(
        () => /initCDNSeriesEvents\(/i.test(document.documentElement.innerHTML),
        undefined,
        { timeout: 60_000, polling: 250 }
      );
    } catch {
      const blocked = await page.evaluate(() => /anubis|access denied|forbidden|blocked/i.test(document.body?.innerText || ""));
      throw new Error(blocked
        ? "The source page blocked the E2E browser before the parser could run."
        : "The source page did not expose its series resolver before the timeout.");
    }

    const seriesContext = await page.evaluate(extractSeriesContextInPage, {
      pageUrl: parsedSourceUrl.href,
      profile
    });
    if (!seriesContext?.resolver) {
      throw new Error("The configured parser did not extract a direct stream resolver.");
    }

    const targetEpisode = targetEpisodeFromContext(seriesContext);
    const resolverConfig = findDirectResolverConfig(profile, seriesContext);
    const resolverOptions = {
      translatorId: seriesContext.selectedTranslatorId,
      qualityLabel: options.qualityLabel || seriesContext.selectedQualityLabel
    };
    const resolverRequest = createDirectResolverRequest(
      resolverConfig,
      seriesContext,
      targetEpisode,
      resolverOptions
    );
    if (!resolverRequest) {
      throw new Error("The configured parser could not build a stream request.");
    }

    let resolution = null;
    let mediaUrl = null;
    let playlistError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resolverData = await fetchDirectResolverData(page, resolverRequest);
      resolution = buildDirectStreamResolution(
        resolverConfig,
        resolverData,
        seriesContext,
        targetEpisode,
        resolverOptions
      );
      if (!resolution?.mediaUrl) {
        throw new Error("The source stream response did not contain a playable URL.");
      }
      mediaUrl = validateHlsUrl(resolution.mediaUrl);
      try {
        await validateHlsPlaylist(page, mediaUrl.href);
        playlistError = null;
        break;
      } catch (error) {
        playlistError = error;
        await page.waitForTimeout(500);
      }
    }
    if (playlistError) {
      throw playlistError;
    }

    return {
      mediaUrl: mediaUrl.href,
      summary: {
        sourceHost: parsedSourceUrl.hostname,
        mediaHost: mediaUrl.hostname,
        parserProfile: profile.id,
        seasonCount: Array.isArray(seriesContext.seasons) ? seriesContext.seasons.length : 0,
        episodeCount: Array.isArray(seriesContext.episodes) ? seriesContext.episodes.length : 0,
        qualityCount: Array.isArray(resolution.seriesContext?.availableQualities)
          ? resolution.seriesContext.availableQualities.length
          : 0,
        selectedQuality: resolution.seriesContext?.selectedQualityLabel || null
      }
    };
  } finally {
    await browser.close();
  }
}
