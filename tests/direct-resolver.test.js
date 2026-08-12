import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectStreamResolution,
  createDirectResolverRequest,
  findDirectResolverConfig
} from "../extension/src/direct-resolver.js";

const resolverConfig = {
  type: "ajaxStreamList",
  provider: "rezka",
  method: "POST",
  credentials: "include",
  executionContext: "page",
  url: "/ajax/get_cdn_series/",
  timestampQuery: "t",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest"
  },
  body: {
    id: "$resolver.itemId",
    translator_id: "$selectedTranslatorId",
    season: "$target.seasonId",
    episode: "$target.episodeId",
    favs: "$resolver.favs",
    action: "get_stream"
  },
  response: {
    streamListPath: "url",
    qualityPath: "quality",
    defaultQualityPath: "default_quality"
  }
};

const seriesContext = {
  currentSeasonId: 1,
  currentEpisodeId: 2,
  selectedTranslatorId: 111,
  selectedQualityLabel: "1080p",
  resolver: {
    provider: "rezka",
    itemId: 9364,
    translatorId: 111,
    origin: "https://rezka.ag",
    pageUrl: "https://rezka.ag/series/thriller/9364-mister-robot-2015.html",
    favs: "favorite-token"
  },
  episodes: [
    { seasonId: 1, episodeId: 1 },
    { seasonId: 1, episodeId: 2 }
  ]
};

test("direct resolver builds the configured same-origin stream request", () => {
  const targetEpisode = { seasonId: 1, episodeId: 2 };
  const request = createDirectResolverRequest(resolverConfig, seriesContext, targetEpisode, {});

  assert.equal(new URL(request.url).pathname, "/ajax/get_cdn_series/");
  assert.ok(new URL(request.url).searchParams.get("t"));
  assert.equal(request.method, "POST");
  assert.equal(request.credentials, "include");
  assert.deepEqual(request.bodyValues, {
    id: "9364",
    translator_id: "111",
    season: "1",
    episode: "2",
    favs: "favorite-token",
    action: "get_stream"
  });
});

test("direct resolver selects the requested HLS quality", () => {
  const targetEpisode = { seasonId: 1, episodeId: 2 };
  const resolution = buildDirectStreamResolution(
    resolverConfig,
    {
      url: "[720p]https://media.example.test/720.m3u8,[1080p]https://media.example.test/1080.m3u8",
      default_quality: "720p"
    },
    seriesContext,
    targetEpisode,
    { qualityLabel: "1080p", translatorId: 111 }
  );

  assert.equal(resolution.mediaUrl, "https://media.example.test/1080.m3u8");
  assert.equal(resolution.seriesContext.currentEpisodeIndex, 1);
  assert.equal(resolution.seriesContext.selectedQualityLabel, "1080p");
  assert.deepEqual(resolution.seriesContext.availableQualities.map((quality) => quality.label), ["720p", "1080p"]);
});

test("direct resolver uses the provider default without an explicit quality", () => {
  const resolution = buildDirectStreamResolution(
    resolverConfig,
    {
      url: "[480p]https://media.example.test/480.m3u8,[720p]https://media.example.test/720.m3u8,[1080p]https://media.example.test/1080.m3u8",
      default_quality: "720p"
    },
    { ...seriesContext, selectedQualityLabel: null },
    { seasonId: 1, episodeId: 2 }
  );

  assert.equal(resolution.mediaUrl, "https://media.example.test/720.m3u8");
  assert.equal(resolution.seriesContext.selectedQualityLabel, "720p");
});

test("direct resolver profile selection respects the provider", () => {
  const profile = {
    directResolvers: [
      { type: "ajaxStreamList", provider: "other" },
      resolverConfig
    ]
  };

  assert.equal(findDirectResolverConfig(profile, seriesContext), resolverConfig);
});
