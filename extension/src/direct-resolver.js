function normalizeQualityLabel(label) {
  return String(label || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isPlayableQualityLabel(label) {
  const normalized = normalizeQualityLabel(label);
  if (!normalized || normalized.includes("ultra")) return false;

  const compact = normalized.replace(/\s+/g, "");
  return /^(?:\d{3,4}(?:p|hd|fhd|uhd)?|\d{3,4}x\d{3,4}|[48]k)$/.test(compact);
}

function readObjectPath(value, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null) return null;
    current = current[part];
  }
  return current ?? null;
}

function resolveConfigValue(expression, context) {
  if (typeof expression !== "string" || !expression.startsWith("$")) {
    return expression;
  }

  return readObjectPath(context, expression.slice(1));
}

function getDirectResolverContext(seriesContext, targetEpisode, options = {}) {
  const resolver = seriesContext?.resolver || {};
  return {
    resolver,
    target: targetEpisode || {},
    selectedTranslatorId: Number.isFinite(Number(options.translatorId))
      ? Number(options.translatorId)
      : Number(seriesContext?.selectedTranslatorId ?? resolver.translatorId ?? null),
    selectedQualityLabel: options.qualityLabel || seriesContext?.selectedQualityLabel || null
  };
}

export function parseStreamOptions(streamText) {
  if (typeof streamText !== "string" || !streamText) return [];

  const options = [];
  const entries = streamText.split(/,(?=\[[^\]]+\])/g);

  for (const entry of entries) {
    const labelMatch = entry.match(/^\[([^\]]+)\]/);
    const urlMatch = entry.match(/https?:\/\/[^\s"'<>]+/i);
    if (!labelMatch || !urlMatch) continue;

    const label = String(labelMatch[1] || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const url = String(urlMatch[0] || "").trim();
    if (!label || !url || !isPlayableQualityLabel(label)) continue;

    options.push({
      label,
      normalizedLabel: normalizeQualityLabel(label),
      url
    });
  }

  return options;
}

export function pickStreamOption(options, preferredQualityLabel, defaultQualityLabel) {
  if (!Array.isArray(options) || options.length === 0) return null;

  const parseResolution = (label) => {
    const value = Number.parseInt(String(label || "").replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(value) ? value : null;
  };
  const preferred = normalizeQualityLabel(preferredQualityLabel);
  if (preferred) {
    const exactMatch = options.find((option) => option.normalizedLabel === preferred);
    if (exactMatch) return exactMatch;

    const looseMatch = options.find((option) => option.normalizedLabel.includes(preferred));
    if (looseMatch) return looseMatch;
  }

  const defaultMatch = normalizeQualityLabel(defaultQualityLabel);
  if (defaultMatch) {
    const exactDefault = options.find((option) => option.normalizedLabel === defaultMatch);
    if (exactDefault) return exactDefault;

    const looseDefault = options.find((option) => option.normalizedLabel.includes(defaultMatch));
    if (looseDefault) return looseDefault;
  }

  const ranked = options
    .map((option) => ({ option, resolution: parseResolution(option.label) ?? parseResolution(option.normalizedLabel) ?? 0 }))
    .sort((left, right) => right.resolution - left.resolution);
  if (ranked.length && ranked[0].resolution > 0) {
    return ranked[0].option;
  }

  return options[0];
}

export function findDirectResolverConfig(profile, seriesContext, source = {}) {
  const resolverType = source.resolverType || "ajaxStreamList";
  const provider = seriesContext?.resolver?.provider || null;
  return (Array.isArray(profile?.directResolvers) ? profile.directResolvers : []).find((resolverConfig) =>
    resolverConfig?.type === resolverType &&
    (!resolverConfig.provider || !provider || resolverConfig.provider === provider)
  ) || null;
}

export function createDirectResolverRequest(resolverConfig, seriesContext, targetEpisode, options = {}) {
  if (!resolverConfig || resolverConfig.type !== "ajaxStreamList" || !seriesContext || !targetEpisode) {
    return null;
  }

  const context = getDirectResolverContext(seriesContext, targetEpisode, options);
  const origin = context.resolver.origin || seriesContext?.resolver?.origin;
  if (!origin || !resolverConfig.url) return null;

  const endpoint = new URL(resolverConfig.url, origin);
  if (resolverConfig.timestampQuery) {
    endpoint.searchParams.set(resolverConfig.timestampQuery, String(Date.now()));
  }

  const bodyValues = {};
  for (const [key, value] of Object.entries(resolverConfig.body || {})) {
    const resolvedValue = resolveConfigValue(value, context);
    bodyValues[key] = resolvedValue == null ? "" : String(resolvedValue);
  }

  return {
    url: endpoint.href,
    method: resolverConfig.method || "POST",
    headers: resolverConfig.headers || {},
    credentials: resolverConfig.credentials || "same-origin",
    bodyValues
  };
}

export function buildDirectStreamResolution(resolverConfig, ajaxData, seriesContext, targetEpisode, options = {}) {
  const responseConfig = resolverConfig?.response || {};
  const streamList = readObjectPath(ajaxData, responseConfig.streamListPath || "url");
  if (!streamList || !seriesContext || !targetEpisode) return null;

  const streamOptions = parseStreamOptions(streamList);
  const selectedStream = pickStreamOption(
    streamOptions,
    options.qualityLabel,
    responseConfig.defaultQualityPath
      ? readObjectPath(ajaxData, responseConfig.defaultQualityPath)
      : null
  );
  if (!selectedStream?.url) return null;

  const seasonId = Number(targetEpisode.seasonId);
  const episodeId = Number(targetEpisode.episodeId);
  const episodes = Array.isArray(seriesContext.episodes) ? seriesContext.episodes : [];
  const currentEpisodeIndex = episodes.findIndex(
    (episode) => Number(episode?.seasonId) === seasonId && Number(episode?.episodeId) === episodeId
  );

  return {
    mediaUrl: selectedStream.url,
    masterPlaylistUrl: null,
    pageUrl: seriesContext.resolver?.pageUrl || null,
    seriesContext: {
      ...seriesContext,
      currentEpisodeIndex,
      currentSeasonId: seasonId,
      currentEpisodeId: episodeId,
      selectedTranslatorId: Number(options.translatorId ?? seriesContext.selectedTranslatorId ?? seriesContext.resolver?.translatorId ?? null),
      selectedQualityLabel: selectedStream.label,
      availableQualities: streamOptions.map((option) => ({
        label: option.label,
        normalizedLabel: option.normalizedLabel
      }))
    }
  };
}
