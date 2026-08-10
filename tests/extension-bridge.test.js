import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createUiRegistry } from "../extension/src/ui-registry.js";

test("UI registry identifies registered tabs and origins across restoration", () => {
  const registry = createUiRegistry();
  registry.register(7, "http://127.0.0.1:5173/?room=ABC123");

  assert.equal(registry.isTab({ id: 7, url: "https://example.com" }), true);
  assert.equal(registry.isTab({ id: 8, url: "http://127.0.0.1:5173/rooms" }), true);
  assert.equal(registry.isUrl("http://127.0.0.1:5173/api/rooms"), true);
  assert.equal(registry.isUrl("https://example.com/video"), false);

  const restored = createUiRegistry();
  restored.hydrate(registry.serialize());
  assert.equal(restored.isTab({ id: 7, url: "https://example.com" }), true);

  restored.remove(7);
  assert.equal(restored.isTab({ id: 7, url: "https://example.com" }), false);
});

test("content bridge registers the UI page before accepting popup media", () => {
  const pageMessageListeners = [];
  const runtimeMessageListeners = [];
  const runtimeMessages = [];
  const storedValues = [];
  const postedMessages = [];
  let observerDisconnected = false;

  const pageWindow = {
    location: { href: "https://private.example.test/?room=ABC123" },
    name: "",
    addEventListener(type, listener) {
      if (type === "message") pageMessageListeners.push(listener);
    },
    postMessage(message) {
      postedMessages.push(message);
    }
  };
  pageWindow.parent = pageWindow;
  pageWindow.top = pageWindow;

  const context = vm.createContext({
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener(listener) {
            runtimeMessageListeners.push(listener);
          }
        },
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          callback?.({ ok: true });
        }
      },
      storage: {
        local: {
          set(value, callback) {
            storedValues.push(value);
            callback?.();
          }
        }
      }
    },
    console,
    document: {
      body: {},
      documentElement: {},
      getElementById() {
        return null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      readyState: "complete"
    },
    MutationObserver: class {
      disconnect() {
        observerDisconnected = true;
      }
      observe() {}
    },
    Set,
    window: pageWindow
  });

  const source = readFileSync(new URL("../extension/src/content-script.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  assert.equal(pageMessageListeners.length, 1);
  pageMessageListeners[0]({
    source: pageWindow,
    data: { type: "WT_EXTENSION_PING" }
  });
  assert.equal(observerDisconnected, true);
  assert.equal(runtimeMessages[0].type, "WT_UI_REGISTER");
  assert.equal(runtimeMessages[0].payload.pageUrl, pageWindow.location.href);

  const mediaPayload = {
    mediaUrl: "https://media.example.test/video.m3u8",
    pageUrl: "https://catalog.example.test/title"
  };
  runtimeMessageListeners[0]({ type: "WT_MEDIA_FOUND", payload: mediaPayload });

  assert.equal(storedValues.at(-1).pendingMediaUrl.payload, mediaPayload);
  assert.equal(postedMessages.at(-1).type, "WT_MEDIA_FOUND");
  assert.equal(postedMessages.at(-1).payload, mediaPayload);
});
