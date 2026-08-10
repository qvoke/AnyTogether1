export const UI_REGISTRATION_STORAGE_KEY = "anyTogetherUiRegistration";

function getUrlOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return null;
  }
}

export function createUiRegistry() {
  const tabIds = new Set();
  const origins = new Set();

  return {
    hydrate(value) {
      for (const tabId of Array.isArray(value?.tabIds) ? value.tabIds : []) {
        if (Number.isFinite(tabId)) tabIds.add(tabId);
      }
      for (const origin of Array.isArray(value?.origins) ? value.origins : []) {
        const normalizedOrigin = getUrlOrigin(origin);
        if (normalizedOrigin) origins.add(normalizedOrigin);
      }
    },
    isTab(tab) {
      return Boolean(
        tab &&
        (tabIds.has(tab.id) || origins.has(getUrlOrigin(tab.url)))
      );
    },
    isTabId(tabId) {
      return tabIds.has(tabId);
    },
    isUrl(value) {
      return origins.has(getUrlOrigin(value));
    },
    register(tabId, pageUrl) {
      if (Number.isFinite(tabId)) tabIds.add(tabId);
      const origin = getUrlOrigin(pageUrl);
      if (origin) origins.add(origin);
    },
    remove(tabId) {
      tabIds.delete(tabId);
    },
    serialize() {
      return { tabIds: [...tabIds], origins: [...origins] };
    }
  };
}
