const CACHE_NAME = "mono82-cache-v37";

/*
 * mono82で現在必要なローカルファイルだけをApp Shellとして保持する。
 * 外部Google FontsはService Workerの同一originキャッシュ対象にしない。
 */
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/main.js",
  "./js/audio.js",
  "./js/export.js",
  "./js/keyboard-navigation.js",
  "./js/sequencer.js",
  "./js/sound-defaults.js",
  "./js/sound-preset-manager.js",
  "./js/sound-presets.js",
  "./js/storage.js",
  "./js/ui.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(cacheNames =>
        Promise.all(
          cacheNames
            .filter(name =>
              (
                name.startsWith("sprooto-cache-") ||
                name.startsWith("mono82-cache-")
              ) &&
              name !== CACHE_NAME
            )
            .map(name => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (!response || response.status !== 200) {
          return response;
        }

        const copy = response.clone();

        event.waitUntil(
          caches
            .open(CACHE_NAME)
            .then(cache => cache.put(request, copy))
        );

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) {
          return cached;
        }

        if (request.mode === "navigate") {
          return caches.match("./index.html");
        }

        throw new Error("offline resource unavailable");
      })
  );
});
